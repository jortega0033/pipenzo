import { describe, expect, it } from 'vitest';
import type { PipenzoLabelV1, PipenzoTicketViewV1 } from '@agent-dock/shared';
import { ticketPhaseSteps } from '../../src/pipenzo/ticket-phase-steps.js';

function ticket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: '00000000-0000-4000-8000-000000000001',
    repo: 'jortega0033/pipenzo',
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

function statusOf(t: PipenzoTicketViewV1, id: string) {
  return ticketPhaseSteps(t).steps.find((step) => step.id === id)?.status;
}

describe('ticketPhaseSteps', () => {
  it('renders a queued ticket as all-upcoming', () => {
    const t = ticket({ lane: 'queued', phase: 'refine', labels: ['pipenzo:queued'] });
    const { steps } = ticketPhaseSteps(t);
    expect(steps.map((s) => s.status)).toEqual(['upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
    expect(steps).toHaveLength(5);
  });

  it('marks Refine active while it is actually running', () => {
    const t = ticket({ lane: 'working', phase: 'refine', labels: ['pipenzo:working'] });
    expect(statusOf(t, 'refine')).toBe('active');
    expect(statusOf(t, 'plan-review')).toBe('upcoming');
  });

  it('marks Implement active while it is actually running, with Refine and Plan review done', () => {
    const t = ticket({ lane: 'working', phase: 'implement', labels: ['pipenzo:working'] });
    expect(statusOf(t, 'refine')).toBe('done');
    expect(statusOf(t, 'plan-review')).toBe('done');
    expect(statusOf(t, 'implement')).toBe('active');
    expect(statusOf(t, 'review')).toBe('upcoming');
  });

  it('marks Review active while it is actually running', () => {
    const t = ticket({ lane: 'working', phase: 'review', labels: ['pipenzo:working'] });
    expect(statusOf(t, 'implement')).toBe('done');
    expect(statusOf(t, 'review')).toBe('active');
    expect(statusOf(t, 'publish')).toBe('upcoming');
  });

  it('shows Plan review awaiting sign-off for a stack decomposition (real awaiting-stack-approval label)', () => {
    const t = ticket({
      lane: 'needs-human',
      phase: 'refine',
      labels: ['pipenzo:needs-human', 'pipenzo:awaiting-stack-approval'] as PipenzoLabelV1[],
    });
    expect(statusOf(t, 'refine')).toBe('done');
    expect(statusOf(t, 'plan-review')).toBe('await');
    expect(ticketPhaseSteps(t).hint?.text).toBe('Stack awaiting sign-off');
  });

  it('shows a needs-pre-scoping refusal as a finished (failed) plan-review outcome, not a wait', () => {
    const t = ticket({
      lane: 'needs-human',
      phase: 'refine',
      labels: ['pipenzo:needs-human', 'pipenzo:needs-pre-scoping'] as PipenzoLabelV1[],
    });
    expect(statusOf(t, 'plan-review')).toBe('fail');
    expect(ticketPhaseSteps(t).hint).toEqual({
      text: 'Declined at Refine — finished outcome',
      quiet: true,
    });
  });

  it('shows Publish awaiting the human push gate once gates have passed (ready-for-review)', () => {
    const t = ticket({ lane: 'ready-for-review', phase: 'review', labels: ['pipenzo:ready-for-review'] });
    expect(statusOf(t, 'review')).toBe('done');
    expect(statusOf(t, 'publish')).toBe('await');
    expect(ticketPhaseSteps(t).hint?.text).toBe('Waiting on you — ready to publish');
  });

  it('marks generic needs-human (parked after failures) as a failed step at the phase it was parked in', () => {
    const implementParked = ticket({
      lane: 'needs-human',
      phase: 'implement',
      labels: ['pipenzo:needs-human'],
    });
    expect(statusOf(implementParked, 'implement')).toBe('fail');
    expect(statusOf(implementParked, 'review')).toBe('upcoming');

    const reviewParked = ticket({ lane: 'needs-human', phase: 'review', labels: ['pipenzo:needs-human'] });
    expect(statusOf(reviewParked, 'implement')).toBe('done');
    expect(statusOf(reviewParked, 'review')).toBe('fail');
  });

  it('marks Publish as failed on a merge conflict, discovered only after approval', () => {
    const t = ticket({
      lane: 'needs-human',
      phase: 'review',
      labels: ['pipenzo:needs-human', 'pipenzo:merge-conflict'] as PipenzoLabelV1[],
    });
    expect(statusOf(t, 'review')).toBe('done');
    expect(statusOf(t, 'publish')).toBe('fail');
  });

  it('appends a CI step, status fail, only when the ticket actually carries pipenzo:ci-failed', () => {
    const clean = ticket({ lane: 'ready-for-review', phase: 'review', labels: ['pipenzo:ready-for-review'] });
    expect(ticketPhaseSteps(clean).steps.find((s) => s.id === 'ci')).toBeUndefined();

    const failed = ticket({
      lane: 'ready-for-review',
      phase: 'review',
      labels: ['pipenzo:ready-for-review', 'pipenzo:ci-failed'] as PipenzoLabelV1[],
    });
    const { steps, hint } = ticketPhaseSteps(failed);
    const ci = steps.find((s) => s.id === 'ci');
    expect(ci?.status).toBe('fail');
    expect(steps).toHaveLength(6);
    // The fix has already committed (lane is back to ready-for-review) -- README's ci-failed row:
    // waiting on the push gate again, not stuck in Needs-human.
    expect(statusOf(failed, 'publish')).toBe('await');
    expect(hint?.text).toBe('Fix ready — at the push gate');
  });

  it('reports CI failed and unaddressed while the ticket still sits in Needs-human', () => {
    const t = ticket({
      lane: 'needs-human',
      phase: 'review',
      labels: ['pipenzo:needs-human', 'pipenzo:ci-failed'] as PipenzoLabelV1[],
    });
    expect(ticketPhaseSteps(t).hint?.text).toBe('CI failed — needs a human');
  });

  it('reports an interrupted daemon as a hint distinct from a generic park', () => {
    const t = ticket({
      lane: 'needs-human',
      phase: 'implement',
      labels: ['pipenzo:needs-human', 'pipenzo:interrupted'] as PipenzoLabelV1[],
    });
    expect(ticketPhaseSteps(t).hint?.text).toBe('The daemon died mid-run — needs a human');
    expect(statusOf(t, 'implement')).toBe('fail');
  });
});
