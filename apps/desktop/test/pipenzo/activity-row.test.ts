import { describe, expect, it } from 'vitest';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import {
  activityRowTime,
  activityRowTitle,
  classifyActivityRow,
  RISK_SCORE_THRESHOLD,
} from '../../src/pipenzo/activity-row.js';

const REPO = 'jortega0033/pipenzo';

function makeTicket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: '00000000-0000-4000-8000-000000000001',
    repo: REPO,
    issueNumber: 94,
    lane: 'queued',
    phase: 'refine',
    labels: ['pipenzo:queued'],
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

describe('classifyActivityRow', () => {
  it('classifies a pipenzo:ci-failed ticket as bad-toned, x-circle, chip-ci', () => {
    const ticket = makeTicket({
      lane: 'needs-human',
      labels: ['pipenzo:ci-failed'],
      attempts: [{ sessionId: 's1', tier: 'mid', model: 'sonnet', outcome: 'typecheck failed' }],
    });
    const result = classifyActivityRow(ticket);
    expect(result.icon).toBe('x-circle');
    expect(result.tone).toBe('bad');
    expect(result.chipLabel).toBe('pipenzo:ci-failed');
    expect(result.chipTone).toBe('ci');
    expect(result.detail).toContain('mid tier');
    expect(result.detail).toContain('typecheck failed');
    expect(result.meta).toContain('1 attempt');
  });

  it('classifies a pipenzo:ci-failed ticket with no attempts yet without fabricating one', () => {
    const ticket = makeTicket({ lane: 'needs-human', labels: ['pipenzo:ci-failed'] });
    const result = classifyActivityRow(ticket);
    expect(result.detail).toContain('No fix attempt has been recorded yet');
    expect(result.meta).toBe('no attempts recorded');
  });

  it('classifies a pipenzo:merge-conflict ticket as warn-toned', () => {
    const ticket = makeTicket({ lane: 'needs-human', labels: ['pipenzo:merge-conflict'] });
    const result = classifyActivityRow(ticket);
    expect(result.icon).toBe('warning');
    expect(result.tone).toBe('warn');
    expect(result.chipLabel).toBe('pipenzo:merge-conflict');
    expect(result.chipTone).toBe('warn');
    expect(result.detail).toContain('no longer merges cleanly');
  });

  it('classifies a pipenzo:needs-pre-scoping ticket using the real estimate, not an invented one', () => {
    const ticket = makeTicket({
      lane: 'needs-human',
      labels: ['pipenzo:needs-pre-scoping'],
      estimate: { lines: 1340, files: 31, layered: false },
    });
    const result = classifyActivityRow(ticket);
    expect(result.icon).toBe('hand');
    expect(result.tone).toBe('neutral');
    expect(result.chipLabel).toBe('pipenzo:needs-pre-scoping');
    expect(result.detail).toContain('1340 changed lines');
    expect(result.detail).toContain('31 files');
    expect(result.detail).toContain('no clean layering');
    expect(result.meta).toBe('1340 changed lines · 31 files');
  });

  it('classifies a pipenzo:awaiting-stack-approval ticket, naming the real child count', () => {
    const ticket = makeTicket({
      lane: 'needs-human',
      labels: ['pipenzo:awaiting-stack-approval'],
      stack: {
        parentId: null,
        childIds: ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'],
        index: null,
      },
    });
    const result = classifyActivityRow(ticket);
    expect(result.icon).toBe('pr-stack');
    expect(result.tone).toBe('warn');
    expect(result.chipLabel).toBe('pipenzo:awaiting-stack-approval');
    expect(result.detail).toContain('2-ticket dependency-ordered stack');
  });

  it('classifies a pipenzo:interrupted ticket', () => {
    const ticket = makeTicket({ lane: 'needs-human', labels: ['pipenzo:interrupted'] });
    const result = classifyActivityRow(ticket);
    expect(result.chipLabel).toBe('pipenzo:interrupted');
    expect(result.tone).toBe('warn');
    expect(result.detail).toContain('daemon died mid-run');
  });

  it('classifies a generic pipenzo:needs-human ticket as parked, naming the real last outcome', () => {
    const ticket = makeTicket({
      lane: 'needs-human',
      labels: ['pipenzo:needs-human'],
      attempts: [
        { sessionId: 's1', tier: 'cheap', model: 'sonnet', outcome: 'gate_failed' },
        { sessionId: 's2', tier: 'mid', model: 'sonnet', outcome: 'gate_failed' },
        { sessionId: 's3', tier: 'frontier', model: 'opus', outcome: 'gate_failed' },
      ],
    });
    const result = classifyActivityRow(ticket);
    expect(result.icon).toBe('x-circle');
    expect(result.tone).toBe('bad');
    expect(result.chipLabel).toBe('pipenzo:needs-human');
    expect(result.chipTone).toBe('danger');
    expect(result.detail).toContain('3 attempts recorded');
    expect(result.detail).toContain('Outcome: gate_failed');
  });

  it('prefers the specific ci-failed classification over the generic needs-human one when both labels are present', () => {
    const ticket = makeTicket({
      lane: 'needs-human',
      labels: ['pipenzo:needs-human', 'pipenzo:ci-failed'],
    });
    const result = classifyActivityRow(ticket);
    expect(result.chipLabel).toBe('pipenzo:ci-failed');
  });

  it('classifies a ticket with no pipenzo: label at all as merged/closed', () => {
    const ticket = makeTicket({
      lane: 'ready-for-review',
      labels: [],
      attempts: [{ sessionId: 's1', tier: 'mid', model: 'sonnet', outcome: 'approved' }],
      budget: { tokensUsed: 41000, limit: 0 },
    });
    const result = classifyActivityRow(ticket);
    expect(result.icon).toBe('check-circle');
    expect(result.tone).toBe('ok');
    expect(result.chipLabel).toBe('merged');
    expect(result.chipTone).toBe('ok');
    expect(result.meta).toContain('41000 tokens');
  });

  it('classifies a ready-for-review ticket as gates-passed', () => {
    const ticket = makeTicket({ lane: 'ready-for-review', labels: ['pipenzo:ready-for-review'] });
    const result = classifyActivityRow(ticket);
    expect(result.icon).toBe('gates');
    expect(result.tone).toBe('ok');
    expect(result.chipLabel).toBe('ready for review');
    expect(result.chipTone).toBe('ok');
  });

  it('classifies a ticket with an armed risk promotion as the most severe risk state', () => {
    const ticket = makeTicket({
      lane: 'working',
      labels: ['pipenzo:working'],
      risk: { score: RISK_SCORE_THRESHOLD, lastResetAt: '2026-01-01T00:00:00.000Z', pendingPromotion: true },
    });
    const result = classifyActivityRow(ticket);
    expect(result.icon).toBe('risk');
    expect(result.tone).toBe('bad');
    expect(result.chipLabel).toBe('risk threshold crossed');
    expect(result.chipTone).toBe('danger');
    expect(result.detail).toContain('gated as HIGH');
    expect(result.meta).toContain('10.0 / 10');
  });

  it('classifies a ticket with a pre-commitment mismatch and no armed promotion using the real prediction text', () => {
    const ticket = makeTicket({
      lane: 'working',
      labels: ['pipenzo:working'],
      precommits: [
        {
          action: 'set PATH in the child env',
          expect: '1 new test passes; the child env still carries PATH',
          ifWrong: 'revert and re-run with PATH forwarded',
          outcome: 'Test failed — child env had no PATH on Windows',
          verdict: 'mismatch',
        },
      ],
    });
    const result = classifyActivityRow(ticket);
    expect(result.icon).toBe('risk');
    expect(result.tone).toBe('warn');
    expect(result.chipLabel).toBe('pre-commitment mismatch');
    expect(result.detail).toContain('1 new test passes; the child env still carries PATH');
    expect(result.detail).toContain('Test failed — child env had no PATH on Windows');
  });

  it('classifies a ticket with only an elevated risk score, no mismatch or promotion', () => {
    const ticket = makeTicket({
      lane: 'working',
      labels: ['pipenzo:working'],
      risk: { score: 4.5, lastResetAt: '2026-01-01T00:00:00.000Z' },
    });
    const result = classifyActivityRow(ticket);
    expect(result.icon).toBe('risk');
    expect(result.tone).toBe('warn');
    expect(result.chipLabel).toBe('risk elevated');
    expect(result.meta).toContain('4.5 / 10');
  });

  it('classifies a ticket with a provisioned worktree and no higher-priority signal', () => {
    const ticket = makeTicket({
      lane: 'working',
      labels: ['pipenzo:working'],
      worktree: { id: '00000000-0000-4000-8000-000000000009', branch: 'issue-94-stdio-env' },
    });
    const result = classifyActivityRow(ticket);
    expect(result.icon).toBe('hand');
    expect(result.tone).toBe('neutral');
    expect(result.chipLabel).toBe('worktree active');
    expect(result.detail).toContain('issue-94-stdio-env');
    expect(result.meta).toBe('branch issue-94-stdio-env');
  });

  it('classifies a plain working ticket by its real phase', () => {
    const refining = classifyActivityRow(makeTicket({ lane: 'working', phase: 'refine' }));
    expect(refining.chipLabel).toBe('refining');
    expect(refining.detail).toContain('Refine is currently running');

    const reviewing = classifyActivityRow(makeTicket({ lane: 'working', phase: 'review' }));
    expect(reviewing.chipLabel).toBe('reviewing');

    const implementing = classifyActivityRow(makeTicket({ lane: 'working', phase: 'implement' }));
    expect(implementing.chipLabel).toBe('implementing');
    expect(implementing.tone).toBe('neutral');
    expect(implementing.chipTone).toBe('warn');
  });

  it('classifies a plain queued ticket as the honest default, using the real estimate', () => {
    const ticket = makeTicket({
      lane: 'queued',
      estimate: { lines: 20, files: 2, layered: false },
    });
    const result = classifyActivityRow(ticket);
    expect(result.icon).toBe('clock');
    expect(result.tone).toBe('neutral');
    expect(result.chipLabel).toBe('queued');
    expect(result.detail).toBe('Accepted and queued — not started yet.');
    expect(result.meta).toBe('20 changed lines · 2 files');
  });
});

describe('activityRowTitle', () => {
  it('uses the cached title when present', () => {
    expect(activityRowTitle(makeTicket({ title: 'Sanitize environment for MCP stdio servers' }))).toBe(
      'Sanitize environment for MCP stdio servers',
    );
  });

  it('falls back to Issue #N when no title has been cached yet', () => {
    expect(activityRowTitle(makeTicket({ title: undefined, issueNumber: 200 }))).toBe('Issue #200');
  });
});

describe('activityRowTime', () => {
  it('formats a real timestamp as HH:MM', () => {
    const date = new Date('2026-09-06T14:12:00.000Z');
    expect(activityRowTime({ ticket: makeTicket(), timestamp: date })).toBe(
      `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
    );
  });

  it('renders an honest placeholder for an undated entry rather than inventing a time', () => {
    expect(activityRowTime({ ticket: makeTicket() })).toBe('—');
  });
});
