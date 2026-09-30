import { randomUUID } from 'node:crypto';
import type { RefineProposedSplitPartV1 } from '@agent-dock/shared';

/**
 * The daemon-side half of the stack approval panel (Pipenzo issue #99), mirroring
 * `high-approval-store.ts`'s capture/decide shape (issue #98) for the same "block run" reason:
 * a caller cannot dispatch the gated action (here, creating real GitHub issues, worktrees and
 * ticket records) without first holding an id this store issued for exactly the parts it captured.
 *
 * ## Why capture snapshots the parts, not just the ticket id
 *
 * HIGH's `capture()` is a pure id mint because there is nothing to freeze -- a HIGH action has
 * already happened by the time it is captured. A stack proposal is different: `ticket.spec
 * .proposedSplit` could in principle change between the moment a human opens the panel and the
 * moment they click Accept (a re-run of `refine()` against the same ticket, however unlikely, would
 * overwrite it). Capturing the parts themselves, not just a pointer to where they currently live,
 * means a `decide()` call is always judged against exactly what the human saw and reordered --
 * never against a split that moved out from under them mid-review.
 *
 * ## Why `order` is a permutation of indices, not a second copy of the parts
 *
 * A `decide('accept', order)` cannot smuggle in more child tickets than the capture actually
 * offered, or reference a part that was never captured: `order` must be an exact-length, true
 * permutation of `[0, parts.length)` for *this* approval, checked here (not just the wire schema's
 * shape-level bound) because only this store knows how many parts a given approval id actually
 * captured. This is the bounded-fan-out property the security review for this ticket asked for --
 * accepting a malformed or oversized `order` cannot create more, fewer, or different tickets than
 * the human was actually shown.
 *
 * ## One entry per approval, deleted on every real decision
 *
 * Same as `HighApprovalStore`: an accept or a reject both consume the entry immediately, so a
 * decision is never re-askable and a retried request against an already-decided id is refused
 * exactly like an unknown one (`decide()` returns `undefined` either way).
 */

export interface StackApprovalEntry {
  readonly ticketId: string;
  readonly parts: readonly RefineProposedSplitPartV1[];
  readonly capturedAt: string;
}

export interface StackApprovalAcceptDecision {
  readonly kind: 'accept';
  readonly ticketId: string;
  /** The captured parts, reordered exactly as the human approved. */
  readonly orderedParts: readonly RefineProposedSplitPartV1[];
}

export interface StackApprovalRejectDecision {
  readonly kind: 'reject';
  readonly ticketId: string;
  /** Always present and non-blank -- `decide()` never returns a reject decision otherwise. */
  readonly reason: string;
}

export type StackApprovalDecision = StackApprovalAcceptDecision | StackApprovalRejectDecision;

export interface DecideStackApprovalOptions {
  readonly order?: readonly number[];
  readonly reason?: string;
}

/** True for an array that is an exact-length permutation of `[0, length)` -- no gaps, no repeats,
 * no out-of-range entries. The one property that keeps an accept's fan-out bounded to exactly
 * `length` children, regardless of what a caller submits. */
export function isIndexPermutation(order: readonly number[], length: number): boolean {
  if (order.length !== length) return false;
  const seen = new Set<number>();
  for (const value of order) {
    if (!Number.isInteger(value) || value < 0 || value >= length) return false;
    if (seen.has(value)) return false;
    seen.add(value);
  }
  return true;
}

export class StackApprovalStore {
  readonly #pending = new Map<string, StackApprovalEntry>();

  /** Freezes the parts a human is about to review and mints the id `decide()` will require. */
  capture(ticketId: string, parts: readonly RefineProposedSplitPartV1[]): string {
    const id = randomUUID();
    this.#pending.set(id, { ticketId, parts: [...parts], capturedAt: new Date().toISOString() });
    return id;
  }

  /**
   * Records a human's Accept/Reject for a still-pending approval id. Returns `undefined` for an
   * unknown id, a wrong ticket, an id already decided, a reject with a missing/blank reason, or an
   * accept whose `order` is not an exact permutation of this approval's own captured parts -- in
   * every one of those cases the entry is left exactly as it was, so a caller cannot retry past the
   * refusal by constructing a slightly different request.
   */
  decide(
    ticketId: string,
    approvalId: string,
    decision: 'accept' | 'reject',
    options: DecideStackApprovalOptions,
  ): StackApprovalDecision | undefined {
    const entry = this.#pending.get(approvalId);
    if (!entry || entry.ticketId !== ticketId) return undefined;

    if (decision === 'reject') {
      const reason = options.reason?.trim();
      if (!reason) return undefined;
      this.#pending.delete(approvalId);
      return { kind: 'reject', ticketId, reason };
    }

    const order = options.order;
    if (!order || !isIndexPermutation(order, entry.parts.length)) return undefined;
    this.#pending.delete(approvalId);
    return {
      kind: 'accept',
      ticketId,
      orderedParts: order.map((partIndex) => entry.parts[partIndex]!),
    };
  }

  /** Test/diagnostic-only: how many approvals are still pending a decision. */
  get size(): number {
    return this.#pending.size;
  }
}
