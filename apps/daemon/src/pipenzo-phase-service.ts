import type {
  PipenzoCaptureCapabilityRequestV1,
  PipenzoCaptureCapabilityV1,
  PipenzoImplementCommitsV1,
  PipenzoImplementRequestV1,
  PipenzoImplementResultQueryV1,
  PipenzoImplementResultV1,
  PipenzoIssueClaimRequestV1,
  PipenzoIssueClaimResultV1,
  PipenzoIssueCreateRequestV1,
  PipenzoIssueCreateResultV1,
  PipenzoPhaseErrorCodeV1,
  PipenzoRefineRequestV1,
  PipenzoRefineResultV1,
  PipenzoReviewRequestV1,
  PipenzoReviewResultV1,
} from '@agent-dock/shared';
import {
  GitHubClientError,
  parseRepoRef,
  resolveConfiguredRepo,
  type GitHubClient,
  type RepoRef,
} from './github-client.js';
import { RefineSubagent, RefinePhaseError, type RefineSessionPort } from './refine-subagent.js';
import {
  ImplementOrchestrator,
  ImplementOrchestratorError,
  type ImplementSessionPort,
  type ImplementWorktreeManager,
} from './implement-orchestrator.js';
import {
  ReviewGateError,
  ReviewGatesRunner,
  type GateCommandRunner,
  type ReviewSessionPort,
  type SpecTestGeneratorPort,
} from './review-gates.js';
import type { OwnedWorktreeLocator } from './publish-service.js';
import type { PipenzoGitRunner } from './pipenzo-git.js';
import { detectScreenshotCapability } from './screenshot-capture.js';
import { readPipenzoRepoConfig, type PipenzoCommandConfig } from './pipenzo-repo-config.js';

/**
 * The one service the Refine / Implement / Review routes call (Pipenzo issue #184).
 *
 * The three phase modules from #179-181 were built as libraries with ports, and until now nothing
 * in the daemon composed them — only the publish service had a route. This is that composition,
 * and it is deliberately thin: it resolves ids to the things the modules need, calls exactly one
 * module method per route, and maps each module's own closed error union onto the wire's closed
 * union. It contains no phase logic of its own, because a second place that decides what a phase
 * does is a second place that can decide it differently.
 *
 * ## The property it exists to hold
 *
 * **A worktree is addressed by id here, and only by id.** `ownedLocation()` is called inside this
 * service and its result never leaves it: the implement result carries a worktree id, a branch and
 * two commit shas; the review request takes a worktree id. So the renderer can say "review the
 * work in this ticket's worktree" and "start a session in it" without ever having been told, or
 * being able to influence, where on disk that is. This is the same rule
 * `pipenzoPublishRequestV1Schema` already follows, applied to the three phases that were missing
 * it.
 *
 * ## Which phases block a request and which do not
 *
 * Refine and Review run to completion inside the route, because both produce a *value* the UI
 * needs as a whole — a validated spec, a review report. Implement does not: it creates the
 * worktree, cuts the branch, dispatches the session and returns. The implement session is long,
 * and its output is a stream the renderer already knows how to render; holding an HTTP request
 * open for it would buy nothing and lose the progress the operator wants to watch.
 * `implementResult()` is the second half, read whenever the operator wants the commits.
 */

export class PipenzoPhaseError extends Error {
  readonly code: PipenzoPhaseErrorCodeV1;
  readonly details: readonly string[];

  constructor(
    code: PipenzoPhaseErrorCodeV1,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PipenzoPhaseError';
    this.code = code;
    this.details = details.slice(0, 20).map((detail) => detail.slice(0, 500));
  }
}

export interface PipenzoPhaseServiceOptions {
  /** Runs a session to completion and reports what it produced. Refine and Review need this. */
  refineSessions: RefineSessionPort;
  reviewSessions: ReviewSessionPort;
  /** Dispatch-only. Implement returns as soon as the provider has the session. */
  implementSessions: ImplementSessionPort;
  worktrees: ImplementWorktreeManager & OwnedWorktreeLocator;
  /** Built lazily from a token read at call time, so no authenticated client is retained. */
  github?: () => GitHubClient;
  commands: GateCommandRunner;
  specTests?: SpecTestGeneratorPort;
  runGit?: PipenzoGitRunner;
  buildCommand?: readonly string[];
  typecheckCommand?: readonly string[];
  testCommand?: readonly string[];
  /**
   * The daemon's own environment. Explicit rather than ambient for the same reason the publish
   * service takes it explicitly: a test can prove what this service reads.
   */
  env?: Readonly<Record<string, string | undefined>>;
}

export class PipenzoPhaseService {
  readonly #refine: RefineSubagent;
  readonly #implement: ImplementOrchestrator;
  readonly #review: ReviewGatesRunner;
  readonly #worktrees: ImplementWorktreeManager & OwnedWorktreeLocator;
  readonly #github: (() => GitHubClient) | undefined;
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(options: PipenzoPhaseServiceOptions) {
    this.#refine = new RefineSubagent(options.refineSessions);
    this.#implement = new ImplementOrchestrator({
      worktrees: options.worktrees,
      sessions: options.implementSessions,
      ...(options.runGit ? { runGit: options.runGit } : {}),
    });
    this.#review = new ReviewGatesRunner({
      commands: options.commands,
      sessions: options.reviewSessions,
      ...(options.specTests ? { specTests: options.specTests } : {}),
      ...(options.runGit ? { runGit: options.runGit } : {}),
      ...(options.buildCommand ? { buildCommand: options.buildCommand } : {}),
      ...(options.typecheckCommand ? { typecheckCommand: options.typecheckCommand } : {}),
      ...(options.testCommand ? { testCommand: options.testCommand } : {}),
    });
    this.#worktrees = options.worktrees;
    this.#github = options.github;
    this.#env = options.env ?? process.env;
  }

  /* ---------------------------------------------------------------- refine */

  async refine(request: PipenzoRefineRequestV1): Promise<PipenzoRefineResultV1> {
    const ref = this.#resolveRepo(request.repo);
    const github = this.#requireGitHub();
    let issue;
    try {
      issue = await github.getIssue(ref, request.issueNumber);
    } catch (error) {
      throw toPhaseError(error);
    }
    try {
      const result = await this.#refine.refine({
        issue: {
          repo: `${ref.owner}/${ref.repo}`,
          number: issue.number,
          title: issue.title,
          body: issue.body,
        },
        cwd: request.repositoryPath,
        provider: request.provider,
        ...(request.model ? { model: request.model } : {}),
      });
      return { sessionId: result.sessionId, spec: result.spec, toolsUsed: [...result.toolsUsed] };
    } catch (error) {
      throw toPhaseError(error);
    }
  }

  /* ------------------------------------------------------------- implement */

  async implement(request: PipenzoImplementRequestV1): Promise<PipenzoImplementResultV1> {
    let started;
    try {
      started = await this.#implement.start({
        spec: request.spec,
        repositoryPath: request.repositoryPath,
        provider: request.provider,
        ...(request.model ? { model: request.model } : {}),
        ...(request.baseRef ? { baseRef: request.baseRef } : {}),
        ...(request.extraInstructions ? { extraInstructions: request.extraInstructions } : {}),
        ...(request.acknowledgeIncludeSecretRisk === true
          ? { acknowledgeIncludeSecretRisk: true as const }
          : {}),
      });
    } catch (error) {
      throw toPhaseError(error);
    }
    // `started.worktreePath` is dropped here, on purpose and by hand. It is the whole point of the
    // route: everything else travels, the path does not.
    return {
      worktreeId: started.worktreeId,
      branch: started.branch,
      baseCommit: started.baseCommit,
      sessionId: started.sessionId,
    };
  }

  async implementResult(
    request: PipenzoImplementResultQueryV1,
  ): Promise<PipenzoImplementCommitsV1> {
    const location = this.#worktrees.ownedLocation(request.worktreeId);
    if (!location) {
      throw new PipenzoPhaseError('worktree_not_found', 'no such owned worktree');
    }
    try {
      const collected = await this.#implement.collect({
        worktreePath: location.path,
        branch: request.branch,
        baseCommit: request.baseCommit,
      });
      return {
        worktreeId: request.worktreeId,
        branch: request.branch,
        baseCommit: request.baseCommit,
        headCommit: collected.headCommit,
        commits: [...collected.commits],
      };
    } catch (error) {
      throw toPhaseError(error);
    }
  }

  /* ---------------------------------------------------------------- review */

  async review(request: PipenzoReviewRequestV1): Promise<PipenzoReviewResultV1> {
    const location = this.#worktrees.ownedLocation(request.worktreeId);
    if (!location) {
      throw new PipenzoPhaseError('worktree_not_found', 'no such owned worktree');
    }
    try {
      return await this.#review.run({
        spec: request.spec,
        worktreePath: location.path,
        baseCommit: request.baseCommit,
        headCommit: request.headCommit,
        implementerTier: request.implementerTier,
        ...(request.implementerProvider
          ? { implementerProvider: request.implementerProvider }
          : {}),
        reviewer: request.reviewer,
        verifier: request.verifier,
      });
    } catch (error) {
      throw toPhaseError(error);
    }
  }

  /* -------------------------------------------------- capability detection */

  /**
   * What screenshot verification would actually do for this repository right now (issue #124).
   *
   * A real probe, not configuration: `detectScreenshotCapability()` resolves Playwright from the
   * repository without loading it, and the escape hatch is read from the repository's own
   * committed `package.json`. README requires both capabilities degrade to a *stated* reduced mode
   * rather than an error, so a `false` here always travels with the reason for it.
   *
   * `activeTrustClass` applies the same selection rule `ScreenshotVerificationRunner` uses, in one
   * place: Playwright present means the agent-proposed manifest, always. A repository configuring
   * both does not get to swap in the weaker trust class by listing it.
   */
  async captureCapabilities(
    request: PipenzoCaptureCapabilityRequestV1,
  ): Promise<PipenzoCaptureCapabilityV1> {
    const capability = detectScreenshotCapability(request.repositoryPath);
    let escapeHatch: PipenzoCommandConfig | undefined;
    let escapeHatchReason: string | undefined;
    try {
      escapeHatch = (await readPipenzoRepoConfig(request.repositoryPath)).screenshot;
      if (!escapeHatch) {
        escapeHatchReason = 'this repository configures no pipenzo.verify.screenshot command';
      }
    } catch (error) {
      // A malformed `pipenzo` block is reported as such rather than as "not configured": a
      // repository that tried to configure this and got it wrong must not look like one that
      // never tried.
      escapeHatchReason =
        error instanceof Error ? error.message : 'the repository pipenzo config is unreadable';
    }
    return {
      schemaVersion: 1,
      screenshot: capability.available
        ? { available: true, packageName: capability.packageName }
        : { available: false, reason: capability.reason },
      escapeHatch: escapeHatch
        ? { configured: true }
        : { configured: false, ...(escapeHatchReason ? { reason: escapeHatchReason } : {}) },
      activeTrustClass: capability.available
        ? 'agent-proposed-manifest'
        : escapeHatch
          ? 'repo-authored-command'
          : null,
    };
  }

  /* ------------------------------------------------------ github issue ops */

  /**
   * README's claim rule, both halves, in one place the renderer cannot half-execute.
   *
   * Assign, then re-read the issue *uncached*, then compare. The re-read is a second request
   * rather than a read of the write's own response body because the write's echo cannot see an
   * assignment that landed a millisecond after it — which is exactly the race the rule exists for.
   * When the re-read shows somebody else, this returns `claimed_elsewhere` rather than throwing:
   * losing a claim race is a normal outcome with a card state of its own (README's sixth
   * Needs-human variant), not an error.
   */
  async claimIssue(request: PipenzoIssueClaimRequestV1): Promise<PipenzoIssueClaimResultV1> {
    const ref = this.#resolveRepo(request.repo);
    const github = this.#requireGitHub();
    try {
      // Resolved daemon-side when the caller did not name one. The token is here, so the identity
      // is here — a renderer-supplied login would let one operator claim a ticket as another.
      const assignee = request.assignee ?? (await github.getAuthenticatedLogin());
      await github.assignIssue(ref, request.issueNumber, assignee);
      const confirmed = await github.getIssue(ref, request.issueNumber);
      const others = confirmed.assignees.filter((login) => login !== assignee);
      return {
        repo: `${ref.owner}/${ref.repo}`,
        issueNumber: confirmed.number,
        outcome:
          confirmed.assignees.includes(assignee) && others.length === 0
            ? 'claimed'
            : 'claimed_elsewhere',
        assignees: [...confirmed.assignees],
        title: confirmed.title,
        htmlUrl: confirmed.htmlUrl,
      };
    } catch (error) {
      throw toPhaseError(error);
    }
  }

  async createIssue(request: PipenzoIssueCreateRequestV1): Promise<PipenzoIssueCreateResultV1> {
    const ref = this.#resolveRepo(request.repo);
    const github = this.#requireGitHub();
    try {
      const issue = await github.createIssue(ref, {
        title: request.title,
        body: request.body,
        ...(request.labels ? { labels: request.labels } : {}),
      });
      return {
        repo: `${ref.owner}/${ref.repo}`,
        issueNumber: issue.number,
        title: issue.title,
        htmlUrl: issue.htmlUrl,
      };
    } catch (error) {
      throw toPhaseError(error);
    }
  }

  #resolveRepo(repo: string | undefined): RepoRef {
    try {
      return repo ? parseRepoRef(repo) : resolveConfiguredRepo(this.#env);
    } catch (error) {
      throw toPhaseError(error);
    }
  }

  #requireGitHub(): GitHubClient {
    if (!this.#github) {
      throw new PipenzoPhaseError(
        'token_missing',
        'no GitHub credential is configured for this daemon',
      );
    }
    try {
      return this.#github();
    } catch (error) {
      throw toPhaseError(error);
    }
  }
}

const REFINE_CODES: Record<RefinePhaseError['code'], PipenzoPhaseErrorCodeV1> = {
  invalid_issue: 'invalid_issue',
  read_only_violation: 'read_only_violation',
  spec_invalid: 'spec_invalid',
  spec_missing: 'spec_missing',
  session_failed: 'session_failed',
};

const IMPLEMENT_CODES: Record<ImplementOrchestratorError['code'], PipenzoPhaseErrorCodeV1> = {
  invalid_spec: 'invalid_spec',
  invalid_request: 'invalid_request',
  workspace_untrusted: 'workspace_untrusted',
  worktree_failed: 'worktree_failed',
  worktree_secret_risk: 'worktree_secret_risk',
  branch_failed: 'branch_failed',
  session_failed: 'session_failed',
};

const REVIEW_CODES: Record<ReviewGateError['code'], PipenzoPhaseErrorCodeV1> = {
  invalid_spec: 'invalid_spec',
  invalid_request: 'invalid_request',
  verifier_tier_too_low: 'verifier_tier_too_low',
  diff_unavailable: 'diff_unavailable',
  reviewer_failed: 'reviewer_failed',
  verifier_failed: 'verifier_failed',
};

const GITHUB_CODES: Record<GitHubClientError['code'], PipenzoPhaseErrorCodeV1> = {
  token_missing: 'token_missing',
  invalid_repository: 'repository_not_configured',
  invalid_request: 'invalid_request',
  unauthorized: 'github_unauthorized',
  forbidden: 'github_forbidden',
  not_found: 'issue_not_found',
  rate_limited: 'github_rate_limited',
  invalid_response: 'github_failed',
  network: 'github_failed',
};

/**
 * Maps a module's own typed failure onto the wire union.
 *
 * The four `Record`s above are exhaustive by type, so adding a code to any module's union is a
 * compile error here rather than a silent fall-through to `session_failed`. Anything genuinely
 * unrecognized is flattened to a generic message and never carries the original text — an unmapped
 * error from deep in octokit or the git stack is exactly the kind of string that can carry a
 * credential, which is the same reasoning `routes/pipenzo-publish.ts` states.
 */
export function toPhaseError(error: unknown): PipenzoPhaseError {
  if (error instanceof PipenzoPhaseError) return error;
  if (error instanceof RefinePhaseError) {
    return new PipenzoPhaseError(REFINE_CODES[error.code], error.message, error.details);
  }
  if (error instanceof ImplementOrchestratorError) {
    return new PipenzoPhaseError(IMPLEMENT_CODES[error.code], error.message, error.details);
  }
  if (error instanceof ReviewGateError) {
    return new PipenzoPhaseError(REVIEW_CODES[error.code], error.message, error.details);
  }
  if (error instanceof GitHubClientError) {
    // The GitHub client redacts its own messages at construction, so this one is safe to surface.
    return new PipenzoPhaseError(GITHUB_CODES[error.code], error.message);
  }
  return new PipenzoPhaseError('session_failed', 'the phase failed');
}
