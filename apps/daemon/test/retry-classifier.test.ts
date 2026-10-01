import { describe, expect, it } from 'vitest';
import type { PipenzoTicketApprovalRejectionV1, PipenzoTicketAttemptV1 } from '@agent-dock/shared';
import { classifyRetry, type RetryClassifierTicket } from '../src/retry-classifier.js';

/**
 * CLAUDE.md hard rule 4's entire spec, proven against the pure classifier in isolation --
 * `pipenzo-phase-service-retry.test.ts` proves the effectful half dispatches exactly what this
 * module names, against a real worktree and a fake session port.
 */

function attempt(overrides: Partial<PipenzoTicketAttemptV1> = {}): PipenzoTicketAttemptV1 {
  return { sessionId: 's-1', tier: 'mid', model: 'claude-sonnet', outcome: 'dispatched', ...overrides };
}

function rejection(
  overrides: Partial<PipenzoTicketApprovalRejectionV1> = {},
): PipenzoTicketApprovalRejectionV1 {
  return { kind: 'high', reason: 'needs a second look', decidedAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

function ticket(overrides: Partial<RetryClassifierTicket> = {}): RetryClassifierTicket {
  return { attempts: [attempt()], ...overrides };
}

describe('classifyRetry (issue #105, CLAUDE.md hard rule 4)', () => {
  it('refuses a ticket with no dispatched attempts at all', () => {
    expect(classifyRetry(ticket({ attempts: [] }))).toEqual({
      eligible: false,
      reason: 'no_attempts',
    });
  });

  it('refuses a denied approval unconditionally -- before attempt count is even considered', () => {
    const result = classifyRetry(
      ticket({ attempts: [attempt()], lastApprovalRejection: rejection() }),
    );
    expect(result).toEqual({ eligible: false, reason: 'denied_approval' });
  });

  it('refuses a denied approval even on the very first attempt (fewer than the max-retries threshold)', () => {
    const result = classifyRetry(
      ticket({ attempts: [attempt({ tier: 'cheap' })], lastApprovalRejection: rejection({ kind: 'medium' }) }),
    );
    expect(result).toEqual({ eligible: false, reason: 'denied_approval' });
  });

  it('refuses once the ticket has reached the needs-human failed-attempt threshold (3)', () => {
    const result = classifyRetry(
      ticket({
        attempts: [attempt(), attempt({ sessionId: 's-2' }), attempt({ sessionId: 's-3' })],
      }),
    );
    expect(result).toEqual({ eligible: false, reason: 'max_retries_reached' });
  });

  it('refuses at exactly the threshold, not only past it', () => {
    const threeAttempts = [attempt(), attempt({ sessionId: 's-2' }), attempt({ sessionId: 's-3' })];
    expect(classifyRetry(ticket({ attempts: threeAttempts })).eligible).toBe(false);
    const fourAttempts = [...threeAttempts, attempt({ sessionId: 's-4' })];
    expect(classifyRetry(ticket({ attempts: fourAttempts })).eligible).toBe(false);
  });

  it('escalates tier and dispatches fresh when the last attempt was cheap', () => {
    const result = classifyRetry(ticket({ attempts: [attempt({ tier: 'cheap' })] }));
    expect(result).toEqual({ eligible: true, mode: 'fresh', tier: 'mid' });
  });

  it('escalates tier and dispatches fresh when the last attempt was mid', () => {
    const result = classifyRetry(ticket({ attempts: [attempt({ tier: 'mid' })] }));
    expect(result).toEqual({ eligible: true, mode: 'fresh', tier: 'frontier' });
  });

  it('forks at the same (highest) tier once the last attempt already reached frontier', () => {
    const result = classifyRetry(ticket({ attempts: [attempt({ tier: 'frontier' })] }));
    expect(result).toEqual({ eligible: true, mode: 'fork', tier: 'frontier' });
  });

  it('never returns mode "fork" for a tier-escalation classification, and vice versa', () => {
    // The CLAUDE.md hard rule 4 property this whole module exists to hold, stated as an explicit,
    // exhaustive check rather than left implicit in the three tier-specific cases above: whenever
    // the classification escalates tier (the returned tier differs from the last attempt's own),
    // the mode must be 'fresh', never 'fork' -- and whenever it stays at the same tier, the mode
    // must be 'fork', never 'fresh'.
    for (const tier of ['cheap', 'mid', 'frontier'] as const) {
      const result = classifyRetry(ticket({ attempts: [attempt({ tier })] }));
      if (!result.eligible) throw new Error('expected an eligible classification for this fixture');
      if (result.tier === tier) {
        expect(result.mode).toBe('fork');
      } else {
        expect(result.mode).toBe('fresh');
      }
    }
  });

  it('only considers the most recent attempt, not the whole history', () => {
    // An early cheap attempt followed by a later frontier one should fork -- the classifier reads
    // `attempts.at(-1)`, never the first or any middle entry.
    const result = classifyRetry(
      ticket({
        attempts: [attempt({ tier: 'cheap' }), attempt({ sessionId: 's-2', tier: 'frontier' })],
      }),
    );
    expect(result).toEqual({ eligible: true, mode: 'fork', tier: 'frontier' });
  });
});
