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
import {
  BoundedPipenzoPhaseSseWriter,
  type PipenzoPhaseEventBus,
} from '../pipenzo-phase-events.js';

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
  // The daemon's own disk, not an upstream: a 5xx that is genuinely this process's fault.
  store_failed: 500,
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

/**
 * `Last-Event-ID` for the phase stream, resolved to the first sequence the subscriber still needs.
 *
 * A present id means "everything after this one", hence the `+ 1`. An absent header resolves to 0,
 * which is a *first* subscription, not a general-purpose reset: 0 is accepted only while the
 * daemon has not yet evicted anything, and is refused with `replay_gap` once the ring buffer has
 * wrapped and `earliestSequence` has moved off zero. That refusal is the point -- answering it with
 * a silently truncated history would leave the board rendering lanes it never saw the moves for --
 * so a reconnecting subscriber that gets a 409 must resubscribe at a sequence inside the window the
 * refusal reports back, not simply drop its cursor and retry bare (which is refused identically,
 * forever). Same parser and same contract as the v2 session stream's, deliberately: a renderer that
 * already knows how to reconnect to one stream should not have to learn a second set of cursor
 * rules. Anything not a plain non-negative integer is a client bug and is refused rather than
 * coerced.
 */
function parsePhaseLastEventId(header: string | string[] | undefined): number | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed < Number.MAX_SAFE_INTEGER ? parsed + 1 : undefined;
}

export function registerPipenzoTicketRoutes(
  app: FastifyInstance,
  machine: PipenzoPhaseMachine,
  events?: PipenzoPhaseEventBus,
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

  if (!events) return;

  /**
   * The phase-change stream (#189).
   *
   * Deliberately *not* under the `limits` above. Those exist because each of the two routes costs a
   * GitHub read against a quota; this one costs a socket and no upstream call at all, and rate-
   * limiting a stream a renderer reconnects to after every daemon restart would lock the board out
   * of live data at precisely the wrong moment. It stays behind the same bearer token and the same
   * reject-any-Origin guard as everything else on this surface.
   */
  app.get('/v2/pipenzo/tickets/events', async (req, reply) => {
    const sinceSequence = parsePhaseLastEventId(req.headers['last-event-id']);
    if (sinceSequence === undefined) {
      reply.code(400).send({ error: 'invalid Last-Event-ID', code: 'invalid_last_event_id' });
      return;
    }

    const window = events.replayWindow();
    if (sinceSequence < window.earliestSequence || sinceSequence > window.nextSequence) {
      // The buffer is bounded, so a cursor outside it cannot be served honestly. Reporting the
      // window back lets the caller resubscribe at a sequence that exists instead of guessing.
      reply.code(409).send({
        error: 'requested phase history is unavailable',
        code: 'replay_gap',
        details: window,
      });
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    let unsubscribe: (() => void) | undefined;
    let cleanupRequested = false;
    const cleanup = (): void => {
      if (!unsubscribe) {
        // Replay can close the writer synchronously, before `subscribe` has returned its disposer.
        cleanupRequested = true;
        return;
      }
      const release = unsubscribe;
      unsubscribe = undefined;
      release();
    };

    const writer = new BoundedPipenzoPhaseSseWriter(reply.raw, cleanup);
    reply.raw.once('close', () => writer.close());
    writer.start();

    unsubscribe = events.subscribe(sinceSequence, (event) => writer.write(event));
    if (cleanupRequested) cleanup();
  });
}
