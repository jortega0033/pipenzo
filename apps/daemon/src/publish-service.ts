import { isAbsolute } from 'node:path';
import type { Logger } from '@agent-dock/agent-runtime';
import {
  pipenzoPublishRequestV1Schema,
  type PipenzoPublishErrorCodeV1,
  type PipenzoPublishRequestV1,
  type PipenzoPublishResultV1,
} from '@agent-dock/shared';
import {
  GitHubClientError,
  createPipenzoOctokit,
  redactSecrets,
  resolveConfiguredRepo,
  toGitHubClientError,
  type RepoRef,
} from './github-client.js';
import { DaemonGitHubCredential } from './github-credential.js';
import {
  buildGitEnvironment,
  buildGitPushEnvironment,
  runGitCommand,
  type GitCommandResult,
  type PipenzoGitRunner,
} from './pipenzo-git.js';

/**
 * The publish service (Pipenzo issue #178) — the module that owns every push and every PR-open,
 * and the reason CLAUDE.md's hard rule #1 is a rule rather than a preference.
 *
 * ## The boundary, stated as properties rather than as intent
 *
 * 1. **No agent tool calls this, and no agent session's environment can find it.** It is not a
 *    provider tool, not an MCP server, not a skill, and not a capability. The only entry point is
 *    `POST /v2/pipenzo/publish` on the daemon's bearer-authenticated local HTTP surface, which
 *    the desktop main process calls after a human clicks a button. A provider subprocess is
 *    spawned with `buildLegacyProviderEnvironment()` / `buildClaudeSdkEnvironment()` — reviewed
 *    OS/runtime keys plus that provider's own auth key, nothing else — so an agent session's
 *    environment carries no daemon port, no daemon bearer token, and no `AGENT_DOCK_*` variable.
 *    `publish-token-boundary.test.ts` asserts all of that.
 *
 *    **What this does not yet claim, stated plainly rather than papered over.** agentdock's
 *    discovery file (`discovery-file.ts`) writes `{port, token}` to a mode-0600 file under the
 *    OS temp directory, and `TEMP`/`TMP`/`HOME` are on the reviewed allowlist — so a session with
 *    a file-read tool could in principle locate and read the daemon's bearer token off disk. Mode
 *    0600 separates *users*, not the agent from the daemon that spawned it. That is an inherited
 *    agentdock property, not one this ticket introduces, but this ticket is what makes it matter,
 *    because before it the authenticated surface held no GitHub-write capability. The real fix is
 *    a second factor this route can check — a short-lived, single-use publish nonce minted by the
 *    desktop main process on the human's click — which needs renderer work that does not exist
 *    yet. Until then the honest statement is: an agent has no *tool* that publishes and no
 *    *environment* that addresses the daemon, and the disk channel is a known open edge.
 *
 * 1b. **No daemon-spawned `git` child gets the token either — including the ones this module does
 *    not own.** See `pipenzo-git.ts`: `git worktree add` runs a repository's `post-checkout` hook
 *    and `git status` can invoke a `core.fsmonitor` command, both resolved from a `.git` an agent
 *    can write to. Every `git` call site in the daemon now builds its environment from the same
 *    reviewed floor, so repository-supplied code cannot read the PAT out of its environment.
 *
 * 2. **The GitHub token is read here and nowhere a subprocess can see it.** `git` runs with the
 *    hardened environment from `pipenzo-git.ts`, so the token is not in `git`'s environment. It is
 *    also never in `git`'s argv (no `-c http.extraheader=…`, no credential in a URL), because
 *    pushing goes through the user's own git credential helper exactly as README's Stack table
 *    says. The token is used for one thing only: the in-process `@octokit/core` call that opens
 *    the pull request. It is read into a local `const` at call time, handed to an `Octokit` that
 *    is constructed inline and unreachable once the call settles, never stored on the instance,
 *    never logged.
 *
 * 3. **Nothing that leaves this module can carry a credential.** Git's stderr can contain a remote
 *    URL with an embedded credential; every string that becomes an error message or a log line
 *    goes through `redactSecrets()` first.
 *
 * 4. **You can only publish a worktree agentdock created, on the branch that worktree has checked
 *    out, at the commit the caller was shown, to the remote the configured repository lives at.**
 *    The request names a *worktree id* and the path comes from
 *    `OwnedWorktreeManager.ownedLocation()`, so no caller can name a directory. Beyond that, four
 *    separate bindings close four different gaps: `refs/heads/*` is shared across every linked
 *    worktree of a repository, so a worktree id alone would let ticket A push `main` or ticket B's
 *    branch; the push names a resolved sha rather than a ref, so a commit landing between
 *    resolution and push cannot ride out under an approval that never saw it; the remote's push
 *    URL is checked against the configured repository, because `.git/config` is agent-writable and
 *    a remote *name* says nothing about where it points; and `--no-verify` keeps a repository's
 *    `pre-push` hook — which is not version-controlled and so is not the human-reviewed trust
 *    class README's hook note is about — from executing at the one moment the daemon is reaching
 *    the network with a credential-bearing operation.
 *
 * ## Walking-skeleton simplifications (build order step 2)
 *
 * - PAT from env, single configured repository, single default base branch. Device-flow OAuth and
 *   the Electron-main token vault are step 4.
 * - `gh stack` is not invoked. Approved stacks ship as sequential PRs until the post-MVP
 *   `gh stack` work lands (README's near-term list); the `gh` binary appears nowhere here.
 * - No force-push of any kind, and no branch deletion. A rejected non-fast-forward push surfaces
 *   as `push_rejected` for a human, rather than being resolved automatically.
 * - No audit-store entry yet. README puts "an audit entry for every publish" in build step 6.
 */

const MAX_ERROR_DETAIL = 2_000;

/** Re-exported for existing importers; the hardening itself now lives in `pipenzo-git.ts`. */
export { buildGitEnvironment, buildGitPushEnvironment };
export type { GitCommandResult, PipenzoGitRunner as PublishGitRunner };

export class PublishServiceError extends Error {
  readonly code: PipenzoPublishErrorCodeV1;

  constructor(code: PipenzoPublishErrorCodeV1, message: string) {
    // Redacts at construction for the same reason `GitHubClientError` does: a message that escapes
    // through a route response, a log, or a pasted stack trace must not be able to carry a token.
    super(redactSecrets(message));
    this.name = 'PublishServiceError';
    this.code = code;
  }
}

export interface OwnedWorktreeLocation {
  readonly id: string;
  readonly path: string;
  readonly sourcePath: string;
}

/** The narrow slice of `OwnedWorktreeManager` this service depends on. */
export interface OwnedWorktreeLocator {
  ownedLocation(id: string): OwnedWorktreeLocation | undefined;
}

export interface OpenedPullRequest {
  readonly number: number;
  readonly htmlUrl: string;
  readonly draft: boolean;
}

export interface PullRequestOpener {
  open(input: {
    ref: RepoRef;
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<OpenedPullRequest>;
}

export interface PublishServiceOptions {
  worktrees: OwnedWorktreeLocator;
  /**
   * The daemon's own environment. Passed explicitly rather than read ambiently so a test can
   * prove what this service does and does not read.
   *
   * That move from env to the Electron-main vault has now happened (issue #165): in the shipped
   * app this environment no longer carries a credential, and `resolveGitHubCredential` below is
   * what actually supplies one. This stays as the fallback source for a daemon nobody injected
   * into — `pnpm dev`, the live-smoke harness, CI.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Where the GitHub credential comes from (issue #165).
   *
   * Injected rather than read here, because in the shipped app it is **not** in `env` at all: the
   * Electron-main vault hands it to the daemon over stdin, and `DaemonGitHubCredential` holds it in
   * a private field precisely so it is not in an environment block a provider subprocess could read
   * out of its own parent. The default keeps the direct-`pnpm dev` path (and every existing test)
   * reading the environment exactly as before.
   */
  resolveGitHubCredential?: (env: Readonly<Record<string, string | undefined>>) => string;
  runGit?: PipenzoGitRunner;
  /** Built lazily, from a token read at call time, so no live authenticated client is retained. */
  createPullRequestOpener?: (token: string) => PullRequestOpener;
  logger?: Logger;
}

export const DEFAULT_REMOTE = 'origin';
export const DEFAULT_BASE_BRANCH_ENV_KEY = 'PIPENZO_GITHUB_BASE';
export const DEFAULT_BASE_BRANCH = 'main';

function detail(result: GitCommandResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  return redactSecrets(text).slice(0, MAX_ERROR_DETAIL);
}

/**
 * Re-asserts the argv contract inside the service.
 *
 * The Zod schema already rejects these shapes on the wire, but this service is also reachable
 * in-process from later phases (the review-gate runner, the reconciler), and an argv guard that
 * only exists in the HTTP layer is one refactor away from not existing. A leading `-` is the one
 * that actually matters: `git push origin -x` is an option, not a ref.
 */
function assertSafeRefName(value: string, field: string): void {
  const usable =
    value.length > 0 &&
    value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.includes('@{') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock');
  if (!usable) {
    throw new PublishServiceError('invalid_request', `${field} is not a usable git ref name`);
  }
}

function assertSafeRemoteName(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.length > 100 || value.includes('..')) {
    throw new PublishServiceError('invalid_request', 'remote is not a usable git remote name');
  }
}

/**
 * Resolves a git remote URL to the GitHub repository it actually points at.
 *
 * Exported for its own test. Handles the four forms git accepts — `https://host/owner/repo(.git)`,
 * `ssh://git@host/owner/repo(.git)`, the scp-like `git@host:owner/repo(.git)`, and any of those
 * carrying userinfo — and returns `undefined` for anything that is not github.com, which is the
 * answer the caller needs: "this remote does not point where you think it does."
 */
export function parseGitHubRemoteUrl(url: string): RepoRef | undefined {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048) return undefined;
  const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed);
  let host: string;
  let path: string;
  if (withScheme) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) return undefined;
    host = parsed.hostname;
    path = parsed.pathname;
  } else if (scpLike?.[1] && scpLike[2]) {
    host = scpLike[1];
    path = scpLike[2];
  } else {
    return undefined;
  }
  if (host.toLowerCase() !== 'github.com') return undefined;
  const segments = path.replace(/^\/+/, '').replace(/\.git$/i, '').split('/');
  if (segments.length !== 2 || !segments[0] || !segments[1]) return undefined;
  return { owner: segments[0], repo: segments[1] };
}

/** GitHub treats owner and repository names case-insensitively; so does this comparison. */
function sameRepo(left: RepoRef, right: RepoRef): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

function octokitPullRequestOpener(token: string): PullRequestOpener {
  const octokit = createPipenzoOctokit(token);
  return {
    async open(input) {
      try {
        const response = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
          owner: input.ref.owner,
          repo: input.ref.repo,
          head: input.head,
          base: input.base,
          title: input.title,
          body: input.body,
          draft: input.draft,
        });
        const data = response.data as Record<string, unknown>;
        if (typeof data.number !== 'number' || typeof data.html_url !== 'string') {
          throw new GitHubClientError('invalid_response', 'GitHub returned an unusable pull request');
        }
        return {
          number: data.number,
          htmlUrl: data.html_url,
          draft: data.draft === true,
        };
      } catch (error) {
        throw toGitHubClientError(error, 'openPullRequest');
      }
    },
  };
}

export class PublishService {
  readonly #worktrees: OwnedWorktreeLocator;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #runGit: PipenzoGitRunner;
  readonly #createOpener: (token: string) => PullRequestOpener;
  /** A *resolver*, never the credential: this field holds a function, and is called at use. */
  readonly #resolveCredential: (env: Readonly<Record<string, string | undefined>>) => string;
  readonly #logger: Logger | undefined;
  /** One publish at a time per worktree: two concurrent pushes of one branch is never intended. */
  readonly #inFlight = new Set<string>();

  constructor(options: PublishServiceOptions) {
    this.#worktrees = options.worktrees;
    this.#env = options.env ?? process.env;
    // Not the raw `resolveGitHubToken`, which only trims and rejects empty: the shape rule that
    // `DaemonGitHubCredential.resolve` enforces on the environment fallback has to hold on every
    // path to `createPipenzoOctokit`, and the half of a symmetric rule that gets skipped is the
    // half that stops being true. `index.ts` always injects `githubCredential.resolve`, so this
    // default is only reached by a caller assembling a `PublishService` by hand.
    this.#resolveCredential =
      options.resolveGitHubCredential ?? ((env) => DaemonGitHubCredential.none().resolve(env));
    this.#runGit = options.runGit ?? runGitCommand;
    this.#createOpener = options.createPullRequestOpener ?? octokitPullRequestOpener;
    this.#logger = options.logger;
  }

  /**
   * The one entry point. Takes the already-parsed wire request so the route stays a thin adapter
   * and an in-process caller cannot skip validation by choosing a different method.
   */
  async publish(request: PipenzoPublishRequestV1): Promise<PipenzoPublishResultV1> {
    const parsed = pipenzoPublishRequestV1Schema.safeParse(request);
    if (!parsed.success) {
      throw new PublishServiceError('invalid_request', 'publish request is not valid');
    }
    const input = parsed.data;
    const remote = input.remote ?? DEFAULT_REMOTE;
    assertSafeRefName(input.branch, 'branch');
    assertSafeRemoteName(remote);

    const location = this.#worktrees.ownedLocation(input.worktreeId);
    if (!location) {
      throw new PublishServiceError('worktree_not_found', 'no agentdock-owned worktree with that id');
    }
    if (!isAbsolute(location.path)) {
      throw new PublishServiceError('worktree_not_found', 'owned worktree path is not absolute');
    }
    // Keyed on the destination as well as the worktree: two worktrees of one repository pushing
    // the same branch at once is the same collision as one worktree doing it twice.
    const leases = [input.worktreeId, `${remote} ${input.branch}`];
    if (leases.some((lease) => this.#inFlight.has(lease))) {
      throw new PublishServiceError('publish_busy', 'a publish is already running for this branch');
    }
    for (const lease of leases) this.#inFlight.add(lease);
    try {
      return await this.#publishLocked(input, location, remote);
    } finally {
      for (const lease of leases) this.#inFlight.delete(lease);
    }
  }

  async #publishLocked(
    input: PipenzoPublishRequestV1,
    location: OwnedWorktreeLocation,
    remote: string,
  ): Promise<PipenzoPublishResultV1> {
    const cwd = location.path;

    // Everything that can fail without side effects runs first. Ordering is the whole point: a
    // request that is going to be refused for a missing token must be refused *before* a branch
    // reaches the remote, or the operator's natural retry produces a second push and a duplicate
    // pull request. The token's *value* is still read at the last possible moment below; only its
    // presence is established here.
    const repo = this.#configuredRepo();
    const pullRequestInput = input.operation === 'push_and_open_pull_request' ? input.pullRequest : undefined;
    let base: string | undefined;
    if (input.operation === 'push_and_open_pull_request') {
      if (!pullRequestInput) {
        throw new PublishServiceError('invalid_request', 'pull request details are required');
      }
      base = pullRequestInput.base ?? this.#defaultBaseBranch();
      assertSafeRefName(base, 'base');
      if (base === input.branch) {
        throw new PublishServiceError('invalid_request', 'a pull request cannot target its own branch');
      }
      this.#assertTokenPresent();
    }

    await this.#assertGitWorktree(cwd);
    await this.#assertRemoteTargetsConfiguredRepo(cwd, remote, repo);
    await this.#assertBranchIsCheckedOut(cwd, input.branch);
    const headSha = await this.#resolveBranchHead(cwd, input.branch);
    await this.#assertNothingUncommitted(cwd);

    const updatedRemote = await this.#push(cwd, remote, input.branch, headSha);
    this.#logger?.info('pipenzo publish pushed a branch', {
      worktreeId: input.worktreeId,
      remote,
      branch: input.branch,
      updatedRemote,
    });

    if (input.operation === 'push') {
      return {
        worktreeId: input.worktreeId,
        remote,
        branch: input.branch,
        headSha,
        updatedRemote,
      };
    }

    if (!pullRequestInput || base === undefined) {
      throw new PublishServiceError('invalid_request', 'pull request details are required');
    }
    // Read the token's value here, at the last possible moment, into a local binding. It is never
    // assigned to a field, never returned, never logged, and goes out of scope with this call.
    const token = this.#resolveToken();
    const opened = await this.#openPullRequest(token, {
      ref: repo,
      head: input.branch,
      base,
      title: pullRequestInput.title,
      body: pullRequestInput.body,
      draft: pullRequestInput.draft === true,
    });
    this.#logger?.info('pipenzo publish opened a pull request', {
      worktreeId: input.worktreeId,
      repo: `${repo.owner}/${repo.repo}`,
      number: opened.number,
    });

    return {
      worktreeId: input.worktreeId,
      remote,
      branch: input.branch,
      headSha,
      updatedRemote,
      pullRequest: {
        number: opened.number,
        htmlUrl: opened.htmlUrl,
        baseRef: base,
        draft: opened.draft,
      },
    };
  }

  /**
   * Establishes that a token exists without binding its value.
   *
   * Called before the push so a request that is going to fail for a missing credential fails
   * before it has a side effect; the value itself is still read at the last possible moment, so
   * the "never held longer than one call" property is unchanged.
   */
  #assertTokenPresent(): void {
    this.#resolveToken();
  }

  #resolveToken(): string {
    try {
      return this.#resolveCredential(this.#env);
    } catch (error) {
      if (error instanceof GitHubClientError && error.code === 'token_missing') {
        throw new PublishServiceError('token_missing', error.message);
      }
      throw error;
    }
  }

  #configuredRepo(): RepoRef {
    try {
      return resolveConfiguredRepo(this.#env);
    } catch (error) {
      throw new PublishServiceError(
        'repository_not_configured',
        error instanceof Error ? error.message : 'no repository configured',
      );
    }
  }

  #defaultBaseBranch(): string {
    return this.#env[DEFAULT_BASE_BRANCH_ENV_KEY]?.trim() || DEFAULT_BASE_BRANCH;
  }

  async #assertGitWorktree(cwd: string): Promise<void> {
    const result = await this.#runGit(['rev-parse', '--is-inside-work-tree'], cwd);
    if (result.code !== 0 || result.stdout.trim() !== 'true') {
      throw new PublishServiceError(
        'worktree_not_a_git_repository',
        'owned worktree is not a git working tree',
      );
    }
  }

  /**
   * Checks not just that the remote exists, but that it points where the caller thinks it does.
   *
   * A remote *name* is not a destination. `remote.<name>.pushurl`, `remote.<name>.url` and
   * `url.<base>.insteadOf` all live in `.git/config`, which is shared across a repository's linked
   * worktrees and therefore writable by an agent working in one of them. Without this check a
   * human approves "push to origin", the branch goes to a host of someone else's choosing, and
   * nothing in the flow notices — because the pull request is opened against the *configured*
   * repository, an entirely independent value the code would never have correlated with the push.
   */
  async #assertRemoteTargetsConfiguredRepo(
    cwd: string,
    remote: string,
    expected: RepoRef,
  ): Promise<void> {
    const listed = await this.#runGit(['remote'], cwd);
    if (listed.code !== 0) {
      throw new PublishServiceError('push_failed', `could not list remotes: ${detail(listed)}`);
    }
    if (!listed.stdout.split(/\r?\n/).map((line) => line.trim()).includes(remote)) {
      throw new PublishServiceError('remote_not_found', `no remote named ${remote}`);
    }
    const url = await this.#runGit(['remote', 'get-url', '--push', remote], cwd);
    if (url.code !== 0) {
      throw new PublishServiceError(
        'remote_not_found',
        `remote ${remote} has no usable push URL: ${detail(url)}`,
      );
    }
    const actual = parseGitHubRemoteUrl(url.stdout.trim());
    if (!actual || !sameRepo(actual, expected)) {
      throw new PublishServiceError(
        'remote_not_found',
        `remote ${remote} does not point at ${expected.owner}/${expected.repo}`,
      );
    }
  }

  /**
   * Binds the named branch to this worktree.
   *
   * `refs/heads/*` lives in the repository's common directory, shared by every linked worktree, so
   * a worktree id on its own selects only a `cwd` — from ticket A's worktree the service would
   * happily resolve and push `main`, or ticket B's branch. Worse, the uncommitted-changes check
   * below reads the status of whatever is *checked out*, so without this the honesty property it
   * exists to hold would be verified against the wrong ref entirely.
   */
  async #assertBranchIsCheckedOut(cwd: string, branch: string): Promise<void> {
    const head = await this.#runGit(['symbolic-ref', '--quiet', 'HEAD'], cwd);
    if (head.code !== 0 || head.stdout.trim() !== `refs/heads/${branch}`) {
      throw new PublishServiceError(
        'branch_not_found',
        `branch ${branch} is not the branch checked out in this worktree`,
      );
    }
  }

  async #resolveBranchHead(cwd: string, branch: string): Promise<string> {
    // Fully-qualified so a branch can never be resolved as a tag, a remote-tracking ref, or a
    // path, and `--` terminates option parsing regardless of what the ref guards above allowed.
    const result = await this.#runGit(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`, '--'],
      cwd,
    );
    const sha = result.stdout.trim().split(/\r?\n/)[0] ?? '';
    if (result.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new PublishServiceError('branch_not_found', `branch ${branch} does not exist in this worktree`);
    }
    return sha;
  }

  /**
   * Refuses to push a worktree with modified *tracked* files.
   *
   * Untracked files are ignored on purpose — a real repository's worktree routinely carries build
   * output and `node_modules`, and that is exactly the false refusal agentdock filed as its own
   * issue #117. What matters here is the honesty property: the commit a human approved on the diff
   * screen is the commit that reaches the remote, with no uncommitted edit silently left behind.
   */
  async #assertNothingUncommitted(cwd: string): Promise<void> {
    const result = await this.#runGit(['status', '--porcelain', '--untracked-files=no'], cwd);
    if (result.code !== 0) {
      throw new PublishServiceError('push_failed', `could not read worktree status: ${detail(result)}`);
    }
    if (result.stdout.trim().length > 0) {
      throw new PublishServiceError(
        'uncommitted_changes',
        'the worktree has uncommitted changes to tracked files; commit or discard them first',
      );
    }
  }

  /**
   * Returns whether the remote actually moved. `--porcelain` reports `=` for an up-to-date ref.
   *
   * The refspec's source is the **resolved sha**, not the branch ref. The agent's session is
   * routinely still live in this worktree, so a commit landing between `#resolveBranchHead` and
   * this call would otherwise be pushed while the response reported the older sha — and the wire
   * contract promises `headSha` is "the commit that was actually pushed". Pushing the sha makes
   * that promise true instead of probable. It also costs `--set-upstream`, which only accepts a
   * branch as its source; nothing here reads upstream, so it is simply dropped.
   *
   * `--no-verify` skips the repository's `pre-push` hook. README's "hooks included" note is about
   * repo-authored, human-committed scripts; `.git/hooks/` is not version-controlled and, in a
   * worktree an agent has been writing to, is not that trust class. Publishing is the one moment
   * the daemon reaches the network with a credential-bearing operation, and it is the worst
   * possible moment to execute code nobody reviewed.
   *
   * No `--force`, no `--force-with-lease`, no `--delete`. A non-fast-forward is a human's
   * decision, and this service deliberately offers no way to make it automatically.
   */
  async #push(cwd: string, remote: string, branch: string, headSha: string): Promise<boolean> {
    const refspec = `${headSha}:refs/heads/${branch}`;
    const result = await this.#runGit(
      ['push', '--porcelain', '--no-verify', remote, refspec],
      cwd,
      { credentialReachable: true },
    );
    if (result.code !== 0) {
      const text = detail(result);
      const rejected = /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(text);
      throw new PublishServiceError(
        rejected ? 'push_rejected' : 'push_failed',
        `git push ${remote} ${branch} failed: ${text}`,
      );
    }
    return !/^=\t/m.test(result.stdout);
  }

  async #openPullRequest(
    token: string,
    input: Parameters<PullRequestOpener['open']>[0],
  ): Promise<OpenedPullRequest> {
    try {
      return await this.#createOpener(token).open(input);
    } catch (error) {
      if (error instanceof PublishServiceError) throw error;
      const mapped =
        error instanceof GitHubClientError ? error : toGitHubClientError(error, 'openPullRequest');
      throw new PublishServiceError(
        mapped.code === 'token_missing' || mapped.code === 'unauthorized'
          ? 'token_missing'
          : 'pull_request_failed',
        mapped.message,
      );
    }
  }
}
