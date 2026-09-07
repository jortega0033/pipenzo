import { z } from 'zod';
import { pipenzoIssueNumberV1Schema, pipenzoRepoRefV1Schema } from './pipenzo-phase-v1.js';
import { pipenzoTicketWorktreeViewV1Schema } from './pipenzo-phase-machine-v1.js';
import {
  PIPENZO_LABELS,
  pipenzoLabelV1Schema,
  pipenzoLaneV1Schema,
  pipenzoPhaseV1Schema,
  pipenzoTicketIdV1Schema,
} from './pipenzo-ticket-v1.js';

/**
 * What a daemon restart found parked, as the desktop is allowed to see it (Pipenzo issue #190).
 *
 * The two stores' own recovery already marks a non-terminal session `interrupted` and reports its
 * id (`FileExecutionGraphStore.recoverInterruptedExecutions`, `FileSessionStore.getRecoveryReport`).
 * Neither of them knows what a ticket is, so until this contract existed a crash mid-Implement left
 * an interrupted session, a dirty worktree and a ticket whose local phase and GitHub label disagree,
 * with nothing that could name the three as one event. This is the shape that names it.
 *
 * ## Exactly two actions, and the report says which one is available
 *
 * README and the epic are explicit that recovery offers **Resume** and **Discard and restart** and
 * nothing else — above all, that it never auto-resumes and never auto-retries, because the approval
 * state of an in-flight MEDIUM/HIGH action is unknowable after a crash and resuming into one could
 * silently re-run something a human was about to deny. So this report is descriptive: it says what
 * was found and what a human's two options are. Nothing in it is a command, and no field turns the
 * refusal to auto-resume off.
 *
 * `resumable` is what makes the offer honest rather than decorative. Resuming a provider thread
 * needs both a `providerSessionId` (the thread id the CLI reported) and a `continuationScope` (the
 * frozen provider/cwd/model/trust tuple a continuation is only valid inside). Both are already
 * persisted, so this is a lookup rather than new machinery — and a Resume button offered for a
 * session missing either one is a button that fails when pressed.
 *
 * Discard-and-restart needs no field here at all: it goes through the existing
 * `POST /v2/worktrees/cleanup`, addressed by the worktree id below.
 *
 * ## The worktree path is withheld here too
 *
 * `pipenzoTicketWorktreeViewV1Schema` — id and branch, never `path` — for exactly the reason
 * `pipenzo-phase-machine-v1.ts` gives: the renderer addresses a worktree by id so it can never ask
 * the daemon to run anything in a directory of its own choosing. The daemon's own ticket record
 * still holds the real path (it has to find the worktree it owns); this contract is the wire, and
 * a recovery surface is not an exception to a rule the ticket and worktree surfaces both keep.
 */

/* --------------------------------------------------------------- label write outcome */

/**
 * How far the `pipenzo:interrupted` **label** got, which is deliberately not the same question as
 * whether the ticket parked.
 *
 * The local park is written first and unconditionally, because it is a local write that cannot fail
 * on a network; the GitHub label write is attempted afterwards and best-effort, because GitHub may
 * be unreachable, rate-limited or tokenless at the moment a daemon starts, and a daemon that
 * refused to start because a label write failed would be a crash-recovery feature that turns one
 * crash into two. This field is how the desktop tells the difference between a ticket GitHub agrees
 * is interrupted and one only this daemon knows about.
 *
 * - `pending` — the local park is committed and the label write has not been attempted yet.
 * - `written` — GitHub carries `pipenzo:interrupted` too; both sides agree.
 * - `failed` — the attempt failed and was logged. The ticket is still parked locally, and the next
 *   `read()`/`transition()` on it reconciles the two sides.
 * - `superseded` — a human moved the ticket out of the park before the label write reached it, so
 *   the write was abandoned rather than performed. The route serving this report is live while the
 *   writes are still running, so this is a normal outcome, not a failure: recovery parks a ticket to
 *   put a decision in front of someone, and once they have made it, re-asserting `interrupted` over
 *   the top would be recovery overruling the human it was built to defer to.
 * - `skipped` — the ticket was already holding an unanswered human gate (`awaiting-stack-approval`,
 *   `needs-pre-scoping`, `merge-conflict`), so neither side's labels were touched. It is already in
 *   the Needs-human lane the park would have moved it to, and `setIssueLabels` replaces the whole
 *   `pipenzo:` namespace, so writing `interrupted` over it would destroy a question nobody has
 *   answered yet. `labels` on this entry is the ticket's real, untouched set.
 */
export const PIPENZO_RECOVERY_LABEL_WRITES = [
  'pending',
  'written',
  'failed',
  'superseded',
  'skipped',
] as const;

export type PipenzoRecoveryLabelWriteV1 = (typeof PIPENZO_RECOVERY_LABEL_WRITES)[number];
export const pipenzoRecoveryLabelWriteV1Schema = z.enum(PIPENZO_RECOVERY_LABEL_WRITES);

/* ------------------------------------------------------------------- parked ticket */

export const pipenzoParkedTicketV1Schema = z
  .object({
    ticketId: pipenzoTicketIdV1Schema,
    repo: pipenzoRepoRefV1Schema,
    issueNumber: pipenzoIssueNumberV1Schema,
    /** The interrupted session that put this ticket here, resolved through `attempts[].sessionId`. */
    sessionId: z.string().min(1).max(128),
    lane: pipenzoLaneV1Schema,
    /**
     * The phase the ticket was in or last completed. Read straight off the stored record rather
     * than recomputed: `phase` already means "in or last completed" (see `PIPENZO_PHASES`), and a
     * crash does not change which phase was last run — only whether it finished.
     */
    phase: pipenzoPhaseV1Schema,
    labels: z
      .array(pipenzoLabelV1Schema)
      .max(PIPENZO_LABELS.length)
      .refine((labels) => new Set(labels).size === labels.length, 'labels must not repeat'),
    worktree: pipenzoTicketWorktreeViewV1Schema.optional(),
    /** True only when a `providerSessionId` **and** a `continuationScope` both exist. */
    resumable: z.boolean(),
    labelWrite: pipenzoRecoveryLabelWriteV1Schema,
  })
  .strict();

/* -------------------------------------------------------------------- the report */

/**
 * The whole of what one daemon start recovered. Cheap to serve: it is in-memory state computed once
 * at startup, not a per-request reconciliation, so unlike the ticket routes this one costs no
 * GitHub read and is safe for a board to poll on open.
 */
export const pipenzoRecoveryReportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    /** Interrupted session ids seen across both stores' recovery reports, deduplicated. */
    interruptedSessionCount: z.number().int().nonnegative().max(1_000_000),
    /**
     * Interrupted sessions that resolved to no ticket. Normal, not an error: agentdock runs plain
     * sessions that have no Pipenzo ticket behind them at all, and a crash interrupts those the same
     * way. Counted so an operator can tell "nothing to park" apart from "the index failed to build".
     */
    unmatchedSessionCount: z.number().int().nonnegative().max(1_000_000),
    /**
     * Ticket-store files the store's own recovery quarantined on this start. Reported beside the
     * parked set rather than in place of it: the two recoveries compose, and a store that had to
     * repair a torn write must not stop the surviving tickets from parking.
     */
    quarantinedTicketRecordCount: z.number().int().nonnegative().max(1_000_000),
    parked: z.array(pipenzoParkedTicketV1Schema).max(500),
  })
  .strict();

export type PipenzoParkedTicketV1 = z.infer<typeof pipenzoParkedTicketV1Schema>;
export type PipenzoRecoveryReportV1 = z.infer<typeof pipenzoRecoveryReportV1Schema>;
