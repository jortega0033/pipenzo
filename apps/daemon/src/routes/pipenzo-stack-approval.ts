import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  pipenzoStackApprovalCaptureRequestV1Schema,
  pipenzoStackApprovalCaptureResultV1Schema,
  pipenzoStackApprovalDecideRequestV1Schema,
  pipenzoStackApprovalDecideResultV1Schema,
  type PipenzoStackApprovalErrorCodeV1,
} from '@agent-dock/shared';
import type { PipenzoPhaseMachine } from '../pipenzo-phase-machine.js';
import type { PipenzoPhaseService } from '../pipenzo-phase-service.js';
import { StackMaterializationError } from '../pipenzo-stack-materializer.js';
import type { StackApprovalStore } from '../stack-approval-store.js';

/**
 * The stack approval panel's own routes (Pipenzo issue #99) -- the human-facing half of the
 * diff-size gate's `stack` verdict, mirroring `routes/pipenzo-high-approval.ts`'s two-route,
 * capture-then-decide shape (issue #98) for the same "block run" reason.
 *
 * ## `capture`
 *
 * Refuses (as `ticket_not_found`, deliberately collapsed with "no such ticket" the same way HIGH's
 * own error codes collapse distinct not-found cases -- a caller cannot legitimately need to tell
 * them apart to do the right thing next) unless the ticket is genuinely on
 * `pipenzo:awaiting-stack-approval` **and** its cached spec carries a non-empty `proposedSplit`.
 * Both conditions matter: a ticket that reached this label via #144's blown-estimate path (a real
 * diff overran its estimate) has no proposed split at all, and there is nothing to approve as a
 * stack for it. `store.capture()` freezes exactly the parts returned here, so nothing later in
 * `decide()` can act on a different set than what this response showed the human.
 *
 * ## `decide`
 *
 * `store.decide()` runs first and enforces the wire contract's own invariants a second time
 * (mandatory reason on reject, an exact-permutation `order` on accept) independently of the schema's
 * `superRefine` -- the same defense-in-depth reasoning `HighApprovalStore.decide()` re-checking its
 * own mandatory-reason rule gives. Only once that succeeds does this route call into
 * `PipenzoPhaseService`'s real, effectful halves (`acceptStack`/`rejectStack`) -- genuine GitHub
 * writes and, for an accept, genuine worktree/branch/ticket creation, never reachable without both a
 * store-issued `approvalId` and a human's own POST to this route.
 */
const STACK_APPROVAL_ERROR_STATUS: Record<PipenzoStackApprovalErrorCodeV1, number> = {
  invalid_request: 400,
  ticket_not_found: 404,
  approval_not_found: 404,
  materialization_failed: 502,
  store_failed: 500,
};

function fail(reply: FastifyReply, code: PipenzoStackApprovalErrorCodeV1, error: string): void {
  reply.code(STACK_APPROVAL_ERROR_STATUS[code]).send({ code, error });
}

function invalid(reply: FastifyReply, what: string): void {
  fail(reply, 'invalid_request', `invalid ${what}`);
}

export function registerPipenzoStackApprovalRoutes(
  app: FastifyInstance,
  machine: Pick<PipenzoPhaseMachine, 'read'>,
  service: Pick<PipenzoPhaseService, 'acceptStack' | 'rejectStack'>,
  store: StackApprovalStore,
): void {
  // Human-paced, same reasoning as the HIGH/MEDIUM routes' own rate limits.
  const limits = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.post('/v2/pipenzo/tickets/risk/stack-approval/capture', limits, async (req, reply) => {
    const parsed = pipenzoStackApprovalCaptureRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'stack-approval capture request');
    const { ticketId } = parsed.data;

    let current;
    try {
      current = await machine.read(ticketId);
    } catch {
      return fail(reply, 'ticket_not_found', `no such ticket: ${ticketId}`);
    }

    const parts = current.ticket.spec?.proposedSplit;
    if (!current.ticket.labels.includes('pipenzo:awaiting-stack-approval') || !parts || parts.length === 0) {
      return fail(
        reply,
        'ticket_not_found',
        `ticket ${ticketId} has no pending stack proposal to capture`,
      );
    }

    try {
      const approvalId = store.capture(ticketId, parts);
      reply.send(pipenzoStackApprovalCaptureResultV1Schema.parse({ approvalId, parts }));
    } catch {
      return fail(reply, 'store_failed', 'capturing the pending stack approval failed');
    }
  });

  app.post('/v2/pipenzo/tickets/risk/stack-approval/decide', limits, async (req, reply) => {
    const parsed = pipenzoStackApprovalDecideRequestV1Schema.safeParse(req.body);
    // The schema's own `superRefine` already refuses a reject with no reason, and an accept with no
    // order or repository path -- this `!parsed.success` branch is what a caller who tries any of
    // those actually hits, before `store.decide()` is ever called.
    if (!parsed.success) return invalid(reply, 'stack-approval decide request');
    const { ticketId, approvalId, decision, order, reason, repositoryPath } = parsed.data;

    const decided = store.decide(ticketId, approvalId, decision, { order, reason });
    if (!decided) {
      return fail(
        reply,
        'approval_not_found',
        `no pending stack approval ${approvalId} for ticket ${ticketId}`,
      );
    }

    if (decided.kind === 'reject') {
      try {
        await service.rejectStack(ticketId, decided.reason);
      } catch (error) {
        return fail(
          reply,
          'store_failed',
          error instanceof Error ? error.message : 'could not post the rejection reason to the issue',
        );
      }
      reply.send(pipenzoStackApprovalDecideResultV1Schema.parse({ decision: 'reject' }));
      return;
    }

    // `superRefine` already guarantees `repositoryPath` is present for an `accept` decision.
    try {
      const children = await service.acceptStack(ticketId, decided.orderedParts, repositoryPath!);
      reply.send(pipenzoStackApprovalDecideResultV1Schema.parse({ decision: 'accept', children }));
    } catch (error) {
      // A `StackMaterializationError` may carry children that were genuinely created before the
      // failure (see that class's own doc comment) -- surfaced in the message so a human reading the
      // error knows what already exists rather than assuming nothing happened.
      const partial =
        error instanceof StackMaterializationError && error.children.length > 0
          ? ` (${error.children.length} of ${decided.orderedParts.length} were created before this failed: ${error.children
              .map((child) => `#${child.issueNumber}`)
              .join(', ')})`
          : '';
      return fail(
        reply,
        'materialization_failed',
        `${error instanceof Error ? error.message : 'accepting the stack failed'}${partial}`,
      );
    }
  });
}
