import type { Logger } from '@agent-dock/agent-runtime';
import type {
  PipenzoIdeaDraftRequestV1,
  PipenzoIdeaDraftResultV1,
  PipenzoCaptureCapabilityRequestV1,
  PipenzoCaptureCapabilityV1,
  PipenzoImplementCommitsV1,
  PipenzoImplementRequestV1,
  PipenzoImplementResultQueryV1,
  PipenzoImplementResultV1,
  PipenzoIssueClaimRequestV1,
  PipenzoIssueClaimResultV1,
  PipenzoIssueCommentRequestV1,
  PipenzoIssueCommentResultV1,
  PipenzoIssueCreateRequestV1,
  PipenzoIssueCreateResultV1,
  PipenzoPhaseErrorCodeV1,
  PipenzoRefineRequestV1,
  PipenzoRefineResultV1,
  PipenzoReviewRequestV1,
  PipenzoReviewResultV1,
  RefineEstimateV1,
  RefineProposedSplitPartV1,
} from '@agent-dock/shared';
import { PIPENZO_DIFF_SIZE_THRESHOLDS } from '@agent-dock/shared';
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
import { IssueDraftError, IssueDrafter } from './issue-drafter.js';
import { readPipenzoRepoConfig, type PipenzoCommandConfig } from './pipenzo-repo-config.js';
import type { PipenzoPhaseMachine } from './pipenzo-phase-machine.js';
import { evaluateDiffSizeGate } from './refine-gate.js';

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
  /**
   * The phase machine (issue #144), narrowed to `read` and `transition`. Optional so a service
   * built without one (every test that predates this ticket) still reviews exactly as before — it
   * just has nothing to transition an `estimate_blown` outcome onto. Not the same object review()
   * builds its GitHub client from: the machine resolves its own client internally, the same lazy,
   * per-call pattern this service already uses everywhere else. `read` is here (and not just
   * `transition`) so a retried review of the same outcome can tell it already recorded this one --
   * see `#reportBlownEstimate`.
   */
  machine?: Pick<PipenzoPhaseMachine, 'read' | 'transition'>;
  /** Logs a failed blown-estimate consequence without failing the review call that produced a
   * perfectly good report — see `review()`'s own comment for why. */
  logger?: Logger;
}

export class PipenzoPhaseService {
  readonly #refine: RefineSubagent;
  readonly #drafter: IssueDrafter;
  readonly #implement: ImplementOrchestrator;
  readonly #review: ReviewGatesRunner;
  readonly #worktrees: ImplementWorktreeManager & OwnedWorktreeLocator;
  readonly #github: (() => GitHubClient) | undefined;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #machine: Pick<PipenzoPhaseMachine, 'read' | 'transition'> | undefined;
  readonly #logger: Logger | undefined;

  constructor(options: PipenzoPhaseServiceOptions) {
    this.#refine = new RefineSubagent(options.refineSessions);
    // The drafter runs on the refine session port on purpose: drafting an issue is the one moment
    // a model is asked to imagine work that does not exist, and a write would let it make its own
    // draft true. See `issue-drafter.ts`.
    this.#drafter = new IssueDrafter(options.refineSessions);
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
    this.#machine = options.machine;
    this.#logger = options.logger;
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
    const conventions = await this.#readConventions(request.repositoryPath);
    let result: { sessionId: string; spec: PipenzoRefineResultV1['spec']; toolsUsed: readonly string[] };
    try {
      result = await this.#refine.refine({
        issue: {
          repo: `${ref.owner}/${ref.repo}`,
          number: issue.number,
          title: issue.title,
          body: issue.body,
        },
        cwd: request.repositoryPath,
        provider: request.provider,
        ...(request.model ? { model: request.model } : {}),
        ...(conventions ? { conventions } : {}),
      });
    } catch (error) {
      throw toPhaseError(error);
    }

    // README's diff-size gate (issue #270): a pure decision over the spec's own estimate, reported
    // on the wire rather than left for a renderer to re-derive (see refineGateVerdictV1Schema's
    // doc comment). Outside the try above: the spec is already valid and already the thing refine()
    // promises to return, and the gate itself cannot throw -- it is a pure function.
    const gateVerdict = evaluateDiffSizeGate(result.spec.estimate);

    // Same reasoning as #144/#266's review-time consequence: a refusal's transition + comment is
    // real but secondary, best-effort and logged, never turning a successful refine into an error.
    if (gateVerdict === 'refuse' && request.ticketId) {
      await this.#reportRefusal(request.ticketId, result.spec);
    }

    return {
      sessionId: result.sessionId,
      spec: result.spec,
      toolsUsed: [...result.toolsUsed],
      gateVerdict,
    };
  }

  /**
   * The actual consequence of a diff-size-gate refusal (issue #270): transitions the ticket to
   * `pipenzo:needs-pre-scoping`, then posts the estimate and what tripped as a comment on its
   * issue. Guarded against a retried `refine()` double-posting the same way
   * `#reportBlownEstimate` is (#266) -- `read()` first, skip both writes if the ticket is already
   * on `pipenzo:needs-pre-scoping`.
   */
  /**
   * Repo-wide conventions (issue #284), read from the trusted *source* repository -- never a
   * worktree, per `pipenzo-repo-config.ts`'s ownership rule (an agent-writable copy feeding a
   * future Review prompt would be a prompt-injection vector, the exact thing that rule closes off).
   *
   * Degrades to "no conventions" rather than failing the whole Refine/Review call: the same
   * "stated reduced mode rather than an error" rule `captureCapabilities()` already applies to a
   * malformed `pipenzo` block, applied here because a maintainer's typo in prose must not block
   * every future ticket's Refine or Review from running at all.
   */
  async #readConventions(sourceRepositoryPath: string): Promise<string | undefined> {
    try {
      return (await readPipenzoRepoConfig(sourceRepositoryPath)).conventions;
    } catch (error) {
      this.#logger?.warn('could not read pipenzo.conventions; continuing without it', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async #reportRefusal(ticketId: string, spec: PipenzoRefineResultV1['spec']): Promise<void> {
    if (!this.#machine) return;
    try {
      const current = await this.#machine.read(ticketId);
      if (current.ticket.labels.includes('pipenzo:needs-pre-scoping')) return;
      const result = await this.#machine.transition(ticketId, 'pipenzo:needs-pre-scoping');
      const github = this.#requireGitHub();
      const ref = parseRepoRef(result.ticket.repo);
      await github.createIssueComment(
        ref,
        result.ticket.issueNumber,
        refusalCommentBody(spec.estimate, spec.proposedSplit),
      );
    } catch (error) {
      this.#logger?.warn('could not record a diff-size refusal against its ticket', {
        ticketId,
        error: error instanceof Error ? error.message : String(error),
      });
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
    const conventions = await this.#readConventions(location.sourcePath);
    let report: PipenzoReviewResultV1;
    try {
      report = await this.#review.run({
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
        ...(conventions ? { conventions } : {}),
      });
    } catch (error) {
      throw toPhaseError(error);
    }

    // Outside the try above, and its own try below: the report is already valid and already the
    // thing this call promises to return. A blown estimate's consequence (issue #144) is real but
    // secondary -- a label write and a GitHub comment that fails must not turn a successful review
    // into a thrown error, the same reasoning `crash-recovery.ts`'s best-effort label write uses.
    if (report.outcome === 'estimate_blown' && request.ticketId) {
      await this.#reportBlownEstimate(request.ticketId, report);
    }

    return report;
  }

  /**
   * The actual consequence of `estimate_blown` (issue #144): transitions the ticket to
   * `pipenzo:awaiting-stack-approval`, then posts the real-vs-predicted numbers as a comment on its
   * issue. Best-effort and logged, never thrown -- see `review()`'s own comment for why.
   *
   * ## Guarded against a retried `review()` call double-posting
   *
   * `GitHubClient.createIssueComment`'s own doc comment says plainly that GitHub has no
   * idempotency key for a comment and "a caller that must not double-post gates itself" — this is
   * that gate. A client that times out waiting for `/v2/pipenzo/review` after the daemon actually
   * finished (transition committed, comment posted, 200 on the wire the client never saw) has a
   * real, natural reason to retry the identical request, and `ReviewGatesRunner.run()` would
   * reproduce `estimate_blown` again against the same worktree/commits. `read()` first and skip
   * both the transition and the comment when the ticket is already on `awaiting-stack-approval` --
   * unlike `transition()` itself (deliberately unconditional, so a move between two Needs-human
   * variants still redraws the card, #80), the comment has no such reason to repeat for a state
   * that was already reached.
   */
  async #reportBlownEstimate(ticketId: string, report: PipenzoReviewResultV1): Promise<void> {
    if (!this.#machine) return;
    try {
      const current = await this.#machine.read(ticketId);
      if (current.ticket.labels.includes('pipenzo:awaiting-stack-approval')) return;
      const result = await this.#machine.transition(ticketId, 'pipenzo:awaiting-stack-approval');
      const github = this.#requireGitHub();
      const ref = parseRepoRef(result.ticket.repo);
      await github.createIssueComment(
        ref,
        result.ticket.issueNumber,
        blownEstimateCommentBody(report),
      );
    } catch (error) {
      this.#logger?.warn('could not record a blown estimate against its ticket', {
        ticketId,
        error: error instanceof Error ? error.message : String(error),
      });
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

  /**
   * Free text in, a structured draft out (issue #84). Creates nothing — filing the draft is a
   * separate, human-clicked `createIssue`, so a model is never the last thing that happened
   * before a ticket appeared in somebody's repository.
   */
  async draftIssue(request: PipenzoIdeaDraftRequestV1): Promise<PipenzoIdeaDraftResultV1> {
    try {
      return await this.#drafter.draft(request);
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

  /**
   * Posts one comment on an issue (issue #228).
   *
   * The thinnest method on this service, and that is the intention: it resolves a repository,
   * calls the client, and maps the error. Everything a comment *means* — the estimate and the
   * proposed split (#100), the real-versus-predicted numbers (#144) — is composed by the caller
   * that has those numbers. A service that formatted them here would be a second place the wording
   * of a public comment is decided, and the first place would stop being reviewable on its own.
   *
   * Note what is not here: no retry, and no "did it already post?" check. GitHub has no
   * idempotency key for a comment, so a caller that must not double-post gates itself.
   */
  async commentOnIssue(
    request: PipenzoIssueCommentRequestV1,
  ): Promise<PipenzoIssueCommentResultV1> {
    const ref = this.#resolveRepo(request.repo);
    const github = this.#requireGitHub();
    try {
      const comment = await github.createIssueComment(ref, request.issueNumber, request.body);
      return {
        repo: `${ref.owner}/${ref.repo}`,
        issueNumber: request.issueNumber,
        commentId: comment.id,
        htmlUrl: comment.htmlUrl,
        createdAt: comment.createdAt,
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

const DRAFT_CODES: Record<IssueDraftError['code'], PipenzoPhaseErrorCodeV1> = {
  invalid_request: 'invalid_request',
  draft_invalid: 'spec_invalid',
  draft_missing: 'spec_missing',
  read_only_violation: 'read_only_violation',
  session_failed: 'session_failed',
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
 * The comment posted on a blown estimate (issue #144), composed here rather than in
 * `review-gates.ts`: that module reports what happened, this service decides what a human reading
 * the issue is told about it. Exported so a test can assert its exact shape without re-running a
 * whole review.
 *
 * Every number comes from `report.diffScope`, which `computeDiffScope` already split into
 * implementation-only figures (`isGeneratedTestPath` excludes `test/pipenzo-generated/`, issue
 * #145) — the same numbers the `diff_scope` gate's own summary already names, restated here as a
 * public comment rather than a private evidence-pane line.
 */
export function blownEstimateCommentBody(report: PipenzoReviewResultV1): string {
  const scope = report.diffScope;
  if (!scope) {
    // Cannot happen for a real `estimate_blown` report -- `diffScope` is always attached
    // alongside a deterministic-gate outcome -- but a comment must never assert numbers it does
    // not have, so this is the honest fallback rather than a thrown error over a public write.
    return (
      'This ticket’s implementation diff blew its Refine-time estimate by more than 50%. ' +
      'Parked in `pipenzo:awaiting-stack-approval` for a human to decide: accept the overrun, or split it into a stack.'
    );
  }
  const { implementation, estimate, ratio } = scope;
  return [
    `This ticket’s implementation diff came in at **${ratio.toFixed(2)}x** its Refine-time estimate, past README’s 50% blown-estimate tolerance.`,
    '',
    '| | Predicted | Actual |',
    '|---|---|---|',
    `| Lines | ${estimate.changedLines} | ${implementation.changedLines} |`,
    `| Files | ${estimate.filesTouched} | ${implementation.filesTouched} |`,
    '',
    'Parked in `pipenzo:awaiting-stack-approval` for a human to decide: accept the overrun, or split it into a stack.',
  ].join('\n');
}

/**
 * The comment posted on a diff-size-gate refusal at Refine (issue #270). Names the estimate and
 * which of README's two conditions tripped -- over the ceiling a dependency-ordered stack could
 * still cover, or inside the stack band with no clean layering -- since those are two different
 * reasons a human re-scoping the ticket needs to tell apart.
 *
 * The ceiling itself comes from `PIPENZO_DIFF_SIZE_THRESHOLDS` (`@agent-dock/shared`), the same
 * constant `refine-gate.ts`'s `evaluateDiffSizeGate` and `RefusalPanel.tsx`'s `trippedBy` (issue
 * #100) read -- not a third copy of README's numbers.
 *
 * `proposedSplit` (issue #271) renders as a numbered list when present, the same "no field, no
 * section" discipline `RefusalPanel.tsx`'s own `Split` block already applies to the UI half of this
 * same refusal -- so the two surfaces stay in agreement about what is real rather than one saying
 * more than the other. It is `undefined` for every spec today (nothing in `refine-subagent.ts`'s
 * prompt asks a provider to produce one yet), so this branch is unreachable until that separate,
 * still-undecided work lands; the comment says only what is real either way.
 */
export function refusalCommentBody(
  estimate: RefineEstimateV1,
  proposedSplit?: readonly RefineProposedSplitPartV1[],
): string {
  const { stackMaxLines, stackMaxFiles } = PIPENZO_DIFF_SIZE_THRESHOLDS;
  const overCeiling = estimate.changedLines > stackMaxLines || estimate.filesTouched > stackMaxFiles;
  const reason = overCeiling
    ? `past the ${stackMaxLines}-line / ${stackMaxFiles}-file ceiling a dependency-ordered stack can still cover`
    : 'no clean layering into a 2–4 PR stack at this size';
  const lines = [
    `This ticket declined at Refine: **${reason}**.`,
    '',
    `Estimate: **${estimate.changedLines}** changed lines across **${estimate.filesTouched}** files.`,
  ];
  if (proposedSplit && proposedSplit.length > 0) {
    lines.push('', `Proposed split · ${proposedSplit.length} ${proposedSplit.length === 1 ? 'ticket' : 'tickets'}, in this order:`);
    proposedSplit.forEach((part, index) => {
      lines.push(
        `${index + 1}. ${part.summary} (≈${part.changedLines} lines, ${part.filesTouched} files)`,
      );
    });
  }
  lines.push(
    '',
    'Parked in `pipenzo:needs-pre-scoping`. Nothing was written and no runs will be spent until a person re-scopes it.',
  );
  return lines.join('\n');
}

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
  if (error instanceof IssueDraftError) {
    return new PipenzoPhaseError(DRAFT_CODES[error.code], error.message, error.details);
  }
  if (error instanceof GitHubClientError) {
    // The GitHub client redacts its own messages at construction, so this one is safe to surface.
    return new PipenzoPhaseError(GITHUB_CODES[error.code], error.message);
  }
  return new PipenzoPhaseError('session_failed', 'the phase failed');
}
