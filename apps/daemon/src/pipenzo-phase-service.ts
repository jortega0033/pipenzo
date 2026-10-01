import type { Logger } from '@agent-dock/agent-runtime';
import type {
  PipenzoIdeaDraftRequestV1,
  PipenzoIdeaDraftResultV1,
  PipenzoCaptureCapabilityRequestV1,
  PipenzoCaptureCapabilityV1,
  PipenzoImplementCommitsV1,
  PipenzoImplementDiffRequestV1,
  PipenzoImplementDiffResultV1,
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
  PipenzoRunStatusRequestV1,
  PipenzoRunStatusResultV1,
  PipenzoStackApprovalDecideChildV1,
  PipenzoSteerRequestV1,
  PipenzoSteerResultV1,
  PipenzoStopRequestV1,
  PipenzoStopResultV1,
  PipenzoTicketRecordV1,
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
import { runGitCommand, type PipenzoGitRunner } from './pipenzo-git.js';
import type { PipenzoRunControlSessionPort } from './pipenzo-run-control-sessions.js';
import { detectScreenshotCapability } from './screenshot-capture.js';
import { IssueDraftError, IssueDrafter } from './issue-drafter.js';
import { readPipenzoRepoConfig, type PipenzoCommandConfig } from './pipenzo-repo-config.js';
import { isBudgetExhausted, type PipenzoPhaseMachine } from './pipenzo-phase-machine.js';
import { evaluateDiffSizeGate } from './refine-gate.js';
import { attachTicketWorktree } from './pipenzo-worktree-lifecycle.js';
import type { PipenzoAuditStore } from './pipenzo-audit-store.js';
import { materializeStack, type StackTicketStorePort } from './pipenzo-stack-materializer.js';
import type { PipenzoExecutionLimiter } from './pipenzo-execution-limiter.js';

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
   * The phase machine (issue #144), narrowed to `read`, `transition` and `recordAttempt`. Optional
   * so a service built without one (every test that predates this ticket) still reviews and
   * implements exactly as before — it just has nothing to transition an `estimate_blown` outcome
   * onto, and nowhere to record an implement dispatch's attempt. Not the same object review()
   * builds its GitHub client from: the machine resolves its own client internally, the same lazy,
   * per-call pattern this service already uses everywhere else. `read` is here (and not just
   * `transition`) so a retried review of the same outcome can tell it already recorded this one --
   * see `#reportBlownEstimate`. `recordAttempt` is here for `implement()`'s own consequence (issue
   * #201) -- see `#recordAttempt`. `recordTokenUsage` and `peekBudget` are here for issue #143's
   * own accounting and enforcement -- see `#recordTokenUsage` and `#assertBudgetNotExhausted`.
   */
  machine?: Pick<
    PipenzoPhaseMachine,
    | 'read'
    | 'transition'
    | 'recordAttempt'
    | 'recordTokenUsage'
    | 'peekBudget'
    | 'gradeRiskAction'
  >;
  /**
   * Local-only ticket-record access (issue #159), narrower than `machine` on purpose: attaching a
   * worktree id to a ticket is not a lane transition and costs no GitHub round trip, so this is a
   * direct store port rather than another `PipenzoPhaseMachine` method. Optional so a service built
   * without one (every test that predates this ticket) still implements exactly as before — it just
   * has nowhere to record the worktree it cut, the same "best-effort, logged, never thrown" shape
   * `#reportRefusal`/`#reportBlownEstimate` already use for their own secondary writes.
   *
   * Widened to include `create` (issue #99): `acceptStack()` needs to persist one new ticket record
   * per approved stack entry, via the exact same direct-store-write pattern `attachTicketWorktree`
   * already established for `update` alone -- `StackTicketStorePort` is a strict superset of the
   * narrower port every pre-#99 caller already satisfies (any `FileTicketStore` trivially has all
   * three methods), so this widening is source-compatible with every existing caller.
   */
  tickets?: StackTicketStorePort;
  /** Logs a failed blown-estimate consequence without failing the review call that produced a
   * perfectly good report — see `review()`'s own comment for why. */
  logger?: Logger;
  /**
   * Where a review-gate result is recorded (issue #160). Optional so every existing test and caller
   * that predates this issue reviews exactly as before, with no audit entry at all.
   * `Pick<..., 'append'>` — the same narrowing `pipenzo-reconciler.ts` and `PublishService` already
   * use for their own optional audit dependency.
   */
  audit?: Pick<PipenzoAuditStore, 'append'>;
  /**
   * Epic #5's execution limit (issue #126), passed straight through to the `ImplementOrchestrator`
   * this service constructs. Optional so a service built without one (every test that predates this
   * ticket) still implements exactly as before, gated only by agentdock's own generic session cap —
   * see `pipenzo-execution-limiter.ts`'s module comment for why the two are separate.
   */
  executionLimiter?: PipenzoExecutionLimiter;
  /**
   * The seam onto agentdock's generic V2 session commands (issue #103's Steer/Stop) --
   * `V2RunControlSessions` in production. Optional so a service built without one (every test and
   * caller that predates this ticket) still refines/implements/reviews exactly as before; it just
   * has no way to steer or stop a dispatched session, which `steerImplement()`/`stopImplement()`
   * both refuse outright rather than guessing at.
   */
  runControls?: PipenzoRunControlSessionPort;
}

export class PipenzoPhaseService {
  readonly #refine: RefineSubagent;
  readonly #drafter: IssueDrafter;
  readonly #implement: ImplementOrchestrator;
  readonly #review: ReviewGatesRunner;
  readonly #worktrees: ImplementWorktreeManager & OwnedWorktreeLocator;
  readonly #github: (() => GitHubClient) | undefined;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #machine:
    | Pick<
        PipenzoPhaseMachine,
        | 'read'
        | 'transition'
        | 'recordAttempt'
        | 'recordTokenUsage'
        | 'peekBudget'
        | 'gradeRiskAction'
      >
    | undefined;
  readonly #ticketWorktrees: StackTicketStorePort | undefined;
  readonly #logger: Logger | undefined;
  readonly #audit: Pick<PipenzoAuditStore, 'append'> | undefined;
  readonly #runControls: PipenzoRunControlSessionPort | undefined;
  readonly #runGit: PipenzoGitRunner;

  constructor(options: PipenzoPhaseServiceOptions) {
    this.#refine = new RefineSubagent(options.refineSessions, options.runGit);
    // The drafter runs on the refine session port on purpose: drafting an issue is the one moment
    // a model is asked to imagine work that does not exist, and a write would let it make its own
    // draft true. See `issue-drafter.ts`.
    this.#drafter = new IssueDrafter(options.refineSessions);
    this.#implement = new ImplementOrchestrator({
      worktrees: options.worktrees,
      sessions: options.implementSessions,
      ...(options.runGit ? { runGit: options.runGit } : {}),
      ...(options.executionLimiter ? { executionLimiter: options.executionLimiter } : {}),
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
    this.#ticketWorktrees = options.tickets;
    this.#logger = options.logger;
    this.#audit = options.audit;
    this.#runControls = options.runControls;
    this.#runGit = options.runGit ?? runGitCommand;
  }

  /* ---------------------------------------------------------------- refine */

  async refine(request: PipenzoRefineRequestV1): Promise<PipenzoRefineResultV1> {
    if (request.ticketId) this.#assertBudgetNotExhausted(request.ticketId);
    const ref = this.#resolveRepo(request.repo);
    const github = this.#requireGitHub();
    let issue;
    try {
      issue = await github.getIssue(ref, request.issueNumber);
    } catch (error) {
      throw toPhaseError(error);
    }
    const conventions = await this.#readConventions(request.repositoryPath);
    let result: {
      sessionId: string;
      spec: PipenzoRefineResultV1['spec'];
      toolsUsed: readonly string[];
      tokensUsed?: number;
    };
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

    // Issue #99's own consequence of a `stack` verdict -- `refine-gate.ts`'s own doc comment names
    // this exact gap ("not built by this ticket [#270]; #100's panel and whatever builds the
    // stack-approval flow own it"). Same best-effort shape as the refusal branch above.
    if (gateVerdict === 'stack' && request.ticketId) {
      await this.#reportStackVerdict(request.ticketId, result.spec);
    }

    // Issue #143: Refine is one of the three phases that spends a ticket's budget (slice 1), and
    // the one that can also park it (slice 2) -- awaited, unlike `implement()`'s own version of
    // this below, because refine() is still in its own request/response cycle when this runs.
    // Best-effort and logged internally, same reasoning as `#reportRefusal` above -- a bookkeeping
    // failure here must not turn an already-produced, already-valid spec into a thrown error.
    if (request.ticketId && result.tokensUsed) {
      await this.#recordTokenUsage(request.ticketId, result.tokensUsed);
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
   *
   * Also caches the whole `spec` onto the ticket record when a ticket store is configured (issue
   * #469) -- the same early write `#reportStackVerdict` below already makes for a `stack` verdict,
   * applied here for the same reason: a refusal is reported once, at Refine time, and a human may
   * reopen this ticket's detail view long after that request/response cycle ends. Without this,
   * `RefusalPanel.tsx` has no real data to render on anything but the original response -- see
   * `pipenzoTicketRefusalV1Schema`'s own doc comment (`@agent-dock/shared`) for how this crosses
   * the wire, narrowed to just `estimate`/`proposedSplit`.
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

      if (this.#ticketWorktrees) {
        const stored = this.#ticketWorktrees.get(ticketId);
        if (stored) {
          try {
            this.#ticketWorktrees.update(ticketId, { ...stored, spec });
          } catch (error) {
            this.#logger?.warn('pipenzo: could not cache the refusal outcome onto its ticket', {
              ticketId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

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

  /**
   * The actual consequence of a diff-size-gate `stack` verdict (issue #99): transitions the ticket
   * to `pipenzo:awaiting-stack-approval` -- the same label #144's blown-estimate path also reaches,
   * from a different trigger -- then posts the estimate and, when one was produced, the proposed
   * split as a comment. Guarded against a retried `refine()` double-posting the same way
   * `#reportRefusal`/`#reportBlownEstimate` are: `read()` first, skip every write if the ticket is
   * already parked there.
   *
   * Also caches the whole `spec` onto the ticket record when a ticket store is configured -- the
   * one write that makes `captureStack()` possible later. Nothing before this ticket ever wrote
   * `ticket.spec` this early (the schema's own doc comment says it is otherwise "cached once
   * Implement is dispatched from it"); a `stack` verdict is parked for a human decision that can
   * come well after this request/response cycle ends, so the parts a human eventually reorders and
   * accepts have to already be durable, not something only the original caller's in-memory response
   * still holds.
   */
  async #reportStackVerdict(ticketId: string, spec: PipenzoRefineResultV1['spec']): Promise<void> {
    if (!this.#machine) return;
    try {
      const current = await this.#machine.read(ticketId);
      if (current.ticket.labels.includes('pipenzo:awaiting-stack-approval')) return;
      const result = await this.#machine.transition(ticketId, 'pipenzo:awaiting-stack-approval');

      if (this.#ticketWorktrees) {
        const stored = this.#ticketWorktrees.get(ticketId);
        if (stored) {
          try {
            this.#ticketWorktrees.update(ticketId, { ...stored, spec });
          } catch (error) {
            this.#logger?.warn('pipenzo: could not cache the proposed stack split onto its ticket', {
              ticketId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      const github = this.#requireGitHub();
      const ref = parseRepoRef(result.ticket.repo);
      await github.createIssueComment(
        ref,
        result.ticket.issueNumber,
        stackProposedCommentBody(spec.estimate, spec.proposedSplit),
      );
    } catch (error) {
      this.#logger?.warn('could not record a diff-size stack verdict against its ticket', {
        ticketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /* -------------------------------------------------------------- stack approval (issue #99) */

  /**
   * The accept half of the stack approval panel. Real materialization
   * (`pipenzo-stack-materializer.ts`'s `materializeStack`) followed by two secondary writes --
   * recording the new children onto the parent's own `stack.childIds`, and a best-effort acceptance
   * comment -- neither of which un-does or hides the real GitHub issues and worktrees already
   * created if either one fails. See `materializeStack`'s own doc comment for the partial-failure
   * contract this method's caller (the stack-approval route) reports on `StackMaterializationError`.
   */
  async acceptStack(
    ticketId: string,
    orderedParts: readonly RefineProposedSplitPartV1[],
    repositoryPath: string,
  ): Promise<PipenzoStackApprovalDecideChildV1[]> {
    if (!this.#machine || !this.#ticketWorktrees) {
      throw new Error('accepting a stack requires both a phase machine and a ticket store to be configured');
    }
    const current = await this.#machine.read(ticketId);
    const parentTicket = current.ticket;
    const github = this.#requireGitHub();
    const ref = parseRepoRef(parentTicket.repo);

    const children = await materializeStack({
      parentTicket,
      repositoryPath,
      orderedParts,
      github,
      repoRef: ref,
      worktrees: this.#worktrees,
      tickets: this.#ticketWorktrees,
    });

    try {
      this.#ticketWorktrees.update(ticketId, {
        ...parentTicket,
        stack: { ...parentTicket.stack, childIds: children.map((child) => child.ticketId) },
      });
    } catch (error) {
      this.#logger?.warn(
        'pipenzo: stack materialized but the parent ticket could not be recorded as a container',
        { ticketId, error: error instanceof Error ? error.message : String(error) },
      );
    }

    try {
      await github.createIssueComment(ref, parentTicket.issueNumber, stackAcceptedCommentBody(children));
    } catch (error) {
      this.#logger?.warn('pipenzo: stack materialized but the acceptance comment could not be posted', {
        ticketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return children;
  }

  /**
   * The reject half. Unlike `#reportRefusal`/`#reportBlownEstimate`/`acceptStack`'s own trailing
   * comment, this comment is **not** swallowed on failure: it is not a secondary bookkeeping write
   * alongside an already-complete action, it is the entire visible content of a reject decision --
   * the issue's own text requires "Reject with reason posted to issue," and a reject whose comment
   * silently failed to post would leave a human's stated reason nowhere a repository maintainer
   * could ever see it. The ticket stays on `pipenzo:awaiting-stack-approval` either way (there is no
   * lane to move it to on a reject -- see `pipenzo-stack-materializer.ts`'s own module comment on why
   * no new label exists for this), so a caller whose comment post threw can simply tell the human it
   * failed and let them retry: nothing here has moved the ticket anywhere a retry would double up.
   */
  async rejectStack(ticketId: string, reason: string): Promise<void> {
    if (!this.#machine) {
      throw new Error('rejecting a stack requires a phase machine to be configured');
    }
    const current = await this.#machine.read(ticketId);
    const github = this.#requireGitHub();
    const ref = parseRepoRef(current.ticket.repo);
    await github.createIssueComment(ref, current.ticket.issueNumber, stackRejectedCommentBody(reason));
  }

  /* ------------------------------------------------------------- implement */

  async implement(request: PipenzoImplementRequestV1): Promise<PipenzoImplementResultV1> {
    if (request.ticketId) this.#assertBudgetNotExhausted(request.ticketId);
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

    // Issue #201's crash-recovery gap, closed: a real dispatch now leaves a real `attempts[]` entry
    // behind, so `pipenzo-crash-recovery.ts`'s session-to-ticket index has something to match a
    // live interrupted session against instead of only what a test hand-seeds. Recorded here,
    // right after `start()` returns a real `sessionId` -- deliberately *before* anything downstream
    // learns how the session ends. That is the one choice that actually serves crash recovery:
    // recording were it deferred to a completed/failed terminal event, the exact sessions that crash
    // recovery exists to catch -- ones that never reach a terminal event at all -- would be the ones
    // this never got around to recording, which would defeat the fix. "Confirmed started" (a real
    // session id exists) is therefore the right point, not "request accepted" (no id yet, nothing to
    // index) or "confirmed finished" (too late for exactly the crash case).
    if (request.ticketId) {
      this.#recordAttempt(request.ticketId, started.sessionId, request);
    }

    // Issue #143's accounting and park-on-exhaustion consequence, for the one phase this route
    // does not wait on. Unlike `#recordAttempt` above, this cannot run synchronously right here --
    // Implement is dispatch-only, and `started.tokensUsed` does not settle until the session this
    // call just started actually finishes, possibly long after this route has already responded.
    // Fire-and-forget, same "best-effort, logged, never thrown" reasoning as every other
    // consequence in this file; there is no in-flight request left by the time it resolves for a
    // thrown error to reach. `#assertBudgetNotExhausted` above is what still refuses the *next*
    // dispatch even if this particular park is still in flight or itself fails.
    if (request.ticketId && started.tokensUsed) {
      const ticketId = request.ticketId;
      started.tokensUsed
        .then((tokens) => this.#recordTokenUsage(ticketId, tokens))
        .catch((error: unknown) => {
          this.#logger?.warn('could not observe an implement session’s token usage', {
            ticketId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    // Best-effort (issue #159): lets a later terminal-state transition (PR merged, closed,
    // abandoned) find this worktree to clean up without the renderer ever having to remember and
    // resend its id. Never allowed to turn a successful dispatch into a thrown error — see
    // `attachTicketWorktree`'s own doc comment.
    if (request.ticketId && this.#ticketWorktrees) {
      attachTicketWorktree(
        this.#ticketWorktrees,
        request.ticketId,
        {
          id: started.worktreeId,
          path: started.worktreePath,
          branch: started.branch,
          // Issue #103: recorded now, alongside `path`/`branch`, so `stopImplement()`/`runStatus()`
          // can report a real commit count while the session is still running -- see
          // `pipenzoTicketWorktreeV1Schema.baseCommit`'s own doc comment for why this is not the
          // same field `implement.baseCommit` caches later, on a human's first collected diff.
          baseCommit: started.baseCommit,
        },
        this.#logger,
      );
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

  /**
   * Best-effort and logged, never thrown -- the same reasoning as `#reportRefusal` and
   * `#reportBlownEstimate`: a worktree exists and a session is already running by the time this is
   * called, so a bookkeeping failure here must not be reported as a failure to start. The operator's
   * natural retry on a thrown error would cut a second worktree for the same ticket, exactly what
   * the route's own comment says the response-shape case must also avoid.
   *
   * `tier` defaults to `'mid'` when the caller has none to give -- model routing does not compute
   * one yet (README's Model routing section, post-MVP), and `PipenzoTicketAttemptV1.tier` is
   * required, so an attempt needs *some* value until a real router exists. `model` defaults to
   * `'default'` for the same reason: `ImplementRequest.model` is optional and, left unset, the
   * provider's own default model is whatever the CLI resolves it to -- nothing on this path observes
   * that resolution to report it faithfully instead.
   */
  #recordAttempt(
    ticketId: string,
    sessionId: string,
    request: Pick<PipenzoImplementRequestV1, 'tier' | 'model'>,
  ): void {
    if (!this.#machine) return;
    try {
      this.#machine.recordAttempt(ticketId, {
        sessionId,
        tier: request.tier ?? 'mid',
        model: request.model ?? 'default',
        outcome: 'dispatched',
      });
    } catch (error) {
      this.#logger?.warn('could not record an implement attempt against its ticket', {
        ticketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Adds real provider token usage to a ticket's local budget (Pipenzo issue #143, slice 1), then
   * checks whether that write just exhausted it (slice 2). Every call site in this file goes
   * through this one method, so there is exactly one place that decides both how a bookkeeping
   * failure is handled and what happens the moment a budget runs out.
   *
   * The local write is best-effort and logged, never thrown -- same reasoning as `#recordAttempt`
   * and every other secondary consequence in this file: a session already ran and already produced
   * real work by the time any of these are called, so a local write failing here must never be
   * reported as if the phase itself had failed. `#reportBudgetExhausted` below is the same
   * discipline applied to the park-on-exhaustion consequence.
   */
  async #recordTokenUsage(ticketId: string, tokens: number): Promise<void> {
    if (!this.#machine) return;
    let ticket: PipenzoTicketRecordV1;
    try {
      ticket = this.#machine.recordTokenUsage(ticketId, tokens);
    } catch (error) {
      this.#logger?.warn('could not record token usage against its ticket', {
        ticketId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (isBudgetExhausted(ticket.budget)) {
      await this.#reportBudgetExhausted(ticketId, ticket.budget);
    }
  }

  /**
   * The actual consequence of a budget exhaustion (Pipenzo issue #143, slice 2): transitions the
   * ticket to `pipenzo:needs-human`, then posts the spend-vs-limit numbers as a comment on its
   * issue. README states the behaviour plainly -- "parks the ticket in Needs human instead of
   * retrying" -- and this is that park. Best-effort and logged, never thrown, and guarded against
   * double-posting on a retried call the same way `#reportBlownEstimate` is: `read()` first, skip
   * both the transition and the comment if the ticket already carries `pipenzo:needs-human`.
   *
   * This is the half of the safety property that reacts to a budget crossing its limit; the other
   * half is `#assertBudgetNotExhausted`, which refuses a *new* dispatch outright rather than
   * waiting for one already in flight to finish and trip this. Both exist because a label write
   * here can itself fail (a rate-limited token, a network blip) -- the pre-dispatch guard is what
   * still holds "never retrying" even if this park never lands.
   */
  async #reportBudgetExhausted(
    ticketId: string,
    budget: PipenzoTicketRecordV1['budget'],
  ): Promise<void> {
    if (!this.#machine) return;
    try {
      const current = await this.#machine.read(ticketId);
      if (current.ticket.labels.includes('pipenzo:needs-human')) return;
      const result = await this.#machine.transition(ticketId, 'pipenzo:needs-human');
      const github = this.#requireGitHub();
      const ref = parseRepoRef(result.ticket.repo);
      await github.createIssueComment(ref, result.ticket.issueNumber, budgetExhaustedCommentBody(budget));
    } catch (error) {
      this.#logger?.warn('could not park a budget-exhausted ticket', {
        ticketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The pre-dispatch half of issue #143, slice 2's "never retrying" property. Called at the top of
   * every route that would dispatch a new paid session against a ticket -- `refine()`, `implement()`,
   * `review()` -- before any of that route's own work happens, so a client that keeps retrying a
   * request against an already-exhausted ticket gets refused immediately rather than burning
   * another session first and finding out via `#reportBudgetExhausted` after the fact.
   *
   * Reads through `PipenzoPhaseMachine.peekBudget()` -- local-only, no GitHub round trip -- rather
   * than `read()`: a pre-flight check gating every dispatch must not cost a network call or be
   * blocked by a rate-limited token, the same reasoning `peekBudget()`'s own doc comment gives.
   * `undefined` (an unknown ticket, or no machine configured) is treated as "nothing to check"
   * rather than refused -- this method's only job is to catch a *known*, *already-exhausted*
   * budget before it is spent further, never to gate dispatch on ticket bookkeeping it cannot see.
   */
  #assertBudgetNotExhausted(ticketId: string): void {
    const budget = this.#machine?.peekBudget(ticketId);
    if (budget && isBudgetExhausted(budget)) {
      throw new PipenzoPhaseError(
        'budget_exhausted',
        `this ticket’s token budget is exhausted (${budget.tokensUsed}/${budget.limit} tokens used); it is parked in pipenzo:needs-human rather than dispatched again`,
      );
    }
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
        // Issue #192. Omitted exactly when `collect()` omits it -- see its doc comment and
        // `ImplementCollectResult.sessionState` for when that is.
        ...(collected.sessionState !== undefined ? { sessionState: collected.sessionState } : {}),
      };
    } catch (error) {
      // `ImplementOrchestratorError('implement_empty_diff', …)` from `collect()` arrives here like
      // every other orchestrator failure and is mapped by `IMPLEMENT_CODES` -- no special case
      // needed, which is the point of routing every module's errors through one `toPhaseError`.
      throw toPhaseError(error);
    }
  }

  /**
   * Reads the diff for a commit range already known to exist in an owned worktree (issue #90's
   * stack, step 2) -- the route `DiffFileList.tsx` had nothing to call before this: `ReviewReportV1`
   * carries a verdict and findings, never the patch itself.
   */
  async implementDiff(request: PipenzoImplementDiffRequestV1): Promise<PipenzoImplementDiffResultV1> {
    const location = this.#worktrees.ownedLocation(request.worktreeId);
    if (!location) {
      throw new PipenzoPhaseError('worktree_not_found', 'no such owned worktree');
    }
    try {
      const diff = await this.#implement.diff({
        worktreePath: location.path,
        baseCommit: request.baseCommit,
        headCommit: request.headCommit,
      });
      return {
        worktreeId: request.worktreeId,
        baseCommit: request.baseCommit,
        headCommit: request.headCommit,
        ...diff,
      };
    } catch (error) {
      throw toPhaseError(error);
    }
  }

  /* --------------------------------------------------- run controls (issue #103) */

  /**
   * Resolves a ticket's most recent Implement attempt to a session that is genuinely live right
   * now, or throws the one of `run_not_found`/`run_not_active` that explains why not. Shared by
   * `steerImplement()` and `stopImplement()` — both need exactly this before they may touch a
   * session, and neither may guess: `RunControls.tsx`'s own "no absent state" rule is only honest
   * if the caller checked a real, current status rather than a ticket's own possibly-stale label.
   *
   * Throws a plain `Error` (not `PipenzoPhaseError`) when this service was built without a phase
   * machine or a run-control port — the same "misconfiguration, not a runtime outcome" distinction
   * `acceptStack()`/`rejectStack()` already draw for their own required dependencies.
   */
  async #resolveRunningAttempt(
    ticketId: string,
  ): Promise<{ ticket: PipenzoTicketRecordV1; attempt: PipenzoTicketRecordV1['attempts'][number]; turnId: string }> {
    if (!this.#machine) {
      throw new Error('steering or stopping a run requires a phase machine to be configured');
    }
    if (!this.#runControls) {
      throw new Error('steering or stopping a run requires a run-control session port to be configured');
    }
    const current = await this.#machine.read(ticketId);
    const attempt = current.ticket.attempts.at(-1);
    if (!attempt) {
      throw new PipenzoPhaseError('run_not_found', 'this ticket has no dispatched Implement attempt');
    }
    const status = this.#runControls.status(attempt.sessionId);
    if (!status?.active || !status.turnId) {
      throw new PipenzoPhaseError(
        'run_not_active',
        'this ticket’s dispatched session is not running right now',
      );
    }
    return { ticket: current.ticket, attempt, turnId: status.turnId };
  }

  /**
   * Commits already on `worktree.branch`, counted fresh from the worktree itself rather than
   * cached anywhere — the one number `RunControls.tsx` needs that nothing already on the ticket
   * record can answer while a session is still running (`ticket.implement` is only ever written
   * once a human has collected a diff; see `pipenzoTicketImplementRangeV1Schema`'s own doc
   * comment). Reads only; never stages, commits, or resets anything in the worktree.
   *
   * `0` for a worktree this service does not own, or a baseCommit this ticket has never recorded
   * (a worktree attached before issue #103) — the same "cannot say, so say the harmless thing"
   * shape `commitCount`'s own schema comment describes, not a thrown error over a display number.
   */
  async #commitCount(worktreeId: string, baseCommit: string | undefined): Promise<number> {
    if (!baseCommit || !/^[0-9a-f]{40}$/.test(baseCommit)) return 0;
    const location = this.#worktrees.ownedLocation(worktreeId);
    if (!location) return 0;
    try {
      const result = await this.#runGit(
        ['rev-list', '--count', '--end-of-options', `${baseCommit}..HEAD`],
        location.path,
      );
      const count = Number.parseInt(result.stdout.trim(), 10);
      return result.code === 0 && Number.isInteger(count) && count >= 0 ? count : 0;
    } catch {
      return 0;
    }
  }

  /**
   * A read-only poll for `RunControls.tsx`'s own gate: "present only while genuinely running."
   * Never throws over a ticket that is not running — that is one of its two ordinary answers, not
   * a failure — so this deliberately does not reuse `#resolveRunningAttempt` above, which throws
   * for exactly that case on purpose for Steer/Stop's different needs.
   */
  async runStatus(request: PipenzoRunStatusRequestV1): Promise<PipenzoRunStatusResultV1> {
    if (!this.#machine) {
      throw new Error('run status requires a phase machine to be configured');
    }
    const current = await this.#machine.read(request.ticketId);
    const attempt = current.ticket.attempts.at(-1);
    const status = attempt && this.#runControls ? this.#runControls.status(attempt.sessionId) : undefined;
    if (!attempt || !status?.active || !current.ticket.worktree) {
      return { live: false };
    }
    const commitCount = await this.#commitCount(
      current.ticket.worktree.id,
      current.ticket.worktree.baseCommit,
    );
    return {
      live: true,
      sessionId: attempt.sessionId,
      tier: attempt.tier,
      model: attempt.model,
      branch: current.ticket.worktree.branch,
      commitCount,
    };
  }

  /**
   * Delivers one instruction to a genuinely running Implement session, at its current turn
   * boundary (issue #103). Dispatched as `input.steer` through `PipenzoRunControlSessionPort` —
   * agentdock's own session machinery is what actually holds the instruction until the session's
   * next tool boundary and records it as a fresh turn in that session's own transcript; nothing in
   * this method touches the ticket's cached Refine spec, because nothing here ever reads or writes
   * `ticket.spec`.
   */
  async steerImplement(request: PipenzoSteerRequestV1): Promise<PipenzoSteerResultV1> {
    const { attempt, turnId } = await this.#resolveRunningAttempt(request.ticketId);
    const result = await this.#runControls!.steer(attempt.sessionId, turnId, request.instruction);
    if (!result.ok) {
      throw new PipenzoPhaseError(
        'run_not_active',
        'this ticket’s dispatched session is not running right now',
      );
    }
    return { sessionId: attempt.sessionId };
  }

  /**
   * Abandons only the running Implement session's current in-flight turn (issue #103) — dispatched
   * as `session.interrupt`, agentdock's own primitive for exactly that, never a worktree cleanup
   * call. Neither this method nor `PipenzoRunControlSessionPort.interrupt()` beneath it ever calls
   * `cleanupTerminalWorktree()`/`cleanupWorktree()` or removes a branch: the worktree this ticket
   * owns, and every commit already on it, are exactly as they were the moment before this call, by
   * construction rather than by care taken here.
   *
   * The ticket's label move to `pipenzo:needs-human` is the one consequence of a successful stop,
   * and it is best-effort like every other secondary write in this file (`#reportBudgetExhausted`
   * is the closest precedent: same target label, same "the real action already happened, a
   * bookkeeping failure here must not be reported as if it hadn't" reasoning) — a human who just
   * clicked Stop already sees a stopped run even if this particular relabel has to be retried.
   */
  async stopImplement(request: PipenzoStopRequestV1): Promise<PipenzoStopResultV1> {
    const { ticket, attempt, turnId } = await this.#resolveRunningAttempt(request.ticketId);
    if (!ticket.worktree) {
      throw new PipenzoPhaseError('run_not_found', 'this ticket has no recorded worktree to stop into');
    }
    const result = await this.#runControls!.interrupt(attempt.sessionId, turnId);
    if (!result.ok) {
      throw new PipenzoPhaseError(
        'run_not_active',
        'this ticket’s dispatched session is not running right now',
      );
    }
    const worktree = ticket.worktree;
    try {
      await this.#machine!.transition(request.ticketId, 'pipenzo:needs-human');
    } catch (error) {
      this.#logger?.warn('pipenzo: stopped a run but could not park its ticket on pipenzo:needs-human', {
        ticketId: request.ticketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const commitCount = await this.#commitCount(worktree.id, worktree.baseCommit);
    return {
      worktreeId: worktree.id,
      branch: worktree.branch,
      commitCount,
      label: 'pipenzo:needs-human',
    };
  }

  /* ---------------------------------------------------------------- review */

  async review(request: PipenzoReviewRequestV1): Promise<PipenzoReviewResultV1> {
    if (request.ticketId) this.#assertBudgetNotExhausted(request.ticketId);
    const location = this.#worktrees.ownedLocation(request.worktreeId);
    if (!location) {
      throw new PipenzoPhaseError('worktree_not_found', 'no such owned worktree');
    }
    const conventions = await this.#readConventions(location.sourcePath);
    // Issue #143, slice 1's own accounting for Review's two LLM passes. A plain accumulator, not
    // `#recordTokenUsage` called per pass -- `report.outcome === 'estimate_blown'`'s branch below
    // already establishes the pattern of "one bookkeeping write per successful review()`, not one
    // per session inside it", and a single local write here is one fewer place a partial failure
    // could leave the ticket's budget half-updated.
    let tokensUsed = 0;
    let report: PipenzoReviewResultV1;
    try {
      report = await this.#review.run({
        subject: { kind: 'ticket', spec: request.spec },
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
        onTokensUsed: (tokens) => {
          tokensUsed += tokens;
        },
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
      await this.#recordEstimateMiss(request.ticketId, report);
    }

    if (request.ticketId && tokensUsed > 0) {
      await this.#recordTokenUsage(request.ticketId, tokensUsed);
    }

    // Issue #95: feed this run's real risk classification into the ticket's cumulative-risk
    // score (issue #158's pure engine) -- the one real trigger point this ticket asks for
    // ("tie into wherever classifyReviewRisk() from review-gates.ts already runs").
    if (request.ticketId && report.risk) {
      this.#recordRiskGrade(request.ticketId, report.risk);
    }

    // Issue #160: every review-gate run that actually reaches an outcome gets an audit entry.
    // `request.ticketId` is optional (every existing caller/test predates this field), and a run
    // with none has no ticket to attribute an entry to -- the same "nothing to attribute this to,
    // so nothing is written" rule `PublishService`'s own audit wiring follows. Deliberately after
    // `#reportBlownEstimate`/`#recordTokenUsage`/`#recordRiskGrade`, not before: this record is a
    // *read* of the already-final `report`, and ordering it last means a slow or failing audit
    // write can never be mistaken for why one of those other, unrelated writes did not happen.
    if (request.ticketId) {
      await this.#recordReviewAudit(request.ticketId, report);
    }

    return report;
  }

  /**
   * Best-effort, logged, never thrown (issue #160) -- see `review()`'s own comment for why. Writes
   * nothing when `audit` was never configured, the same already-documented "no store, no entry"
   * state `PublishService`'s own audit wiring treats identically.
   */
  async #recordReviewAudit(ticketId: string, report: PipenzoReviewResultV1): Promise<void> {
    if (!this.#audit) return;
    try {
      await this.#audit.append({
        ticketId,
        kind: 'review_gate_result',
        outcome: report.outcome,
        risk: report.risk,
        baseCommit: report.baseCommit,
        headCommit: report.headCommit,
      });
    } catch (error) {
      this.#logger?.warn('could not record this review’s result to the pipenzo audit store', {
        ticketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Issue #95's own half of `review()`'s side effects, split out for the same reason
   * `#recordTokenUsage`/`#reportBlownEstimate` are: best-effort and logged, never thrown -- a
   * successful review already happened and already is the thing `review()` promises to return, so
   * a local scoring write failing must not turn that into an error the caller sees.
   */
  #recordRiskGrade(ticketId: string, grade: PipenzoReviewResultV1['risk']): void {
    if (!this.#machine || !grade) return;
    try {
      this.#machine.gradeRiskAction(ticketId, grade);
    } catch (error) {
      this.#logger?.warn('could not grade this review against its ticket’s cumulative risk score', {
        ticketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

  /**
   * Persists the blown-estimate miss itself (issue #269): predicted (`diffScope.estimate`), actual
   * (`diffScope.implementation`), and the ratio between them, as an `estimate_miss` audit entry --
   * so the daemon can query a ticket's past misses later, instead of the numbers only ever existing
   * transiently in this response and in `blownEstimateCommentBody()`'s GitHub comment text.
   *
   * Best-effort, logged, never thrown -- same reasoning as `#recordReviewAudit` (issue #160): a
   * review already completed and already is the thing `review()` promises to return, so a secondary
   * bookkeeping write failing here must not turn that into a thrown error. Writes nothing when
   * `audit` was never configured, same "no store, no entry" rule every other audit write in this
   * file follows.
   *
   * Deliberately unconditional, unlike `#reportBlownEstimate`'s own label-transition/comment: this
   * is a log entry, not a state the ticket is parked in, so a retried `review()` call that reproduces
   * `estimate_blown` against the same worktree/commits recording a second row costs nothing a reader
   * cannot already filter out by `recordedAt` -- there is no GitHub-comment-style "no idempotency
   * key" reason to gate it the way that method's own doc comment explains for itself.
   */
  async #recordEstimateMiss(ticketId: string, report: PipenzoReviewResultV1): Promise<void> {
    if (!this.#audit) return;
    const scope = report.diffScope;
    if (!scope || scope.estimate === undefined || scope.ratio === undefined) {
      // Cannot happen for a real `estimate_blown` report -- the same invariant
      // `blownEstimateCommentBody`'s own fallback branch documents -- but this must never fabricate
      // numbers it does not have, so it skips the write rather than inventing a predicted/actual pair.
      this.#logger?.warn('estimate_blown outcome had no diffScope.estimate/ratio to record', {
        ticketId,
      });
      return;
    }
    try {
      await this.#audit.append({
        ticketId,
        kind: 'estimate_miss',
        outcome: 'estimate_blown',
        predicted: scope.estimate,
        actual: scope.implementation,
        ratio: scope.ratio,
      });
    } catch (error) {
      this.#logger?.warn('could not record this estimate miss to the pipenzo audit store', {
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
  baseline_unavailable: 'baseline_unavailable',
  dirty_checkout: 'dirty_checkout',
  baseline_changed: 'baseline_changed',
  workspace_untrusted: 'workspace_untrusted',
};

const IMPLEMENT_CODES: Record<ImplementOrchestratorError['code'], PipenzoPhaseErrorCodeV1> = {
  invalid_spec: 'invalid_spec',
  invalid_request: 'invalid_request',
  workspace_untrusted: 'workspace_untrusted',
  worktree_failed: 'worktree_failed',
  worktree_secret_risk: 'worktree_secret_risk',
  branch_failed: 'branch_failed',
  commit_failed: 'commit_failed',
  session_failed: 'session_failed',
  implement_empty_diff: 'implement_empty_diff',
  diff_unavailable: 'diff_unavailable',
  execution_limit_exceeded: 'execution_limit_exceeded',
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
  workspace_untrusted: 'workspace_untrusted',
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
  if (!scope || scope.estimate === undefined || scope.ratio === undefined) {
    // Cannot happen for a real `estimate_blown` report -- `diffScope` (with an estimate) is always
    // attached alongside that outcome, and `estimate_blown` cannot fire for issue #206's
    // external-PR review path in the first place (there is no ticket to post a comment on) -- but
    // a comment must never assert numbers it does not have, so this is the honest fallback rather
    // than a thrown error over a public write.
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
 * The comment posted when a ticket's token budget runs out (Pipenzo issue #143, slice 2).
 * Exported for the same reason `blownEstimateCommentBody` is: a test can assert its exact shape
 * without re-running a whole phase dispatch.
 */
export function budgetExhaustedCommentBody(budget: PipenzoTicketRecordV1['budget']): string {
  return [
    `This ticket’s token budget is exhausted: **${budget.tokensUsed}** tokens used against a limit of **${budget.limit}**.`,
    '',
    'Parked in `pipenzo:needs-human`. README’s own rule for a spent budget is to park it rather than retry it -- raise the limit and re-queue it, or take it from here by hand.',
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
 * more than the other. `refine-subagent.ts`'s prompt now asks the same session for one whenever its
 * own estimate is a refusal, but it is explicitly told to omit the field rather than fake a split it
 * cannot stand behind -- so `undefined` here is still a normal, expected outcome, not evidence the
 * prompt change did nothing.
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

/** Posted when `#reportStackVerdict` first parks a ticket on `pipenzo:awaiting-stack-approval` from
 * a Refine-time `stack` verdict (issue #99) -- the sibling of `refusalCommentBody` above and
 * `blownEstimateCommentBody` below, for the third trigger of that same label. */
export function stackProposedCommentBody(
  estimate: RefineEstimateV1,
  proposedSplit?: readonly RefineProposedSplitPartV1[],
): string {
  const lines = [
    `This ticket's diff is estimated at **${estimate.changedLines}** changed lines across **${estimate.filesTouched}** files -- over the one-PR budget, but it layers cleanly into a dependency-ordered stack.`,
  ];
  if (proposedSplit && proposedSplit.length > 0) {
    lines.push(
      '',
      `Proposed split · ${proposedSplit.length} ${proposedSplit.length === 1 ? 'ticket' : 'tickets'}, in this order:`,
    );
    proposedSplit.forEach((part, index) => {
      lines.push(
        `${index + 1}. ${part.summary} (≈${part.changedLines} lines, ${part.filesTouched} files)`,
      );
    });
    lines.push(
      '',
      'Parked in `pipenzo:awaiting-stack-approval` for a human to accept, reorder, or reject this split.',
    );
  } else {
    lines.push(
      '',
      'Parked in `pipenzo:awaiting-stack-approval` -- no proposed split was generated for it yet.',
    );
  }
  return lines.join('\n');
}

/** Posted by `acceptStack()` once every child ticket in the approved order has been materialized. */
export function stackAcceptedCommentBody(
  children: readonly { readonly issueNumber: number; readonly title: string }[],
): string {
  const lines = [
    `Stack accepted -- ${children.length} child ${children.length === 1 ? 'ticket' : 'tickets'} created, in dependency order:`,
    '',
  ];
  children.forEach((child, index) => {
    lines.push(`${index + 1}. #${child.issueNumber} -- ${child.title}`);
  });
  lines.push(
    '',
    'This ticket is now a container; restacking after a merge is GitHub’s own job (`gh stack`).',
  );
  return lines.join('\n');
}

/** Posted by `rejectStack()`, mandatory reason inline -- see that method's own doc comment for why
 * this particular comment is never best-effort. */
export function stackRejectedCommentBody(reason: string): string {
  return [
    'Stack proposal rejected.',
    '',
    reason,
    '',
    'The ticket stays in `pipenzo:awaiting-stack-approval` -- no worktree was created and nothing retries on its own.',
  ].join('\n');
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
