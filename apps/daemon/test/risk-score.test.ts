import { describe, expect, it } from 'vitest';
import type { RiskGrade } from '../src/risk-classifier.js';
import {
  INITIAL_RISK_SCORE_STATE,
  RISK_SCORE_THRESHOLD,
  RISK_SCORE_WEIGHTS,
  gradeAction,
  recordActivityOpened,
  recordApprovalOutcome,
  recordMismatch,
  type RiskScoreState,
} from '../src/risk-score.js';

function fold(state: RiskScoreState, grades: RiskGrade[]): RiskScoreState {
  return grades.reduce((acc, grade) => gradeAction(acc, grade).state, state);
}

function atThreshold(): RiskScoreState {
  // 10 MEDIUM actions land exactly on the threshold without themselves being promoted.
  let state = INITIAL_RISK_SCORE_STATE;
  for (let i = 0; i < 10; i += 1) {
    const result = gradeAction(state, 'medium');
    expect(result.promoted).toBe(false);
    state = result.state;
  }
  return state;
}

describe('gradeAction — weight accumulation', () => {
  it.each<[RiskGrade, number]>([
    ['low', RISK_SCORE_WEIGHTS.low],
    ['medium', RISK_SCORE_WEIGHTS.medium],
    ['high', RISK_SCORE_WEIGHTS.high],
  ])('adds %s\'s weight (%d) from a zero state', (grade, weight) => {
    expect(gradeAction(INITIAL_RISK_SCORE_STATE, grade).state.score).toBe(weight);
  });

  it('adds 3 for a pre-commitment mismatch', () => {
    expect(recordMismatch(INITIAL_RISK_SCORE_STATE).score).toBe(3);
  });

  it('matches the research-report worked example: 14 LOW actions (7.0) plus one mismatch (10.0) trips the threshold', () => {
    let state = INITIAL_RISK_SCORE_STATE;
    for (let i = 0; i < 14; i += 1) state = gradeAction(state, 'low').state;
    expect(state.score).toBeCloseTo(7.0, 10);
    expect(state.pendingPromotion).toBe(false);

    state = recordMismatch(state);
    expect(state.score).toBeCloseTo(10.0, 10);
    expect(state.pendingPromotion).toBe(true);
  });

  it('exposes the weight table and threshold for callers that need to explain "why"', () => {
    expect(RISK_SCORE_WEIGHTS).toEqual({ low: 0.5, medium: 1, mismatch: 3, high: 0 });
    expect(RISK_SCORE_THRESHOLD).toBe(10);
  });
});

describe('gradeAction — threshold crossing promotes the next MEDIUM specifically', () => {
  it('sets pendingPromotion once the score reaches the threshold, without promoting the action that crossed it', () => {
    const state = atThreshold();
    expect(state.score).toBe(10);
    expect(state.pendingPromotion).toBe(true);
  });

  it('promotes the next MEDIUM to HIGH-equivalent gating, adding no extra weight, then consumes the promotion exactly once', () => {
    const state = atThreshold();
    const promoted = gradeAction(state, 'medium');
    expect(promoted.effectiveGrade).toBe('high');
    expect(promoted.promoted).toBe(true);
    expect(promoted.state.score).toBe(10); // unchanged: a HIGH-equivalent adds nothing, like a real HIGH
    expect(promoted.state.pendingPromotion).toBe(false);

    const next = gradeAction(promoted.state, 'medium');
    expect(next.effectiveGrade).toBe('medium');
    expect(next.promoted).toBe(false);
    expect(next.state.score).toBe(11);
  });

  it.each<[string, RiskGrade]>([
    ['a LOW action', 'low'],
    ['a HIGH action', 'high'],
  ])('does not let an intervening %s consume or clear the pending promotion', (_label, grade) => {
    const between = gradeAction(atThreshold(), grade);
    expect(between.effectiveGrade).toBe(grade); // the intervening action is graded normally...
    expect(between.state.pendingPromotion).toBe(true); // ...but the pending promotion survives it
    const medium = gradeAction(between.state, 'medium');
    expect(medium.effectiveGrade).toBe('high');
    expect(medium.promoted).toBe(true);
  });

  it('does not retroactively re-grade actions already graded before the threshold was crossed', () => {
    let state = INITIAL_RISK_SCORE_STATE;
    const recorded: RiskGrade[] = [];
    for (let i = 0; i < 9; i += 1) {
      const result = gradeAction(state, 'medium');
      recorded.push(result.effectiveGrade);
      state = result.state;
    }
    expect(recorded).toEqual(Array(9).fill('medium'));

    // The 10th action lands exactly on the threshold, so it is not itself promoted -- promotion is
    // set for the *next* MEDIUM. Nothing about the 9 already-recorded grades above changes.
    const tenth = gradeAction(state, 'medium');
    expect(tenth.effectiveGrade).toBe('medium');
    expect(tenth.state.pendingPromotion).toBe(true);
    expect(recorded).toEqual(Array(9).fill('medium'));
  });

  it('a mismatch can also trip the threshold and set a pending promotion', () => {
    let state = INITIAL_RISK_SCORE_STATE;
    for (let i = 0; i < 8; i += 1) state = gradeAction(state, 'medium').state; // score 8
    state = recordMismatch(state); // score 11
    expect(state.pendingPromotion).toBe(true);
    expect(gradeAction(state, 'medium').promoted).toBe(true);
  });
});

describe('the asymmetric reset rule', () => {
  it('a HIGH approval resets the score to zero; a MEDIUM approval deliberately does not', () => {
    const built = fold(INITIAL_RISK_SCORE_STATE, ['medium', 'medium', 'medium']);
    expect(built.score).toBe(3);
    expect(recordApprovalOutcome(built, 'high')).toEqual(INITIAL_RISK_SCORE_STATE);
    expect(recordApprovalOutcome(built, 'medium')).toEqual(built);
  });

  it('opening Activity resets the score to zero regardless of current state', () => {
    const built = fold(INITIAL_RISK_SCORE_STATE, ['medium', 'medium', 'low', 'low']);
    expect(built.score).toBeGreaterThan(0);
    expect(recordActivityOpened(built)).toEqual(INITIAL_RISK_SCORE_STATE);
  });

  it('does not reset merely because ordinary approvals keep happening -- only the specified triggers reset', () => {
    // 20 MEDIUM approvals in a row, none HIGH and Activity never opened. Under a naive "any
    // approval resets" rule this could never accumulate past 1; the real rule must keep climbing
    // and eventually promote (this is the bug the research report's own worked example caught).
    let state = INITIAL_RISK_SCORE_STATE;
    let sawPromotion = false;
    for (let i = 0; i < 20; i += 1) {
      const result = gradeAction(state, 'medium');
      state = recordApprovalOutcome(result.state, result.effectiveGrade);
      if (result.promoted) sawPromotion = true;
    }
    expect(sawPromotion).toBe(true);
  });

  it('a promoted MEDIUM, approved through the HIGH-equivalent flow, resets the score', () => {
    const graded = gradeAction(atThreshold(), 'medium');
    expect(graded.effectiveGrade).toBe('high');
    expect(recordApprovalOutcome(graded.state, graded.effectiveGrade)).toEqual(INITIAL_RISK_SCORE_STATE);
  });
});

describe('invariant: a real HIGH classification can never be bypassed, softened, or auto-allowed', () => {
  it.each<RiskScoreState>([
    INITIAL_RISK_SCORE_STATE,
    { score: 0, pendingPromotion: true },
    { score: 9.5, pendingPromotion: false },
    { score: 10, pendingPromotion: true },
    { score: 1000, pendingPromotion: true },
    // Even a nonsensical/adversarial negative state must not matter: HIGH grading is unconditional
    // on the `grade` argument, never derived from `state`.
    { score: -5, pendingPromotion: true },
  ])('grading a HIGH action always yields effectiveGrade "high", unchanged, from state %j', (state) => {
    const result = gradeAction(state, 'high');
    expect(result.effectiveGrade).toBe('high');
    expect(result.promoted).toBe(false); // it was already HIGH; nothing was "promoted"
    expect(result.state.score).toBe(state.score); // +0, per RISK_SCORE_WEIGHTS.high
  });

  it('promotion only ever tightens gating (MEDIUM -> HIGH-equivalent), never loosens a grade the classifier assigned', () => {
    const severity: Record<RiskGrade, number> = { low: 0, medium: 1, high: 2 };
    const pending: RiskScoreState = { score: 10, pendingPromotion: true };
    for (const grade of ['low', 'medium', 'high'] as const) {
      expect(severity[gradeAction(pending, grade).effectiveGrade]).toBeGreaterThanOrEqual(severity[grade]);
    }
  });

  it('fails closed, not open, on a grade outside the RiskGrade union -- it never silently degrades to MEDIUM gating', () => {
    // A value that slips past the type system at a daemon/IPC boundary must not fall through into
    // the weaker MEDIUM path; it must throw rather than be treated as an ordinary, less-scrutinized
    // action.
    expect(() => gradeAction(INITIAL_RISK_SCORE_STATE, 'bogus' as RiskGrade)).toThrow();
  });

  it('a reset (HIGH approval or opening Activity) only ever zeroes the score -- it cannot itself suppress or weaken a later HIGH grade', () => {
    const resetState = recordActivityOpened({ score: 999, pendingPromotion: true });
    expect(gradeAction(resetState, 'high').effectiveGrade).toBe('high');
  });
});
