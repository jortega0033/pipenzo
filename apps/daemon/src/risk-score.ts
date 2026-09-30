import type { RiskGrade } from './risk-classifier.js';

/**
 * The cumulative-risk scoring engine (Pipenzo issue #158).
 *
 * Pure business logic only — this module holds no UI, no persistence, and is not wired into any
 * caller yet. The cumulative-risk strip (issue #95) binds a UI to this engine's `RiskScoreState`
 * later; that ticket is explicitly blocked on this one and out of scope here.
 *
 * **Source of the exact numbers.** README.md ("What exists today") only says the cumulative-risk
 * strip and pre-commitment records "aren't built either" yet — it does not restate the mechanics.
 * The precise weights, threshold, promotion, and reset rule are specified in
 * `docs/research-report.html`, §11 decision 05 ("05 · Risk-graded approval, with cumulative
 * risk"), quoted here because it is easy to get subtly wrong and the report explains *why* the
 * numbers are what they are, not just what they are:
 *
 * > "Corrected: each auto-approved LOW action adds 0.5, each MEDIUM approval adds 1, each
 * > pre-commitment mismatch adds 3, a HIGH action adds nothing (a human already looked hard at
 * > it). Threshold 10. Only a HIGH approval — or an explicit 'I've looked', meaning opening the
 * > ticket's Activity view — resets the score to zero. A MEDIUM approval deliberately does not:
 * > approving one inline card is a glance at one action, not a review of the run, and treating
 * > the two as equivalent is what broke the original formula. [...] When the score crosses the
 * > threshold the next MEDIUM action is promoted to HIGH — full card, notification."
 *
 * The report also explains why the obvious first draft ("any approval resets to zero") is wrong:
 * under that rule a MEDIUM or HIGH action is immediately followed by its own approval, which wipes
 * the counter before its weight can ever accumulate, so only LOW actions could ever add up — the
 * asymmetric reset rule here (HIGH approval or opening Activity only) is what makes the threshold
 * reachable at all. GitHub issue #95 ("Rail: cumulative-risk strip wiring") and #119 ("Opening
 * Activity resets the risk score") restate the same reset rule; this module is their shared
 * dependency.
 *
 * **Why promotion is a pending flag consumed by the next MEDIUM, not a retroactive re-grade.**
 * "The next MEDIUM action is promoted to HIGH" describes a future action, not a correction to
 * actions already scored — `gradeAction` never revisits a grade it already returned. A LOW action
 * or a HIGH action occurring while a promotion is pending does not consume it; only the next
 * action this engine grades as MEDIUM does.
 *
 * **Why a promoted MEDIUM does not also add the MEDIUM weight.** Once promoted, the action is
 * gated exactly like a real HIGH action (full card, notification, no auto-allow, no Undo per
 * `risk-classifier.ts`'s HIGH semantics) — and "a HIGH action adds nothing" because a human already
 * looked hard at it. A promoted MEDIUM gets that same full look, so it earns the same zero weight,
 * not the ordinary MEDIUM's +1. This also keeps the engine's core safety invariant simple: nothing
 * this module does can ever cause the running score to grow *and* leave the gating unchanged or
 * weaker — promotion only ever tightens gating.
 *
 * **The HIGH-never-bypassable invariant (CLAUDE.md hard rule 3).** `gradeAction` for a real HIGH
 * grade always returns `effectiveGrade: 'high'` regardless of `state` — no score value, no pending
 * promotion, and no call sequence can turn a real HIGH classification into anything other than
 * HIGH-equivalent gating. Promotion is one-directional: it can only turn a MEDIUM into a
 * HIGH-equivalent, never the reverse, and it never touches an action already classified HIGH by
 * `classifyRisk` in `risk-classifier.ts`. See `risk-score.test.ts`'s "never bypassable" suite for
 * the tests proving this against arbitrary states.
 */

/** An event this engine can score. `'mismatch'` is a pre-commitment prediction/outcome mismatch
 * (research-report.html §11 decision 02), not an action grade — it can accompany a MEDIUM or HIGH
 * action's own outcome, since only those get pre-commitment records. */
export type RiskScoreEventKind = RiskGrade | 'mismatch';

/** Serializable running state. Safe to persist wherever a ticket's own state lives (e.g. the
 * ticket store's future `riskScore` field per README's "Team usage" section) — this module has no
 * opinion on where that is, and issue #158 does not wire one in. */
export interface RiskScoreState {
  /** The cumulative, unreviewed-risk score. Never negative. */
  readonly score: number;
  /** Set once `score` reaches the threshold; consumed by the next action this engine grades as
   * MEDIUM, which is then gated as HIGH instead. Never set or cleared by a LOW or HIGH action. */
  readonly pendingPromotion: boolean;
}

export interface GradeActionResult {
  /** The state to persist after this action. */
  readonly state: RiskScoreState;
  /** What gating should actually apply to this action: `grade` unchanged, unless this was a
   * MEDIUM action consuming a pending promotion, in which case `'high'`. Never anything other than
   * `grade` when `grade` is itself `'high'`. */
  readonly effectiveGrade: RiskGrade;
  /** True exactly when this action's grade was promoted from MEDIUM to HIGH-equivalent gating. */
  readonly promoted: boolean;
}

/** Weights per research-report.html §11 decision 05. HIGH is included for completeness/clarity at
 * call sites, even though `gradeAction` never actually adds it (a HIGH-graded action always adds
 * zero, and a promoted MEDIUM also adds zero — see the module doc comment). */
export const RISK_SCORE_WEIGHTS = Object.freeze({
  low: 0.5,
  medium: 1,
  mismatch: 3,
  high: 0,
} as const satisfies Record<RiskScoreEventKind, number>);

/** Once `score` reaches this, the next MEDIUM-graded action is promoted to HIGH-equivalent gating. */
export const RISK_SCORE_THRESHOLD = 10;

export const INITIAL_RISK_SCORE_STATE: RiskScoreState = Object.freeze({
  score: 0,
  pendingPromotion: false,
});

function crossedThreshold(score: number): boolean {
  return score >= RISK_SCORE_THRESHOLD;
}

/** Freezes a freshly-built state object before returning it. `readonly` in `RiskScoreState` is
 * compile-time only; this is defense-in-depth so a caller that (accidentally or otherwise) mutates
 * a returned state in place can't corrupt this module's own invariants for the next call. */
function freezeState(state: RiskScoreState): RiskScoreState {
  return Object.freeze(state);
}

/**
 * Grades one classified action against the running score, applying weight accumulation and, when
 * applicable, promotion. Call this once per action, in the order the actions actually happened —
 * the engine is a fold over a sequence and has no notion of "replay" or "undo" for a grade already
 * returned.
 *
 * HIGH is handled first and unconditionally: a real HIGH classification always grades HIGH,
 * regardless of `state.pendingPromotion` or `state.score`, and a pending promotion earmarked for
 * "the next MEDIUM" is left untouched by it — a HIGH action neither consumes nor clears it.
 *
 * **Fails closed, not open, on anything that isn't a real `RiskGrade`.** `grade` is a closed TS
 * union at every typed call site, but this is exactly the kind of safety-critical gating logic
 * (CLAUDE.md hard rule 3) where a value that slips past the type system at a daemon/IPC boundary
 * must not silently fall through into a weaker path. The alternative of letting anything other
 * than `'high'`/`'low'` implicitly mean "treat as medium" would violate this module's own stated
 * property — promotion and grading may only ever tighten gating, never loosen it by omission — so
 * an unrecognized grade throws instead of being graded as MEDIUM.
 */
export function gradeAction(state: RiskScoreState, grade: RiskGrade): GradeActionResult {
  if (grade === 'high') {
    return {
      state: freezeState({ score: state.score + RISK_SCORE_WEIGHTS.high, pendingPromotion: state.pendingPromotion }),
      effectiveGrade: 'high',
      promoted: false,
    };
  }

  if (grade === 'low') {
    return {
      state: freezeState({ score: state.score + RISK_SCORE_WEIGHTS.low, pendingPromotion: state.pendingPromotion }),
      effectiveGrade: 'low',
      promoted: false,
    };
  }

  if (grade === 'medium') {
    if (state.pendingPromotion) {
      return {
        state: freezeState({ score: state.score, pendingPromotion: false }),
        effectiveGrade: 'high',
        promoted: true,
      };
    }
    const score = state.score + RISK_SCORE_WEIGHTS.medium;
    return {
      state: freezeState({ score, pendingPromotion: crossedThreshold(score) }),
      effectiveGrade: 'medium',
      promoted: false,
    };
  }

  // Exhaustiveness check: `grade` is `never` here for every real `RiskGrade`. Reaching this line
  // means a caller passed something outside the type at runtime -- fail closed rather than guess.
  const unrecognized: never = grade;
  throw new Error(`gradeAction: unrecognized risk grade ${JSON.stringify(unrecognized)}`);
}

/**
 * Records a pre-commitment prediction/outcome mismatch (+3). Not an action grade on its own, so it
 * never has an `effectiveGrade` — call this alongside whatever `gradeAction` call already covered
 * the MEDIUM/HIGH action the mismatched prediction was attached to.
 */
export function recordMismatch(state: RiskScoreState): RiskScoreState {
  const score = state.score + RISK_SCORE_WEIGHTS.mismatch;
  return freezeState({ score, pendingPromotion: state.pendingPromotion || crossedThreshold(score) });
}

/**
 * The asymmetric reset rule: a HIGH approval, or explicitly opening the ticket's Activity view
 * ("I've looked"), resets the score to zero. A MEDIUM approval is deliberately not a reset trigger
 * — see the module doc comment for why treating it as one made the threshold unreachable.
 *
 * Callers should invoke this with `'high'` when the action a human just approved was gated as HIGH
 * — which includes a promoted MEDIUM, since `gradeAction` already reported `effectiveGrade: 'high'`
 * for it and the approval UI it goes through is the full HIGH card. Passing `'medium'` here is a
 * deliberate no-op, kept explicit (rather than only exposing `resetOnHighApproval`) so a call site
 * that grades an approval outcome can call this unconditionally without its own branch.
 */
export function recordApprovalOutcome(
  state: RiskScoreState,
  approvedEffectiveGrade: RiskGrade,
): RiskScoreState {
  if (approvedEffectiveGrade === 'high') return INITIAL_RISK_SCORE_STATE;
  return state;
}

/** The other reset trigger: opening the ticket's Activity view (issue #119). Always resets,
 * unconditionally — there is no "activity opened but doesn't count" case. */
export function recordActivityOpened(_state: RiskScoreState): RiskScoreState {
  return INITIAL_RISK_SCORE_STATE;
}
