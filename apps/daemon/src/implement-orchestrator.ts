import { lstat, readFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import {
  MAX_IMPLEMENT_DIFF_CHARS,
  refineSpecV1Schema,
  type CreateSessionV2Request,
  type ImplementSessionStateV1,
  type OwnedWorktreeV2,
  type PermissionActionV2,
  type ProviderId,
  type RefineSpecV1,
} from '@agent-dock/shared';
import { runGitCommand, type GitCommandResult, type PipenzoGitRunner } from './pipenzo-git.js';
import { WorktreeManagerError, isSecretShapedPath } from './worktree-manager.js';
import type { OwnedWorktreeLocation } from './publish-service.js';

/**
 * The Implement phase (Pipenzo issue #180) — "spec in, worktree with commits out", and nothing
 * more than that.
 *
 * Three things it is built around:
 *
 * 1. **The session is seeded with the spec, not the issue.** This is enforced by shape, not by
 *    discipline: `implement()` accepts a `RefineSpecV1` and a repository path, and never receives
 *    the raw issue body at all, so there is no path by which the issue text could reach the
 *    prompt. README's Implement step is explicit that a fresh session sees the spec, and the
 *    reason is the whole point of having a Refine phase — an implementer that re-reads the
 *    original ticket is free to re-interpret scope the spec already settled.
 *
 * 2. **The worktree is agentdock's, not a parallel concept.** `OwnedWorktreeManager` already owns
 *    provisioning, trust gating, the per-repository serialization from agentdock issue #118, and
 *    cleanup. This module calls it. One worktree per ticket, per README's Team-usage section.
 *
 * 3. **A real branch, created daemon-side.** agentdock creates owned worktrees *detached*
 *    (`git worktree add --detach`), which is right for its own use and wrong for a ticket that
 *    has to end in a pushable `issue-<n>` branch. The orchestrator creates that branch itself,
 *    through the same `execFile` trust model as everything else — never by asking the agent to
 *    run a git command, which would be the first crack in the boundary #178 exists to hold. The
 *    same goes for the commit: the agent only edits files, and once its session completes the
 *    daemon commits them itself (`#commitWork`), with repository hooks disabled.
 *
 * ## Walking-skeleton simplifications, each owned by a later ticket
 *
 * - **No retry ladder.** One attempt. Same-tier fork vs. tier-escalation-as-fresh-session is
 *   README's step-6 territory and is deliberately not modelled here, not even as a stub.
 * - **No risk classifier and no pre-commitment records.** `apps/daemon/src/risk-classifier.ts`
 *   (issue #157) exists and is tested, but nothing calls it yet — this module still does not grade
 *   risk or record a pre-commitment. That wiring is downstream tickets (#97, #98, #131, #149,
 *   #158, #160), not this one.
 * - **No symbol graph.** README is explicit that the symbol graph is a user-configured MCP server
 *   inherited from agentdock's runtime, not a Pipenzo module. With none configured, Implement
 *   falls back to `Grep`/`Glob` — which is what happens by default here, since this module
 *   configures no MCP server at all.
 * - **One model choice, passed in.** Routing classes to model tiers is build step 4+.
 */

export type ImplementOrchestratorErrorCode =
  | 'invalid_spec'
  | 'invalid_request'
  | 'workspace_untrusted'
  | 'worktree_failed'
  | 'worktree_secret_risk'
  | 'branch_failed'
  | 'commit_failed'
  | 'session_failed'
  /**
   * Issue #192: the implement session reached a terminal state and left nothing on the ticket
   * branch -- `headCommit === baseCommit`. `collect()` throws this instead of returning an
   * empty-but-successful result once it has itself observed the session end; see its doc comment.
   */
  | 'implement_empty_diff'
  | 'diff_unavailable';

export class ImplementOrchestratorError extends Error {
  readonly code: ImplementOrchestratorErrorCode;
  readonly details: readonly string[];

  constructor(
    code: ImplementOrchestratorErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ImplementOrchestratorError';
    this.code = code;
    this.details = [...details];
  }
}

export type ImplementPermissionVerdict =
  | { readonly outcome: 'allow'; readonly reason: 'filesystem' }
  | {
      readonly outcome: 'deny';
      readonly reason:
        | 'command'
        | 'network'
        | 'mcp'
        | 'external_side_effect'
        | 'destructive'
        | 'incomplete_effects'
        | 'unclassifiable';
    };

/**
 * The Implement phase's permission shape: it may read and write files, and nothing else. Its
 * prompt is built from a spec that Refine derived from an issue body a stranger may have written,
 * so it is inside the same prompt-injection blast radius as Refine. The session being
 * write-capable must not make the session publish-capable: a command (`git push`, `gh`, `curl`
 * against the daemon's own publish route with a bearer token read off disk), a network call, or an
 * MCP invocation is denied. This bounds what the Implement *session* can do. It does not bound what
 * the files it writes do later, when Review's build/test gates execute them — that is a separate
 * boundary (`review-gates.ts`), not one this function can hold.
 *
 * Fail-closed the same way `evaluateRefinePermission()` is: exactly one branch returns `allow`.
 */
export function evaluateImplementPermission(
  action: PermissionActionV2,
): ImplementPermissionVerdict {
  if (action.risk === 'destructive' || action.mcpDestructive) {
    return { outcome: 'deny', reason: 'destructive' };
  }
  switch (action.actionClass) {
    case 'filesystem':
      return action.effectsComplete &&
        action.risk === 'normal' &&
        (action.operation === 'filesystem.read' || action.operation === 'filesystem.write')
        ? { outcome: 'allow', reason: 'filesystem' }
        : { outcome: 'deny', reason: 'incomplete_effects' };
    case 'command':
      return { outcome: 'deny', reason: 'command' };
    case 'network':
      return { outcome: 'deny', reason: 'network' };
    case 'mcp':
      return { outcome: 'deny', reason: 'mcp' };
    case 'external_side_effect':
      return { outcome: 'deny', reason: 'external_side_effect' };
    default:
      return { outcome: 'deny', reason: 'unclassifiable' };
  }
}

/** One worktree per ticket, and its branch name is derived, never caller-supplied. */
export function ticketBranchName(issueNumber: number): string {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new ImplementOrchestratorError('invalid_spec', 'issue number must be a positive integer');
  }
  return `issue-${issueNumber}`;
}

export interface WorktreePreviewLike {
  readonly secretRisk: boolean;
  readonly includeFiles: readonly string[];
}

/** The slice of `OwnedWorktreeManager` this orchestrator uses. */
export interface ImplementWorktreeManager {
  preview(input: { cwd: string; name: string; ref?: string }): Promise<WorktreePreviewLike>;
  create(input: {
    cwd: string;
    name: string;
    ref?: string;
    confirmIncludeCopy: true;
  }): Promise<OwnedWorktreeV2>;
  ownedLocation(id: string): OwnedWorktreeLocation | undefined;
}

/** How a dispatched implement session ended, as the session machinery observed it. */
export type ImplementSessionEnd = 'completed' | 'failed' | 'cancelled';

export interface ImplementSessionOutcome {
  readonly sessionId: string;
  /**
   * Settles once the session reaches its terminal event. The orchestrator commits the worktree
   * itself only after this resolves `'completed'` — see `#commitWork`. Absent (a port that cannot
   * observe its session), nothing is ever committed on the agent's behalf.
   */
  readonly ended?: Promise<ImplementSessionEnd>;
  /**
   * Settles with the session's real provider token usage once it ends (Pipenzo issue #143) --
   * `0` for a session that reported none, absent entirely for a port with no way to observe usage
   * at all, same "cannot say" vs "said none" distinction as `RefineSessionOutcome.tokensUsed`.
   * Kept separate from `ended` rather than folded into it (e.g. `{end, tokensUsed}`) so a caller
   * that only wants the terminal state -- `#commitWhenEnded`, which existed before this ticket --
   * does not have to change what it reads off the promise it already awaits.
   */
  readonly tokensUsed?: Promise<number>;
}

/** The seam onto agentdock's session machinery, mirroring `RefineSessionPort`. */
export interface ImplementSessionPort {
  run(request: CreateSessionV2Request): Promise<ImplementSessionOutcome>;
}

export interface ImplementRequest {
  /** The only description of the work this phase ever sees. */
  readonly spec: RefineSpecV1;
  /** The source repository the worktree is cut from. */
  readonly repositoryPath: string;
  readonly provider: ProviderId;
  readonly model?: string;
  /** Base ref the worktree starts from. Defaults to the repository's current `HEAD`. */
  readonly baseRef?: string;
  /**
   * Explicit acknowledgement that this repository's `.worktreeinclude` may copy a file agentdock
   * flagged as secret-shaped into the agent's worktree. Absent, a flagged include refuses. Fail
   * closed: copying a `.env` next to an agent is a decision a human makes, not a default.
   */
  readonly acknowledgeIncludeSecretRisk?: boolean;
  /**
   * The operator's own note, from the Implement dialog's "extra instructions" field (issue #83).
   *
   * Appended to the spec-derived prompt under its own heading, never merged into it and never
   * substituted for any part of it — see `appendOperatorInstructions()`. It is the one
   * caller-authored string that reaches an implementer prompt, and it is a *human's* string: the
   * raw issue body still has no route here.
   */
  readonly extraInstructions?: string;
}

/** What `start()` returns: everything the route needs, plus the path only the daemon may hold. */
export interface ImplementStartResult {
  readonly worktreeId: string;
  /** Daemon-internal. Never projected onto a route response — see `ownedLocation`'s comment. */
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly sessionId: string;
  /** See `ImplementSessionOutcome.tokensUsed`; carried through unchanged so `PipenzoPhaseService`
   *  can record it against the ticket once the dispatched session actually finishes. */
  readonly tokensUsed?: Promise<number>;
}

export interface ImplementCollectRequest {
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
}

export interface ImplementCollectResult {
  readonly headCommit: string;
  /**
   * Commits on the ticket branch since the base, oldest first — normally the one the daemon made
   * after the session completed. Empty means the session left nothing to commit, or has not
   * finished yet.
   */
  readonly commits: readonly string[];
  /**
   * Issue #192. Set whenever this daemon process has itself observed the dispatched session, i.e.
   * there is a `PendingCommit` record for this worktree path. Omitted when it cannot know --
   * `#pendingCommits` is not persisted, so a daemon restart leaves a mid-flight session
   * unobservable, and `collect()` falls back to reporting the branch exactly as git has it, same as
   * before this field existed.
   */
  readonly sessionState?: ImplementSessionStateV1;
}

export interface ImplementDiffRequest {
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly headCommit: string;
}

export interface ImplementDiffResult {
  readonly diffText: string;
  readonly truncated: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly filesChanged: number;
}

/** What the daemon's post-session commit step did, held until `collect()` reports it. */
type CommitOutcome =
  | { readonly kind: 'committed'; readonly commit: string }
  | { readonly kind: 'nothing_to_commit' }
  | { readonly kind: 'session_not_completed'; readonly end: ImplementSessionEnd }
  | { readonly kind: 'refused'; readonly error: ImplementOrchestratorError };

interface PendingCommit {
  /** True once the session's terminal event arrived, i.e. the commit step is running or done. */
  sessionEnded: boolean;
  outcome: Promise<CommitOutcome>;
}

/**
 * Hooks off, fsmonitor off, for every git command the daemon runs over files the agent wrote.
 * `core.hooksPath` pointing at the null device means no `pre-commit`, `prepare-commit-msg`,
 * `commit-msg` or `post-commit` hook is found — including one the agent wrote into a tracked hooks
 * directory like `.husky/` — which `--no-verify` alone would not cover (it skips only two of them).
 * Agent-written code never executes as part of a daemon-owned git step.
 */
const NO_REPO_CODE = Object.freeze([
  '-c',
  `core.hooksPath=${devNull}`,
  '-c',
  'core.fsmonitor=false',
]);

/**
 * Reads a linked worktree's `.git` pointer file (`gitdir: …`). `undefined` when it is missing, or is
 * not a plain file — a directory or a symlink is not what `git worktree add` created.
 */
export type GitPointerReader = (worktreePath: string) => Promise<string | undefined>;

export const readGitPointer: GitPointerReader = async (worktreePath) => {
  try {
    const path = join(worktreePath, '.git');
    if (!(await lstat(path)).isFile()) return undefined;
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return undefined;
  }
};

const COMMIT_SUBJECT_MAX = 72;
/** `owner/repo`, nothing else: what may be written into the commit's `Refs` line. */
const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * GitHub's closing keywords when followed by something they would close (`#12`, `owner/repo#12`, an
 * issue URL). A zero-width space after the first letter keeps the word readable and makes it no
 * longer the keyword, so a merged commit cannot close an issue its text happens to name.
 */
const CLOSING_KEYWORD =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?=\s*:?\s*(?:#\d|[\w.-]+\/[\w.-]+#\d|https?:\/\/))/gi;

function defangClosingKeywords(value: string): string {
  return value.replace(CLOSING_KEYWORD, (word) => `${word.slice(0, 1)}\u200b${word.slice(1)}`);
}

function flattenToOneLine(value: string): string {
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? ' ' : char;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The commit message for the daemon's post-session commit. Everything in the spec is Refine's
 * model output, and Refine read an issue a stranger may have written, so nothing here is trusted
 * text:
 *
 * - The subject is the title flattened to one line (no forged extra lines), with closing keywords
 *   defanged, truncated to 72 characters, and suffixed with the issue number.
 * - There is no body from the spec. The summary used to be one, and a multi-paragraph model string
 *   as a commit's last paragraphs is exactly how a forged `Co-authored-by:`/`Signed-off-by:`
 *   trailer or a `Fixes #N` gets in.
 * - The `Refs owner/repo#n` line is written only when the repository is a plain `owner/repo` slug
 *   and the number a positive integer; otherwise it is left out rather than repaired. `Refs` is
 *   neither a closing keyword nor a trailer token.
 */
export function buildImplementCommitMessage(spec: RefineSpecV1): string {
  const number = spec.issue.number;
  const validNumber = Number.isSafeInteger(number) && number > 0;
  const suffix = validNumber ? ` (#${number})` : '';
  let title = defangClosingKeywords(flattenToOneLine(spec.issue.title)) || 'Implement ticket';
  if (title.length + suffix.length > COMMIT_SUBJECT_MAX) {
    title = `${title.slice(0, COMMIT_SUBJECT_MAX - suffix.length - 1).trimEnd()}…`;
  }
  const repo = spec.issue.repo.trim();
  const refs = validNumber && REPO_SLUG.test(repo) ? `Refs ${repo}#${number}` : undefined;
  return refs ? `${title}${suffix}\n\n${refs}` : `${title}${suffix}`;
}

export interface ImplementResult {
  readonly worktreeId: string;
  /** Daemon-internal. Never projected onto a route response — see `ownedLocation`'s comment. */
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  /** Commits the session produced, oldest first. Empty means the agent committed nothing. */
  readonly commits: readonly string[];
  /** Issue #192 -- see `ImplementCollectResult.sessionState`. */
  readonly sessionState?: ImplementSessionStateV1;
  readonly sessionId: string;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;

export class ImplementOrchestrator {
  readonly #worktrees: ImplementWorktreeManager;
  readonly #sessions: ImplementSessionPort;
  readonly #runGit: PipenzoGitRunner;
  readonly #readGitPointer: GitPointerReader;
  /**
   * The post-session commit per worktree path, for sessions this daemon process dispatched. Not
   * persisted: after a daemon restart there is no session to wait for, and `collect()` reports the
   * branch as git has it.
   */
  readonly #pendingCommits = new Map<string, PendingCommit>();

  constructor(options: {
    worktrees: ImplementWorktreeManager;
    sessions: ImplementSessionPort;
    runGit?: PipenzoGitRunner;
    /** Test seam for the `.git` pointer check in `#commitWork`. */
    readGitPointer?: GitPointerReader;
  }) {
    this.#worktrees = options.worktrees;
    this.#sessions = options.sessions;
    this.#runGit = options.runGit ?? runGitCommand;
    this.#readGitPointer = options.readGitPointer ?? readGitPointer;
  }

  /**
   * Everything up to and including handing the session to the provider: validate, preview, create
   * the worktree, cut the branch, dispatch.
   *
   * Split out of `implement()` for issue #184's route. The route cannot hold an HTTP request open
   * for the length of an implement session, and more importantly it should not: the renderer
   * streams the session by id through the routes it already speaks, which is precisely how a
   * session gets started *inside the ticket's worktree* without the renderer ever being handed
   * that worktree's path. What comes back here is an id, a branch and a base commit — the path
   * stays on the daemon side of the boundary.
   */
  async start(request: ImplementRequest): Promise<ImplementStartResult> {
    const spec = this.#validateSpec(request.spec);
    if (!request.repositoryPath.trim()) {
      throw new ImplementOrchestratorError('invalid_request', 'a repository path is required');
    }
    const branch = ticketBranchName(spec.issue.number);

    const preview = await this.#preview(request, branch);
    if (preview.secretRisk && request.acknowledgeIncludeSecretRisk !== true) {
      throw new ImplementOrchestratorError(
        'worktree_secret_risk',
        'this repository’s .worktreeinclude would copy a secret-shaped file into the agent worktree',
        preview.includeFiles.slice(0, 20),
      );
    }

    const worktree = await this.#createWorktree(request, branch);
    const location = this.#worktrees.ownedLocation(worktree.id);
    if (!location) {
      throw new ImplementOrchestratorError(
        'worktree_failed',
        'the newly created worktree could not be located',
      );
    }

    const baseCommit = await this.#createBranch(location.path, branch);
    // Captured before the agent runs, so the commit step can tell whether the worktree still
    // points at the repository the daemon created it from.
    const gitPointer = await this.#readGitPointer(location.path);
    const session = await this.#runSession(request, spec, location.path);
    if (session.ended) {
      this.#commitWhenEnded(location.path, branch, spec, gitPointer, session.ended);
    }

    return {
      worktreeId: worktree.id,
      worktreePath: location.path,
      branch,
      baseCommit,
      sessionId: session.sessionId,
      ...(session.tokensUsed ? { tokensUsed: session.tokensUsed } : {}),
    };
  }

  /**
   * Reads what is on the ticket branch. If the session this daemon dispatched into the worktree has
   * ended, first waits for the daemon's own commit of its work, and surfaces a refused or failed
   * commit as `commit_failed` rather than as an empty, successful-looking result. While the session
   * is still running it reads the branch as it is and never commits partial work.
   *
   * Issue #192: once the session has ended (by this daemon's own observation, not a guess) and
   * `commits` comes back empty, that is no longer reported as an ordinary success either. It throws
   * `implement_empty_diff` instead -- `headCommit === baseCommit` after a completed, failed or
   * cancelled session is exactly the shape #191's incident left behind: a session that terminated
   * cleanly, returned a session id, and touched nothing. A session this daemon cannot observe (no
   * `PendingCommit` record -- a restarted daemon, or a port with no way to see termination) gets none
   * of this: `sessionState` is left off the result and the branch is reported exactly as git has it,
   * the same as before this ticket, because there is no terminal event to have detected.
   */
  async collect(request: ImplementCollectRequest): Promise<ImplementCollectResult> {
    if (!request.worktreePath.trim()) {
      throw new ImplementOrchestratorError('invalid_request', 'a worktree path is required');
    }
    if (!SHA_PATTERN.test(request.baseCommit)) {
      throw new ImplementOrchestratorError('invalid_request', 'a full base commit sha is required');
    }
    const pending = this.#pendingCommits.get(request.worktreePath);
    let sessionState: ImplementSessionStateV1 | undefined;
    if (pending) {
      if (pending.sessionEnded) {
        const outcome = await pending.outcome;
        if (outcome.kind === 'refused') throw outcome.error;
        sessionState = outcome.kind === 'session_not_completed' ? outcome.end : 'completed';
      } else {
        sessionState = 'running';
      }
    }
    const headCommit = await this.#resolveHead(request.worktreePath, request.branch);
    const commits = await this.#commitsSince(request.worktreePath, request.baseCommit, headCommit);
    if (sessionState !== undefined && sessionState !== 'running' && commits.length === 0) {
      throw new ImplementOrchestratorError(
        'implement_empty_diff',
        `the implement session ended (${sessionState}) without committing any changes`,
      );
    }
    return { headCommit, commits, ...(sessionState !== undefined ? { sessionState } : {}) };
  }

  /**
   * Reads the unified diff for a commit range already known to exist in the worktree (issue #90's
   * stack, step 2) — a plain `git diff`, never a checkout or a command that runs a repository hook,
   * so this needs none of `#commitWork`'s `NO_REPO_CODE` hardening, the same reasoning
   * `#resolveHead`/`#commitsSince` above already rest on.
   *
   * Mirrors `review-gates.ts`'s own `#readDiff` (`git diff --numstat` for the stats, then
   * `git diff --patch --no-color` for the text) rather than importing it: that module's version is
   * shaped around feeding an LLM pass (it also returns `ReviewInputCompletenessV1`), and duplicating
   * two `git diff` invocations here is cheaper than threading a review-shaped return type back out
   * through a route that has nothing to do with Review.
   */
  async diff(request: ImplementDiffRequest): Promise<ImplementDiffResult> {
    if (!request.worktreePath.trim()) {
      throw new ImplementOrchestratorError('invalid_request', 'a worktree path is required');
    }
    if (!SHA_PATTERN.test(request.baseCommit) || !SHA_PATTERN.test(request.headCommit)) {
      throw new ImplementOrchestratorError('invalid_request', 'a full base and head commit sha are required');
    }
    const range = `${request.baseCommit}..${request.headCommit}`;
    let numstat: GitCommandResult;
    let patch: GitCommandResult;
    try {
      numstat = await this.#runGit(['diff', '--numstat', '--end-of-options', range], request.worktreePath);
      if (numstat.code !== 0) {
        throw new ImplementOrchestratorError('diff_unavailable', 'could not read the diff for this range');
      }
      patch = await this.#runGit(
        ['diff', '--patch', '--no-color', '--end-of-options', range],
        request.worktreePath,
      );
      if (patch.code !== 0) {
        throw new ImplementOrchestratorError('diff_unavailable', 'could not read the diff for this range');
      }
    } catch (error) {
      if (error instanceof ImplementOrchestratorError) throw error;
      // git itself failed to run rather than exiting non-zero -- same class of failure
      // review-gates.ts's own `#readDiff` catch guards against (e.g. pipenzo-git.ts's maxBuffer cap).
      throw new ImplementOrchestratorError('diff_unavailable', 'could not read the diff for this range');
    }
    const stats = summarizeNumstat(numstat.stdout);
    const truncated = patch.stdout.length > MAX_IMPLEMENT_DIFF_CHARS;
    return {
      diffText: truncated ? patch.stdout.slice(0, MAX_IMPLEMENT_DIFF_CHARS) : patch.stdout,
      truncated,
      ...stats,
    };
  }

  /** Start plus collect, for a caller that can await the whole phase (the composition tests do). */
  async implement(request: ImplementRequest): Promise<ImplementResult> {
    const started = await this.start(request);
    await this.#pendingCommits.get(started.worktreePath)?.outcome;
    const collected = await this.collect({
      worktreePath: started.worktreePath,
      branch: started.branch,
      baseCommit: started.baseCommit,
    });
    return { ...started, ...collected };
  }

  #validateSpec(spec: RefineSpecV1): RefineSpecV1 {
    const parsed = refineSpecV1Schema.safeParse(spec);
    if (!parsed.success) {
      throw new ImplementOrchestratorError(
        'invalid_spec',
        'implement requires a valid v1 refine spec',
        parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`),
      );
    }
    return parsed.data;
  }

  async #preview(request: ImplementRequest, branch: string): Promise<WorktreePreviewLike> {
    try {
      return await this.#worktrees.preview({
        cwd: request.repositoryPath,
        name: branch,
        ...(request.baseRef ? { ref: request.baseRef } : {}),
      });
    } catch (error) {
      throw this.#worktreeFailure(error, 'worktree preview failed');
    }
  }

  async #createWorktree(request: ImplementRequest, branch: string): Promise<OwnedWorktreeV2> {
    try {
      return await this.#worktrees.create({
        cwd: request.repositoryPath,
        name: branch,
        ...(request.baseRef ? { ref: request.baseRef } : {}),
        confirmIncludeCopy: true,
      });
    } catch (error) {
      throw this.#worktreeFailure(error, 'worktree creation failed');
    }
  }

  #worktreeFailure(error: unknown, fallback: string): ImplementOrchestratorError {
    if (error instanceof ImplementOrchestratorError) return error;
    if (error instanceof WorktreeManagerError) {
      return new ImplementOrchestratorError(
        error.code === 'workspace_untrusted' ? 'workspace_untrusted' : 'worktree_failed',
        error.message,
        [error.code],
      );
    }
    return new ImplementOrchestratorError(
      'worktree_failed',
      error instanceof Error ? error.message : fallback,
    );
  }

  /**
   * Turns agentdock's detached owned worktree into the ticket's branch.
   *
   * `git switch --create` fails rather than silently reusing an existing branch of the same name,
   * which is the behaviour worth having: two tickets resolving to one branch would defeat exactly
   * the isolation README's Team-usage section says the design depends on.
   */
  async #createBranch(cwd: string, branch: string): Promise<string> {
    const head = await this.#runGit(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], cwd);
    const baseCommit = head.stdout.trim();
    if (head.code !== 0 || !SHA_PATTERN.test(baseCommit)) {
      throw new ImplementOrchestratorError(
        'branch_failed',
        'the owned worktree has no resolvable HEAD commit',
      );
    }
    const created = await this.#runGit(['switch', '--create', branch, '--no-guess'], cwd);
    if (created.code !== 0) {
      throw new ImplementOrchestratorError(
        'branch_failed',
        `could not create branch ${branch} in the owned worktree`,
        [created.stderr.trim().slice(0, 500)],
      );
    }
    return baseCommit;
  }

  async #runSession(
    request: ImplementRequest,
    spec: RefineSpecV1,
    cwd: string,
  ): Promise<ImplementSessionOutcome> {
    try {
      return await this.#sessions.run({
        provider: request.provider,
        cwd,
        prompt: appendOperatorInstructions(buildImplementPrompt(spec), request.extraInstructions),
        ...(request.model ? { model: request.model } : {}),
      });
    } catch (error) {
      throw new ImplementOrchestratorError(
        'session_failed',
        error instanceof Error ? error.message : 'the implement session failed',
      );
    }
  }

  #commitWhenEnded(
    worktreePath: string,
    branch: string,
    spec: RefineSpecV1,
    gitPointer: string | undefined,
    ended: Promise<ImplementSessionEnd>,
  ): void {
    const pending = { sessionEnded: false } as PendingCommit;
    pending.outcome = ended
      .then(
        (end) => end,
        (): ImplementSessionEnd => 'failed',
      )
      .then(async (end): Promise<CommitOutcome> => {
        pending.sessionEnded = true;
        // A failed or cancelled session's half-finished edits are left in the worktree for a human
        // to look at, never committed as though they were the work.
        if (end !== 'completed') return { kind: 'session_not_completed', end };
        return this.#commitWork(worktreePath, branch, spec, gitPointer);
      })
      .catch((error: unknown): CommitOutcome => ({
        kind: 'refused',
        error:
          error instanceof ImplementOrchestratorError
            ? error
            : new ImplementOrchestratorError(
                'commit_failed',
                'the daemon could not commit the implement worktree',
              ),
      }));
    this.#pendingCommits.set(worktreePath, pending);
  }

  /**
   * The daemon's own commit of what the completed session wrote — the same trust boundary as
   * `#createBranch` and the eventual publish. The agent is told not to commit and, on Claude, has
   * no tool that could; this runs in the daemon, through the hardened `runGitCommand` environment,
   * with every repository hook and fsmonitor switched off (`NO_REPO_CODE`), after the session's
   * terminal event.
   *
   * Refuses rather than commits when the worktree's `.git` pointer changed, when it is no longer on
   * the ticket branch, or when the staged set contains a secret-shaped path (the same test
   * `.worktreeinclude` previews use): staging "everything the agent left" must not be how a copied
   * `.env` ends up on a branch the publish step pushes.
   */
  async #commitWork(
    cwd: string,
    branch: string,
    spec: RefineSpecV1,
    gitPointer: string | undefined,
  ): Promise<CommitOutcome> {
    const git = (args: readonly string[]) => this.#runGit([...NO_REPO_CODE, ...args], cwd);
    const fail = (message: string, details: readonly string[] = []): never => {
      throw new ImplementOrchestratorError('commit_failed', message, details);
    };

    // The worktree's `.git` file sits inside the agent's working directory. Rewritten to point at
    // an agent-built git directory, its config could name a filter, gpg program or hook the
    // commands below would run, so nothing runs unless it is exactly what it was before the session.
    if (!gitPointer || (await this.#readGitPointer(cwd)) !== gitPointer) {
      fail('the worktree’s .git pointer changed during the session; nothing was committed');
    }

    const head = await git(['symbolic-ref', '--quiet', 'HEAD']);
    if (head.code !== 0 || head.stdout.trim() !== `refs/heads/${branch}`) {
      fail(`the worktree is no longer on ${branch}; nothing was committed`);
    }
    const added = await git(['add', '--all']);
    if (added.code !== 0)
      fail('could not stage the implement changes', [added.stderr.trim().slice(0, 500)]);
    const staged = await git(['diff', '--cached', '--name-only', '-z']);
    if (staged.code !== 0)
      fail('could not list the staged implement changes', [staged.stderr.trim().slice(0, 500)]);
    const paths = staged.stdout.split('\0').filter((path) => path.length > 0);
    if (paths.length === 0) return { kind: 'nothing_to_commit' };
    const secretShaped = paths.filter((path) => isSecretShapedPath(path));
    if (secretShaped.length > 0) {
      await git(['reset', '--quiet']);
      fail(
        'the implement session left secret-shaped files in the worktree; nothing was committed',
        secretShaped.slice(0, 20),
      );
    }
    const committed = await git([
      'commit',
      '--no-verify',
      '--quiet',
      '-m',
      buildImplementCommitMessage(spec),
    ]);
    if (committed.code !== 0) {
      fail('git commit failed in the implement worktree', [committed.stderr.trim().slice(0, 500)]);
    }
    const commit = await git(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
    const sha = commit.stdout.trim();
    if (commit.code !== 0 || !SHA_PATTERN.test(sha)) fail('the new commit does not resolve');
    return { kind: 'committed', commit: sha };
  }

  async #resolveHead(cwd: string, branch: string): Promise<string> {
    const result = await this.#runGit(
      ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`],
      cwd,
    );
    const sha = result.stdout.trim();
    if (result.code !== 0 || !SHA_PATTERN.test(sha)) {
      throw new ImplementOrchestratorError(
        'branch_failed',
        `branch ${branch} no longer resolves after the implement session`,
      );
    }
    return sha;
  }

  async #commitsSince(cwd: string, base: string, head: string): Promise<readonly string[]> {
    if (base === head) return [];
    const result = await this.#runGit(
      ['rev-list', '--reverse', '--end-of-options', `${base}..${head}`],
      cwd,
    );
    if (result.code !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => SHA_PATTERN.test(line));
  }
}

/**
 * Sums a `git diff --numstat` block into the three numbers `DiffReviewHead`'s stat row needs.
 *
 * A binary file reports `-\t-\tpath` for its added/deleted columns (numstat's own convention, the
 * same one `review-gates.ts`'s `computeDiffScope`/`parseTouchedFiles` already read) -- counted as a
 * touched file with zero changed lines, never `NaN`, since `Number('-')` is not what "no line count
 * applies" should turn into.
 */
function summarizeNumstat(numstat: string): {
  additions: number;
  deletions: number;
  filesChanged: number;
} {
  let additions = 0;
  let deletions = 0;
  let filesChanged = 0;
  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [added, deleted] = line.split('\t');
    filesChanged += 1;
    if (added !== '-') additions += Number(added) || 0;
    if (deleted !== '-') deletions += Number(deleted) || 0;
  }
  return { additions, deletions, filesChanged };
}

/**
 * Renders the spec — and only the spec — into the implementer's prompt.
 *
 * Exported so a test can assert the negative: nothing that was not in the spec appears here. The
 * function takes no issue body, no GitHub payload, and no free-form caller text, so that negative
 * is a property of the signature rather than of the wording.
 */
/**
 * Appends the operator's own note to a spec-derived prompt, under its own heading.
 *
 * A separate function rather than a second parameter on `buildImplementPrompt()`, because that
 * function's one-argument signature is the enforcement of "the implementer sees the spec and
 * nothing else" and a test asserts its arity. This composes on top of that instead of widening it:
 * the note is clearly labelled as a human's addition, and the prompt still says the spec is the
 * agreement, so an instruction that contradicts the spec reads as what it is rather than as a
 * quiet re-scoping.
 */
export function appendOperatorInstructions(prompt: string, extraInstructions?: string): string {
  const note = extraInstructions?.trim();
  if (!note) return prompt;
  return [
    prompt,
    '',
    'Extra instructions from the operator who started this run',
    '  These were typed by a human alongside the Start button. They add to the spec above; they do',
    '  not replace it, and they do not widen what is in scope.',
    ...note.split(/\r?\n/).map((line) => `  ${line}`),
  ].join('\n');
}

export function buildImplementPrompt(spec: RefineSpecV1): string {
  const criteria = spec.acceptanceCriteria.map(
    (criterion) => `  ${criterion.id} (${criterion.kind}): ${criterion.text}`,
  );
  const outOfScope = spec.outOfScope.map((entry) => `  - ${entry}`);
  const files = spec.filesLikelyTouched.map((path) => `  - ${path}`);
  const questions = spec.openQuestions.map((entry) => `  - ${entry}`);
  return [
    'You are the Implement phase of an issue-to-PR loop. A separate read-only Refine phase already',
    'decided what this ticket is and is not. Implement exactly that spec in this worktree by',
    'editing files. Do not re-scope, do not expand beyond it, and do not go looking for the',
    'original ticket text — the spec below is the agreement.',
    '',
    'Do not commit. Leave your changes in the working tree: when your session ends, the daemon',
    'commits them to this ticket’s branch itself.',
    '',
    'You cannot push and you cannot open a pull request. Publishing is a daemon-side action a human',
    'triggers after reviewing your diff; there is no tool here that does it, and attempting it is a',
    'wasted turn.',
    '',
    `Ticket: ${spec.issue.repo}#${spec.issue.number} — ${spec.issue.title}`,
    '',
    'Summary',
    `  ${spec.summary}`,
    '',
    'Acceptance criteria (EARS notation — every one of these must hold when you are done)',
    ...criteria,
    '',
    'Explicitly out of scope',
    ...outOfScope,
    ...(files.length > 0 ? ['', 'Files the refine phase expects to be touched', ...files] : []),
    ...(questions.length > 0
      ? [
          '',
          'Open questions the refine phase could not resolve. If one of these blocks you, stop and',
          'say so rather than guessing:',
          ...questions,
        ]
      : []),
    '',
    'Size agreement',
    `  The refine phase predicted ${spec.estimate.changedLines} changed lines across`,
    `  ${spec.estimate.filesTouched} files. That prediction is checked against your real diff at`,
    '  review. Staying near it is part of the work, not a nicety.',
  ].join('\n');
}
