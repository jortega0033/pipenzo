import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  pipenzoTicketReadRequestV1Schema,
  pipenzoTicketReconciliationV1Schema,
  pipenzoTicketTransitionRequestV1Schema,
  type PipenzoTicketErrorCodeV1,
  type PipenzoTicketViewV1,
} from '@agent-dock/shared';
import type { PipenzoTicketRecordV1 } from '@agent-dock/shared';
import {
  PipenzoPhaseMachineError,
  isLaneBearingLabel,
  type PipenzoPhaseMachine,
  type PipenzoTicketReconciliation,
} from '../pipenzo-phase-machine.js';

/**
 * The phase-machine routes (Pipenzo issue #188).
 *
 * These sit on exactly the surface `routes/pipenzo-phases.ts` describes and inherit every one of its
 * properties from `server.ts`: the startup bearer token, the reject-any-Origin browser guard, and
 * the fact that an agent session's environment carries neither the daemon's port nor its token. They
 * are not agent tools, not MCP servers, not skills, and nothing a model can name — the caller is the
 * desktop main process, acting for a human.
 *
 * Both choices below are copied from the phase routes rather than re-decided here:
 *
 * - **A rejected body is never echoed.** The Zod issue list stays on this side.
 * - **Low rate limits.** Both routes are human-paced — a person opens a ticket, a person drags a
 *   card — and each one costs a GitHub read against a rate-limited API.
 *
 * ## Why there is no list route
 *
 * A board needs every ticket, and this surface deliberately does not offer that. Reconciling one
 * ticket costs one GitHub read; reconciling a board costs one per ticket, on an API with a quota,
 * every time anyone opens the board. The reconciler that makes a list affordable is the polling
 * layer with `If-None-Match` (build step 4, #161 — "a `304` costs no quota at all"), which #188
 * explicitly puts out of scope. Shipping an unreconciled list route in the meantime would be worse
 * than shipping none: it would return lanes that look authoritative and are not, through a surface
 * whose entire purpose is that the label wins.
 */
const TICKET_ERROR_STATUS: Record<PipenzoTicketErrorCodeV1, number> = {
  invalid_request: 400,
  ticket_not_found: 404,
  // Not a bad request: the body was well formed and the ticket exists. It is the machine reporting
  // that the move is not one this state allows, which is a conflict with current state.
  illegal_transition: 409,
  token_missing: 412,
  invalid_repository: 412,
  issue_not_found: 404,
  // GitHub's own 401/403 are reported as 502, never mirrored -- a 401 on this route means the
  // *daemon's* bearer token was wrong, and an upstream credential failure wearing the same status
  // would send an operator looking in entirely the wrong place.
  github_unauthorized: 502,
  github_forbidden: 502,
  github_rate_limited: 429,
  github_failed: 502,
};

function fail(reply: FastifyReply, error: PipenzoPhaseMachineError): void {
  reply.code(TICKET_ERROR_STATUS[error.code]).send({
    code: error.code,
    error: error.message,
    ...(error.details.length > 0 ? { details: error.details } : {}),
  });
}

function invalid(reply: FastifyReply, what: string): void {
  reply.code(400).send({ code: 'invalid_request', error: `invalid ${what}` });
}

/**
 * Drops `worktree.path` on the way out.
 *
 * Written as an explicit field-by-field construction rather than a spread with a deletion, so the
 * path can only reach the wire if somebody adds it here on purpose. `pipenzoTicketViewV1Schema` is
 * `.strict()` and would reject the extra key as a second line of defence, but a route that
 * 500s on a leak is a worse outcome than one that never assembles it — this is the first line.
 */
function toTicketView(ticket: PipenzoTicketRecordV1): PipenzoTicketViewV1 {
  return {
    schemaVersion: ticket.schemaVersion,
    ticketId: ticket.ticketId,
    repo: ticket.repo,
    issueNumber: ticket.issueNumber,
    lane: ticket.lane,
    phase: ticket.phase,
    labels: ticket.labels,
    estimate: ticket.estimate,
    taskType: ticket.taskType,
    stack: ticket.stack,
    ...(ticket.worktree
      ? { worktree: { id: ticket.worktree.id, branch: ticket.worktree.branch } }
      : {}),
    attempts: ticket.attempts,
    budget: ticket.budget,
    risk: ticket.risk,
    precommits: ticket.precommits,
    etags: ticket.etags,
  };
}

function toReconciliationBody(result: PipenzoTicketReconciliation) {
  return {
    ticket: toTicketView(result.ticket),
    divergence: result.divergence,
    previousLane: result.previousLane,
    observedLabels: result.observedLabels,
    changed: result.changed,
  };
}

export function registerPipenzoTicketRoutes(
  app: FastifyInstance,
  machine: PipenzoPhaseMachine,
): void {
  const limits = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.post('/v2/pipenzo/tickets/read', limits, async (req, reply) => {
    const parsed = pipenzoTicketReadRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'ticket read request');
    try {
      const result = await machine.read(parsed.data.ticketId);
      reply.send(pipenzoTicketReconciliationV1Schema.parse(toReconciliationBody(result)));
    } catch (error) {
      if (error instanceof PipenzoPhaseMachineError) return fail(reply, error);
      return fail(reply, new PipenzoPhaseMachineError('github_failed', 'ticket read failed'));
    }
  });

  app.post('/v2/pipenzo/tickets/transition', limits, async (req, reply) => {
    const parsed = pipenzoTicketTransitionRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'ticket transition request');
    // The schema closes `label` to the vocabulary but cannot express "lane-bearing" without
    // duplicating the lane table on the wire. Checked here so the machine is never handed the
    // schema marker as if it were a state.
    if (!isLaneBearingLabel(parsed.data.label)) {
      return invalid(reply, 'ticket transition request');
    }
    let result: PipenzoTicketReconciliation;
    try {
      result = await machine.transition(parsed.data.ticketId, parsed.data.label);
    } catch (error) {
      if (error instanceof PipenzoPhaseMachineError) return fail(reply, error);
      return fail(reply, new PipenzoPhaseMachineError('github_failed', 'ticket transition failed'));
    }
    // Outside the try, same reasoning as the implement route: the GitHub label is already written by
    // now, so a response-shape mismatch must not be reported as a failure to transition -- the
    // operator's natural retry would be judged against a state that has already moved.
    reply.send(pipenzoTicketReconciliationV1Schema.parse(toReconciliationBody(result)));
  });
}
