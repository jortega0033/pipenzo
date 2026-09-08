import { Octokit } from '@octokit/core';
import { paginateRest, type PaginateInterface } from '@octokit/plugin-paginate-rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import {
  MAX_ISSUE_COMMENT_CHARS,
  PIPENZO_LABEL_NAMESPACE,
  isPipenzoLabel,
  issueCommentBodyProblem,
  issueCreateBodyProblem,
} from '@agent-dock/shared';
import { ConditionalRequestCache } from './github-conditional-cache.js';
import {
  GITHUB_CORE_RATE_LIMIT_RESOURCE,
  GitHubRateLimitTracker,
  type GitHubRateLimitSnapshot,
} from './github-rate-limit.js';

/**
 * Pipenzo's GitHub API client (issue #177).
 *
 * Three properties this module exists to hold, all of them stated in README:
 *
 * 1. **It is `@octokit/core`, never the `gh` binary.** README's Stack table pins the client to
 *    `@octokit/core` + `paginate-rest` precisely so the GitHub surface is pure JS that tree-shakes
 *    into the daemon bundle. The single `gh` command family Pipenzo will ever shell out to is
 *    `gh stack`, and that belongs to the publish service, not here.
 * 2. **It cannot publish.** There is deliberately no `push`, no `createPullRequest`, no
 *    `merge` on this interface. Pushing a branch and opening a PR are the publish service's job
 *    (`publish-service.ts`, issue #178) so that the one module holding write-to-the-world power
 *    stays a single, reviewable, agent-unreachable surface. Label writes are the one exception,
 *    because labels *are* Pipenzo's state model (README's label table) and a phase machine whose
 *    states are labels cannot write a state without them.
 * 3. **It is an interface first.** `GitHubClient` is the seam a `FakeGitHubClient` (see
 *    `github-client-fake.ts`, README's Testing suite 2) sits behind today and a GitLab adapter
 *    sits behind later (README's near-term post-MVP list). Callers depend on the interface.
 *
 * Walking-skeleton simplifications, all owned by later build-order steps:
 * - Device-flow OAuth is still build step 4. What this client authenticates with is a PAT.
 *
 * Issue #165 closed the other half of that row. The shipped daemon no longer reads its PAT from
 * its own environment: Electron main holds it in a `safeStorage` vault and writes it over stdin,
 * and `fromToken` — reading a token this module no longer fetches for itself — is what `index.ts`
 * calls. `GITHUB_TOKEN_ENV_KEYS` below documents what is left of the env path and who still uses it.
 *
 * Issue #161 closed the two rate-limit gaps this comment used to list:
 * - **Conditional requests.** `getIssue` and `listLabels` send `If-None-Match` from a
 *   per-`(repo, resource)` ETag store (`github-conditional-cache.ts`) and serve the stored body on
 *   a `304`, which costs no rate-limit quota at all. See `#conditional` below.
 * - **The throttling/retry ladder.** `@octokit/plugin-throttling` honours `Retry-After` and
 *   GitHub's secondary-limit signal, and `@octokit/plugin-retry` retries transient 5xx. What is
 *   deliberately *not* retried is a primary-limit window longer than
 *   `MAX_RATE_LIMIT_SLEEP_SECONDS` — see `pipenzoThrottleOptions` for why sleeping through an
 *   hour-long reset inside a daemon request is worse than surfacing `rate_limited`.
 */

/**
 * The only environment variable Pipenzo reads its PAT from.
 *
 * A `GITHUB_TOKEN` fallback was considered and rejected: GitHub Actions injects that variable
 * automatically, so a daemon started inside CI would silently publish as the Actions token instead
 * of failing `token_missing` — an ambiguity about *which credential just pushed* is exactly what a
 * publish gate must not have. One name, no fallback.
 *
 * Issue #165 settled what happens to this read path now the Electron-main vault exists, and it is
 * not quite the "delete it outright" this comment used to promise. It is no longer how the
 * **shipped** daemon gets its credential: Electron main strips this variable from the daemon's
 * environment entirely and writes the token to stdin instead, because the daemon is the parent of
 * every provider subprocess and a child can read its parent's environment block regardless of what
 * it inherited (`github-credential.ts` has the full argument). What remains is the only source a
 * daemon started *without* an Electron main has — a direct `pnpm dev`, the live-smoke harness, CI —
 * and in the shipped app it is unreachable rather than merely deprioritised, so the "vault, or else
 * env" ambiguity this comment warned about cannot arise.
 */
export const GITHUB_TOKEN_ENV_KEYS = Object.freeze(['PIPENZO_GITHUB_TOKEN'] as const);

/** Walking-skeleton single-repo pin (build order step 2: "hardcoded repo"). */
export const GITHUB_REPO_ENV_KEY = 'PIPENZO_GITHUB_REPO';

/**
 * The one label namespace Pipenzo owns, and the boundary `setIssueLabels` refuses to cross.
 *
 * Every state in README's label table is prefixed with this. Everything else on an issue belongs to
 * whoever put it there — a triage label, a `good first issue`, a release marker some other
 * automation writes — and a phase machine that replaced the whole label set on a lane transition
 * would quietly delete all of it on the first ticket it touched.
 *
 * Re-exported from `@agent-dock/shared` (Pipenzo issue #187) rather than declared here: the string
 * and the `pipenzo:`-prefixed label vocabulary that depends on it now live in
 * `pipenzo-ticket-v1.ts`, which both this daemon and the desktop renderer can import, whereas
 * `apps/daemon` is not something the renderer can reach into. This module keeps the re-export (so
 * every existing importer of `github-client.js` is untouched) but is no longer the source of truth
 * for the string — it is still the source of truth for *the write guard below*, which is a
 * daemon-only, network-adjacent concern the shared vocabulary module has no business owning.
 */
export { PIPENZO_LABEL_NAMESPACE, isPipenzoLabel };

export type GitHubClientErrorCode =
  | 'token_missing'
  | 'invalid_repository'
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'invalid_response'
  | 'network';

/**
 * Typed failure, matching agentdock's `WorktreeManagerError` shape (a closed `code` union plus a
 * message) rather than a bare `throw new Error`. Routes map `code` to a status; nothing upstream
 * has to string-match a message.
 *
 * The constructor scrubs its own message. A raw octokit error can carry a request URL with
 * credentials in it, and an operator pasting a stack trace into an issue is the realistic way a
 * PAT leaks — so redaction happens here, at construction, not at each call site that might forget.
 */
export class GitHubClientError extends Error {
  readonly code: GitHubClientErrorCode;
  readonly status: number | undefined;
  /** Unix ms at which a `rate_limited` window resets, when GitHub reported one. */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: GitHubClientErrorCode,
    message: string,
    options?: { status?: number; retryAfterMs?: number },
  ) {
    super(redactSecrets(message));
    this.name = 'GitHubClientError';
    this.code = code;
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * The daemon's own resolved credential(s), registered so `redactSecrets` can scrub them by exact
 * value regardless of shape (issue #211). Module-private and additive-only: nothing ever removes a
 * value once registered, and there is no read accessor — the set exists to be matched against, not
 * inspected. Registering a value is still a second place it sits in heap memory alongside
 * `DaemonGitHubCredential`'s own private field; what this design buys is that neither this set nor
 * `redactSecrets` can be used to read it back out anywhere in this codebase.
 */
const knownSecrets = new Set<string>();

/**
 * A floor on length rather than trusting every caller to have already validated shape: an empty or
 * near-empty string registered by mistake would make the exact-match rule in `redactSecrets` below
 * scrub that substring out of *every* message this module ever produces, which is a worse failure
 * than the known limit this function exists to close. Set to the same 20-character floor
 * `github-credential.ts`'s `isTokenShaped` already enforces on every real GitHub credential this
 * daemon resolves — not an arbitrary smaller number, so a future caller cannot register something
 * shorter than any credential this process actually holds while still believing it passed a real
 * shape check.
 */
const MIN_KNOWN_SECRET_LENGTH = 20;

/**
 * Registers `value` as a secret `redactSecrets` should also scrub by exact substring match, for
 * any future appearance regardless of format — the mitigation issue #211 asked for once the
 * daemon started holding its resolved token in a first-class object (`DaemonGitHubCredential`)
 * instead of reading it from the environment at call time, which made an exact-value scrub cheap
 * and format-independent for the first time.
 *
 * Registering does not itself log, persist, or return `value` — this function's only effect is
 * adding it to the in-memory set `redactSecrets` reads, for the life of this process.
 */
export function registerKnownSecret(value: string): void {
  const trimmed = value.trim();
  if (trimmed.length >= MIN_KNOWN_SECRET_LENGTH) knownSecrets.add(trimmed);
}

/**
 * Removes anything shaped like a GitHub credential from a string, then removes any exact match of
 * a value `registerKnownSecret` was told about.
 *
 * Deliberately pattern-based first rather than "strip the token we happen to hold" alone: the
 * strings that reach here come from octokit and from Node's HTTP stack, and they can contain a
 * *different* credential than the one this client was constructed with (a redirect, a proxy URL, a
 * credential-in-URL a user pasted into a remote). Matching the shapes covers all of them; the
 * exact-value pass below covers the one shape no pattern can, at all, safely.
 *
 * Rule order matters and is not arbitrary. The URL rules run **before** the header rule, because
 * `https://x-access-token:ghp_…@github.com/o/r.git` contains a literal `x-access-token:` and a
 * header rule matching first would swallow the host and repository path along with the credential
 * — leaving an operator a `push_failed` with no diagnostic in it at all. Redaction should remove
 * the secret, not the sentence. The exact-value pass runs **last**, after every pattern rule, so its
 * job is ordinarily the leftover a shape rule was never going to catch. (A pattern rule that only
 * partially rewrote a registered secret would leave a fragment the exact pass can no longer match —
 * unreachable for anything `isTokenShaped` accepts today, since the `gh*_`/`github_pat_`/JWT rules
 * each consume their whole match, but worth knowing this pass is not a backstop for that case.)
 *
 * **Formerly a known limit, closed by issue #211:** a pre-2021 40-hex classic PAT cannot be
 * *pattern*-matched — this module interpolates commit SHAs into messages, and a 40-hex rule would
 * redact every one of them, a false-positive rate worse than the leak it would prevent. Once the
 * daemon holds its resolved token in `DaemonGitHubCredential` rather than re-reading the
 * environment at call time (issue #165), that exact string is known in advance and cheap to
 * register — `apps/daemon/src/index.ts` does so once, at startup. A classic PAT this daemon was
 * never handed (someone else's, in a proxy URL or a pasted remote) is still only caught when its
 * shape matches one of the pattern rules above; the known-limit is narrower, not eliminated.
 */
export function redactSecrets(value: string): string {
  let scrubbed = value
    // Credential in a URL, both forms: `user:pass@host` and the bare `token@host` git also uses.
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/)[^/@\s:]+@/gi, '$1[redacted]@')
    // Classic and fine-grained GitHub tokens, wherever they appear.
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted]')
    // A bare JWT — what a GitHub App installation token looks like with no `Bearer` in front.
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]')
    // Base64 of a `gh*_` token: what `Authorization: Basic` carries on the wire.
    .replace(/\bZ2h[A-Za-z0-9+/]{16,}={0,2}/g, '[redacted]')
    // Any auth header. The value alternation consumes the scheme *and* what follows it: a rule
    // that stops after `Basic` leaves the entire credential sitting in the log line.
    // The `"?'?` on both sides of the separator matters: in a JSON body the key is quoted
    // (`"access_token":"…"`), and a rule that only allows a bare `key: value` misses it.
    .replace(
      /\b(proxy-authorization|authorization|x-access-token|access_token|token)"?'?\s*[:=]\s*"?'?(?:basic|bearer|token)?\s*[^\s"']+/gi,
      '$1: [redacted]',
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]');
  // `replaceAll` with a *string* argument, not a regex built from `secret`: a token's characters
  // are printable ASCII and could still include a regex metacharacter, and the string overload
  // does a literal substring match with no pattern interpretation at all -- the replacement
  // `'[redacted]'` carries no `$` either, so there is no substitution-pattern hazard on that side.
  for (const secret of knownSecrets) {
    if (secret) scrubbed = scrubbed.replaceAll(secret, '[redacted]');
  }
  return scrubbed;
}

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

/** `owner/name`, validated against GitHub's own character rules rather than trusted. */
export function parseRepoRef(value: string): RepoRef {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(value.trim());
  if (!match?.[1] || !match[2] || match[2] === '.' || match[2] === '..') {
    throw new GitHubClientError(
      'invalid_repository',
      `not an owner/name repository reference: ${value}`,
    );
  }
  return { owner: match[1], repo: match[2] };
}

export interface GitHubIssue {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly labels: readonly string[];
  /** Login names. README's claim rule (Team usage) reads this to refuse a ticket someone else owns. */
  readonly assignees: readonly string[];
  readonly htmlUrl: string;
  readonly updatedAt: string;
  /** Response ETag, for the conditional-request path the ticket store owns (build step 3). */
  readonly etag: string | undefined;
}

/**
 * One comment Pipenzo posted (issue #228).
 *
 * Narrower than GitHub's payload, and narrow in one direction on purpose: this is the echo of a
 * *write*, not a row in a comment list. There is no author field because there is only ever one
 * author — whoever the daemon's credential belongs to — and no reactions, no `updated_at`, no
 * `author_association`, because nothing reads them. Widening this is somebody's later ticket with
 * a consumer attached to it.
 */
export interface GitHubIssueComment {
  readonly id: number;
  readonly body: string;
  readonly htmlUrl: string;
  /** ISO-8601, as GitHub reports it. */
  readonly createdAt: string;
}

export interface GitHubLabel {
  readonly name: string;
  /** Six lowercase hex digits, no leading `#` — GitHub's own wire shape. */
  readonly color: string;
  readonly description: string;
}

/**
 * One repository the credential can reach (issue #115).
 *
 * Narrower than GitHub's payload on purpose: this carries only what the repo picker shows, so a
 * field cannot become load-bearing in a renderer without somebody widening a type here first.
 * `archived` is kept rather than filtered out at this level — the picker has to *show* an archived
 * repository in order to explain why it cannot be chosen.
 */
export interface GitHubRepository {
  /** `owner/name`, as GitHub itself reports it. */
  readonly fullName: string;
  readonly archived: boolean;
  readonly defaultBranch: string;
  readonly language?: string;
  readonly openIssues: number;
  /** ISO-8601, absent for a repository that has never been pushed to. */
  readonly pushedAt?: string;
}

/**
 * How many pages of `GET /user/repos` this client will walk before giving up and saying so.
 *
 * 100 per page, so this is 5,000 repositories — far above any plausible account, and bounded so an
 * organisation with an implausible one cannot turn a picker into an unbounded quota spend. The
 * caller is told when the cap was hit rather than being handed a short list that looks complete.
 */
export const GITHUB_REPO_PAGE_CAP = 50;

export interface GitHubPullRequestDiff {
  readonly number: number;
  readonly baseRef: string;
  readonly headRef: string;
  readonly headSha: string;
  /** A real unified diff, which is what `react-diff-view` parses (README's Stack table). */
  readonly diff: string;
  readonly changedFiles: number;
  readonly additions: number;
  readonly deletions: number;
}

export type GitHubCheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | 'stale'
  | 'skipped'
  | 'unknown';

export interface GitHubCheckRun {
  readonly name: string;
  readonly status: 'queued' | 'in_progress' | 'completed' | 'unknown';
  readonly conclusion: GitHubCheckConclusion | undefined;
  readonly detailsUrl: string | undefined;
}

/**
 * The seam. A `FakeGitHubClient` and a future GitLab adapter both implement exactly this.
 *
 * Note what is absent, on purpose: no branch push, no pull-request creation, no merge. See the
 * module comment — those live in the publish service so the write-to-the-world surface is one
 * module a human can read in full.
 */
export interface GitHubClient {
  getIssue(ref: RepoRef, issueNumber: number): Promise<GitHubIssue>;
  /**
   * Every repository this credential can *write* to, for the repo picker (issue #115).
   *
   * Write, not read: Pipenzo's whole job on a repository is creating labels and opening pull
   * requests, so a repository it can only read is one it can never manage. Listing those anyway
   * would fill the picker with rows that fail at the first write, long after the user chose them.
   * The filter is GitHub's own `permissions.push`, applied here rather than in the UI so every
   * consumer inherits it.
   */
  listAccessibleRepositories(): Promise<{
    readonly repositories: readonly GitHubRepository[];
    readonly truncated: boolean;
  }>;
  listLabels(ref: RepoRef): Promise<readonly GitHubLabel[]>;
  /** Idempotent: an existing label with the same name is returned rather than re-created. */
  createLabel(ref: RepoRef, label: GitHubLabel): Promise<GitHubLabel>;
  /**
   * Replaces the `pipenzo:` labels on one issue, and returns the issue's resulting label set.
   *
   * Replace, not add: a lane transition that left the previous lane's label in place would put the
   * ticket in two lanes at once, and the label is the authoritative side of that (README's label
   * table). Passing an empty array clears the namespace.
   *
   * Foreign labels are preserved by this method rather than by its callers. Pipenzo owns one
   * namespace, not the issue, so a human's `bug` or `good first issue` has to survive every lane
   * write — and a rule enforced at one call site is a rule that the second call site forgets. See
   * the implementation for the read-modify-write this costs.
   */
  setIssueLabels(
    ref: RepoRef,
    issueNumber: number,
    labels: readonly string[],
  ): Promise<readonly string[]>;
  /** Removes one label, treating "it was not there" as success so a transition is idempotent. */
  removeIssueLabel(ref: RepoRef, issueNumber: number, name: string): Promise<void>;
  /**
   * Adds an assignee (issue #184, for #83's claim pre-flight). Additive, never a replacement:
   * GitHub's `POST .../assignees` adds, and Pipenzo must not be able to evict a human who is
   * already on a ticket. The refusal in a lost claim race is decided by re-reading the issue
   * afterwards, not by this call failing — GitHub happily accepts a second assignee.
   */
  assignIssue(ref: RepoRef, issueNumber: number, assignee: string): Promise<GitHubIssue>;
  /**
   * The login the configured token authenticates as (issue #83's claim pre-flight).
   *
   * The daemon holds the token, so the daemon is the only thing that actually knows who "I" is.
   * Asking the renderer for a login would let a caller claim a ticket *as somebody else*, which
   * would defeat the entire point of an assignment race — the loser has to be able to trust that
   * the name on the ticket is the person who took it.
   */
  getAuthenticatedLogin(): Promise<string>;
  /** Creates an issue (issue #184, for #84's "New from idea"). Never opens a pull request. */
  createIssue(ref: RepoRef, input: GitHubIssueDraft): Promise<GitHubIssue>;
  /**
   * The latest remaining-quota reading for one rate-limit bucket (issue #229), or `undefined` when
   * there is none worth believing -- nothing observed yet, or a reading whose window has since
   * refilled.
   *
   * Synchronous and free: it returns what a previous response already said, and never makes a
   * request of its own. Epic #4's rule is *"below ~15% remaining quota: degrade, don't fail"*, and
   * `remaining / limit` is that fraction; the threshold itself belongs to the consumer that reacts
   * to it, not here.
   *
   * On the interface rather than only on the octokit implementation because the polling reconciler
   * (#231) is the caller, and a reconciler that could not be tested against `FakeGitHubClient`
   * would have its degradation behaviour tested nowhere at all.
   */
  rateLimit(resource?: string): GitHubRateLimitSnapshot | undefined;
  /**
   * The push half of the same reading (issue #229). Returns its own unsubscribe.
   *
   * On the interface for the reason `rateLimit` is, and it is the stronger case of the two: the
   * point of the hook is that a long-lived consumer reacts *without* polling an accessor, so a
   * consumer that could only subscribe through the concrete octokit client would be tested against
   * the fake by polling — which is the thing the hook exists to avoid. A client with no tracker
   * wired returns a no-op unsubscribe rather than refusing, because "nothing will ever be
   * published here" is a legitimate configuration and not a caller error.
   */
  subscribeRateLimit(listener: (snapshot: GitHubRateLimitSnapshot) => void): () => void;
  /**
   * Posts one comment on an issue (issue #228).
   *
   * Epic #4's diff-size gate ends two of its rows in a comment rather than in a lane move: the
   * "no clean layering at any size" row posts the estimate and the proposed split before handing
   * to a human (#100), and a blown estimate records real-versus-predicted numbers where a human
   * will see them (#144). Neither is expressible with labels, which is the only write this client
   * had.
   *
   * Post only. No edit, no delete, no list — each of those is a capability with no caller today,
   * and an unused write on this interface is an unused write on a credential that can reach every
   * repository the operator connected.
   *
   * **Not idempotent, and cannot be made so.** GitHub has no idempotency key for comments, so a
   * retried call posts a second comment. Callers that must not double-post gate themselves; this
   * method will not guess, because guessing means either silently swallowing a real second comment
   * or reading the comment list on every write.
   */
  createIssueComment(
    ref: RepoRef,
    issueNumber: number,
    body: string,
  ): Promise<GitHubIssueComment>;
  getPullRequestDiff(ref: RepoRef, pullNumber: number): Promise<GitHubPullRequestDiff>;
  listPullRequestChecks(ref: RepoRef, pullNumber: number): Promise<readonly GitHubCheckRun[]>;
}

/** What `createIssue` accepts. No assignee: creating and claiming stay two auditable steps. */
export interface GitHubIssueDraft {
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
}

/**
 * Resolves the PAT from the environment, never from a request body or an agent-reachable surface.
 *
 * Takes an explicit `env` so callers (and tests) can hand in a scoped object; the default is the
 * daemon's own `process.env`, which is the only process that ever holds this value. Trimmed and
 * length-checked so an empty or whitespace variable reads as "not configured" rather than as a
 * token that will 401 later with a confusing message.
 */
export function resolveGitHubToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  for (const key of GITHUB_TOKEN_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  throw new GitHubClientError(
    'token_missing',
    `no GitHub token configured; set ${GITHUB_TOKEN_ENV_KEYS.join(' or ')}`,
  );
}

/** Reads the walking skeleton's single hardcoded repository pin. */
export function resolveConfiguredRepo(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RepoRef {
  const value = env[GITHUB_REPO_ENV_KEY]?.trim();
  if (!value) {
    throw new GitHubClientError(
      'invalid_repository',
      `no repository configured; set ${GITHUB_REPO_ENV_KEY} to owner/name`,
    );
  }
  return parseRepoRef(value);
}

type PipenzoOctokit = Octokit & { paginate: PaginateInterface };

/**
 * Exported so a test can compose the same client and assert each plugin is genuinely installed.
 * Without the list, "does this client throttle?" is only checkable by observing that construction
 * does not throw — which stays true if `throttling` is dropped, because an unrecognised `throttle`
 * option is simply ignored.
 */
export const PIPENZO_OCTOKIT_PLUGINS = Object.freeze([paginateRest, retry, throttling] as const);

const OctokitWithPagination = Octokit.plugin(...PIPENZO_OCTOKIT_PLUGINS);

export const PIPENZO_USER_AGENT = 'pipenzo/0.1 (+https://github.com/jortega0033/pipenzo)';

/**
 * The longest `Retry-After`/reset wait this client will sleep through rather than fail (issue #161).
 *
 * GitHub's *secondary* limits are short — seconds to a minute — and sleeping through one is exactly
 * right: the alternative is a spurious failure the caller would have retried anyway. A *primary*
 * limit is different. Its reset can be up to an hour away, and every one of these calls happens
 * inside a daemon HTTP request that a renderer is awaiting; sleeping for fifty minutes would look
 * to the user like Pipenzo had hung, with no way to tell that from a real deadlock. Past this bound
 * the error is allowed through instead, where `toGitHubClientError` turns it into a `rate_limited`
 * carrying `retryAfterMs` — which is precisely what the "degrade, don't fail" surface (#75) needs
 * in order to widen poll intervals and say "syncing slowly" rather than spin.
 */
export const MAX_RATE_LIMIT_SLEEP_SECONDS = 60;

/** How many times a limit that *is* short enough to wait out may be retried before giving up. */
export const MAX_RATE_LIMIT_RETRIES = 2;

/**
 * The whole retry-or-surface decision, as a pure function so it can be asserted without a network.
 *
 * A non-finite or negative `retryAfter` (a malformed `Retry-After`, a reset already in the past) is
 * treated as not-retryable rather than as "wait zero seconds and hammer": the plugin would loop
 * immediately against a limit GitHub has not actually lifted, which is how a client earns a
 * secondary-limit block on top of the primary one it already had.
 */
export function shouldRetryRateLimit(retryAfterSeconds: number, retryCount: number): boolean {
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) return false;
  if (!Number.isFinite(retryCount) || retryCount >= MAX_RATE_LIMIT_RETRIES) return false;
  return retryAfterSeconds <= MAX_RATE_LIMIT_SLEEP_SECONDS;
}

export interface PipenzoThrottleObserver {
  /**
   * Called each time GitHub reports a limit, whether or not the request is retried. The
   * rate-limit degradation surface (#75) subscribes here; nothing in this module reacts to it.
   */
  onRateLimit?(event: {
    kind: 'primary' | 'secondary';
    retryAfterSeconds: number;
    retrying: boolean;
    method: string;
    url: string;
  }): void;
}

interface ThrottleRequestOptions {
  method?: string;
  url?: string;
}

/**
 * The `@octokit/plugin-throttling` policy, in one place so the publish service and the read client
 * cannot drift apart on it. Both handlers are mandatory — the plugin throws at construction if
 * either is missing, which is a design choice of its own worth keeping: there is no silent default.
 */
function pipenzoThrottleOptions(observer: PipenzoThrottleObserver | undefined): {
  onRateLimit: (retryAfter: number, options: unknown, octokit: unknown, retryCount: number) => boolean;
  onSecondaryRateLimit: (
    retryAfter: number,
    options: unknown,
    octokit: unknown,
    retryCount: number,
  ) => boolean;
} {
  const decide = (
    kind: 'primary' | 'secondary',
    retryAfter: number,
    options: unknown,
    retryCount: number,
  ): boolean => {
    const request = (options ?? {}) as ThrottleRequestOptions;
    const retrying = shouldRetryRateLimit(retryAfter, retryCount);
    observer?.onRateLimit?.({
      kind,
      retryAfterSeconds: retryAfter,
      retrying,
      method: request.method ?? 'GET',
      url: request.url ?? '',
    });
    return retrying;
  };
  return {
    onRateLimit: (retryAfter, options, _octokit, retryCount) =>
      decide('primary', retryAfter, options, retryCount),
    onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) =>
      decide('secondary', retryAfter, options, retryCount),
  };
}

/**
 * Builds the one configured octokit instance.
 *
 * Exported because the publish service (issue #178) needs an authenticated client for its
 * PR-open half and must not grow a second, differently-configured auth path — but note that it
 * builds its *own* instance from its *own* token read. The two never share a live object, so
 * there is no handle a caller of this module could follow to the publish service's credential.
 *
 * Note what the retry plugin will and will not retry, because it matters for a publishing surface:
 * its `doNotRetry` list covers 400/401/403/404/410/422/451, so a rejected token, a missing repo and
 * a validation failure all surface immediately. Only transient 5xx and 408 are retried, and a
 * 403/429 carrying a limit signal is handled by the throttling plugin above instead.
 */
export function createPipenzoOctokit(
  token: string,
  options: {
    throttleObserver?: PipenzoThrottleObserver;
    /**
     * Where remaining-quota readings are recorded (issue #229). Optional, and shared rather than
     * owned, for the same reason `cache` is: `index.ts` builds a fresh authenticated client per
     * request, so a tracker a client constructed for itself would be discarded before its second
     * observation.
     */
    rateLimits?: GitHubRateLimitTracker;
  } = {},
): PipenzoOctokit {
  const octokit = new OctokitWithPagination({
    auth: token,
    userAgent: PIPENZO_USER_AGENT,
    throttle: pipenzoThrottleOptions(options.throttleObserver),
    log: redactingOctokitLog(),
  }) as PipenzoOctokit;
  const rateLimits = options.rateLimits;
  if (rateLimits) installRateLimitCapture(octokit, rateLimits);
  return octokit;
}

/**
 * Records remaining quota off every response this client receives (issue #229).
 *
 * ## Why a hook rather than a line in each method
 *
 * There are a dozen call sites in this file and `paginate` makes requests of its own that none of
 * them can see. A capture written per method would miss the paginated pages, and the next method
 * added would miss it entirely -- silently, because nothing fails when a reading is not taken. The
 * hook sits under all of it, including `paginate`'s internal requests, and costs no extra HTTP
 * request: these are headers on responses the client was making anyway.
 *
 * ## Why the error path is hooked too, and what that has to do with 304s
 *
 * `@octokit/request` *raises* a `304 Not Modified` rather than returning it, so a capture written
 * only into the success path would see nothing during exactly the traffic the conditional-request
 * layer (#161) produces -- a reconciler polling unchanged issues gets 304s and almost nothing else.
 * The reading on a 304 is recorded, and it is the reading that matters most: a 304 costs no quota,
 * so its headers report the *current* headroom for free, and refusing to record them would leave
 * the tracker's last reading ageing out (`latest` drops an expired snapshot) precisely while the
 * daemon was busiest.
 *
 * The same hook sees 403s and 429s, which is deliberate: an exhausted `remaining: 0` is a true
 * reading and the one a consumer most needs. The error is always rethrown -- this observes, it
 * never handles.
 */
function installRateLimitCapture(octokit: PipenzoOctokit, rateLimits: GitHubRateLimitTracker): void {
  octokit.hook.after('request', (response) => {
    rateLimits.record((response as { headers?: unknown }).headers);
  });
  octokit.hook.error('request', (error) => {
    rateLimits.record(responseHeadersOf(error));
    throw error;
  });
}

/**
 * Octokit's own logger, routed through `redactSecrets`.
 *
 * This module's stated rule is that redaction happens once, at `GitHubClientError` construction,
 * rather than at each call site that might forget — and `octokit.log` is the one path that escapes
 * it. Left unset, `@octokit/core` defaults `warn`/`error` straight to `console.warn`/`console.error`,
 * and `@octokit/plugin-throttling` calls exactly that (`octokit.log.warn("Error in
 * throttling-plugin limit handler", e)`) whenever a rate-limit handler throws — including the
 * degradation-surface observer this module invites callers to supply. That error object never
 * passes through `GitHubClientError`, so nothing else would scrub it.
 *
 * `debug` and `info` are dropped rather than redacted: they are per-request chatter with no
 * consumer here, and a log line that is never emitted cannot leak.
 */
function redactingOctokitLog(): {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
} {
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return redactSecrets(value);
    if (value instanceof Error) return redactSecrets(`${value.name}: ${value.message}`);
    try {
      return redactSecrets(JSON.stringify(value) ?? String(value));
    } catch {
      // A circular or unserializable argument: name its type rather than risk printing it raw.
      return `[unserializable ${typeof value}]`;
    }
  };
  return {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => console.warn(...args.map(scrub)),
    error: (...args: unknown[]) => console.error(...args.map(scrub)),
  };
}

/**
 * Whether a paginated response says there is another page.
 *
 * Reads GitHub's `Link` header rather than counting items: a full page is not the same thing as a
 * next page (GitHub omits `rel="next"` when the last page is exactly full), and guessing from the
 * item count is how a list silently loses its tail.
 */
function hasNextPage(headers: Record<string, unknown> | undefined): boolean {
  const link = headers?.link;
  return typeof link === 'string' && /;\s*rel="next"/.test(link);
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * The response headers carried by a thrown octokit error.
 *
 * A `304` is raised rather than returned, so this is the only way to read the headers of the one
 * response shape whose headers still matter — `Link` above all, which says whether a paginated
 * resource has grown a page since it was cached.
 */
function responseHeadersOf(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = (error as { response?: { headers?: unknown } }).response;
  const headers = response?.headers;
  return headers && typeof headers === 'object' ? (headers as Record<string, unknown>) : undefined;
}

function headerOf(error: unknown, name: string): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = (error as { response?: { headers?: Record<string, unknown> } }).response;
  const value = response?.headers?.[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Maps an octokit/network failure onto the closed error union.
 *
 * A 403 carrying an exhausted `x-ratelimit-remaining` is GitHub's primary-limit response and a
 * 429 is its secondary-limit one; both are `rate_limited` rather than `forbidden`, because the
 * caller's correct reaction (back off, widen the poll interval — README's rate-limit row) is
 * completely different from the reaction to a real permission failure.
 */
export function toGitHubClientError(error: unknown, operation: string): GitHubClientError {
  if (error instanceof GitHubClientError) return error;
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const remaining = headerOf(error, 'x-ratelimit-remaining');
  const resetSeconds = Number(headerOf(error, 'x-ratelimit-reset'));
  const retryAfterSeconds = Number(headerOf(error, 'retry-after'));
  const retryAfterMs = Number.isFinite(retryAfterSeconds)
    ? Date.now() + retryAfterSeconds * 1000
    : Number.isFinite(resetSeconds) && resetSeconds > 0
      ? resetSeconds * 1000
      : undefined;

  if (status === 429 || (status === 403 && remaining === '0')) {
    return new GitHubClientError('rate_limited', `${operation}: GitHub rate limit reached`, {
      status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (status === 401) {
    return new GitHubClientError('unauthorized', `${operation}: GitHub rejected the token`, {
      status,
    });
  }
  if (status === 403) {
    return new GitHubClientError('forbidden', `${operation}: ${message}`, { status });
  }
  if (status === 404) {
    return new GitHubClientError('not_found', `${operation}: ${message}`, { status });
  }
  if (status === 422 || status === 400) {
    return new GitHubClientError('invalid_request', `${operation}: ${message}`, { status });
  }
  if (status !== undefined) {
    return new GitHubClientError('network', `${operation}: ${message}`, { status });
  }
  return new GitHubClientError('network', `${operation}: ${message}`);
}

/**
 * One repository row, or `undefined` for one Pipenzo could never manage.
 *
 * Returning `undefined` rather than throwing for a repository without push access is the point:
 * one unusable entry in a five-thousand-row listing must not fail the whole picker. A *malformed*
 * entry still throws, because that means GitHub's shape changed and guessing would be worse.
 */
function normalizeRepository(
  raw: Record<string, unknown>,
  operation: string,
): GitHubRepository | undefined {
  const permissions = raw.permissions as Record<string, unknown> | undefined;
  // Absent permissions is treated as "no push access", not as "assume yes". GitHub omits the block
  // for some listing shapes, and the safe reading of a missing capability is that it is missing.
  if (permissions?.push !== true) return undefined;
  const fullName = requireString(raw.full_name, 'full_name', operation);
  const language = typeof raw.language === 'string' && raw.language.length > 0 ? raw.language : undefined;
  const pushedAt = typeof raw.pushed_at === 'string' && raw.pushed_at.length > 0 ? raw.pushed_at : undefined;
  return {
    fullName,
    archived: raw.archived === true,
    defaultBranch: requireString(raw.default_branch, 'default_branch', operation),
    ...(language ? { language } : {}),
    // GitHub's `open_issues_count` includes pull requests. Named `openIssues` on the wire with that
    // stated, rather than silently presented as an issue count it is not.
    openIssues: Math.max(0, Math.trunc(requireNumber(raw.open_issues_count, 'open_issues_count', operation))),
    ...(pushedAt ? { pushedAt } : {}),
  };
}

function requireString(value: unknown, field: string, operation: string): string {
  if (typeof value !== 'string') {
    throw new GitHubClientError('invalid_response', `${operation}: ${field} was not a string`);
  }
  return value;
}

function requireNumber(value: unknown, field: string, operation: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GitHubClientError('invalid_response', `${operation}: ${field} was not a number`);
  }
  return value;
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string'
          ? (entry as { name: string }).name
          : undefined,
    )
    .filter((name): name is string => name !== undefined);
}

function loginNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      entry && typeof entry === 'object' && typeof (entry as { login?: unknown }).login === 'string'
        ? (entry as { login: string }).login
        : undefined,
    )
    .filter((login): login is string => login !== undefined);
}

function normalizeCheckStatus(value: unknown): GitHubCheckRun['status'] {
  return value === 'queued' || value === 'in_progress' || value === 'completed' ? value : 'unknown';
}

const CHECK_CONCLUSIONS: readonly GitHubCheckConclusion[] = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
  'skipped',
];

function normalizeCheckConclusion(value: unknown): GitHubCheckConclusion | undefined {
  if (value === null || value === undefined) return undefined;
  return CHECK_CONCLUSIONS.includes(value as GitHubCheckConclusion)
    ? (value as GitHubCheckConclusion)
    : 'unknown';
}

/** What `#conditional` needs from an octokit response; narrower than octokit's own generics. */
interface ConditionalResponse {
  readonly data: unknown;
  readonly headers?: Record<string, unknown> | undefined;
}

export interface OctokitGitHubClientOptions {
  /**
   * The per-`(repo, resource)` ETag store (issue #161). Optional, and shared rather than owned:
   * `index.ts` builds one authenticated client *per request* from a token read at call time (that
   * is the token-boundary rule), so a cache the client constructed for itself would be discarded
   * before it ever served a validator. Omitting it turns conditional requests off entirely, which
   * is what the unit tests that assert unconditional behaviour want.
   */
  readonly cache?: ConditionalRequestCache;
  /**
   * Where remaining-quota readings are recorded and read back (issue #229). Shared for the same
   * reason `cache` is, and omitting it turns capture off entirely -- which is what the unit tests
   * asserting request behaviour without a tracker want.
   *
   * Only `fromToken` can wire this to the transport, because that is the factory that builds the
   * octokit instance the hook is installed on. `withOctokit` accepts a tracker so a caller that
   * built its own instance through `createPipenzoOctokit` can hand back the same one; it cannot
   * install the hook for you, and a tracker passed there without that wiring will simply never be
   * fed.
   */
  readonly rateLimits?: GitHubRateLimitTracker;
}

/** The one real implementation. Everything network-facing in Pipenzo's GitHub surface is here. */
export class OctokitGitHubClient implements GitHubClient {
  readonly #octokit: PipenzoOctokit;
  readonly #cache: ConditionalRequestCache | undefined;
  readonly #rateLimits: GitHubRateLimitTracker | undefined;

  private constructor(
    octokit: PipenzoOctokit,
    cache: ConditionalRequestCache | undefined,
    rateLimits: GitHubRateLimitTracker | undefined,
  ) {
    this.#octokit = octokit;
    this.#cache = cache;
    this.#rateLimits = rateLimits;
  }

  /** Issue #229. Reads the shared tracker; never a request. */
  rateLimit(
    resource: string = GITHUB_CORE_RATE_LIMIT_RESOURCE,
  ): GitHubRateLimitSnapshot | undefined {
    return this.#rateLimits?.latest(resource);
  }

  /** Issue #229. A no-op subscription when this client was built without a tracker. */
  subscribeRateLimit(listener: (snapshot: GitHubRateLimitSnapshot) => void): () => void {
    return this.#rateLimits?.subscribe(listener) ?? ((): void => {});
  }

  /**
   * Builds the client from a token the caller already resolved. The only credential-bearing
   * factory this class has.
   *
   * There used to be a `fromEnvironment` beside it that did its own `process.env` read. Issue #165
   * removed its last caller — `index.ts` resolves through `DaemonGitHubCredential`, which prefers
   * the credential Electron main wrote to stdin and falls back to the environment itself — and it
   * is deleted rather than left exported, which is what this module's original comment promised:
   * *"this read path is deleted, not kept as a fallback."* An exported, untested, zero-caller
   * factory that reads a PAT out of `process.env` is precisely the thing a later edit picks up by
   * name and quietly reintroduces the env read with. The environment path itself is not lost; it
   * lives in `resolveGitHubToken`, which is exported and directly tested.
   *
   * It takes a `cache` option because this is the factory the shipped daemon actually calls, so a
   * version of it that could not be handed the shared `ConditionalRequestCache` would leave issue
   * #161's conditional-request layer switched off everywhere except the tests that construct a
   * client directly — present in the source, absent from the running app, and invisible to
   * anything but a rate-limit graph.
   */
  static fromToken(
    token: string,
    options: OctokitGitHubClientOptions = {},
  ): OctokitGitHubClient {
    return new OctokitGitHubClient(
      createPipenzoOctokit(token, { rateLimits: options.rateLimits }),
      options.cache,
      options.rateLimits,
    );
  }

  /** Injection seam for tests and for a caller that already holds a configured octokit. */
  static withOctokit(
    octokit: PipenzoOctokit,
    options: OctokitGitHubClientOptions = {},
  ): OctokitGitHubClient {
    return new OctokitGitHubClient(octokit, options.cache, options.rateLimits);
  }

  /**
   * One conditional GET: send the stored validator, serve the stored body on a `304`.
   *
   * `@octokit/request` raises a `304` as a `RequestError` rather than returning it, which is why the
   * cache hit is handled in the `catch`. That is not a workaround — it is the reason this has to be
   * one shared helper: a call site that forgot the 304 branch would turn every unchanged poll into
   * a thrown `network` error, and the failure would only appear the *second* time a resource was
   * read, which is the worst possible shape for a bug to have.
   *
   * `normalize` runs outside the `try` on purpose. It raises `invalid_response` for a body GitHub
   * answered 200 with but that does not have the fields this client requires, and that must not be
   * rewritten into a `network` error by the transport's own error mapper. It receives the whole
   * response rather than just the body, and may return `undefined` to mean **this response is not
   * one this resource may cache** — see `listLabels`, where a paginated first page is only storable
   * when it is also the last page.
   *
   * Two things make a `304` insufficient on its own, and both are checked before the stored body is
   * served:
   *
   * - **The entry may have been invalidated while this request was in flight.** The cache is shared
   *   between the reconciler and request-scoped clients, so a write can land mid-read; GitHub's
   *   eventually-consistent replicas can then answer the pre-write validator with a `304`, and
   *   returning the pre-write body would not self-heal — every later poll would get the same
   *   agreeing `304`. Comparing the cache's generation across the await turns that into a miss.
   * - **A `304` carries headers too**, and for a paginated resource they can say the list has grown
   *   a second page. `acceptNotModified` is where a caller inspects them; see `listLabels`.
   *
   * Either check failing costs one unconditional re-read, which is why the loop runs at most twice:
   * the second pass sends no validator, so it cannot produce another `304`.
   */
  async #conditional<T>(
    ref: RepoRef,
    resource: string,
    operation: string,
    send: (headers: Record<string, string>) => Promise<ConditionalResponse>,
    normalize: (response: ConditionalResponse, etag: string | undefined) => T | undefined,
    acceptNotModified?: (headers: Record<string, unknown> | undefined) => boolean,
  ): Promise<T | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cached = attempt === 0 ? this.#cache?.get<T>(ref, resource) : undefined;
      const generation = this.#cache?.generation;
      let response: ConditionalResponse;
      try {
        response = await send(cached ? { 'if-none-match': cached.etag } : {});
      } catch (error) {
        if (cached !== undefined && statusOf(error) === 304) {
          const headers = responseHeadersOf(error);
          if (
            this.#cache?.generation === generation &&
            (acceptNotModified?.(headers) ?? true)
          ) {
            this.#cache?.noteNotModified();
            return cached.value;
          }
          this.#cache?.invalidate(ref, resource);
          continue;
        }
        throw toGitHubClientError(error, operation);
      }
      const rawEtag = response.headers?.etag;
      const etag = typeof rawEtag === 'string' ? rawEtag : undefined;
      const value = normalize(response, etag);
      if (etag !== undefined && value !== undefined) {
        this.#cache?.set(ref, resource, etag, value);
      } else {
        // No validator, or a response this resource may not cache. Anything already stored describes
        // a state that no longer holds, so it is dropped rather than replayed later.
        this.#cache?.invalidate(ref, resource);
      }
      return value;
    }
    /* c8 ignore next 4 -- the second pass sends no validator, so it cannot loop again. */
    throw new GitHubClientError(
      'network',
      `${operation}: a conditional read did not settle`,
    );
  }

  async getIssue(ref: RepoRef, issueNumber: number): Promise<GitHubIssue> {
    const operation = `getIssue ${ref.owner}/${ref.repo}#${issueNumber}`;
    assertPositiveInteger(issueNumber, 'issue number', operation);
    const issue = await this.#conditional<GitHubIssue>(
      ref,
      `issue:${issueNumber}`,
      operation,
      (headers) =>
        this.#octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
          owner: ref.owner,
          repo: ref.repo,
          issue_number: issueNumber,
          headers,
        }),
      (response, etag) => {
        const data = response.data as Record<string, unknown>;
        if (data.pull_request !== undefined) {
          throw new GitHubClientError('not_found', `${operation}: reference is a pull request`);
        }
        return normalizeIssue(ref, data, etag, operation);
      },
    );
    // Unreachable: this resource's `normalize` either returns an issue or throws. The check is here
    // so that a future edit which starts returning `undefined` fails loudly instead of handing the
    // phase machine an issue-shaped hole.
    if (issue === undefined) {
      throw new GitHubClientError('invalid_response', `${operation}: no issue in the response`);
    }
    return issue;
  }

  /**
   * Adds an assignee and returns the issue *as GitHub answered the write*.
   *
   * The response body of `POST /assignees` is the updated issue, so the caller gets the
   * post-write assignee list from the same round trip. That is deliberately **not** the claim
   * decision: README's rule is assign, then re-read uncached, and the re-read is a separate
   * `getIssue()` the caller makes — a write's own echo cannot see a concurrent assignment that
   * landed a millisecond later, which is the exact race the claim rule exists for.
   *
   * `Cache-Control: no-cache` is set on the request so no intermediary can answer a subsequent
   * read from a copy of this one.
   */
  async assignIssue(ref: RepoRef, issueNumber: number, assignee: string): Promise<GitHubIssue> {
    const operation = `assignIssue ${ref.owner}/${ref.repo}#${issueNumber}`;
    assertPositiveInteger(issueNumber, 'issue number', operation);
    assertLogin(assignee, operation);
    let response;
    try {
      response = await this.#octokit.request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/assignees',
        {
          owner: ref.owner,
          repo: ref.repo,
          issue_number: issueNumber,
          assignees: [assignee],
          headers: { 'cache-control': 'no-cache' },
        },
      );
    } catch (error) {
      throw toGitHubClientError(error, operation);
    } finally {
      // `finally`, not the success path: a write that timed out may still have landed, and a
      // conditional read afterwards must not be answered from a body recorded before it.
      this.#cache?.invalidate(ref, `issue:${issueNumber}`);
    }
    const data = response.data as Record<string, unknown>;
    if (data.pull_request !== undefined) {
      throw new GitHubClientError('not_found', `${operation}: reference is a pull request`);
    }
    return normalizeIssue(ref, data, undefined, operation);
  }

  /**
   * Creates an issue.
   *
   * Note what this is not allowed to become: GitHub's issue-create endpoint also accepts
   * `assignees` and `milestone`, and neither is plumbed through. Creating a ticket and claiming it
   * are two separate operator actions with two separate audit trails, and collapsing them into one
   * request would mean a drafted issue could arrive already owned by whoever's PAT the daemon
   * happens to hold.
   */
  async getAuthenticatedLogin(): Promise<string> {
    const operation = 'getAuthenticatedLogin';
    let response;
    try {
      response = await this.#octokit.request('GET /user');
    } catch (error) {
      throw toGitHubClientError(error, operation);
    }
    const login = requireString((response.data as Record<string, unknown>).login, 'login', operation);
    assertLogin(login, operation);
    return login;
  }

  /**
   * Walks `GET /user/repos` and normalizes what comes back.
   *
   * `affiliation` is pinned to the three memberships that can carry write access, which is both a
   * correctness and a cost decision: without it GitHub's default includes every organisation
   * repository the account can merely see, which on a large org is thousands of rows the picker
   * would list and Pipenzo could never manage. `permissions.push` is then checked per repository,
   * because affiliation says how you are related to a repository, not what you may do to it.
   *
   * Uncached, unlike `listLabels`. This is a first-run and a settings action, not a hot path, and a
   * conditional-request cache keyed on a listing that changes whenever the user's org memberships
   * change would answer `304` for a repository they were granted access to an hour ago.
   */
  async listAccessibleRepositories(): Promise<{
    readonly repositories: readonly GitHubRepository[];
    readonly truncated: boolean;
  }> {
    const operation = 'listAccessibleRepositories';
    const collected: GitHubRepository[] = [];
    let truncated = false;
    try {
      // `iterator`, not `paginate`: the cap has to be enforced *while* walking. `paginate` would
      // fetch every page first and let this method notice the size afterwards, which is the one
      // thing the cap exists to prevent.
      let pages = 0;
      for await (const response of this.#octokit.paginate.iterator('GET /user/repos', {
        per_page: 100,
        affiliation: 'owner,collaborator,organization_member',
        sort: 'pushed',
        direction: 'desc',
      })) {
        // Checked *before* this page is counted, not after the previous one. Breaking as soon as
        // the cap is reached would report `truncated` for an account with exactly
        // `GITHUB_REPO_PAGE_CAP` pages and nothing beyond them — telling the user their list is
        // incomplete when it is complete, which is the one thing this flag exists to prevent.
        // Arriving here at all means the iterator produced a further page, so there really is more.
        if (pages >= GITHUB_REPO_PAGE_CAP) {
          truncated = true;
          break;
        }
        pages += 1;
        if (!Array.isArray(response.data)) {
          throw new GitHubClientError(
            'invalid_response',
            `${operation}: repositories was not an array`,
          );
        }
        for (const entry of response.data) {
          const repository = normalizeRepository(entry as Record<string, unknown>, operation);
          if (repository) collected.push(repository);
        }
      }
    } catch (error) {
      if (error instanceof GitHubClientError) throw error;
      throw toGitHubClientError(error, operation);
    }
    return { repositories: collected, truncated };
  }

  async createIssue(ref: RepoRef, input: GitHubIssueDraft): Promise<GitHubIssue> {
    const operation = `createIssue ${ref.owner}/${ref.repo}`;
    assertIssueDraft(input, operation);
    let response;
    try {
      response = await this.#octokit.request('POST /repos/{owner}/{repo}/issues', {
        owner: ref.owner,
        repo: ref.repo,
        title: input.title,
        body: input.body,
        ...(input.labels && input.labels.length > 0 ? { labels: [...input.labels] } : {}),
      });
    } catch (error) {
      throw toGitHubClientError(error, operation);
    } finally {
      // Creating an issue *with labels* can create the labels: GitHub's issue-create endpoint adds
      // any name that does not exist yet (for a caller with push access, which the daemon always
      // has). So this is a write to the repository label list as well as to the issue, and leaving
      // the cached list in place would let a subsequent `listLabels` miss a label Pipenzo itself
      // just caused to exist.
      if (input.labels && input.labels.length > 0) this.#cache?.invalidate(ref, 'labels');
    }
    return normalizeIssue(ref, response.data as Record<string, unknown>, undefined, operation);
  }

  /**
   * Posts one comment (issue #228).
   *
   * ## Why there is no pull-request guard, unlike `getIssue` and `assignIssue`
   *
   * Both of those refuse a number that turns out to be a PR, because both read or write the
   * *issue* GitHub would hand back and a PR is not one. This one deliberately does not, and the
   * divergence is a decision rather than an oversight: GitHub's comment endpoint genuinely accepts
   * a PR number and posts to the PR's conversation, and the only way to know beforehand is an extra
   * `GET` on every comment — a read on the hot path to forbid something the operator asked for by
   * number. Commenting on a PR is a legitimate thing to do with this route, and the route itself is
   * human-gated and agent-unreachable, so the guard would buy nothing the boundary does not.
   *
   * ## Why this invalidates the cached issue
   *
   * A comment is not a field of `GitHubIssue`, so nothing this write produces is stored in the
   * conditional cache. What it *does* change is the issue's `updated_at`, which is on
   * `GitHubIssue` and therefore in any cached body — GitHub bumps an issue's timestamp when a
   * comment lands on it. So the same rule the other writes here state applies unchanged: a write
   * that timed out may still have landed, and a conditional read afterwards must not be answered
   * from a body recorded before it.
   *
   * What the invalidation costs, written down so a later edit neither "optimises" it away nor
   * believes it is free:
   *
   * - **For this issue, it is very likely free.** A comment bumps `updated_at`, so we expect the
   *   next conditional read of `issue:<n>` to be answered `200` anyway; dropping the entry mostly
   *   stops the client sending a validator that could not have matched. "Very likely", not
   *   "certainly" — GitHub's caching layer is eventually consistent and a post-write `304` from a
   *   replica is a real, observed behaviour, which is the reason `invalidateRepo` exists at all.
   * - **It is not free globally.** `ConditionalRequestCache` keeps one `#generation` counter per
   *   cache instance rather than one per key, and `invalidate()` bumps it — and `index.ts` shares
   *   a single instance between the phase machine's reconciler and the phase service's
   *   request-scoped clients, so in the shipped daemon that counter is process-wide. `#conditional` captures the counter
   *   before its await and refuses a `304` whose generation no longer matches, so a comment landing
   *   while the reconciler has N conditional reads in flight on *other* resources turns each of
   *   those free `304`s into a paid `200` and evicts N warm entries.
   *
   * That is conservative and correct — a write that may have landed must not be read around — and
   * it is the price of a shared cache. Making it per-key (a `Map<string, number>` compared in
   * `#conditional`) is the durable fix and belongs in its own ticket, not here.
   */
  async createIssueComment(
    ref: RepoRef,
    issueNumber: number,
    body: string,
  ): Promise<GitHubIssueComment> {
    const operation = `createIssueComment ${ref.owner}/${ref.repo}#${issueNumber}`;
    assertPositiveInteger(issueNumber, 'issue number', operation);
    assertCommentBody(body, operation);
    let response;
    try {
      response = await this.#octokit.request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        {
          owner: ref.owner,
          repo: ref.repo,
          issue_number: issueNumber,
          body,
          // Same as the sibling writes: no intermediary may answer a later read from a copy of this.
          headers: { 'cache-control': 'no-cache' },
        },
      );
    } catch (error) {
      throw toGitHubClientError(error, operation);
    } finally {
      this.#cache?.invalidate(ref, `issue:${issueNumber}`);
    }
    return normalizeIssueComment(response.data as Record<string, unknown>, operation);
  }

  /**
   * Every label on a repository.
   *
   * ## Why a paginated read gets a *conditional first page* rather than a conditional list
   *
   * An ETag validates one response, and one response is one page. A cache keyed on "the label list"
   * but validated by page one's ETag would answer `304` — and serve a stale list — whenever a
   * change landed on page two only. So the fast path is taken **only when the whole list fits in
   * one page**: page one is requested with `If-None-Match`, and its ETag is stored only if the
   * response carries no `rel="next"` link.
   *
   * That rule is sound rather than merely lucky. Reaching a second page requires the list to grow
   * past 100, and growing past 100 necessarily changes page one's contents (an insert shifts it, an
   * append fills the last free slot), which changes page one's ETag, which produces a `200` and a
   * re-evaluation of the single-page test. There is no path from "cached as single-page" to "silently
   * multi-page".
   *
   * When the list really is multi-page the first request is spent for nothing and the read falls
   * through to `paginate`. That costs one extra point on a call that is already spending several,
   * on a repository shape Pipenzo does not otherwise optimise for — the right side of the trade for
   * a hot path (`getIssue`) that is *always* single-response.
   */
  async listLabels(ref: RepoRef): Promise<readonly GitHubLabel[]> {
    const operation = `listLabels ${ref.owner}/${ref.repo}`;
    if (this.#cache !== undefined) {
      const singlePage = await this.#conditional<readonly GitHubLabel[]>(
        ref,
        'labels',
        operation,
        (headers) =>
          this.#octokit.request('GET /repos/{owner}/{repo}/labels', {
            owner: ref.owner,
            repo: ref.repo,
            per_page: 100,
            headers,
          }),
        (response) => {
          if (hasNextPage(response.headers)) return undefined;
          if (!Array.isArray(response.data)) {
            throw new GitHubClientError('invalid_response', `${operation}: labels was not an array`);
          }
          return response.data.map((label) =>
            normalizeLabel(label as Record<string, unknown>, operation),
          );
        },
        // The same test on the `304` path, where `normalize` never runs. GitHub sends `Link` on a
        // 304 too, so a list that has grown a second page since it was cached says so here — and
        // this is what makes the fast path safe without depending on GitHub's (undocumented) label
        // ordering to guarantee that growth always disturbs page one.
        (headers) => !hasNextPage(headers),
      );
      if (singlePage !== undefined) return singlePage;
    }
    try {
      const labels = await this.#octokit.paginate('GET /repos/{owner}/{repo}/labels', {
        owner: ref.owner,
        repo: ref.repo,
        per_page: 100,
      });
      return labels.map((label) => normalizeLabel(label as Record<string, unknown>, operation));
    } catch (error) {
      throw toGitHubClientError(error, operation);
    }
  }

  /**
   * Creates a label, treating "already exists" as success.
   *
   * GitHub answers a duplicate name with a 422, and Pipenzo's label set is written on first
   * contact with any repo — so a 422 here means "another Pipenzo instance, or an earlier run,
   * already created it," which is the desired end state, not a failure. Note this never
   * *renames*: README's schema-versioning rule requires renames go through the rename endpoint so
   * existing issue associations survive, and that belongs to the version-bump path, not here.
   */
  async createLabel(ref: RepoRef, label: GitHubLabel): Promise<GitHubLabel> {
    const operation = `createLabel ${ref.owner}/${ref.repo}:${label.name}`;
    assertLabel(label, operation);
    try {
      const response = await this.#octokit.request('POST /repos/{owner}/{repo}/labels', {
        owner: ref.owner,
        repo: ref.repo,
        name: label.name,
        color: label.color,
        description: label.description,
      });
      return normalizeLabel(response.data as Record<string, unknown>, operation);
    } catch (error) {
      const mapped = toGitHubClientError(error, operation);
      if (mapped.code !== 'invalid_request') throw mapped;
      try {
        const existing = await this.#octokit.request('GET /repos/{owner}/{repo}/labels/{name}', {
          owner: ref.owner,
          repo: ref.repo,
          name: label.name,
        });
        return normalizeLabel(existing.data as Record<string, unknown>, operation);
      } catch (lookupError) {
        void lookupError;
        throw mapped;
      }
    } finally {
      // The repository label list this may have just changed. Invalidated whatever the outcome, for
      // the same reason `assignIssue` does: a failed write is not proof of an unchanged resource.
      this.#cache?.invalidate(ref, 'labels');
    }
  }

  /**
   * Replaces this issue's `pipenzo:` labels, preserving every label outside that namespace.
   *
   * GitHub's `PUT .../labels` replaces the issue's entire label set, which is the semantics a lane
   * transition wants for the namespace and exactly the wrong semantics for everything else. So the
   * current labels are read first and the foreign ones are carried into the write.
   *
   * **The read-modify-write race is real and is accepted here.** A label a human adds between the
   * GET and the PUT is lost. The alternative — `POST` the additions and `DELETE` the removals
   * individually — is race-free but not atomic, so a lane transition could be observed with two
   * lane labels at once or none, and the lane is the state the board renders from. A briefly wrong
   * lane is a worse failure than a rarely dropped triage label, so this takes the atomic write and
   * narrows the window instead: one GET immediately before one PUT, no work in between.
   *
   * Callers that only need a label gone should use `removeIssueLabel`, which is a single request
   * and has no window at all.
   */
  async setIssueLabels(
    ref: RepoRef,
    issueNumber: number,
    labels: readonly string[],
  ): Promise<readonly string[]> {
    const operation = `setIssueLabels ${ref.owner}/${ref.repo}#${issueNumber}`;
    assertPositiveInteger(issueNumber, 'issue number', operation);
    for (const name of labels) assertLabelName(name, operation);
    // The machine may only write its own namespace. A caller asking for anything else is a bug in
    // the caller, and refusing here is what keeps "Pipenzo owns one namespace" true by
    // construction rather than by everyone remembering.
    for (const name of labels) {
      if (!isPipenzoLabel(name)) {
        throw new GitHubClientError(
          'invalid_request',
          `${operation}: ${name} is outside the ${PIPENZO_LABEL_NAMESPACE} namespace`,
        );
      }
    }
    try {
      // Paginated, like `listLabels`, and for a sharper reason than completeness: the PUT below
      // replaces the issue's *entire* label set, so a foreign label this read failed to see is a
      // foreign label the write deletes. A single 100-item page would turn "preserve what a human
      // put here" into "preserve the first hundred of it".
      const current = await this.#octokit.paginate(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/labels',
        { owner: ref.owner, repo: ref.repo, issue_number: issueNumber, per_page: 100 },
      );
      const foreign = labelNames(current).filter((name) => !isPipenzoLabel(name));
      // A caller that repeats a name, or a foreign label that somehow starts with the namespace,
      // must not produce a duplicate entry in the write.
      const desired = [...new Set([...foreign, ...labels])];
      const response = await this.#octokit.request(
        'PUT /repos/{owner}/{repo}/issues/{issue_number}/labels',
        {
          owner: ref.owner,
          repo: ref.repo,
          issue_number: issueNumber,
          labels: desired,
          headers: { 'cache-control': 'no-cache' },
        },
      );
      return labelNames(response.data);
    } catch (error) {
      throw toGitHubClientError(error, operation);
    } finally {
      this.#cache?.invalidate(ref, `issue:${issueNumber}`);
    }
  }

  /**
   * Removes one label from one issue. A label that was not on the issue is success, not a failure.
   *
   * GitHub answers both "that label is not on this issue" and "there is no such issue" with a 404,
   * so treating 404 as success also swallows a wrong issue number. That is the documented trade:
   * the phase machine re-applies transitions on recovery and must be able to remove a label twice
   * without failing, and it learns about a bad issue number from the `getIssue` it does anyway.
   *
   * Returns nothing on purpose. The 404 path cannot know the resulting label set, and inventing one
   * would be worse than making the caller re-read when it actually needs it.
   */
  async removeIssueLabel(ref: RepoRef, issueNumber: number, name: string): Promise<void> {
    const operation = `removeIssueLabel ${ref.owner}/${ref.repo}#${issueNumber}:${name}`;
    assertPositiveInteger(issueNumber, 'issue number', operation);
    assertLabelName(name, operation);
    if (!isPipenzoLabel(name)) {
      throw new GitHubClientError(
        'invalid_request',
        `${operation}: ${name} is outside the ${PIPENZO_LABEL_NAMESPACE} namespace`,
      );
    }
    try {
      await this.#octokit.request(
        'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}',
        { owner: ref.owner, repo: ref.repo, issue_number: issueNumber, name },
      );
    } catch (error) {
      const mapped = toGitHubClientError(error, operation);
      if (mapped.code === 'not_found') return;
      throw mapped;
    } finally {
      this.#cache?.invalidate(ref, `issue:${issueNumber}`);
    }
  }

  async getPullRequestDiff(ref: RepoRef, pullNumber: number): Promise<GitHubPullRequestDiff> {
    const operation = `getPullRequestDiff ${ref.owner}/${ref.repo}#${pullNumber}`;
    assertPositiveInteger(pullNumber, 'pull request number', operation);
    try {
      const metadata = await this.#octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: ref.owner,
        repo: ref.repo,
        pull_number: pullNumber,
      });
      const diff = await this.#octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: ref.owner,
        repo: ref.repo,
        pull_number: pullNumber,
        mediaType: { format: 'diff' },
      });
      const data = metadata.data as Record<string, unknown>;
      const base = data.base as Record<string, unknown> | undefined;
      const head = data.head as Record<string, unknown> | undefined;
      return {
        number: requireNumber(data.number, 'number', operation),
        baseRef: requireString(base?.ref, 'base.ref', operation),
        headRef: requireString(head?.ref, 'head.ref', operation),
        headSha: requireString(head?.sha, 'head.sha', operation),
        diff: typeof diff.data === 'string' ? diff.data : '',
        changedFiles: requireNumber(data.changed_files, 'changed_files', operation),
        additions: requireNumber(data.additions, 'additions', operation),
        deletions: requireNumber(data.deletions, 'deletions', operation),
      };
    } catch (error) {
      throw toGitHubClientError(error, operation);
    }
  }

  async listPullRequestChecks(
    ref: RepoRef,
    pullNumber: number,
  ): Promise<readonly GitHubCheckRun[]> {
    const operation = `listPullRequestChecks ${ref.owner}/${ref.repo}#${pullNumber}`;
    assertPositiveInteger(pullNumber, 'pull request number', operation);
    try {
      const metadata = await this.#octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: ref.owner,
        repo: ref.repo,
        pull_number: pullNumber,
      });
      const head = (metadata.data as Record<string, unknown>).head as
        | Record<string, unknown>
        | undefined;
      const headSha = requireString(head?.sha, 'head.sha', operation);
      const runs = await this.#octokit.paginate('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
        owner: ref.owner,
        repo: ref.repo,
        ref: headSha,
        per_page: 100,
      });
      return runs.map((entry) => {
        const run = entry as Record<string, unknown>;
        return {
          name: typeof run.name === 'string' ? run.name : 'unknown',
          status: normalizeCheckStatus(run.status),
          conclusion: normalizeCheckConclusion(run.conclusion),
          detailsUrl: typeof run.details_url === 'string' ? run.details_url : undefined,
        };
      });
    } catch (error) {
      throw toGitHubClientError(error, operation);
    }
  }
}

function assertPositiveInteger(value: number, field: string, operation: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubClientError('invalid_request', `${operation}: ${field} must be a positive integer`);
  }
}

/** GitHub's own login rules: alphanumeric with single hyphens, at most 39 characters. */
function assertLogin(login: string, operation: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) {
    throw new GitHubClientError('invalid_request', `${operation}: not a usable GitHub login`);
  }
}

/**
 * Aligned with `assertCommentBody` (issue #232): both now call a shared prose-body predicate from
 * `@agent-dock/shared` rather than each carrying its own length/control-character check. Before
 * #232 this compared `input.body.length` (UTF-16 units) against 65,536 with no control-character
 * rule at all -- the same divergence from the comment body's rule that #232 found on the wire
 * schema, duplicated here on the client's own floor.
 */
function assertIssueDraft(input: GitHubIssueDraft, operation: string): void {
  const title = input.title.trim();
  if (!title || title.length > 256) {
    throw new GitHubClientError(
      'invalid_request',
      `${operation}: an issue title must be 1-256 characters`,
    );
  }
  switch (issueCreateBodyProblem(input.body)) {
    case 'blank':
      // Unreachable today: `issueCreateBodyProblem` allows a blank body, matching #84's shipped
      // route. The case stays so a future tightening of `allowBlank` fails a type check here
      // instead of falling through to `default`.
      throw new GitHubClientError('invalid_request', `${operation}: issue body must not be blank`);
    case 'too_long':
      throw new GitHubClientError('invalid_request', `${operation}: issue body is too long`);
    case 'control_characters':
      throw new GitHubClientError(
        'invalid_request',
        `${operation}: issue body must not contain control characters`,
      );
    default:
      break;
  }
  for (const label of input.labels ?? []) assertLabelName(label, operation);
}

/**
 * One comment-body rule, called by both the real client and the fake (issue #228).
 *
 * Exported for exactly one reason: `FakeGitHubClient.createIssueComment` calls this, rather than
 * re-implementing the checks. #100's refusal panel and #144's blown-estimate record are both tested
 * against the fake, and a fake that re-derived the rule would let a later edit here leave those
 * tests green against a client that would refuse the identical call.
 *
 * The rule itself lives on the wire contract (`issueCommentBodyProblem` in `@agent-dock/shared`),
 * not here, so that the HTTP route and this client cannot drift apart. What this function adds is
 * the client's error type and the operation name in the message.
 *
 * This is also the *floor*, not a duplicate of the route's check: a daemon-side caller reaching
 * `PipenzoPhaseService.commentOnIssue` or this method directly never passes through the route's
 * `safeParse`, and both #100 and #144 are that shape.
 */
export function assertCommentBody(body: string, operation: string): void {
  switch (issueCommentBodyProblem(body)) {
    case 'blank':
      throw new GitHubClientError(
        'invalid_request',
        `${operation}: a comment body cannot be empty`,
      );
    case 'too_long':
      throw new GitHubClientError(
        'invalid_request',
        `${operation}: a comment body must be at most ${MAX_ISSUE_COMMENT_CHARS} characters`,
      );
    case 'control_characters':
      throw new GitHubClientError(
        'invalid_request',
        `${operation}: a comment body must not contain control characters`,
      );
    default:
      return;
  }
}

function normalizeIssueComment(
  data: Record<string, unknown>,
  operation: string,
): GitHubIssueComment {
  return {
    id: requireNumber(data.id, 'id', operation),
    // Deliberately tolerant, and the only field here that is. `requireString` throws, and this
    // function runs *after* the POST returned 201 — the comment is already public by then, so a
    // throw would report a landed write as `github_failed`/502 and invite a retry that posts a
    // duplicate. That cost buys nothing: nothing reads this field on the real path.
    // `commentOnIssue` returns only the id, the permalink and the timestamp, and
    // `pipenzoIssueCommentResultV1Schema` deliberately does not echo the body at all. The three
    // fields that *are* consumed use `requireString`, because for those a missing value really is
    // a response this client cannot work with.
    body: typeof data.body === 'string' ? data.body : '',
    htmlUrl: requireString(data.html_url, 'html_url', operation),
    createdAt: requireString(data.created_at, 'created_at', operation),
  };
}

function normalizeIssue(
  ref: RepoRef,
  data: Record<string, unknown>,
  etag: string | undefined,
  operation: string,
): GitHubIssue {
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: requireNumber(data.number, 'number', operation),
    title: requireString(data.title, 'title', operation),
    body: typeof data.body === 'string' ? data.body : '',
    state: data.state === 'closed' ? 'closed' : 'open',
    labels: labelNames(data.labels),
    assignees: loginNames(data.assignees),
    htmlUrl: requireString(data.html_url, 'html_url', operation),
    updatedAt: requireString(data.updated_at, 'updated_at', operation),
    etag,
  };
}

/**
 * One label-name rule, shared by every path that sends a name to GitHub.
 *
 * A comma is excluded because GitHub's own `DELETE .../labels/{name}` takes the name in the path
 * and treats a comma as a separator, so a name containing one is not addressable for removal — a
 * label the machine could add and then never take off again.
 */
function assertLabelName(name: string, operation: string): void {
  if (!/^[^\s,][^,]{0,49}$/.test(name)) {
    throw new GitHubClientError('invalid_request', `${operation}: label name is not usable`);
  }
}

function assertLabel(label: GitHubLabel, operation: string): void {
  assertLabelName(label.name, operation);
  if (!/^[0-9a-f]{6}$/.test(label.color)) {
    throw new GitHubClientError(
      'invalid_request',
      `${operation}: label color must be six lowercase hex digits without a leading #`,
    );
  }
}

function normalizeLabel(data: Record<string, unknown>, operation: string): GitHubLabel {
  return {
    name: requireString(data.name, 'name', operation),
    color: typeof data.color === 'string' ? data.color.toLowerCase() : '000000',
    description: typeof data.description === 'string' ? data.description : '',
  };
}
