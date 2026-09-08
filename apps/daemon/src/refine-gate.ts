import { PIPENZO_DIFF_SIZE_THRESHOLDS, type RefineEstimateV1 } from '@agent-dock/shared';

/**
 * The diff-size gate at Refine (issue #270), separated from `refine-subagent.ts` the same way
 * `review-gates.ts` is separated from the phases that produce what it gates: this module decides,
 * the subagent (and, at Review, the implementer) only ever produces the numbers it decides against.
 *
 * README's "Small PRs, by construction" section states the rule as a clean total order over two
 * numbers and one boolean, so this is a pure function over `RefineEstimateV1` — no I/O, no
 * subprocess, nothing to fake in a test:
 *
 * - `≤ 100` changed lines **and** `≤ 10` files → `single`: one PR, proceed normally.
 * - `≤ 400` changed lines **and** `≤ 20` files **and** `layered` → `stack`: a dependency-ordered
 *   stack of 2–4 PRs is required. Not a refusal — README is explicit that this is a legitimate
 *   outcome with its own downstream handling (not built by this ticket; #100's panel and whatever
 *   builds the stack-approval flow own it).
 * - Anything above the 400/20 ceiling, or inside the 100–400/10–20 band without a clean layering,
 *   → `refuse`: hand the ticket to a human with the estimate, flagged
 *   `pipenzo:needs-pre-scoping`.
 *
 * The four numbers themselves live in `@agent-dock/shared`'s `PIPENZO_DIFF_SIZE_THRESHOLDS`, not
 * here — `apps/desktop/src/pipenzo/RefusalPanel.tsx` needs the same rule to describe which
 * condition tripped, and a daemon-only constant would leave the desktop with its own copy of
 * README's numbers, free to drift from this one.
 */
export type DiffSizeGateVerdict = 'single' | 'stack' | 'refuse';

export function evaluateDiffSizeGate(estimate: RefineEstimateV1): DiffSizeGateVerdict {
  const { onePrMaxLines, onePrMaxFiles, stackMaxLines, stackMaxFiles } =
    PIPENZO_DIFF_SIZE_THRESHOLDS;
  if (estimate.changedLines <= onePrMaxLines && estimate.filesTouched <= onePrMaxFiles) {
    return 'single';
  }
  if (estimate.changedLines <= stackMaxLines && estimate.filesTouched <= stackMaxFiles) {
    return estimate.layered ? 'stack' : 'refuse';
  }
  return 'refuse';
}
