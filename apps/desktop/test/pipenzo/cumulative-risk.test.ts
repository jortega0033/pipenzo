import { describe, expect, it } from 'vitest';
import {
  RISK_SCORE_THRESHOLD,
  riskSegments,
  summarizeCumulativeRisk,
} from '../../src/pipenzo/cumulative-risk.js';

describe('riskSegments', () => {
  it('fills zero segments for a zero score', () => {
    expect(riskSegments(0).every((segment) => !segment.on)).toBe(true);
  });

  it('rounds a fractional score up to at least one filled segment', () => {
    const segments = riskSegments(0.5);
    expect(segments.filter((segment) => segment.on)).toHaveLength(1);
  });

  it('fills exactly one segment per whole point for a whole-number score', () => {
    expect(riskSegments(4).filter((segment) => segment.on)).toHaveLength(4);
  });

  it('fills all ten segments at the threshold', () => {
    expect(riskSegments(10).every((segment) => segment.on)).toBe(true);
  });

  it('colors the first four segments plain, the next three warm, the last three hot -- by position, not by count filled', () => {
    const segments = riskSegments(10);
    expect(segments.slice(0, 4).map((segment) => segment.tone)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(segments.slice(4, 7).map((segment) => segment.tone)).toEqual(['warm', 'warm', 'warm']);
    expect(segments.slice(7, 10).map((segment) => segment.tone)).toEqual(['hot', 'hot', 'hot']);
  });

  it('leaves an unfilled segment’s tone undefined even past its color band', () => {
    // Only 2 segments filled: the 8th segment (index 7, the "hot" band) is not on, so it must not
    // carry a tone -- an unfilled segment must never look like a filled one.
    const segments = riskSegments(2);
    expect(segments[7]).toEqual({ on: false, tone: undefined });
  });
});

describe('summarizeCumulativeRisk', () => {
  it('reports "Calm" and an honest empty sentence for a fresh, zero score', () => {
    const summary = summarizeCumulativeRisk({ score: 0 });
    expect(summary.level).toBe('Calm');
    expect(summary.text).toBe('No unreviewed risk since the last reset.');
    expect(summary.countText).toBe('0.0 / 10');
    expect(summary.promoted).toBe(false);
  });

  it('reports "Calm" below 4, "Moderate" from 4 up to the threshold, "High" at or above it', () => {
    expect(summarizeCumulativeRisk({ score: 2 }).level).toBe('Calm');
    expect(summarizeCumulativeRisk({ score: 4 }).level).toBe('Moderate');
    expect(summarizeCumulativeRisk({ score: 7 }).level).toBe('Moderate');
    expect(summarizeCumulativeRisk({ score: 10 }).level).toBe('High');
  });

  it('treats an absent pendingPromotion as false, honestly -- not as unknown', () => {
    expect(summarizeCumulativeRisk({ score: 3 }).promoted).toBe(false);
  });

  it('is "High" whenever a promotion is armed, regardless of the numeric score', () => {
    // Defensive: a real engine only arms a promotion once score >= threshold, but the summary
    // must not silently under-report severity if a stale/clamped record ever disagreed.
    expect(summarizeCumulativeRisk({ score: 3, pendingPromotion: true }).level).toBe('High');
  });

  it('surfaces the promotion banner text only when a promotion is armed', () => {
    const armed = summarizeCumulativeRisk({ score: 10, pendingPromotion: true });
    const notArmed = summarizeCumulativeRisk({ score: 10, pendingPromotion: false });
    expect(armed.promoted).toBe(true);
    expect(armed.promoText.length).toBeGreaterThan(0);
    expect(notArmed.promoted).toBe(false);
  });

  it('clamps a score above the threshold rather than reporting an unbounded number', () => {
    const summary = summarizeCumulativeRisk({ score: 999 });
    expect(summary.countText).toBe(`10.0 / ${RISK_SCORE_THRESHOLD}`);
    expect(summary.segments.every((segment) => segment.on)).toBe(true);
  });

  it('formats the count to one decimal place, matching the canvas’s own {{riskCount}}', () => {
    expect(summarizeCumulativeRisk({ score: 0.5 }).countText).toBe('0.5 / 10');
    expect(summarizeCumulativeRisk({ score: 7 }).countText).toBe('7.0 / 10');
  });
});
