/**
 * The Cumulative risk rail block's data (`TicketDetail.dc.html`'s "Cumulative risk" block, issue
 * #95) -- pure mapping from a ticket's persisted risk record onto what `CumulativeRiskStrip.tsx`
 * renders. Kept separate from the component for the same reason `rail.ts`/`model-routing.ts` keep
 * their own mapping decisions out of JSX: independently testable, and reviewable without touching
 * markup.
 *
 * ## Why this renders less than the design canvas mocks up
 *
 * `TicketDetail.dc.html`'s static specimens show a rich sentence per ticket -- "8 low-risk actions
 * (4.0) and 1 mismatch (3.0) since your last look" -- broken down by *how many* of each kind of
 * event contributed. `apps/daemon/src/risk-score.ts`'s real engine (issue #158) does not carry that
 * breakdown: `RiskScoreState` is exactly `{ score, pendingPromotion }`, a running weighted sum with
 * no per-category counters, by that module's own explicit design (see its doc comment: promotion is
 * "a pending flag consumed by the next MEDIUM, not a retroactive re-grade", and nothing about the
 * engine remembers how the current score was assembled). Reproducing the mock's exact sentence would
 * mean inventing counts this codebase does not have -- exactly the "no mocked routing info" rule
 * `model-routing.ts`'s own doc comment already applies to this same rail. So this block reports
 * only what the wire record (`PipenzoTicketRiskV1`, `packages/shared/src/pipenzo-ticket-v1.ts`)
 * actually carries: the running score and whether a promotion is armed, worded honestly rather than
 * as a fabricated breakdown.
 */

/** Mirrors `apps/daemon/src/risk-score.ts`'s `RISK_SCORE_THRESHOLD` and
 * `pipenzoTicketRiskV1Schema.score`'s own `[0, 10]` bound -- not imported from either (the desktop
 * renderer cannot import daemon internals, and the shared schema does not expose its numeric bound
 * as a runtime constant), so this is the one place a future change to that number would also need
 * to change on this side of the wire. */
export const RISK_SCORE_THRESHOLD = 10;

/** The rail's ten fixed segments, `TicketDetail.dc.html`'s own `.risk-seg` bands: the first four
 * (index 0-3) are the calm/`ok` band, the next three (4-6) `warm`, and the last three (7-9) `hot` --
 * a fixed position-based coloring, independent of how many segments are actually filled. */
const SEGMENT_COUNT = 10;
const WARM_FROM_INDEX = 4;
const HOT_FROM_INDEX = 7;

export type RiskSegmentTone = 'warm' | 'hot' | undefined;

export interface RiskSegment {
  readonly on: boolean;
  readonly tone: RiskSegmentTone;
}

export type CumulativeRiskLevel = 'Calm' | 'Moderate' | 'High';

export interface CumulativeRiskSummary {
  readonly segments: readonly RiskSegment[];
  readonly level: CumulativeRiskLevel;
  readonly text: string;
  /** `"3.5 / 10"` -- always one decimal place, always out of the threshold, matching the canvas's
   * own `{{riskCount}}`. */
  readonly countText: string;
  readonly promoted: boolean;
  /** Only meaningful when `promoted` is true. */
  readonly promoText: string;
}

/** The minimal shape this module needs from a ticket's persisted risk record -- narrower than the
 * full `PipenzoTicketRiskV1` (this never needs `lastResetAt`), for the same reason
 * `modelRoutingRows()` takes just `reviewer`/`verifier` rather than a whole `ReviewReportV1`. */
export interface CumulativeRiskInput {
  readonly score: number;
  /** Absent means "no promotion armed" -- see `pipenzoTicketRiskV1Schema`'s own doc comment on why
   * a ticket persisted before this field existed reads that way rather than as unknown. */
  readonly pendingPromotion?: boolean;
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(Math.max(score, 0), RISK_SCORE_THRESHOLD);
}

function segmentTone(index: number): RiskSegmentTone {
  if (index >= HOT_FROM_INDEX) return 'hot';
  if (index >= WARM_FROM_INDEX) return 'warm';
  return undefined;
}

/** One filled segment per whole point, rounded up so any nonzero score shows at least one segment
 * -- the canvas's own worked examples do this too (a 0.5 score renders one filled segment, not a
 * fractional one there is no half-segment styling for). */
function filledSegmentCount(clampedScore: number): number {
  return Math.min(Math.ceil(clampedScore), SEGMENT_COUNT);
}

export function riskSegments(clampedScore: number): readonly RiskSegment[] {
  const filled = filledSegmentCount(clampedScore);
  return Array.from({ length: SEGMENT_COUNT }, (_, index) => ({
    on: index < filled,
    tone: index < filled ? segmentTone(index) : undefined,
  }));
}

/**
 * Calm below 4, Moderate from 4 up to (not including) the threshold, High at or above it --
 * matching every worked example in `TicketDetail.dc.html`'s own mock data (filled 1/2 -> Calm,
 * filled 4/7 -> Moderate, filled 10 -> High). A ticket with a promotion already armed is always
 * High even if a stale/clamped score somehow reads under the threshold, since an armed promotion
 * is itself the higher-severity fact.
 */
function riskLevel(clampedScore: number, pendingPromotion: boolean): CumulativeRiskLevel {
  if (pendingPromotion || clampedScore >= RISK_SCORE_THRESHOLD) return 'High';
  if (clampedScore >= WARM_FROM_INDEX) return 'Moderate';
  return 'Calm';
}

function formatScore(score: number): string {
  return score.toFixed(1);
}

export function summarizeCumulativeRisk(risk: CumulativeRiskInput): CumulativeRiskSummary {
  const clamped = clampScore(risk.score);
  const promoted = risk.pendingPromotion ?? false;
  const level = riskLevel(clamped, promoted);
  const text =
    clamped === 0 && !promoted
      ? 'No unreviewed risk since the last reset.'
      : `${formatScore(clamped)} of ${RISK_SCORE_THRESHOLD} points accumulated since the last reset.`;
  return {
    segments: riskSegments(clamped),
    level,
    text,
    countText: `${formatScore(clamped)} / ${RISK_SCORE_THRESHOLD}`,
    promoted,
    promoText:
      'The next MEDIUM action is gated as HIGH -- full card, no auto-allow -- until a HIGH ' +
      'approval or opening this ticket’s Activity view resets the strip.',
  };
}
