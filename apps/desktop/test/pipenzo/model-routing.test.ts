import { describe, expect, it } from 'vitest';
import type { LlmReviewPassV1, PipenzoTicketAttemptV1, VerifierPassV1 } from '@agent-dock/shared';
import { modelRoutingRows } from '../../src/pipenzo/model-routing.js';

const IMPLEMENT_ATTEMPT: PipenzoTicketAttemptV1 = {
  sessionId: 'implement-session-1',
  tier: 'mid',
  model: 'sonnet',
  outcome: 'gate_failed',
};

const LATER_IMPLEMENT_ATTEMPT: PipenzoTicketAttemptV1 = {
  sessionId: 'implement-session-2',
  tier: 'frontier',
  model: 'opus',
  outcome: 'running',
};

const REVIEWER: LlmReviewPassV1 = {
  sessionId: 'reviewer-session',
  tier: 'mid',
  model: 'sonnet',
  findings: [],
};

const VERIFIER: VerifierPassV1 = {
  sessionId: 'verifier-session',
  tier: 'frontier',
  model: 'opus',
  findings: [],
  verdict: 'approved',
  vendorDiversityUnavailable: false,
};

describe('modelRoutingRows', () => {
  it('returns no rows for a ticket with no attempts and no review pass', () => {
    expect(modelRoutingRows([])).toEqual([]);
  });

  it('reads the Implement row from the most recent attempt, not the first', () => {
    const rows = modelRoutingRows([IMPLEMENT_ATTEMPT, LATER_IMPLEMENT_ATTEMPT]);
    expect(rows).toEqual([{ phase: 'Implement', value: 'opus' }]);
  });

  it('adds a Reviewer row only once a reviewer pass exists', () => {
    const rows = modelRoutingRows([IMPLEMENT_ATTEMPT], REVIEWER);
    expect(rows).toEqual([
      { phase: 'Implement', value: 'sonnet' },
      { phase: 'Reviewer', value: 'sonnet' },
    ]);
  });

  it('adds a Verifier row with no warn tone when vendor diversity was available', () => {
    const rows = modelRoutingRows([IMPLEMENT_ATTEMPT], REVIEWER, VERIFIER);
    expect(rows.at(-1)).toEqual({ phase: 'Verifier', value: 'opus' });
  });

  it('tags the Verifier row warn when vendor diversity was unavailable (issue #147)', () => {
    const rows = modelRoutingRows([IMPLEMENT_ATTEMPT], REVIEWER, {
      ...VERIFIER,
      vendorDiversityUnavailable: true,
    });
    expect(rows.at(-1)).toEqual({ phase: 'Verifier', value: 'opus', tone: 'warn' });
  });

  it('never fabricates a Refine row -- no data source exists for one yet', () => {
    const rows = modelRoutingRows([IMPLEMENT_ATTEMPT], REVIEWER, VERIFIER);
    expect(rows.some((row) => (row.phase as string) === 'Refine')).toBe(false);
    expect(rows).toHaveLength(3);
  });
});
