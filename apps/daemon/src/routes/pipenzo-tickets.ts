import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  pipenzoTicketListV1Schema,
  pipenzoTicketReadRequestV1Schema,
  pipenzoTicketReconciliationV1Schema,
  pipenzoTicketRiskActivityOpenedRequestV1Schema,
  pipenzoTicketRiskApprovalOutcomeRequestV1Schema,
  pipenzoTicketRiskResponseV1Schema,
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
import {
  computeWorkingLaneConcurrency,
  PIPENZO_DEFAULT_WORKING_CAPACITY,
} from '../working-lane-concurrency.js';
import {
  cleanupTerminalWorktree,
  isAbandonedToQueue,
  type TerminalWorktreeCleanupPort,
  type TicketWorktreeStorePort,
} from '../pipenzo-worktree-lifecycle.js';

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
 * - **Low rate limits.** `read`/`transition` are human-paced — a person opens a ticket, a person
 *   drags a card — and each one costs a GitHub read against a rate-limited API.
 *
 * ## The list route (issue #255) reads local state, never GitHub
 *
 * `GET /v2/pipenzo/tickets` used to not exist, and this module's own comment said why: reconciling
 * one ticket costs one GitHub read, so reconciling a board on every open would cost one per ticket
 * against a rate-limited API. That calculus held only until something kept the local record
 * reconciled *without* a live board-open triggering it — and the polling reconciler (#231) is that
 * something: it walks every connected repo's tickets on its own cadence, through this same
 * `PipenzoPhaseMachine.read()`, and keeps `FileTicketStore` label-wins reconciled in the background.
 * So the list route below is a synchronous local read (`machine.list()`, a passthrough to
 * `FileTicketStore.list()`) with no GitHub call and no per-ticket cost at all — the generous rate
 * limit it carries reflects that, matching `GET /v2/pipenzo/repos/connected`'s reasoning exactly.
 *
 * A ticket between reconciler polls can be up to one interval (60s by default) stale, which is the
 * honest tradeoff this design makes: "board open" no longer means "N GitHub reads", it means
 * "whatever the background loop already knew". A caller that needs one ticket reconciled *right
 * now* still wants `POST /v2/pipenzo/tickets/read`, not this.
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
  // Same family as illegal_transition: the request was well formed, but the machine refuses to act
  // on this ticket's current state -- here because that state is a schema this build cannot safely
  // read or write, not because the transition itself was illegal.
  schema_read_only: 409,
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
    ...(ticket.title ? { title: ticket.title } : {}),
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
    ...(ticket.updatedAt ? { updatedAt: ticket.updatedAt } : {}),
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
  /**
   * Terminal-state worktree cleanup (issue #159). Both optional, and only ever used together: a
   * human-driven transition that abandons a ticket back to `pipenzo:queued` (the phase machine's own
   * module doc names `working`/`ready-for-review` -> `queued` as exactly this) is followed by one
   * best-effort `cleanupTerminalWorktree()` call, the same shape the reconciler already uses for an
   * issue that closed. Omitted by every test that predates this ticket, which still transitions
   * exactly as before.
   */
  worktreeCleanup?: { tickets: TicketWorktreeStorePort; worktrees: TerminalWorktreeCleanupPort },
): void {
  const limits = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  // The board's list route (issue #255). Generous rather than `limits` above: this is a local read
  // through `machine.list()` with no GitHub call behind it, matching the reasoning
  // `GET /v2/pipenzo/repos/connected` already states for the same shape of route.
  app.get(
    '/v2/pipenzo/tickets',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      const records = machine.list();
      // Issue #85: the same hold-vs-run decision #164 defined, computed over every ticket
      // currently in the Working lane -- see `working-lane-concurrency.ts` for why this is a
      // report, not a gate. Every other lane is left out: `computeWorkingLaneConcurrency` has no
      // opinion on what a non-Working ticket's predicted files overlapping one would mean.
      const concurrency = computeWorkingLaneConcurrency(
        records
          .filter((record) => record.lane === 'working')
          .map((record) => ({
            ticketId: record.ticketId,
            issueNumber: record.issueNumber,
            filesLikelyTouched: record.spec?.filesLikelyTouched ?? [],
          })),
      );
      reply.send(
        pipenzoTicketListV1Schema.parse({
          tickets: records.map((record) => {
            const view = toTicketView(record);
            const state = concurrency.get(record.ticketId);
            return state ? { ...view, concurrency: state } : view;
          }),
          workingLaneCapacity: PIPENZO_DEFAULT_WORKING_CAPACITY,
        }),
      );
    },
  );

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
    // Best-effort, outside the try above and never allowed to turn a written label into a failed
    // response — same reasoning as the implement route's own comment. A cleanup refusal or failure
    // is surfaced by `cleanupTerminalWorktree()` itself, not by this route.
    if (worktreeCleanup && isAbandonedToQueue(result.previousLane, result.ticket.lane)) {
      await cleanupTerminalWorktree({
        ...worktreeCleanup,
        ticketId: parsed.data.ticketId,
        reason: 'abandoned',
      });
    }
    // Outside the try, same reasoning as the implement route: the GitHub label is already written by
    // now, so a response-shape mismatch must not be reported as a failure to transition -- the
    // operator's natural retry would be judged against a state that has already moved.
    reply.send(pipenzoTicketReconciliationV1Schema.parse(toReconciliationBody(result)));
  });

  /**
   * Issue #119: opening the ticket's Activity view always resets the cumulative-risk score to
   * zero. No renderer calls this yet -- the Activity view itself is issues #116-118, not yet
   * built -- but the daemon-side half of that reset (issue #95, `risk-score.ts`'s pure engine
   * from issue #158) is real today, and this is its one real entry point on the wire.
   */
  app.post('/v2/pipenzo/tickets/risk/activity-opened', limits, async (req, reply) => {
    const parsed = pipenzoTicketRiskActivityOpenedRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'risk activity-opened request');
    try {
      machine.recordRiskActivityOpened(parsed.data.ticketId);
    } catch (error) {
      if (error instanceof PipenzoPhaseMachineError) return fail(reply, error);
      return fail(reply, new PipenzoPhaseMachineError('store_failed', 'risk reset failed'));
    }
    const risk = machine.peekRiskScore(parsed.data.ticketId);
    if (!risk) {
      return fail(
        reply,
        new PipenzoPhaseMachineError('ticket_not_found', `no such ticket: ${parsed.data.ticketId}`),
      );
    }
    reply.send(pipenzoTicketRiskResponseV1Schema.parse({ risk }));
  });

  /**
   * Issues #95/#97/#98: a human approved a MEDIUM- or HIGH-graded action. A HIGH approval resets
   * the score; a MEDIUM approval deliberately does not (`risk-score.ts`'s own doc comment on
   * `recordApprovalOutcome`). No renderer calls this yet -- `PublishActions.tsx`'s approval cards
   * are keyed by `worktreeId`, not `ticketId` -- see this ticket's PR description.
   */
  app.post('/v2/pipenzo/tickets/risk/approval-outcome', limits, async (req, reply) => {
    const parsed = pipenzoTicketRiskApprovalOutcomeRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'risk approval-outcome request');
    try {
      machine.recordRiskApprovalOutcome(parsed.data.ticketId, parsed.data.effectiveGrade);
    } catch (error) {
      if (error instanceof PipenzoPhaseMachineError) return fail(reply, error);
      return fail(reply, new PipenzoPhaseMachineError('store_failed', 'risk approval outcome failed'));
    }
    const risk = machine.peekRiskScore(parsed.data.ticketId);
    if (!risk) {
      return fail(
        reply,
        new PipenzoPhaseMachineError('ticket_not_found', `no such ticket: ${parsed.data.ticketId}`),
      );
    }
    reply.send(pipenzoTicketRiskResponseV1Schema.parse({ risk }));
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
