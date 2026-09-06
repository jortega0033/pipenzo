import {
  refineSpecV1Schema,
  type CreateSessionV2Request,
  type OwnedWorktreeV2,
  type ProviderId,
  type RefineSpecV1,
} from '@agent-dock/shared';
import { runGitCommand, type PipenzoGitRunner } from './pipenzo-git.js';
import { WorktreeManagerError } from './worktree-manager.js';
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
 *    run a git command, which would be the first crack in the boundary #178 exists to hold.
 *
 * ## Walking-skeleton simplifications, each owned by a later ticket
 *
 * - **No retry ladder.** One attempt. Same-tier fork vs. tier-escalation-as-fresh-session is
 *   README's step-6 territory and is deliberately not modelled here, not even as a stub.
 * - **No risk classifier and no pre-commitment records.** `apps/daemon/src/risk-classifier.ts` is
 *   named in README's build step 6 and does not exist yet; nothing here pretends to grade risk.
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
  | 'session_failed';

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

export interface ImplementSessionOutcome {
  readonly sessionId: string;
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
}

export interface ImplementCollectRequest {
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
}

export interface ImplementCollectResult {
  readonly headCommit: string;
  /** Commits the session produced, oldest first. Empty means the agent committed nothing. */
  readonly commits: readonly string[];
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
  readonly sessionId: string;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;

export class ImplementOrchestrator {
  readonly #worktrees: ImplementWorktreeManager;
  readonly #sessions: ImplementSessionPort;
  readonly #runGit: PipenzoGitRunner;

  constructor(options: {
    worktrees: ImplementWorktreeManager;
    sessions: ImplementSessionPort;
    runGit?: PipenzoGitRunner;
  }) {
    this.#worktrees = options.worktrees;
    this.#sessions = options.sessions;
    this.#runGit = options.runGit ?? runGitCommand;
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
    const session = await this.#runSession(request, spec, location.path);

    return {
      worktreeId: worktree.id,
      worktreePath: location.path,
      branch,
      baseCommit,
      sessionId: session.sessionId,
    };
  }

  /** Reads what the dispatched session actually committed. Pure git, no session involvement. */
  async collect(request: ImplementCollectRequest): Promise<ImplementCollectResult> {
    if (!request.worktreePath.trim()) {
      throw new ImplementOrchestratorError('invalid_request', 'a worktree path is required');
    }
    if (!SHA_PATTERN.test(request.baseCommit)) {
      throw new ImplementOrchestratorError('invalid_request', 'a full base commit sha is required');
    }
    const headCommit = await this.#resolveHead(request.worktreePath, request.branch);
    return {
      headCommit,
      commits: await this.#commitsSince(request.worktreePath, request.baseCommit, headCommit),
    };
  }

  /** Start plus collect, for a caller that can await the whole phase (the composition tests do). */
  async implement(request: ImplementRequest): Promise<ImplementResult> {
    const started = await this.start(request);
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
    'decided what this ticket is and is not. Implement exactly that spec in this worktree, and',
    'commit your work. Do not re-scope, do not expand beyond it, and do not go looking for the',
    'original ticket text — the spec below is the agreement.',
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
