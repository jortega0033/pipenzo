import { randomUUID } from 'node:crypto';

/**
 * The daemon-side half of the HIGH full publish-gate card (Pipenzo issue #98), the HIGH-risk
 * sibling of `medium-approval-store.ts`'s MEDIUM flow (issue #97).
 *
 * ## A HIGH-specific store, not a shared one (a deliberate choice, see the ticket notes)
 *
 * `MediumApprovalStore` and this store share a shape -- capture before the card is shown, decide
 * exactly once -- but their *lifecycles* diverge in ways that would make one generic store harder
 * to audit, not easier:
 *
 * - MEDIUM's `capture()` does real filesystem I/O (`captureUndoSnapshot`, a real `git rev-parse` and
 *   file reads) because an allowed MEDIUM action can be undone. HIGH never can
 *   (`isUndoAvailable()` in `undo-snapshot.ts` is an allowlist of exactly `'low' | 'medium'` --
 *   CLAUDE.md hard rule 3's fail-closed twin for the Undo side). This store's `capture()` is a pure,
 *   synchronous id mint: there is nothing to read from disk for an action that can never be
 *   restored.
 * - MEDIUM's `decide('allow')` keeps its entry alive for the rest of the resolved-line UI's
 *   life (`status()`/`undo()` need it later). Since HIGH offers neither, `decide()` here deletes
 *   the entry on *every* decision -- approve or reject alike -- the moment it resolves. That also
 *   means this store can never accumulate the "allowed and never undone" long-lived entries
 *   `MediumApprovalStore`'s own module comment flags as a known, tracked gap; a HIGH decision is
 *   never worth revisiting, so nothing here is ever kept past the one call that resolves it.
 * - MEDIUM's `reason` is optional either way. HIGH's is mandatory for a reject -- enforced first on
 *   the wire (`pipenzoHighApprovalDecideRequestV1Schema`'s own `superRefine`) and re-checked here,
 *   independently, so a caller cannot reach an approve-shaped default via a code path that
 *   constructs a `decide()` call directly rather than through the validated route. There is no
 *   parameter default and no branch of `decide()` that treats a missing or blank reason on a reject
 *   as anything other than a refusal to act -- see `high-approval-store.test.ts`'s own
 *   "never proceeds without a reason" suite.
 *
 * Building a shared abstraction over both would mean threading an `undo`-capability flag and a
 * reason-requiredness flag through one generic class -- exactly the kind of "one code path serving
 * two invariants of different strictness" shape CLAUDE.md hard rule 3 warns against papering over.
 * Two small, independently auditable stores is the more honest trade.
 */

export interface HighApprovalEntry {
  readonly ticketId: string;
  readonly branch: string;
  readonly capturedAt: string;
}

export interface CaptureHighApprovalInput {
  readonly ticketId: string;
  readonly branch: string;
}

export interface HighApprovalDecision {
  readonly ticketId: string;
  readonly branch: string;
  readonly decision: 'approve' | 'reject';
  /** Present for every `'reject'` (enforced by `decide()` below) and never fabricated for an
   * `'approve'` that supplied none. */
  readonly reason?: string;
  readonly decidedAt: string;
}

export class HighApprovalStore {
  readonly #pending = new Map<string, HighApprovalEntry>();

  /** Records which ticket and branch a HIGH decision is about, before a human ever sees the card --
   * the same "block run" call-order property `MediumApprovalStore.capture()` buys, minus any
   * filesystem read (see the module comment). Returns the new entry's id. */
  capture(input: CaptureHighApprovalInput): string {
    const id = randomUUID();
    this.#pending.set(id, {
      ticketId: input.ticketId,
      branch: input.branch,
      capturedAt: new Date().toISOString(),
    });
    return id;
  }

  /**
   * Records a human's Approve/Reject for a still-pending approval id. Returns `undefined` for an
   * unknown id, a wrong ticket, an id already decided, or -- the enforcement point CLAUDE.md hard
   * rule 3 exists for -- a `'reject'` whose `reason` is missing or blank. There is no branch of this
   * method that returns a decision for a reject with no reason: the check runs before the entry is
   * ever read out or deleted, so a caller cannot retry past it by constructing a slightly different
   * request -- the entry stays pending, exactly as if `decide()` had never been called.
   *
   * The entry is deleted on every real decision, approve or reject alike -- unlike
   * `MediumApprovalStore.decide()`, which keeps an allowed entry alive for `status()`/`undo()`.
   * There is no HIGH equivalent of either, so nothing is ever left to look up again.
   */
  decide(
    ticketId: string,
    approvalId: string,
    decision: 'approve' | 'reject',
    reason?: string,
  ): HighApprovalDecision | undefined {
    const entry = this.#pending.get(approvalId);
    if (!entry || entry.ticketId !== ticketId) return undefined;
    if (decision === 'reject' && (!reason || reason.trim().length === 0)) return undefined;

    this.#pending.delete(approvalId);
    return {
      ticketId: entry.ticketId,
      branch: entry.branch,
      decision,
      reason: decision === 'reject' ? reason!.trim() : undefined,
      decidedAt: new Date().toISOString(),
    };
  }

  /** Test/diagnostic-only: how many approvals are still pending a decision. */
  get size(): number {
    return this.#pending.size;
  }
}
