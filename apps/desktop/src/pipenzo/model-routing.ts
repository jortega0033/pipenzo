import type { LlmReviewPassV1, PipenzoTicketAttemptV1, VerifierPassV1 } from '@agent-dock/shared';

/**
 * The Model routing rail block's rows (`TicketDetail.dc.html`'s "Model routing" block, issue #96)
 * -- pure mapping from real, already-persisted or already-in-hand phase data onto what
 * `ModelRoutingBlock.tsx` renders. Kept separate from the component for the same reason
 * `rail.ts` keeps `RailPanel.tsx`'s own mapping decisions out of its JSX: independently
 * testable, and reviewable without touching markup.
 *
 * **Only three of the canvas's four rows are ever produced, and that is deliberate.** The canvas
 * mock shows "Refine: sonnet" as its first row, but nothing in this codebase can back that value
 * with real data: `pipenzoRefineRequestV1Schema`/`pipenzoRefineResultV1Schema`
 * (`packages/shared/src/pipenzo-phase-v1.ts`) carry no `tier`, and `PipenzoPhaseService.refine()`
 * spends the ticket's token budget (issue #143) without ever calling `recordAttempt()` the way
 * `implement()` does -- so `PipenzoTicketRecordV1.attempts[]` never gains a Refine entry to read.
 * Inventing a model name here to fill that row would be exactly the "no mocked routing info" this
 * ticket was asked not to ship. Once something records which model ran Refine, a fourth row
 * belongs here; until then, a caller with only three real facts gets three real rows.
 */

export type RoutingPhase = 'Implement' | 'Reviewer' | 'Verifier';

export interface RoutingRow {
  readonly phase: RoutingPhase;
  /** The model string exactly as the daemon recorded or reported it -- never re-derived or
   *  reformatted, so this can never say something the source data didn't. */
  readonly value: string;
  /** Set only for the verifier, and only when `vendorDiversityUnavailable` was true (issue #147):
   *  a verifier sharing the implementer's vendor is a weaker check, and the rail's tones are the
   *  one place that is visible at a glance -- the same discipline `rail.ts`'s
   *  `specTestRulingRows()` already applies to a dropped spec test. */
  readonly tone?: 'warn';
}

/**
 * `attempts` is `PipenzoTicketRecordV1.attempts` -- oldest first, so the *last* entry is the most
 * recent Implement dispatch (`PipenzoPhaseMachine.recordAttempt()`'s own append order). A ticket
 * with no Implement attempt yet contributes no Implement row, the same as a ticket whose Review
 * phase has not run yet contributes no Reviewer/Verifier row.
 *
 * `reviewer`/`verifier` are `ReviewReportV1.reviewer`/`.verifier` (or the equivalent live pass a
 * caller is holding mid-review) -- passed as the two fields directly, rather than a whole
 * `ReviewReportV1`, because this function only ever reads those two fields and a caller holding
 * just a reviewer/verifier pass (without a full, schema-valid report) should not have to fabricate
 * one to call this.
 */
export function modelRoutingRows(
  attempts: readonly PipenzoTicketAttemptV1[],
  reviewer?: LlmReviewPassV1,
  verifier?: VerifierPassV1,
): readonly RoutingRow[] {
  const rows: RoutingRow[] = [];
  const lastAttempt = attempts.at(-1);
  if (lastAttempt) {
    rows.push({ phase: 'Implement', value: lastAttempt.model });
  }
  if (reviewer) {
    rows.push({ phase: 'Reviewer', value: reviewer.model });
  }
  if (verifier) {
    rows.push({
      phase: 'Verifier',
      value: verifier.model,
      ...(verifier.vendorDiversityUnavailable ? { tone: 'warn' } : {}),
    });
  }
  return rows;
}
