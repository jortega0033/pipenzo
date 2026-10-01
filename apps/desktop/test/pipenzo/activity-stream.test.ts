import { describe, expect, it } from 'vitest';
import type {
  PipenzoTicketAttemptV1,
  PipenzoTicketPrecommitV1,
  PipenzoTicketViewV1,
  ReviewReportV1,
} from '@agent-dock/shared';
import {
  activityStreamAttemptTitle,
  activityStreamCiFailedTitle,
  activityStreamIcon,
  activityStreamIconTone,
  activityStreamLineEnds,
  activityStreamReviewTitle,
  activityStreamRiskGrade,
  buildActivityStream,
  isLowRiskActivityEntry,
  type ActivityStreamEntry,
} from '../../src/pipenzo/activity-stream.js';

const TICKET_ID = '00000000-0000-4000-8000-000000000001';

function ticket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: TICKET_ID,
    repo: 'jortega0033/pipenzo',
    issueNumber: 94,
    lane: 'working',
    phase: 'implement',
    labels: ['pipenzo:working'],
    estimate: { lines: 0, files: 0, layered: false },
    taskType: 'chore',
    stack: { parentId: null, childIds: [], index: null },
    attempts: [],
    budget: { tokensUsed: 0, limit: 0 },
    risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
    precommits: [],
    etags: {},
    ...overrides,
  };
}

function attempt(overrides: Partial<PipenzoTicketAttemptV1> = {}): PipenzoTicketAttemptV1 {
  return { sessionId: 'session-1', tier: 'mid', model: 'default', outcome: 'dispatched', ...overrides };
}

function precommit(overrides: Partial<PipenzoTicketPrecommitV1> = {}): PipenzoTicketPrecommitV1 {
  return {
    action: 'Delete the legacy fixture',
    expect: 'vitest count stays the same',
    ifWrong: 'git checkout -- the file',
    outcome: 'vitest count unchanged',
    verdict: 'match',
    ...overrides,
  };
}

function reviewReport(overrides: Partial<ReviewReportV1> = {}): ReviewReportV1 {
  return {
    schemaVersion: 1,
    outcome: 'approved',
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    implementerTier: 'mid',
    deterministic: [
      { id: 'build', status: 'passed', summary: 'ok', durationMs: 100 },
      { id: 'typecheck', status: 'passed', summary: 'ok', durationMs: 100 },
    ],
    risk: 'low',
    verifier: { sessionId: 'v1', tier: 'mid', model: 'opus', findings: [], verdict: 'approved', vendorDiversityUnavailable: false },
    ...overrides,
  };
}

describe('buildActivityStream', () => {
  it('builds no rows for a ticket with nothing recorded and no review supplied', () => {
    expect(buildActivityStream(ticket())).toEqual([]);
  });

  it('builds one row per real attempt, in array order', () => {
    const t = ticket({ attempts: [attempt({ sessionId: 's1' }), attempt({ sessionId: 's2', outcome: 'interrupted_recovered' })] });
    const entries = buildActivityStream(t);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'attempt', attempt: { sessionId: 's1' } });
    expect(entries[1]).toMatchObject({ kind: 'attempt', attempt: { sessionId: 's2' } });
  });

  it('builds one row per real precommit, after every attempt row', () => {
    const t = ticket({
      attempts: [attempt()],
      precommits: [precommit({ action: 'first' }), precommit({ action: 'second' })],
    });
    const entries = buildActivityStream(t);
    expect(entries.map((e) => e.kind)).toEqual(['attempt', 'precommit', 'precommit']);
  });

  it('appends a review row only when a real report is supplied', () => {
    const entries = buildActivityStream(ticket(), { reviewReport: reviewReport() });
    expect(entries).toEqual([{ kind: 'review', report: reviewReport() }]);
  });

  it('appends a review-pending row when review is running and no report exists yet', () => {
    const entries = buildActivityStream(ticket(), { reviewPending: true });
    expect(entries).toEqual([{ kind: 'review-pending' }]);
  });

  it('prefers a finished report over a stale pending flag', () => {
    const entries = buildActivityStream(ticket(), { reviewReport: reviewReport(), reviewPending: true });
    expect(entries).toEqual([{ kind: 'review', report: reviewReport() }]);
  });

  it('marks the last attempt live only while genuinely dispatched, implementing, and working', () => {
    const t = ticket({ lane: 'working', phase: 'implement', attempts: [attempt({ outcome: 'dispatched' })] });
    const [entry] = buildActivityStream(t);
    expect(entry).toMatchObject({ kind: 'attempt', live: true });
  });

  it('does not mark an attempt live once it has a terminal outcome', () => {
    const t = ticket({ lane: 'working', phase: 'implement', attempts: [attempt({ outcome: 'interrupted_recovered' })] });
    const [entry] = buildActivityStream(t);
    expect(entry).toMatchObject({ live: false });
  });

  it('does not mark an attempt live once the lane has moved past working', () => {
    const t = ticket({ lane: 'ready-for-review', phase: 'review', attempts: [attempt({ outcome: 'dispatched' })] });
    const [entry] = buildActivityStream(t);
    expect(entry).toMatchObject({ live: false });
  });

  it('only ever marks the most recent attempt live, never an earlier one', () => {
    const t = ticket({
      lane: 'working',
      phase: 'implement',
      attempts: [attempt({ sessionId: 's1', outcome: 'dispatched' }), attempt({ sessionId: 's2', outcome: 'dispatched' })],
    });
    const entries = buildActivityStream(t);
    expect(entries[0]).toMatchObject({ live: false });
    expect(entries[1]).toMatchObject({ live: true });
  });

  it('appends a ci-failed row, last, only when the ticket carries the real label', () => {
    const t = ticket({ labels: ['pipenzo:ci-failed'], attempts: [attempt({ sessionId: 's1' })] });
    const entries = buildActivityStream(t);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'attempt', attempt: { sessionId: 's1' } });
    expect(entries[1]).toMatchObject({ kind: 'ci-failed', lastAttempt: { sessionId: 's1' } });
  });

  it('does not append a ci-failed row for a ticket without the real label', () => {
    const t = ticket({ labels: ['pipenzo:working'], attempts: [attempt()] });
    const entries = buildActivityStream(t);
    expect(entries.some((e) => e.kind === 'ci-failed')).toBe(false);
  });

  it('appends ci-failed after every other real row, attempts, precommits, and review alike', () => {
    const t = ticket({
      labels: ['pipenzo:ci-failed'],
      attempts: [attempt()],
      precommits: [precommit()],
    });
    const entries = buildActivityStream(t, { reviewReport: reviewReport() });
    expect(entries.map((e) => e.kind)).toEqual(['attempt', 'precommit', 'review', 'ci-failed']);
  });

  it('carries undefined lastAttempt on the ci-failed row when no attempt has been recorded yet', () => {
    const t = ticket({ labels: ['pipenzo:ci-failed'], attempts: [] });
    const entries = buildActivityStream(t);
    expect(entries).toEqual([{ kind: 'ci-failed', lastAttempt: undefined }]);
  });
});

describe('activityStreamIcon / activityStreamIconTone', () => {
  it('maps attempt and precommit rows to the implement icon', () => {
    expect(activityStreamIcon({ kind: 'attempt', attempt: attempt(), live: false })).toBe('implement');
    expect(activityStreamIcon({ kind: 'precommit', precommit: precommit() })).toBe('implement');
  });

  it('maps both review row kinds to the review icon', () => {
    expect(activityStreamIcon({ kind: 'review', report: reviewReport() })).toBe('review');
    expect(activityStreamIcon({ kind: 'review-pending' })).toBe('review');
  });

  it('tones a live attempt and a pending review as live, everything else default', () => {
    expect(activityStreamIconTone({ kind: 'attempt', attempt: attempt(), live: true })).toBe('live');
    expect(activityStreamIconTone({ kind: 'attempt', attempt: attempt(), live: false })).toBe('default');
    expect(activityStreamIconTone({ kind: 'review-pending' })).toBe('live');
    expect(activityStreamIconTone({ kind: 'review', report: reviewReport() })).toBe('default');
    expect(activityStreamIconTone({ kind: 'precommit', precommit: precommit() })).toBe('default');
  });

  it('maps the ci-failed row to the x-circle icon, bad tone', () => {
    expect(activityStreamIcon({ kind: 'ci-failed', lastAttempt: undefined })).toBe('x-circle');
    expect(activityStreamIconTone({ kind: 'ci-failed', lastAttempt: undefined })).toBe('bad');
  });
});

describe('activityStreamRiskGrade / isLowRiskActivityEntry', () => {
  it('reads the real RiskGrade only off a review row', () => {
    expect(activityStreamRiskGrade({ kind: 'review', report: reviewReport({ risk: 'high' }) })).toBe('high');
    expect(activityStreamRiskGrade({ kind: 'attempt', attempt: attempt(), live: false })).toBeUndefined();
    expect(activityStreamRiskGrade({ kind: 'precommit', precommit: precommit() })).toBeUndefined();
    expect(activityStreamRiskGrade({ kind: 'review-pending' })).toBeUndefined();
  });

  it('is LOW-compact exactly for a review row graded low, for every other real grade and kind it is not', () => {
    expect(isLowRiskActivityEntry({ kind: 'review', report: reviewReport({ risk: 'low' }) })).toBe(true);
    expect(isLowRiskActivityEntry({ kind: 'review', report: reviewReport({ risk: 'medium' }) })).toBe(false);
    expect(isLowRiskActivityEntry({ kind: 'review', report: reviewReport({ risk: 'high' }) })).toBe(false);
    expect(isLowRiskActivityEntry({ kind: 'attempt', attempt: attempt(), live: false })).toBe(false);
    expect(isLowRiskActivityEntry({ kind: 'precommit', precommit: precommit() })).toBe(false);
    expect(isLowRiskActivityEntry({ kind: 'review-pending' })).toBe(false);
  });
});

describe('activityStreamLineEnds', () => {
  it('terminates the line for the last of N rows when nothing continues below', () => {
    const entries: ActivityStreamEntry[] = [
      { kind: 'attempt', attempt: attempt({ sessionId: 's1' }), live: false },
      { kind: 'attempt', attempt: attempt({ sessionId: 's2' }), live: false },
      { kind: 'attempt', attempt: attempt({ sessionId: 's3' }), live: false },
    ];
    expect(activityStreamLineEnds(0, entries, false)).toBe(false);
    expect(activityStreamLineEnds(1, entries, false)).toBe(false);
    expect(activityStreamLineEnds(2, entries, false)).toBe(true);
  });

  it('never terminates the last row when the caller says more stream content follows', () => {
    const entries: ActivityStreamEntry[] = [{ kind: 'attempt', attempt: attempt(), live: false }];
    expect(activityStreamLineEnds(0, entries, true)).toBe(false);
  });

  it('terminates a single-row stream at index 0', () => {
    const entries: ActivityStreamEntry[] = [{ kind: 'review-pending' }];
    expect(activityStreamLineEnds(0, entries, false)).toBe(true);
  });

  it('draws the real lineage line from the last attempt row down into the trailing ci-failed row', () => {
    const entries: ActivityStreamEntry[] = [
      { kind: 'attempt', attempt: attempt({ sessionId: 's1' }), live: false },
      { kind: 'ci-failed', lastAttempt: attempt({ sessionId: 's1' }) },
    ];
    expect(activityStreamLineEnds(0, entries, false)).toBe(false);
    expect(activityStreamLineEnds(1, entries, false)).toBe(true);
  });
});

describe('activityStreamAttemptTitle', () => {
  it('names the one real dispatch outcome honestly', () => {
    expect(activityStreamAttemptTitle(attempt({ outcome: 'dispatched' }))).toBe('Implement session dispatched');
  });

  it('names the one real crash-recovery outcome honestly', () => {
    expect(activityStreamAttemptTitle(attempt({ outcome: 'interrupted_recovered' }))).toMatch(/recovered/i);
  });

  it('names an unresolved crash-recovery outcome with the real lane it names', () => {
    expect(activityStreamAttemptTitle(attempt({ outcome: 'interrupted_unresolved:needs-human' }))).toContain(
      'needs-human',
    );
  });

  it('falls back to the raw outcome string for one this module does not recognize, rather than guessing', () => {
    expect(activityStreamAttemptTitle(attempt({ outcome: 'some_future_outcome' }))).toBe(
      'Outcome: some_future_outcome',
    );
  });
});

describe('activityStreamReviewTitle', () => {
  it('reports the real deterministic-gate pass count', () => {
    expect(activityStreamReviewTitle(reviewReport())).toBe('Review approved — 2/2 deterministic gates passed');
  });

  it('names every real outcome in the closed REVIEW_OUTCOMES union', () => {
    expect(activityStreamReviewTitle(reviewReport({ outcome: 'verifier_rejected', verifier: { sessionId: 'v1', tier: 'mid', model: 'opus', findings: [], verdict: 'rejected', vendorDiversityUnavailable: false } }))).toContain(
      'rejected by the adversarial verifier',
    );
    expect(activityStreamReviewTitle(reviewReport({ outcome: 'deterministic_failed', verifier: undefined, deterministic: [{ id: 'build', status: 'failed', summary: 'nope', durationMs: 10 }] }))).toContain(
      'stopped at the deterministic gates',
    );
  });

  it('reports "no deterministic gates ran" honestly rather than a false 0/0', () => {
    expect(activityStreamReviewTitle(reviewReport({ deterministic: [] }))).toContain('no deterministic gates ran');
  });
});

describe('activityStreamCiFailedTitle', () => {
  it('names the real last-attempt tier and model when a fix attempt has been recorded', () => {
    const title = activityStreamCiFailedTitle({
      kind: 'ci-failed',
      lastAttempt: attempt({ tier: 'frontier', model: 'opus' }),
    });
    expect(title).toContain('frontier tier');
    expect(title).toContain('opus');
    expect(title).not.toMatch(/PR #|commit|session\.fork/i);
  });

  it('reports the honest gap when no attempt has been recorded yet, never a guess', () => {
    const title = activityStreamCiFailedTitle({ kind: 'ci-failed', lastAttempt: undefined });
    expect(title).toBe('A post-merge-request check failed on this ticket. No fix attempt has been recorded yet.');
  });
});
