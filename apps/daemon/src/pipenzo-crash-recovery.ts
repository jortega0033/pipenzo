import {
  PIPENZO_SCHEMA_V1_MARKER_LABEL,
  type PipenzoLabelV1,
  type PipenzoParkedTicketV1,
  type PipenzoRecoveryReportV1,
  type PipenzoTicketRecordV1,
} from '@agent-dock/shared';
import type { Logger } from '@agent-dock/agent-runtime';
import type { ExecutionGraphStore } from './execution-graph-store.js';
import type { SessionStore } from './session-store.js';
import type { FileTicketStore } from './pipenzo-ticket-store.js';
import type { PipenzoPhaseEventBus } from './pipenzo-phase-events.js';
import { isConditionLabel, type PipenzoPhaseMachine } from './pipenzo-phase-machine.js';

/**
 * Crash recovery for the half nothing owned (Pipenzo issue #190).
 *
 * The inherited half already worked and then stopped. `FileExecutionGraphStore` marks every
 * non-terminal execution `interrupted` with `reason: 'daemon_restart'` and reports its session id;
 * `FileSessionStore` does the same for its compatibility records. Neither store knows what a ticket
 * is, so `index.ts` could only log a count — and a crash mid-Implement left three things with no
 * owner: an interrupted session, a dirty worktree, and a ticket whose local phase and its GitHub
 * label disagree. This module is what turns those three into one parked ticket a human can act on.
 *
 * ## It parks. It never resumes, and never retries.
 *
 * README and the epic both state the refusal, and it is the reason this file has no dispatch path
 * of any kind: **the approval state of an in-flight MEDIUM/HIGH action is unknowable after a
 * crash.** The daemon died somewhere between "the implementer posted what it is about to run" and
 * "a human approved or denied it", and nothing on disk distinguishes those two. Resuming into that
 * gap could silently re-run something a person was about to deny. No configuration flag turns this
 * off, which is why there is no option to turn off — a flag would be the feature.
 *
 * So the only two outcomes a parked ticket offers are a human's: **Resume** (offered only when it
 * would actually succeed, see `resumableSession` below) and **Discard and restart**, which needs
 * nothing new here because it goes through the worktree cleanup route that already exists
 * (`POST /v2/worktrees/cleanup`, issue #112, addressed by the worktree id this report carries).
 *
 * ## The sessionId -> ticketId index is built in memory, at recovery time
 *
 * `attempts[].sessionId` already carries the lineage, so the index is a walk over
 * `FileTicketStore.list()` rather than a new persisted structure — deliberately, and for three
 * reasons. Recovery runs exactly once per daemon start, so the walk is paid once. `list()` is
 * already an in-memory read of records the store loaded on construction, so the walk costs no extra
 * I/O at all. And a persisted index would itself be durable state that can tear mid-write, which
 * means the crash-recovery path would acquire its own crash-recovery problem — a second thing to
 * repair before the first one can run. Nothing here changes the ticket store's on-disk schema.
 *
 * ## Write order is inverted here, on purpose
 *
 * `PipenzoPhaseMachine` writes GitHub first and the local record second, and its module comment
 * explains why that is right for an operator-driven transition. This module writes the **local**
 * record first and attempts the GitHub label afterwards, which is the opposite order, because the
 * question it answers is different: not "which order survives a crash between the two writes" but
 * "what must never be allowed to stop a daemon from starting".
 *
 * The label write is a network round trip to a rate-limited API, and a daemon starts in exactly the
 * conditions where that call is least likely to work: no token configured yet, no network, or a
 * quota already spent. Ordering GitHub first would mean a ticket whose session crashed is not parked
 * *anywhere* whenever GitHub is unreachable — the local record would never be written, and the one
 * store that could have told a human what happened would be silent. Ordering the local write first
 * costs a window in which this daemon knows a ticket is interrupted and GitHub does not, and that
 * window closes on its own: `read()` reconciles the record to the issue's labels on the next look,
 * which is the same self-healing property the machine's own ordering relies on.
 *
 * The GitHub half is therefore best-effort and cannot throw into startup. A failure is logged with
 * the ticket named, and the parked entry says `labelWrite: 'failed'` so the desktop can show which
 * tickets GitHub has not been told about.
 */

/** Only what recovery reads: the execution record for one interrupted session id. */
export type RecoveryExecutionLookup = Pick<ExecutionGraphStore, 'get'>;

/** Only what recovery reads from the v1 compatibility store. */
export type RecoveryCompatSessionLookup = Pick<SessionStore, 'get'>;

export interface PipenzoCrashRecoveryOptions {
  tickets: FileTicketStore;
  executions: RecoveryExecutionLookup;
  sessions: RecoveryCompatSessionLookup;
  logger: Logger;
  /**
   * The phase machine, used for the GitHub half only. Optional: a daemon assembled without a GitHub
   * client still parks every interrupted ticket locally, which is the half that matters for not
   * losing the ticket. Without it the parked entries simply stay `pending`.
   */
  machine?: PipenzoPhaseMachine;
  /**
   * The phase stream (#189). Recovery moving a lane is exactly the kind of transition that stream
   * exists to carry: the board is very often opened for the first time right after a restart, and a
   * ticket that silently changed columns while the desktop was not connected is a card a human
   * never sees move.
   */
  events?: PipenzoPhaseEventBus;
}

export interface PipenzoCrashRecoveryInput {
  /**
   * Interrupted session ids from **both** stores' recovery reports. The caller merges them; this
   * module deduplicates, because one session can appear in both (the execution graph is the
   * authority, and `FileSessionStore` keeps a compatibility record for the same id).
   */
  interruptedSessionIds: readonly string[];
  /** `TicketStoreRecoveryReport.quarantinedFiles.length`, carried through to the report. */
  quarantinedTicketRecordCount: number;
}

const EMPTY_REPORT: PipenzoRecoveryReportV1 = {
  schemaVersion: 1,
  interruptedSessionCount: 0,
  unmatchedSessionCount: 0,
  quarantinedTicketRecordCount: 0,
  parked: [],
};

export class PipenzoCrashRecovery {
  readonly #tickets: FileTicketStore;
  readonly #executions: RecoveryExecutionLookup;
  readonly #sessions: RecoveryCompatSessionLookup;
  readonly #logger: Logger;
  readonly #machine: PipenzoPhaseMachine | undefined;
  readonly #events: PipenzoPhaseEventBus | undefined;
  #report: PipenzoRecoveryReportV1 = EMPTY_REPORT;

  constructor(options: PipenzoCrashRecoveryOptions) {
    this.#tickets = options.tickets;
    this.#executions = options.executions;
    this.#sessions = options.sessions;
    this.#logger = options.logger;
    this.#machine = options.machine;
    this.#events = options.events;
  }

  /**
   * The local half: resolve every interrupted session to its ticket and park it in Needs-human.
   *
   * Synchronous and local-only by construction. It is called at startup beside the two recovery
   * reports it consumes, before the server listens, so `GET /v2/pipenzo/recovery` can never answer
   * with a half-built report — and because it touches nothing but the ticket store's own files, it
   * cannot be the reason a daemon fails to start.
   */
  park(input: PipenzoCrashRecoveryInput): PipenzoRecoveryReportV1 {
    const sessionIds = [...new Set(input.interruptedSessionIds)];
    const index = this.#sessionToTicket();
    const parked: PipenzoParkedTicketV1[] = [];
    let unmatched = 0;

    // One ticket parks once, however many of its sessions the crash interrupted. A ticket can carry
    // several `attempts[]` -- a tier escalation, sibling executions -- and without this the loop
    // would park the same ticket twice: two cards for one ticket on the recovery screen, and a
    // second phase-stream event whose `fromLane` was read from a pre-park snapshot and so names a
    // lane the ticket had already left. The first interrupted session is the one reported, matching
    // `#sessionToTicket`'s first-wins rule.
    const parkedTicketIds = new Set<string>();

    for (const sessionId of sessionIds) {
      const ticket = index.get(sessionId);
      if (!ticket) {
        // Normal, not an error: agentdock runs plain sessions with no Pipenzo ticket behind them,
        // and a crash interrupts those the same way it interrupts a ticket's. Counted rather than
        // logged one by one so a restart after a wide crash does not produce a wall of warnings.
        unmatched += 1;
        continue;
      }
      if (parkedTicketIds.has(ticket.ticketId)) continue;
      const record = this.#parkTicket(ticket, sessionId);
      if (record) {
        parkedTicketIds.add(ticket.ticketId);
        parked.push(record);
      }
    }

    if (unmatched > 0) {
      this.#logger.info('interrupted sessions belonged to no Pipenzo ticket', {
        sessions: unmatched,
      });
    }
    if (parked.length > 0) {
      this.#logger.warn('parked interrupted Pipenzo tickets for a human', {
        tickets: parked.length,
        resumable: parked.filter((entry) => entry.resumable).length,
      });
    }

    this.#report = {
      schemaVersion: 1,
      interruptedSessionCount: sessionIds.length,
      unmatchedSessionCount: unmatched,
      quarantinedTicketRecordCount: input.quarantinedTicketRecordCount,
      parked,
    };
    return this.report();
  }

  /**
   * The GitHub half: put `pipenzo:interrupted` on each parked ticket's issue, best-effort.
   *
   * Deliberately a separate call from `park()`, so `index.ts` can run it **after** `app.listen()`
   * resolves. Recovery must not make a daemon's startup wait on a rate-limited network API — a
   * desktop waiting to connect would sit behind however long GitHub takes to answer for every parked
   * ticket, and a GitHub outage would turn a crash into a daemon that never finishes starting. The
   * local park has already committed by then, so the route serves a truthful report for the whole
   * window this is still running.
   *
   * Sequential rather than concurrent: these are writes against a quota'd API, and a restart that
   * fired every parked ticket's label write at once is the shape of request burst that gets a token
   * rate-limited precisely when an operator needs it working.
   *
   * The transition goes through `PipenzoPhaseMachine` rather than `GitHubClient.setIssueLabels`
   * directly. Writing the label here would mean re-deriving three things the machine already owns
   * and that a second copy would drift from: which labels survive a write (`setIssueLabels` replaces
   * the whole `pipenzo:` namespace, so the schema marker and a carried `pipenzo:ci-failed` have to
   * be re-asserted), what the local record should say afterwards (GitHub's response, not our
   * intent), and the announcement on the phase stream.
   *
   * Never throws. A rejected promise from here would be an unhandled rejection in a fire-and-forget
   * call at startup, which is the same daemon-killing failure the local-first ordering exists to
   * avoid, arriving through a different door.
   */
  async writeLabels(): Promise<PipenzoRecoveryReportV1> {
    const machine = this.#machine;
    if (!machine || this.#report.parked.length === 0) return this.report();

    const updated: PipenzoParkedTicketV1[] = [];
    for (const entry of this.#report.parked) {
      if (entry.labelWrite !== 'pending') {
        updated.push(entry);
        continue;
      }
      // Re-read immediately before the write, because this loop runs while the API is live. Each
      // iteration costs two GitHub round trips, so on a real backlog the board has been up and
      // answering `GET /v2/pipenzo/recovery` for a long time before the last ticket's turn comes --
      // long enough for someone to read the parked set and act on it. If they moved this ticket out
      // of the park, the write is abandoned: recovery parks a ticket to put a decision in front of a
      // human, and re-asserting `interrupted` after they made it would be this module overruling the
      // human it exists to defer to, which is the same harm as the auto-resume it refuses outright.
      if (!this.#stillParked(entry.ticketId)) {
        updated.push({ ...entry, labelWrite: 'superseded' });
        continue;
      }
      try {
        const result = await machine.transition(entry.ticketId, 'pipenzo:interrupted');
        // Report what the two sides settled on rather than what was asked for. A concurrent writer
        // can pin the issue at another lane between the write and its response, and a recovery
        // screen that showed the lane it requested would be the one surface claiming a state
        // neither store holds.
        //
        // `written` means "GitHub carries pipenzo:interrupted too", so it is claimed only when the
        // label is actually in the settled set. A transition can return without throwing and still
        // land a different label -- `transitionDivergenceFor` names the cases: a racing writer whose
        // label outranks ours (`lane_reconciled`), `ambiguous_labels`, `unlabelled`. Reporting
        // `written` there would assert an agreement that does not exist.
        const landed = result.ticket.labels.includes('pipenzo:interrupted');
        updated.push({
          ...entry,
          lane: result.ticket.lane,
          labels: [...result.ticket.labels],
          labelWrite: landed ? 'written' : 'superseded',
        });
      } catch (error) {
        // Named, so an operator knows which ticket GitHub has not been told about, and can find it
        // on the board by the local park that did land. The message only: `GitHubClientError`
        // redacts its own, and a stack is noise for a network failure at startup.
        this.#logger.warn('could not write pipenzo:interrupted to GitHub', {
          ticketId: entry.ticketId,
          repo: entry.repo,
          issueNumber: entry.issueNumber,
          error: error instanceof Error ? error.message : String(error),
        });
        // The local record is left exactly as the failed transition left it, which may mean the
        // park was undone: `transition()` reconciles before it writes, and reconciliation is
        // label-wins, so a successful issue read followed by a failed `setIssueLabels` rewrites the
        // record to whatever the issue still says.
        //
        // Re-applying the park here was tried and removed. Nothing in the record can distinguish
        // "reconciliation reverted my park" from "a human moved this ticket while the write was in
        // flight" -- there is no revision on `PipenzoTicketRecordV1` and no compare-and-set on the
        // store -- and this loop runs after `listen()`, against a live API, so the second case is
        // real. Restoring blind discarded genuine human progress and left the local record and the
        // phase stream claiming a lane GitHub disagreed with: a divergence recovery invented.
        //
        // Leaving it alone keeps both sides telling the same story, and costs nothing that matters:
        // the interruption is still reported here with `labelWrite: 'failed'`, which is the surface
        // the recovery screen reads, and the next read or transition reconciles anyway.
        updated.push({ ...entry, labelWrite: 'failed' });
      }
    }

    this.#report = { ...this.#report, parked: updated };
    return this.report();
  }

  /**
   * Whether the ticket is still in the park this recovery wrote, and so still recovery's to finish.
   *
   * Checked immediately before each label write. A record that has left `needs-human`, or that no
   * longer carries `pipenzo:interrupted`, has been moved by something other than this loop -- in
   * practice a human acting on the recovery screen, since the route is live throughout.
   *
   * The check narrows the window to one ticket's transition rather than closing it outright: a human
   * acting in the seconds between this read and `setIssueLabels` returning is still overwritten, and
   * `#restorePark` cannot tell that case apart from the reconciliation it exists to undo, because
   * both leave a record without the label. Closing it fully needs a compare-and-set the ticket store
   * does not offer. What is bounded here is the window that actually matters: without this check it
   * spanned the whole backlog's worth of round trips, which is where a human realistically acts.
   */
  #stillParked(ticketId: string): boolean {
    const current = this.#tickets.get(ticketId);
    return (
      current !== undefined &&
      current.lane === 'needs-human' &&
      current.labels.includes('pipenzo:interrupted')
    );
  }

  /** A defensive copy, so a route handler cannot hand a caller the live report to mutate. */
  report(): PipenzoRecoveryReportV1 {
    return {
      ...this.#report,
      parked: this.#report.parked.map((entry) => ({
        ...entry,
        labels: [...entry.labels],
        ...(entry.worktree ? { worktree: { ...entry.worktree } } : {}),
      })),
    };
  }

  /**
   * `attempts[].sessionId` -> ticket, built from the records already in memory.
   *
   * First attempt wins on a repeated session id. That collision should not happen — a session
   * belongs to one ticket — and picking a winner deterministically is better than either throwing
   * (a corrupt attempt list would then stop every other ticket from parking) or parking the same
   * session against two tickets (two cards claiming one crashed session, one of them wrong).
   */
  #sessionToTicket(): Map<string, PipenzoTicketRecordV1> {
    const index = new Map<string, PipenzoTicketRecordV1>();
    for (const ticket of this.#tickets.list()) {
      for (const attempt of ticket.attempts) {
        if (!index.has(attempt.sessionId)) index.set(attempt.sessionId, ticket);
      }
    }
    return index;
  }

  /**
   * Writes one parked ticket and announces it. Returns `undefined` when the store refused the write,
   * so one unwritable record cannot stop the rest of the backlog from parking.
   */
  #persistPark(ticket: PipenzoTicketRecordV1): PipenzoTicketRecordV1 | undefined {
    const parked: PipenzoTicketRecordV1 = {
      ...ticket,
      lane: 'needs-human',
      labels: interruptedLabels(ticket.labels),
    };
    try {
      this.#tickets.update(ticket.ticketId, parked);
    } catch {
      // The store's own message is deliberately not forwarded. It bottoms out in `atomicWriteJson`,
      // which does not wrap Node's fs errors, so an EACCES or ENOSPC would put the absolute record
      // path -- and with it the state directory layout, the OS username and the pid -- into the
      // daemon's log, where the logger's key-based redactor would not catch it. Same substitution
      // the phase machine's `persist()` makes, for the same reason: recovery has no more business
      // publishing the daemon's on-disk layout than the phase surface does. The ticket id is enough
      // to act on, and the store has already reported the failure through its own quarantine path.
      this.#logger.warn('could not park an interrupted ticket in the ticket store', {
        ticketId: ticket.ticketId,
      });
      return undefined;
    }

    // After the write, never before, for the same reason the phase machine announces after both
    // sides commit: the stream is a report of what happened, and a board that redrew a lane for a
    // park that then failed to persist would be showing a column nothing agrees with.
    this.#events?.publish({
      ticketId: parked.ticketId,
      fromLane: ticket.lane,
      toLane: parked.lane,
      phase: parked.phase,
      labels: parked.labels,
    });
    return parked;
  }

  /** The parked record plus the session that put it there, as the recovery surface reports it. */
  #parkTicket(ticket: PipenzoTicketRecordV1, sessionId: string): PipenzoParkedTicketV1 | undefined {
    // A ticket already holding an unanswered human gate is reported as it stands, not parked: it is
    // already in the lane the park would move it to, and writing over its label would destroy the
    // question it is holding. See `holdsHumanGate`.
    const parked = holdsHumanGate(ticket) ? ticket : this.#persistPark(ticket);
    if (!parked) return undefined;
    return {
      ticketId: parked.ticketId,
      repo: parked.repo,
      issueNumber: parked.issueNumber,
      sessionId,
      lane: parked.lane,
      phase: parked.phase,
      labels: [...parked.labels],
      ...(parked.worktree
        ? { worktree: { id: parked.worktree.id, branch: parked.worktree.branch } }
        : {}),
      resumable: this.#resumable(sessionId),
      labelWrite: holdsHumanGate(ticket) ? 'skipped' : 'pending',
    };
  }

  /**
   * Whether Resume would actually succeed for this session, which is the only condition under which
   * it is offered.
   *
   * Both halves are required and neither substitutes for the other. `providerSessionId` is the
   * thread id the provider CLI reported, without which there is nothing to continue. A
   * `continuationScope` is the frozen tuple a continuation is only valid inside — provider,
   * executable path and version, authenticated account fingerprint, selected model, and the
   * workspace-trust epoch — and the execution graph refuses a continuation whose scope has moved.
   * A session with an id but no scope is one the daemon recorded before it had enough to resume
   * from; offering Resume there is a button that fails when pressed, which on a recovery screen is
   * worse than no button, because the alternative action (discard and restart) is one a human will
   * only reach for after the first one has already wasted their time.
   *
   * The scope lives only on the execution graph record. The `providerSessionId` may come from either
   * store: the graph is the authority, and the v1 compatibility record is consulted as a fallback so
   * a session that predates the graph's copy is not reported unresumable for a bookkeeping reason.
   */
  #resumable(sessionId: string): boolean {
    const execution = this.#executions.get(sessionId);
    if (execution?.continuationScope === undefined) return false;
    const providerSessionId =
      execution.session.providerSessionId ?? this.#sessions.get(sessionId)?.providerSessionId;
    return providerSessionId !== undefined && providerSessionId.length > 0;
  }
}

/**
 * The label set a parked ticket carries locally.
 *
 * It predicts what the GitHub half will write rather than inventing its own vocabulary: the state
 * label is replaced by `pipenzo:interrupted` (a ticket cannot be both working and interrupted), and
 * everything the phase machine would retain across a write is retained here too — the schema marker,
 * which is not lane-bearing, and any condition label, which README's ci-failed row says stays on a
 * ticket through a lane change. Predicting the same set is what makes the subsequent `transition()`
 * find the two sides in agreement instead of reporting a divergence recovery itself caused.
 *
 * A ticket already holding an unanswered human gate is never parked at all — see `holdsHumanGate`.
 *
 * The schema marker is deliberately *not* added when the record does not already carry it. The
 * machine's write will add it to the issue, but until that write lands the authoritative side has
 * no such label, and a local record asserting a state GitHub never agreed to is the one failure mode
 * the precedence rule exists to prevent. Reconciliation adds it on the next read.
 */
function interruptedLabels(current: readonly PipenzoLabelV1[]): PipenzoLabelV1[] {
  const retained = current.filter(
    (label) => label === PIPENZO_SCHEMA_V1_MARKER_LABEL || isConditionLabel(label),
  );
  return [...new Set<PipenzoLabelV1>(['pipenzo:interrupted', ...retained])];
}

/**
 * The Needs-human labels that stand for a question already put to a human and not yet answered.
 *
 * These are not states a crash invalidates. `pipenzo:awaiting-stack-approval` is README's
 * decomposition or blown-estimate gate, waiting on someone to accept, reorder or reject;
 * `needs-pre-scoping` and `merge-conflict` are the same shape of unfinished ask.
 */
const PIPENZO_HUMAN_GATE_LABELS: ReadonlySet<PipenzoLabelV1> = new Set<PipenzoLabelV1>([
  'pipenzo:needs-pre-scoping',
  'pipenzo:awaiting-stack-approval',
  'pipenzo:merge-conflict',
]);

/**
 * Whether the ticket is already waiting on a human, in which case recovery leaves its labels alone.
 *
 * Parking would write `pipenzo:interrupted` through `PipenzoPhaseMachine.transition()`, and
 * `setIssueLabels` replaces the whole `pipenzo:` namespace — so the gate would be destroyed on the
 * authoritative side, with nothing downstream to raise it again. After a Resume the ticket would
 * proceed straight past an approval nobody ever gave. Losing a pending approval that way is the same
 * class of harm as auto-resuming into one, which this module refuses outright.
 *
 * Skipping the park costs nothing that matters. The whole point of parking is to put a ticket
 * somewhere a human will see it, and a ticket at a gate is already in the Needs-human lane, already
 * on the board, already in front of the person whose answer it waits on. The interruption is still
 * reported: the entry appears in the recovery report with its real labels and `labelWrite: 'skipped'`,
 * so the desktop can show that this ticket also holds a crashed session without the daemon
 * overwriting the question it is holding.
 */
function holdsHumanGate(ticket: PipenzoTicketRecordV1): boolean {
  return ticket.labels.some((label) => PIPENZO_HUMAN_GATE_LABELS.has(label));
}
