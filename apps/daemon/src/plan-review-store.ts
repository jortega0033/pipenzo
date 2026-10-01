import { randomUUID } from 'node:crypto';
import type { RefineSpecV1 } from '@agent-dock/shared';

/**
 * The daemon-side half of the plan-review gate (Pipenzo issue #15, UI half #101), mirroring
 * `stack-approval-store.ts`'s capture/decide shape (issue #99) for the same "block run" reason: a
 * caller cannot dispatch the gated action -- here, `PipenzoPhaseService.implement()` itself, not
 * just a secondary materialization step -- without first holding an id this store issued for
 * exactly the plan it captured.
 *
 * ## Why capture freezes the whole `RefineSpecV1`, not just a pointer to the ticket
 *
 * Same reasoning as `StackApprovalStore`'s own doc comment: `ticket.spec` could in principle change
 * between the moment a human opens the plan-review panel and the moment they decide (a retried
 * `refine()` against the same ticket, however unlikely, would overwrite it, and `#reportRefusal`/
 * `#reportStackVerdict` elsewhere already show a cached spec is not append-only). Capturing the whole
 * spec -- not just the narrow `PipenzoPlanReviewSpecV1` projection the wire response shows a human --
 * means `PipenzoPhaseService.approvePlanReview()` always dispatches Implement with exactly the plan a
 * human approved, never a plan that moved out from under them mid-review, and never a second,
 * independently-reconstructed `RefineSpecV1` that could disagree with what the panel displayed.
 *
 * ## One entry per approval, deleted on every real decision
 *
 * Same as `StackApprovalStore`/`HighApprovalStore`: every decision -- approve, request changes, or
 * reject -- consumes the entry immediately, so a decision is never re-askable (CLAUDE.md hard rule
 * #4) and a retried request against an already-decided id is refused exactly like an unknown one
 * (`decide()` returns `undefined` either way).
 *
 * ## Cross-ticket isolation
 *
 * Every method takes `ticketId` alongside `approvalId` and refuses (`undefined`) unless the entry on
 * file was captured for that exact ticket -- the same property `MediumApprovalStore`'s own `#owned`
 * helper buys, applied here as a plain field comparison since this store (like `StackApprovalStore`)
 * has no undo half to share the check with.
 */

export interface PlanReviewEntry {
  readonly ticketId: string;
  readonly spec: RefineSpecV1;
  readonly capturedAt: string;
}

export class PlanReviewStore {
  readonly #pending = new Map<string, PlanReviewEntry>();

  /** Freezes the plan a human is about to review and mints the id `decide()` will require. */
  capture(ticketId: string, spec: RefineSpecV1): string {
    const id = randomUUID();
    this.#pending.set(id, { ticketId, spec, capturedAt: new Date().toISOString() });
    return id;
  }

  /** The entry for `approvalId`, iff it belongs to `ticketId` and is still pending a decision.
   * `undefined` for an unknown id, a wrong ticket, or one already decided. */
  peek(ticketId: string, approvalId: string): PlanReviewEntry | undefined {
    const entry = this.#pending.get(approvalId);
    return entry && entry.ticketId === ticketId ? entry : undefined;
  }

  /**
   * Consumes a still-pending approval id for `ticketId`, returning the frozen plan it captured.
   * `undefined` for an unknown id, a wrong ticket, or one already decided -- in every one of those
   * cases nothing is removed, so a caller cannot retry past the refusal by resubmitting the same
   * id. The route (`routes/pipenzo-plan-review.ts`) decides what each of the three real decisions
   * actually does with the plan this hands back; this store only owns "was this id genuinely
   * pending for this ticket, and if so, freeze it as spent."
   */
  consume(ticketId: string, approvalId: string): PlanReviewEntry | undefined {
    const entry = this.peek(ticketId, approvalId);
    if (!entry) return undefined;
    this.#pending.delete(approvalId);
    return entry;
  }

  /** Test/diagnostic-only: how many approvals are still pending a decision. */
  get size(): number {
    return this.#pending.size;
  }
}
