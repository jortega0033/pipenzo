import { describe, expect, it } from 'vitest';
import type { PipenzoTicketAttemptV1, PipenzoTicketBudgetV1 } from '@agent-dock/shared';
import {
  computeHeadroom,
  formatTokenCount,
  NO_PROVIDER_QUOTA_TEXT,
} from '../../src/pipenzo/subscription-headroom.js';

const ATTEMPT = (n: number): PipenzoTicketAttemptV1 => ({
  sessionId: `implement-session-${n}`,
  tier: 'mid',
  model: 'sonnet',
  outcome: 'running',
});

describe('formatTokenCount', () => {
  it('renders an exact, comma-separated number under 10,000', () => {
    expect(formatTokenCount(9_999)).toBe('9,999');
    expect(formatTokenCount(1_234)).toBe('1,234');
  });

  it('rounds to the nearest thousand between 10,000 and 1,000,000', () => {
    expect(formatTokenCount(412_000)).toBe('~412k');
    expect(formatTokenCount(10_499)).toBe('~10k');
  });

  it('rounds to one decimal place in millions at or above 1,000,000', () => {
    expect(formatTokenCount(3_400_000)).toBe('~3.4M');
  });
});

describe('computeHeadroom', () => {
  it('counts sessions as the number of recorded Implement attempts', () => {
    const budget: PipenzoTicketBudgetV1 = { tokensUsed: 100, limit: 0 };
    expect(computeHeadroom([ATTEMPT(1), ATTEMPT(2)], budget).sessions).toBe(2);
  });

  it('reports tokensUsed and limit verbatim from the real budget', () => {
    const budget: PipenzoTicketBudgetV1 = { tokensUsed: 40_000, limit: 200_000 };
    const headroom = computeHeadroom([ATTEMPT(1)], budget);
    expect(headroom.tokensUsed).toBe(40_000);
    expect(headroom.limit).toBe(200_000);
  });

  it('computes an honest remaining-sessions estimate from the real average per attempt', () => {
    // 40,000 tokens across 2 attempts = 20,000/session average; 160,000 tokens remain of a
    // 200,000 limit, so 160,000 / 20,000 = 8 sessions' worth of headroom left.
    const budget: PipenzoTicketBudgetV1 = { tokensUsed: 40_000, limit: 200_000 };
    const headroom = computeHeadroom([ATTEMPT(1), ATTEMPT(2)], budget);
    expect(headroom.estimateText).toBe('~8 sessions remaining');
  });

  it('uses the singular "session" when the estimate is exactly one', () => {
    // 50,000 tokens across 1 attempt = 50,000/session average; 50,000 tokens remain of a
    // 100,000 limit, so 50,000 / 50,000 = exactly 1 session's worth of headroom left.
    const budget: PipenzoTicketBudgetV1 = { tokensUsed: 50_000, limit: 100_000 };
    const headroom = computeHeadroom([ATTEMPT(1)], budget);
    expect(headroom.estimateText).toBe('~1 session remaining');
  });

  it('omits the estimate when no limit is configured (limit: 0 means unlimited)', () => {
    const budget: PipenzoTicketBudgetV1 = { tokensUsed: 40_000, limit: 0 };
    const headroom = computeHeadroom([ATTEMPT(1)], budget);
    expect(headroom.estimateText).toBeUndefined();
  });

  it('omits the estimate when no attempt exists yet to average from, even if tokens were spent', () => {
    // Refine can spend tokens (issue #143) without ever recording an attempt -- see this module's
    // own doc comment on why `sessions` is a floor, not a total.
    const budget: PipenzoTicketBudgetV1 = { tokensUsed: 5_000, limit: 200_000 };
    const headroom = computeHeadroom([], budget);
    expect(headroom.sessions).toBe(0);
    expect(headroom.estimateText).toBeUndefined();
  });

  it('never reports a negative remaining headroom once the budget is already exceeded', () => {
    const budget: PipenzoTicketBudgetV1 = { tokensUsed: 250_000, limit: 200_000 };
    const headroom = computeHeadroom([ATTEMPT(1)], budget);
    expect(headroom.estimateText).toBe('~0 sessions remaining');
  });
});

describe('NO_PROVIDER_QUOTA_TEXT', () => {
  it('states plainly that no provider reports a quota', () => {
    expect(NO_PROVIDER_QUOTA_TEXT).toContain('no provider reports a quota');
  });
});
