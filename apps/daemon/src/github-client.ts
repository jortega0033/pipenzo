import { Octokit } from '@octokit/core';
import { paginateRest, type PaginateInterface } from '@octokit/plugin-paginate-rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { PIPENZO_LABEL_NAMESPACE, isPipenzoLabel } from '@agent-dock/shared';
import { ConditionalRequestCache } from './github-conditional-cache.js';

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
 * - The PAT is read from the environment. The Electron-main token vault and device-flow OAuth are
 *   build step 4; step 2 and step 3 both read a PAT from env by design.
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
 * When build step 4 lands the Electron-main token vault, this read path is **deleted**, not kept
 * as a fallback. A "vault, or else env" resolver is how a long-lived key survives its own
 * replacement.
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
 * Removes anything shaped like a GitHub credential from a string.
 *
 * Deliberately pattern-based rather than "strip the token we happen to hold": the strings that
 * reach here come from octokit and from Node's HTTP stack, and they can contain a *different*
 * credential than the one this client was constructed with (a redirect, a proxy URL, a
 * credential-in-URL a user pasted into a remote). Matching the shapes covers all of them.
 *
 * Rule order matters and is not arbitrary. The URL rules run **before** the header rule, because
 * `https://x-access-token:ghp_…@github.com/o/r.git` contains a literal `x-access-token:` and a
 * header rule matching first would swallow the host and repository path along with the credential
 * — leaving an operator a `push_failed` with no diagnostic in it at all. Redaction should remove
 * the secret, not the sentence.
 *
 * **Known limit, recorded rather than re-litigated:** a pre-2021 40-hex classic PAT is not
 * matched, and cannot be. This module interpolates commit SHAs into messages, and a 40-hex rule
 * would redact every one of them. That is one more reason the env-PAT path is temporary and build
 * step 4's vault is the real fix — a credential you cannot recognize is one you cannot scrub.
 */
export function redactSecrets(value: string): string {
  return (
    value
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
      .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
  );
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

export interface GitHubLabel {
  readonly name: string;
  /** Six lowercase hex digits, no leading `#` — GitHub's own wire shape. */
  readonly color: string;
  readonly description: string;
}

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

const OctokitWithPagination = Octokit.plugin(paginateRest, retry, throttling);

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
  options: { throttleObserver?: PipenzoThrottleObserver } = {},
): PipenzoOctokit {
  return new OctokitWithPagination({
    auth: token,
    userAgent: PIPENZO_USER_AGENT,
    throttle: pipenzoThrottleOptions(options.throttleObserver),
  }) as PipenzoOctokit;
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
}

/** The one real implementation. Everything network-facing in Pipenzo's GitHub surface is here. */
export class OctokitGitHubClient implements GitHubClient {
  readonly #octokit: PipenzoOctokit;
  readonly #cache: ConditionalRequestCache | undefined;

  private constructor(octokit: PipenzoOctokit, cache: ConditionalRequestCache | undefined) {
    this.#octokit = octokit;
    this.#cache = cache;
  }

  /** Reads the PAT from the environment and builds the client. Throws `token_missing` if unset. */
  static fromEnvironment(
    env: Readonly<Record<string, string | undefined>> = process.env,
    options: OctokitGitHubClientOptions = {},
  ): OctokitGitHubClient {
    return new OctokitGitHubClient(createPipenzoOctokit(resolveGitHubToken(env)), options.cache);
  }

  /** Injection seam for tests and for a caller that already holds a configured octokit. */
  static withOctokit(
    octokit: PipenzoOctokit,
    options: OctokitGitHubClientOptions = {},
  ): OctokitGitHubClient {
    return new OctokitGitHubClient(octokit, options.cache);
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
   */
  async #conditional<T>(
    ref: RepoRef,
    resource: string,
    operation: string,
    send: (headers: Record<string, string>) => Promise<ConditionalResponse>,
    normalize: (response: ConditionalResponse, etag: string | undefined) => T | undefined,
  ): Promise<T | undefined> {
    const cached = this.#cache?.get<T>(ref, resource);
    let response: ConditionalResponse;
    try {
      response = await send(cached ? { 'if-none-match': cached.etag } : {});
    } catch (error) {
      if (cached !== undefined && statusOf(error) === 304) {
        this.#cache?.noteNotModified();
        return cached.value;
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
    }
    return normalizeIssue(ref, response.data as Record<string, unknown>, undefined, operation);
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

function assertIssueDraft(input: GitHubIssueDraft, operation: string): void {
  const title = input.title.trim();
  if (!title || title.length > 256) {
    throw new GitHubClientError(
      'invalid_request',
      `${operation}: an issue title must be 1-256 characters`,
    );
  }
  if (input.body.length > 65_536) {
    throw new GitHubClientError('invalid_request', `${operation}: issue body is too long`);
  }
  for (const label of input.labels ?? []) assertLabelName(label, operation);
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
