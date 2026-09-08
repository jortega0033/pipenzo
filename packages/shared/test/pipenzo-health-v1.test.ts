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
      quota: { remainingFraction: 0.8642, resetAt: AT + 3_600_000, degraded: false },
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
        quota: { remainingFraction: 0.5, resetAt: AT, degraded: false, remaining: 2500 },
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

  it('names the discriminator for an unrecognised state, rather than one near-miss per member', () => {
    const result = pipenzoGitHubHealthV1Schema.safeParse({ state: 'degraded', lastCleanPollAt: AT });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.path).toEqual(['state']);
    }
  });

  /**
   * The state a starting daemon is actually in, and the one it stays in while the connected-repos
   * list is empty. Without it a producer could fill no member of the union at all before its first
   * poll settled: `healthy` demands a clean poll it has never made, and the failing states demand a
   * failure run it has not had.
   */
  it('lets a producer that has observed nothing say so, rather than invent a clean poll', () => {
    expect(pipenzoGitHubHealthV1Schema.parse({ state: 'unknown' })).toEqual({ state: 'unknown' });
    const withQuota = {
      state: 'unknown',
      quota: { remainingFraction: 1, resetAt: AT, degraded: false },
    } as const;
    expect(pipenzoGitHubHealthV1Schema.parse(withQuota)).toEqual(withQuota);
    // Still strict, and still has no retry ladder to render.
    expect(pipenzoGitHubHealthV1Schema.safeParse({ state: 'unknown', attempt: 1 }).success).toBe(false);
  });

  /**
   * `unreachable` may legitimately schedule nothing -- whether an exhausted ladder keeps polling or
   * waits for a human is #231's decision, and requiring the field here would have pinned it from
   * the consumer's side and made the state unfillable if #231 chose the other answer.
   */
  it('allows an exhausted ladder with nothing scheduled', () => {
    const stalled = {
      state: 'unreachable',
      consecutiveFailures: 5,
      firstFailureAt: AT,
      maxAttempts: 5,
    } as const;
    expect(pipenzoGitHubHealthV1Schema.parse(stalled)).toEqual(stalled);
  });

  /**
   * The rules the object shapes cannot express. Each one is a *rendered* number: a contract whose
   * job is to stop a banner showing `undefined` has no reason to let it show nonsense instead.
   */
  it('refuses cross-field nonsense the shapes alone would accept', () => {
    const cases: Array<[string, unknown]> = [
      [
        'attempt 7 of 5',
        {
          state: 'retrying',
          attempt: 7,
          maxAttempts: 5,
          nextAttemptAt: AT + 1_000,
          consecutiveFailures: 7,
          firstFailureAt: AT,
        },
      ],
      [
        'a next attempt scheduled before the failures began',
        {
          state: 'retrying',
          attempt: 2,
          maxAttempts: 5,
          nextAttemptAt: AT - 1_000,
          consecutiveFailures: 2,
          firstFailureAt: AT,
        },
      ],
      [
        'a clean poll after the failure run it supposedly precedes',
        {
          state: 'unreachable',
          consecutiveFailures: 5,
          firstFailureAt: AT,
          maxAttempts: 5,
          lastCleanPollAt: AT + 1_000,
        },
      ],
      [
        'a clean poll after the credential was rejected',
        { state: 'credential_rejected', rejectedAt: AT, lastCleanPollAt: AT + 1_000 },
      ],
    ];
    for (const [name, payload] of cases) {
      expect(pipenzoGitHubHealthV1Schema.safeParse(payload).success, name).toBe(false);
    }
    // The boundary is inclusive: equal millisecond stamps are a fast producer, not a contradiction.
    expect(
      pipenzoGitHubHealthV1Schema.safeParse({
        state: 'credential_rejected',
        rejectedAt: AT,
        lastCleanPollAt: AT,
      }).success,
    ).toBe(true);
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
      const quota = { remainingFraction, resetAt: AT, degraded: remainingFraction < 0.15 };
      expect(pipenzoGitHubQuotaV1Schema.parse(quota)).toEqual(quota);
    }
  });

  it('refuses a fraction outside 0..1, which would be a producer computing it wrong', () => {
    for (const remainingFraction of [-0.01, 1.01]) {
      expect(
        pipenzoGitHubQuotaV1Schema.safeParse({ remainingFraction, resetAt: AT, degraded: false })
          .success,
        String(remainingFraction),
      ).toBe(false);
    }
  });

  // Rejected by `z.number()` itself rather than by the bounds -- a different rule, so a
  // different case, rather than a value smuggled into the loop above under the wrong name.
  it('refuses a NaN fraction, which is not a number at all', () => {
    expect(
      pipenzoGitHubQuotaV1Schema.safeParse({
        remainingFraction: Number.NaN,
        resetAt: AT,
        degraded: false,
      }).success,
    ).toBe(false);
  });

  /**
   * The producer's decision, not the input to it. If #75 re-derived "~15%" from the fraction there
   * would be two places deciding what degraded means, free to disagree the moment either is tuned.
   */
  it('requires the degraded flag, so the threshold lives in exactly one place', () => {
    expect(pipenzoGitHubQuotaV1Schema.safeParse({ remainingFraction: 0.1, resetAt: AT }).success).toBe(
      false,
    );
  });
});
