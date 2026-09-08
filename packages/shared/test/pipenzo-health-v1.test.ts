import { describe, expect, it } from 'vitest';
import {
  pipenzoGitHubHealthV1Schema,
  pipenzoGitHubQuotaV1Schema,
  type PipenzoGitHubHealthV1,
} from '../src/pipenzo-health-v1.js';

/**
 * Issue #230. Five of epic #4's banner tickets each render a fact about Pipenzo's connection to
 * GitHub, and before this type there was no wire shape carrying any of them — `connected` from the
 * vault meant "a credential is stored here", never "GitHub still accepts it".
 */

const AT = Date.UTC(2026, 8, 8, 14, 2, 0);

describe('pipenzoGitHubHealthV1Schema', () => {
  it('round-trips a healthy payload, with and without a quota reading', () => {
    const bare = { state: 'healthy', lastCleanPollAt: AT } as const;
    expect(pipenzoGitHubHealthV1Schema.parse(bare)).toEqual(bare);

    const withQuota = {
      state: 'healthy',
      lastCleanPollAt: AT,
      quota: { remainingFraction: 0.8642, resetAt: AT + 3_600_000 },
    } as const;
    expect(pipenzoGitHubHealthV1Schema.parse(withQuota)).toEqual(withQuota);
  });

  it('round-trips the three failing states', () => {
    const payloads: PipenzoGitHubHealthV1[] = [
      {
        state: 'retrying',
        attempt: 2,
        maxAttempts: 5,
        nextAttemptAt: AT + 30_000,
        consecutiveFailures: 2,
        firstFailureAt: AT,
        lastCleanPollAt: AT - 60_000,
      },
      {
        state: 'unreachable',
        consecutiveFailures: 5,
        firstFailureAt: AT,
        nextAttemptAt: AT + 300_000,
        maxAttempts: 5,
      },
      { state: 'credential_rejected', rejectedAt: AT, lastCleanPollAt: AT - 60_000 },
    ];
    for (const payload of payloads) {
      expect(pipenzoGitHubHealthV1Schema.parse(payload), payload.state).toEqual(payload);
    }
  });

  /**
   * The criterion this type exists to satisfy: a state's companion fields are *required*, not
   * merely allowed. #70 renders "attempt 2 of 5", and an optional `attempt` reaches the banner as
   * `undefined` — "attempt undefined of 5" is worse than no banner at all.
   */
  it('refuses a state that is missing a field its banner renders', () => {
    const cases: Array<[string, unknown]> = [
      // #70 has nothing to count with.
      [
        'retrying without an attempt',
        {
          state: 'retrying',
          maxAttempts: 5,
          nextAttemptAt: AT + 30_000,
          consecutiveFailures: 2,
          firstFailureAt: AT,
        },
      ],
      [
        'retrying without a ceiling',
        {
          state: 'retrying',
          attempt: 2,
          nextAttemptAt: AT + 30_000,
          consecutiveFailures: 2,
          firstFailureAt: AT,
        },
      ],
      [
        'retrying without a next attempt to count down to',
        { state: 'retrying', attempt: 2, maxAttempts: 5, consecutiveFailures: 2, firstFailureAt: AT },
      ],
      // #71 has no "since 14:02".
      [
        'unreachable without a first failure',
        { state: 'unreachable', consecutiveFailures: 5, nextAttemptAt: AT, maxAttempts: 5 },
      ],
      [
        'unreachable without a next attempt -- the loop has not stopped, only the ladder',
        { state: 'unreachable', consecutiveFailures: 5, firstFailureAt: AT, maxAttempts: 5 },
      ],
      // #73 has no clean poll to say "working again since".
      ['healthy without a last clean poll', { state: 'healthy' }],
      // #72 cannot say when the credential stopped working.
      ['credential_rejected without a rejection time', { state: 'credential_rejected' }],
    ];
    for (const [name, payload] of cases) {
      expect(pipenzoGitHubHealthV1Schema.safeParse(payload).success, name).toBe(false);
    }
  });

  it('rejects an unknown key rather than dropping it, on every variant', () => {
    const cases: unknown[] = [
      { state: 'healthy', lastCleanPollAt: AT, retryAfter: 30 },
      {
        state: 'retrying',
        attempt: 2,
        maxAttempts: 5,
        nextAttemptAt: AT,
        consecutiveFailures: 2,
        firstFailureAt: AT,
        message: 'connection reset',
      },
      {
        state: 'unreachable',
        consecutiveFailures: 5,
        firstFailureAt: AT,
        nextAttemptAt: AT,
        maxAttempts: 5,
        httpStatus: 502,
      },
      { state: 'credential_rejected', rejectedAt: AT, token: 'anything' },
      {
        state: 'healthy',
        lastCleanPollAt: AT,
        quota: { remainingFraction: 0.5, resetAt: AT, remaining: 2500 },
      },
    ];
    for (const payload of cases) {
      expect(pipenzoGitHubHealthV1Schema.safeParse(payload).success, JSON.stringify(payload)).toBe(
        false,
      );
    }
  });

  /**
   * `credential_rejected` deliberately carries neither, and the absence is the statement: retrying
   * a credential GitHub has rejected does not fix it, and a banner offering "retrying in 30s" for a
   * revoked token points the user at something that will never happen.
   */
  it('gives credential_rejected no retry ladder to render', () => {
    for (const extra of [{ nextAttemptAt: AT }, { attempt: 1 }, { maxAttempts: 5 }]) {
      expect(
        pipenzoGitHubHealthV1Schema.safeParse({ state: 'credential_rejected', rejectedAt: AT, ...extra })
          .success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('names the discriminator when the state is unknown, rather than reporting four near-misses', () => {
    const result = pipenzoGitHubHealthV1Schema.safeParse({ state: 'degraded', lastCleanPollAt: AT });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['state']);
    }
  });

  it('requires every timestamp to be a positive integer of unix milliseconds', () => {
    for (const bad of [0, -1, 1.5, '2026-09-08T14:02:00Z', null]) {
      expect(
        pipenzoGitHubHealthV1Schema.safeParse({ state: 'healthy', lastCleanPollAt: bad }).success,
        String(bad),
      ).toBe(false);
    }
  });
});

describe('pipenzoGitHubQuotaV1Schema', () => {
  it('accepts the two ends of the fraction, since both are real states', () => {
    // Exhausted is the reading a consumer most needs; full is what a fresh daemon sees.
    for (const remainingFraction of [0, 0.15, 1]) {
      expect(
        pipenzoGitHubQuotaV1Schema.parse({ remainingFraction, resetAt: AT }),
      ).toEqual({ remainingFraction, resetAt: AT });
    }
  });

  it('refuses a fraction outside 0..1, which would be a producer computing it wrong', () => {
    for (const remainingFraction of [-0.01, 1.01, Number.NaN]) {
      expect(
        pipenzoGitHubQuotaV1Schema.safeParse({ remainingFraction, resetAt: AT }).success,
        String(remainingFraction),
      ).toBe(false);
    }
  });
});
