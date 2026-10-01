import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  pipenzoPlanReviewCaptureRequestV1Schema,
  pipenzoPlanReviewCaptureResultV1Schema,
  pipenzoPlanReviewDecideRequestV1Schema,
  pipenzoPlanReviewDecideResultV1Schema,
  type PipenzoPlanReviewErrorCodeV1,
  type PipenzoPlanReviewSpecV1,
  type RefineSpecV1,
} from '@agent-dock/shared';
import type { PipenzoPhaseMachine } from '../pipenzo-phase-machine.js';
import type { PipenzoPhaseService } from '../pipenzo-phase-service.js';
import type { PlanReviewStore } from '../plan-review-store.js';

/**
 * The plan-review gate's own routes (Pipenzo issue #15, UI half #101) -- the human-facing half of a
 * clean Refine verdict's plan-review park, mirroring `routes/pipenzo-stack-approval.ts`'s two-route,
 * capture-then-decide shape (issue #99) for the same "block run" reason.
 *
 * ## `capture`
 *
 * Refuses (as `ticket_not_found`, deliberately collapsed with "no such ticket" the same way HIGH's
 * and stack approval's own error codes already collapse distinct not-found cases a caller cannot
 * legitimately need to tell apart) unless the ticket's local `awaitingPlanReview` marker is genuinely
 * set **and** its cached `spec` survived -- there is no dedicated label to check instead; see
 * `pipenzoTicketRecordV1Schema.awaitingPlanReview`'s own doc comment for why. `store.capture()`
 * freezes the whole spec; only a narrow `PipenzoPlanReviewSpecV1` projection of it crosses back on
 * the wire -- see `pipenzo-plan-review-v1.ts`'s own module comment for why that projection is wider
 * than `pipenzoTicketRefusalV1Schema`'s but still not the whole `RefineSpecV1`.
 *
 * ## `decide`
 *
 * `store.consume()` runs first; an unknown or already-decided `approvalId` is refused as
 * `approval_not_found` before any of `PipenzoPhaseService`'s own real, effectful methods are ever
 * called. Only once that succeeds does this route call `approvePlanReview`/`requestPlanReviewChanges`
 * /`rejectPlanReview` -- genuine Implement dispatch for an approve, a genuine GitHub comment either
 * way -- never reachable without both a store-issued `approvalId` and a human's own POST here.
 */
const PLAN_REVIEW_ERROR_STATUS: Record<PipenzoPlanReviewErrorCodeV1, number> = {
  invalid_request: 400,
  ticket_not_found: 404,
  approval_not_found: 404,
  implement_failed: 502,
  store_failed: 500,
};

function fail(reply: FastifyReply, code: PipenzoPlanReviewErrorCodeV1, error: string): void {
  reply.code(PLAN_REVIEW_ERROR_STATUS[code]).send({ code, error });
}

function invalid(reply: FastifyReply, what: string): void {
  fail(reply, 'invalid_request', `invalid ${what}`);
}

/** The narrow, wire-safe projection of a cached `RefineSpecV1` a plan-review decision is shown and
 * judged against -- see `pipenzo-plan-review-v1.ts`'s own `pipenzoPlanReviewSpecV1Schema` doc
 * comment for exactly which fields and why. */
function toPlanReviewSpec(spec: RefineSpecV1): PipenzoPlanReviewSpecV1 {
  return {
    summary: spec.summary,
    acceptanceCriteria: spec.acceptanceCriteria,
    outOfScope: spec.outOfScope,
    filesLikelyTouched: spec.filesLikelyTouched,
    estimate: spec.estimate,
    openQuestions: spec.openQuestions,
  };
}

export function registerPipenzoPlanReviewRoutes(
  app: FastifyInstance,
  machine: Pick<PipenzoPhaseMachine, 'read'>,
  service: Pick<
    PipenzoPhaseService,
    'approvePlanReview' | 'requestPlanReviewChanges' | 'rejectPlanReview'
  >,
  store: PlanReviewStore,
): void {
  // Human-paced, same reasoning as the HIGH/MEDIUM/stack-approval routes' own rate limits.
  const limits = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.post('/v2/pipenzo/tickets/risk/plan-review/capture', limits, async (req, reply) => {
    const parsed = pipenzoPlanReviewCaptureRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'plan-review capture request');
    const { ticketId } = parsed.data;

    let current;
    try {
      current = await machine.read(ticketId);
    } catch {
      return fail(reply, 'ticket_not_found', `no such ticket: ${ticketId}`);
    }

    const spec = current.ticket.spec;
    if (!current.ticket.awaitingPlanReview || !spec) {
      return fail(
        reply,
        'ticket_not_found',
        `ticket ${ticketId} has no pending plan review to capture`,
      );
    }

    try {
      const approvalId = store.capture(ticketId, spec);
      reply.send(
        pipenzoPlanReviewCaptureResultV1Schema.parse({
          approvalId,
          spec: toPlanReviewSpec(spec),
        }),
      );
    } catch {
      return fail(reply, 'store_failed', 'capturing the pending plan review failed');
    }
  });

  app.post('/v2/pipenzo/tickets/risk/plan-review/decide', limits, async (req, reply) => {
    const parsed = pipenzoPlanReviewDecideRequestV1Schema.safeParse(req.body);
    // The schema's own `superRefine` already refuses a `request_changes`/`reject` with no
    // feedback/reason, and an `approve` with no implement inputs -- this `!parsed.success` branch is
    // what a caller who tries any of those actually hits, before `store.consume()` is ever called.
    if (!parsed.success) return invalid(reply, 'plan-review decide request');
    const { ticketId, approvalId, decision, feedback, reason, implement } = parsed.data;

    const entry = store.consume(ticketId, approvalId);
    if (!entry) {
      return fail(
        reply,
        'approval_not_found',
        `no pending plan review ${approvalId} for ticket ${ticketId}`,
      );
    }

    if (decision === 'request_changes') {
      try {
        await service.requestPlanReviewChanges(ticketId, feedback!);
      } catch (error) {
        return fail(
          reply,
          'store_failed',
          error instanceof Error ? error.message : 'could not send the plan back for changes',
        );
      }
      reply.send(pipenzoPlanReviewDecideResultV1Schema.parse({ decision: 'request_changes' }));
      return;
    }

    if (decision === 'reject') {
      try {
        await service.rejectPlanReview(ticketId, reason!);
      } catch (error) {
        return fail(
          reply,
          'store_failed',
          error instanceof Error ? error.message : 'could not post the rejection reason to the issue',
        );
      }
      reply.send(pipenzoPlanReviewDecideResultV1Schema.parse({ decision: 'reject' }));
      return;
    }

    // `superRefine` already guarantees `implement` is present for an `approve` decision.
    try {
      const started = await service.approvePlanReview(ticketId, entry.spec, implement!);
      reply.send(
        pipenzoPlanReviewDecideResultV1Schema.parse({
          decision: 'approve',
          worktreeId: started.worktreeId,
          branch: started.branch,
          baseCommit: started.baseCommit,
          sessionId: started.sessionId,
        }),
      );
    } catch (error) {
      return fail(
        reply,
        'implement_failed',
        error instanceof Error ? error.message : 'approving the plan review failed',
      );
    }
  });
}
