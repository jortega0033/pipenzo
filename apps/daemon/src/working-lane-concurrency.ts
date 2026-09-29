import type { PipenzoTicketConcurrencyV1 } from '@agent-dock/shared';
import { evaluateFileOverlapGate, type FileOverlapCandidateV1 } from './file-overlap-gate.js';

/**
 * Surfaces #164's `evaluateFileOverlapGate` on the Working lane (Pipenzo issue #85, split of epic
 * #5's "Queue + dual-audience mode, bounded concurrency").
 *
 * `file-overlap-gate.ts`'s own module comment says the dispatcher that would call it "does not
 * exist yet in this codebase" -- that is still true after this file. Nothing here starts, stops,
 * or gates a real Implement session; the daemon dispatches whatever the desktop clicks Implement
 * on exactly as it did before this file existed. What this adds is a read-only report of the same
 * hold-vs-run decision issue #164 already defined, computed over every ticket the phase machine
 * currently has in the Working lane, so the board's list route (`routes/pipenzo-tickets.ts`) can
 * show it. The queue that would actually act on this report is #5's own, later, ticket.
 *
 * ## Ordering, since there is no real one
 *
 * A real dispatcher would know which ticket actually claimed a slot first. `PipenzoTicketRecordV1`
 * (`pipenzo-ticket-v1.ts`) carries no `startedAt` or any other timestamp a working ticket picks up
 * on entering that lane, so there is no genuine signal to order by. Ascending issue number is the
 * stand-in used below: stable and deterministic, and a reasonable proxy for "which of these was
 * probably dispatched first" on a repo that works roughly oldest-issue-first. A future dispatcher
 * that tracks real dispatch order should replace this ordering, not layer a second one on top of it.
 *
 * ## Capacity does not gate holding by itself
 *
 * `PIPENZO_DEFAULT_WORKING_CAPACITY` only feeds the lane header's "N of 2 running" pill (see
 * `BoardScreen.tsx`). Whether a given ticket is `held` is decided purely by
 * `evaluateFileOverlapGate` against every ticket ordered ahead of it that is itself `running` --
 * matching the one worked example the design canvas and README both give (two tickets serialised
 * over a shared file), not a generic "too many tickets at once" throttle the canvas has no card
 * for.
 */
export const PIPENZO_DEFAULT_WORKING_CAPACITY = 2;

/** One Working-lane ticket's identity plus the Refine-phase prediction `evaluateFileOverlapGate`
 * already compares on (`FileOverlapCandidateV1`), plus the issue number this file orders by. */
export interface WorkingLaneTicketV1 extends FileOverlapCandidateV1 {
  readonly issueNumber: number;
}

/**
 * Evaluates every given Working-lane ticket against every other one, in ascending issue-number
 * order, and returns the same `run`/`held` decision `evaluateFileOverlapGate` makes for a single
 * candidate -- one entry per input ticket, keyed by `ticketId`.
 *
 * Tickets outside the Working lane should never be passed in: this file has no opinion on what a
 * `queued` or `ready-for-review` ticket's `filesLikelyTouched` overlapping a running one would even
 * mean, and the caller (`routes/pipenzo-tickets.ts`) already filters to `lane === 'working'` before
 * calling this.
 */
export function computeWorkingLaneConcurrency(
  tickets: readonly WorkingLaneTicketV1[],
): ReadonlyMap<string, PipenzoTicketConcurrencyV1> {
  const ordered = [...tickets].sort((a, b) => a.issueNumber - b.issueNumber);
  const running: WorkingLaneTicketV1[] = [];
  const result = new Map<string, PipenzoTicketConcurrencyV1>();

  for (const ticket of ordered) {
    const verdict = evaluateFileOverlapGate(ticket, running);
    if (verdict.decision === 'run') {
      result.set(ticket.ticketId, { state: 'running' });
      running.push(ticket);
      continue;
    }

    const overlapTicketId = verdict.overlappingTicketIds[0];
    const overlapFile = verdict.overlappingFiles[0];
    if (overlapTicketId === undefined || overlapFile === undefined) {
      // evaluateFileOverlapGate's own contract: a 'hold' decision always names at least one
      // overlapping ticket and file. Guarded rather than asserted with `!` so a future change to
      // that contract fails loudly here instead of silently emitting an incoherent 'held' state.
      throw new Error('file-overlap gate reported hold with no overlap detail');
    }
    const overlapTicket = running.find((candidate) => candidate.ticketId === overlapTicketId);
    result.set(ticket.ticketId, {
      state: 'held',
      overlapTicketId,
      overlapIssueNumber: overlapTicket ? overlapTicket.issueNumber : ticket.issueNumber,
      overlapFile,
    });
  }

  return result;
}
