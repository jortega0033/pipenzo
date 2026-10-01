import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  pipenzoHighApprovalCaptureRequestV1Schema,
  pipenzoHighApprovalCaptureResultV1Schema,
  pipenzoHighApprovalDecideRequestV1Schema,
  pipenzoHighApprovalDecideResultV1Schema,
  type PipenzoHighApprovalErrorCodeV1,
} from '@agent-dock/shared';
import { PipenzoPhaseMachineError, type PipenzoPhaseMachine } from '../pipenzo-phase-machine.js';
import type { HighApprovalStore } from '../high-approval-store.js';
import type { OwnedWorktreeManager } from '../worktree-manager.js';

/**
 * The HIGH full publish-gate card's own routes (Pipenzo issue #98), the HIGH-risk sibling of
 * `routes/pipenzo-medium-approval.ts` (issue #97) -- same authenticated local surface, same
 * `worktreeId`-resolved-server-side contract ("no worktree filesystem path, in either direction").
 *
 * Two routes, not four: `capture` (before the card is shown -- see `high-approval-store.ts`'s own
 * module comment for why this does no filesystem read at all, unlike MEDIUM's), `decide` (the
 * human's Approve/Reject; an `'approve'` also resets the cumulative-risk strip to zero via
 * `machine.recordRiskApprovalOutcome(ticketId, 'high')` -- the asymmetric reset rule's other half,
 * `risk-score.ts`'s own doc comment). There is no `status`/`undo` pair here: CLAUDE.md hard rule 3's
 * "never an auto-allow" is paired with the equally absolute "never an Undo" for HIGH
 * (`isUndoAvailable()` in `undo-snapshot.ts`), so there is nothing for a third or fourth route to
 * poll or restore.
 *
 * `worktreeId` is checked against `machine.peekWorktree(ticketId)` before it is ever resolved to a
 * real path, exactly like the MEDIUM route -- a request naming a real ticket and a real (but
 * different) worktree id is refused exactly like an unknown ticket.
 */
const HIGH_APPROVAL_ERROR_STATUS: Record<PipenzoHighApprovalErrorCodeV1, number> = {
  invalid_request: 400,
  ticket_not_found: 404,
  worktree_not_found: 404,
  approval_not_found: 404,
  store_failed: 500,
};

function fail(reply: FastifyReply, code: PipenzoHighApprovalErrorCodeV1, error: string): void {
  reply.code(HIGH_APPROVAL_ERROR_STATUS[code]).send({ code, error });
}

function invalid(reply: FastifyReply, what: string): void {
  fail(reply, 'invalid_request', `invalid ${what}`);
}

export function registerPipenzoHighApprovalRoutes(
  app: FastifyInstance,
  machine: PipenzoPhaseMachine,
  worktrees: OwnedWorktreeManager,
  store: HighApprovalStore,
): void {
  // Human-paced, same reasoning as the MEDIUM route's own rate limit: nothing legitimate captures
  // or decides on ten HIGH actions a minute.
  const limits = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.post('/v2/pipenzo/tickets/risk/high-approval/capture', limits, async (req, reply) => {
    const parsed = pipenzoHighApprovalCaptureRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'high-approval capture request');
    const { ticketId, worktreeId, branch } = parsed.data;

    const recordedWorktree = machine.peekWorktree(ticketId);
    if (!recordedWorktree || recordedWorktree.id !== worktreeId) {
      return fail(reply, 'ticket_not_found', `no such ticket, or ${worktreeId} is not its worktree`);
    }
    if (!worktrees.ownedLocation(worktreeId)) {
      return fail(reply, 'worktree_not_found', `no such worktree: ${worktreeId}`);
    }

    try {
      const approvalId = store.capture({ ticketId, branch });
      reply.send(pipenzoHighApprovalCaptureResultV1Schema.parse({ approvalId }));
    } catch {
      return fail(reply, 'store_failed', 'capturing the pending HIGH approval failed');
    }
  });

  app.post('/v2/pipenzo/tickets/risk/high-approval/decide', limits, async (req, reply) => {
    const parsed = pipenzoHighApprovalDecideRequestV1Schema.safeParse(req.body);
    // The schema's own `superRefine` already refuses a reject with no reason -- this `!parsed.success`
    // branch is what a caller who tries it actually hits, before `store.decide()` is ever called.
    if (!parsed.success) return invalid(reply, 'high-approval decide request');
    const { ticketId, approvalId, decision, reason } = parsed.data;

    const decided = store.decide(ticketId, approvalId, decision, reason);
    if (!decided) {
      return fail(
        reply,
        'approval_not_found',
        `no pending HIGH approval ${approvalId} for ticket ${ticketId}`,
      );
    }

    if (decision === 'reject') {
      // The asymmetric reset rule only ever fires on an approval -- a rejected action never ran, so
      // it never earns a risk-score entry of its own. It does earn a durable rejection record,
      // though (issue #105, CLAUDE.md hard rule 4): `HighApprovalStore.decide()` already deleted its
      // own ephemeral entry above, so this is the one place the ticket itself learns a human said no,
      // for `classifyRetry()` to refuse a retry against. Best-effort, never thrown -- the reject
      // itself already succeeded by the time this runs, same reasoning as every other secondary
      // bookkeeping write on this surface (`pipenzo-phase-service.ts`'s `#reportBudgetExhausted` is
      // the closest precedent) -- but logged via the request's own logger rather than swallowed
      // silently: a failure here is exactly the case CLAUDE.md hard rule 4 needs to be *detectable*,
      // since a later retry would otherwise find no rejection on file and proceed.
      try {
        machine.recordApprovalRejection(ticketId, 'high', decided.reason);
      } catch (error) {
        req.log.warn(
          { ticketId, error: error instanceof Error ? error.message : String(error) },
          'pipenzo: a HIGH reject succeeded but its durable rejection record could not be written',
        );
      }
      reply.send(pipenzoHighApprovalDecideResultV1Schema.parse({ decision }));
      return;
    }

    try {
      machine.recordRiskApprovalOutcome(ticketId, 'high');
    } catch (error) {
      if (error instanceof PipenzoPhaseMachineError) return fail(reply, 'store_failed', error.message);
      return fail(reply, 'store_failed', 'recording the approval outcome failed');
    }
    const risk = machine.peekRiskScore(ticketId);
    reply.send(pipenzoHighApprovalDecideResultV1Schema.parse({ decision, risk }));
  });
}
