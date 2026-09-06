import { Octokit } from '@octokit/core';
import { paginateRest, type PaginateInterface } from '@octokit/plugin-paginate-rest';

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
 * - No conditional-request/ETag *caching* layer. Reads surface the response ETag so the ticket
 *   store (build step 3) can start sending `If-None-Match` without this module changing shape,
 *   but nothing here stores or replays one yet.
 * - No `@octokit/plugin-throttling` / `plugin-retry` ladder yet (README's rate-limit row). Rate
 *   limiting surfaces as a typed `rate_limited` error with the reset time rather than a retry.
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
   * Adds an assignee (issue #184, for #83's claim pre-flight). Additive, never a replacement:
   * GitHub's `POST .../assignees` adds, and Pipenzo must not be able to evict a human who is
   * already on a ticket. The refusal in a lost claim race is decided by re-reading the issue
   * afterwards, not by this call failing — GitHub happily accepts a second assignee.
   */
  assignIssue(ref: RepoRef, issueNumber: number, assignee: string): Promise<GitHubIssue>;
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

const OctokitWithPagination = Octokit.plugin(paginateRest);

export const PIPENZO_USER_AGENT = 'pipenzo/0.1 (+https://github.com/jortega0033/pipenzo)';

/**
 * Builds the one configured octokit instance.
 *
 * Exported because the publish service (issue #178) needs an authenticated client for its
 * PR-open half and must not grow a second, differently-configured auth path — but note that it
 * builds its *own* instance from its *own* token read. The two never share a live object, so
 * there is no handle a caller of this module could follow to the publish service's credential.
 */
export function createPipenzoOctokit(token: string): PipenzoOctokit {
  return new OctokitWithPagination({
    auth: token,
    userAgent: PIPENZO_USER_AGENT,
  }) as PipenzoOctokit;
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

/** The one real implementation. Everything network-facing in Pipenzo's GitHub surface is here. */
export class OctokitGitHubClient implements GitHubClient {
  readonly #octokit: PipenzoOctokit;

  private constructor(octokit: PipenzoOctokit) {
    this.#octokit = octokit;
  }

  /** Reads the PAT from the environment and builds the client. Throws `token_missing` if unset. */
  static fromEnvironment(
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): OctokitGitHubClient {
    return new OctokitGitHubClient(createPipenzoOctokit(resolveGitHubToken(env)));
  }

  /** Injection seam for tests and for a caller that already holds a configured octokit. */
  static withOctokit(octokit: PipenzoOctokit): OctokitGitHubClient {
    return new OctokitGitHubClient(octokit);
  }

  async getIssue(ref: RepoRef, issueNumber: number): Promise<GitHubIssue> {
    const operation = `getIssue ${ref.owner}/${ref.repo}#${issueNumber}`;
    assertPositiveInteger(issueNumber, 'issue number', operation);
    let response;
    try {
      response = await this.#octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: issueNumber,
      });
    } catch (error) {
      throw toGitHubClientError(error, operation);
    }
    const data = response.data as Record<string, unknown>;
    if (data.pull_request !== undefined) {
      throw new GitHubClientError('not_found', `${operation}: reference is a pull request`);
    }
    const etag = response.headers.etag;
    return normalizeIssue(ref, data, typeof etag === 'string' ? etag : undefined, operation);
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

  async listLabels(ref: RepoRef): Promise<readonly GitHubLabel[]> {
    const operation = `listLabels ${ref.owner}/${ref.repo}`;
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
  for (const label of input.labels ?? []) {
    if (!/^[^\s,][^,]{0,49}$/.test(label)) {
      throw new GitHubClientError('invalid_request', `${operation}: label name is not usable`);
    }
  }
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

function assertLabel(label: GitHubLabel, operation: string): void {
  if (!/^[^\s,][^,]{0,49}$/.test(label.name)) {
    throw new GitHubClientError('invalid_request', `${operation}: label name is not usable`);
  }
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
