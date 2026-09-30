import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  pipenzoMediumApprovalCaptureRequestV1Schema,
  pipenzoMediumApprovalCaptureResultV1Schema,
  pipenzoMediumApprovalDecideRequestV1Schema,
  pipenzoMediumApprovalDecideResultV1Schema,
  pipenzoMediumApprovalStatusRequestV1Schema,
  pipenzoMediumApprovalStatusResultV1Schema,
  pipenzoMediumApprovalUndoRequestV1Schema,
  pipenzoMediumApprovalUndoResultV1Schema,
  type PipenzoMediumApprovalErrorCodeV1,
} from '@agent-dock/shared';
import { PipenzoPhaseMachineError, type PipenzoPhaseMachine } from '../pipenzo-phase-machine.js';
import type { MediumApprovalStore } from '../medium-approval-store.js';
import { UndoSnapshotError } from '../undo-snapshot.js';
import type { OwnedWorktreeManager } from '../worktree-manager.js';

/**
 * The MEDIUM inline approval flow's own routes (Pipenzo issue #97), on the same authenticated local
 * surface as `routes/pipenzo-tickets.ts` -- the startup bearer token and reject-any-Origin guard
 * from `server.ts`, never reachable from an agent session's own environment.
 *
 * Four routes, one per step of the flow: `capture` (pre-action snapshot, before the gated action
 * runs), `decide` (the human's Allow/Reject, `allow` also recording the risk-score outcome via
 * `machine.recordRiskApprovalOutcome`), `status` (a live, non-mutating undo-availability poll for
 * the resolved-line UI), `undo` (the one-shot restore). See `medium-approval-store.ts`'s own module
 * comment for why the gate and the decision are two separate calls, and
 * `pipenzo-medium-approval-v1.ts`'s module comment for the wire shapes.
 *
 * `worktreeId` never resolves to a path this route echoes back -- `OwnedWorktreeManager.ownedLocation`
 * is read here, server-side, and only its `path` is ever handed to `MediumApprovalStore.capture`,
 * matching the "no worktree filesystem path, in either direction" rule the ticket-view routes state.
 * Before that resolution happens at all, `machine.peekWorktree(ticketId)` must agree that this
 * `worktreeId` is the one actually recorded against this `ticketId` -- a request naming a real
 * ticket and a real (but different) worktree id is refused exactly like an unknown ticket, so a
 * caller cannot snapshot, decide on, or undo a different ticket's worktree by supplying its id
 * alongside a `ticketId` it does not belong to.
 */
const MEDIUM_APPROVAL_ERROR_STATUS: Record<PipenzoMediumApprovalErrorCodeV1, number> = {
  invalid_request: 400,
  ticket_not_found: 404,
  worktree_not_found: 404,
  snapshot_not_found: 404,
  git_unavailable: 502,
  store_failed: 500,
};

function fail(reply: FastifyReply, code: PipenzoMediumApprovalErrorCodeV1, error: string): void {
  reply.code(MEDIUM_APPROVAL_ERROR_STATUS[code]).send({ code, error });
}

function invalid(reply: FastifyReply, what: string): void {
  fail(reply, 'invalid_request', `invalid ${what}`);
}

export function registerPipenzoMediumApprovalRoutes(
  app: FastifyInstance,
  machine: PipenzoPhaseMachine,
  worktrees: OwnedWorktreeManager,
  store: MediumApprovalStore,
): void {
  // Human-paced and each backed by real git/filesystem I/O, same reasoning as the publish route's
  // own rate limit: nothing legitimate captures or decides on ten MEDIUM actions a minute.
  const limits = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.post('/v2/pipenzo/tickets/risk/medium-approval/capture', limits, async (req, reply) => {
    const parsed = pipenzoMediumApprovalCaptureRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'medium-approval capture request');
    const { ticketId, worktreeId, branch, touchedPaths } = parsed.data;

    const recordedWorktree = machine.peekWorktree(ticketId);
    if (!recordedWorktree || recordedWorktree.id !== worktreeId) {
      return fail(reply, 'ticket_not_found', `no such ticket, or ${worktreeId} is not its worktree`);
    }
    const location = worktrees.ownedLocation(worktreeId);
    if (!location) return fail(reply, 'worktree_not_found', `no such worktree: ${worktreeId}`);

    try {
      const snapshotId = await store.capture({
        ticketId,
        worktreeRoot: location.path,
        branch,
        touchedPaths,
      });
      reply.send(pipenzoMediumApprovalCaptureResultV1Schema.parse({ snapshotId }));
    } catch (error) {
      if (error instanceof UndoSnapshotError) {
        // 'high_risk_blocked' cannot happen -- this store always captures at 'medium' -- but is
        // included for exhaustiveness against `UndoSnapshotError.code`'s real union rather than an
        // unchecked cast.
        if (error.code === 'git_unavailable') return fail(reply, 'git_unavailable', error.message);
        return invalid(reply, 'medium-approval capture request');
      }
      return fail(reply, 'store_failed', 'capturing the pre-action snapshot failed');
    }
  });

  app.post('/v2/pipenzo/tickets/risk/medium-approval/decide', limits, async (req, reply) => {
    const parsed = pipenzoMediumApprovalDecideRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'medium-approval decide request');
    const { ticketId, snapshotId, decision, reason } = parsed.data;

    const decided = store.decide(ticketId, snapshotId, decision, reason);
    if (!decided) {
      return fail(
        reply,
        'snapshot_not_found',
        `no pending medium-approval snapshot ${snapshotId} for ticket ${ticketId}`,
      );
    }

    if (decision === 'reject') {
      // The asymmetric reset rule (risk-score.ts) only ever fires on an *approval* -- a rejected
      // action never ran, so it never earns a risk-score entry of its own, allow or reset alike.
      reply.send(pipenzoMediumApprovalDecideResultV1Schema.parse({ decision }));
      return;
    }

    try {
      machine.recordRiskApprovalOutcome(ticketId, 'medium');
    } catch (error) {
      if (error instanceof PipenzoPhaseMachineError) return fail(reply, 'store_failed', error.message);
      return fail(reply, 'store_failed', 'recording the approval outcome failed');
    }
    const risk = machine.peekRiskScore(ticketId);
    reply.send(pipenzoMediumApprovalDecideResultV1Schema.parse({ decision, risk }));
  });

  app.post(
    '/v2/pipenzo/tickets/risk/medium-approval/status',
    // Polled by the resolved-line UI while it is on screen (issue #97's own "live ... indicator"),
    // never on a fixed clock -- generous, matching `GET /v2/pipenzo/tickets/events`'s own reasoning
    // for a route with no upstream cost: this is a local git `rev-parse`, not a GitHub read.
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = pipenzoMediumApprovalStatusRequestV1Schema.safeParse(req.body);
      if (!parsed.success) return invalid(reply, 'medium-approval status request');
      const status = await store.status(parsed.data.ticketId, parsed.data.snapshotId);
      if (!status) {
        return fail(
          reply,
          'snapshot_not_found',
          `no allowed medium-approval snapshot ${parsed.data.snapshotId} for ticket ${parsed.data.ticketId}`,
        );
      }
      reply.send(pipenzoMediumApprovalStatusResultV1Schema.parse(status));
    },
  );

  app.post('/v2/pipenzo/tickets/risk/medium-approval/undo', limits, async (req, reply) => {
    const parsed = pipenzoMediumApprovalUndoRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'medium-approval undo request');
    const outcome = await store.undo(parsed.data.ticketId, parsed.data.snapshotId);
    if (!outcome) {
      return fail(
        reply,
        'snapshot_not_found',
        `no allowed medium-approval snapshot ${parsed.data.snapshotId} for ticket ${parsed.data.ticketId}`,
      );
    }
    reply.send(
      pipenzoMediumApprovalUndoResultV1Schema.parse(
        outcome.restored ? { restored: true } : { restored: false, reason: outcome.reason },
      ),
    );
  });
}
