import { describe, expect, it } from 'vitest';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import {
  classifyNeedsHumanCard,
  NEEDS_HUMAN_FAILED_ATTEMPT_THRESHOLD,
} from '../../src/pipenzo/needs-human-card.js';

const REPO = 'jortega0033/pipenzo';

function makeTicket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: '00000000-0000-4000-8000-000000000001',
    repo: REPO,
    issueNumber: 94,
    lane: 'needs-human',
    phase: 'implement',
    labels: ['pipenzo:needs-human'],
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

describe('classifyNeedsHumanCard', () => {
  it('classifies a pipenzo:needs-pre-scoping ticket using the real base estimate', () => {
    const ticket = makeTicket({
      labels: ['pipenzo:needs-pre-scoping'],
      estimate: { lines: 1340, files: 31, layered: false },
    });
    const card = classifyNeedsHumanCard(ticket);
    expect(card.variant).toBe('needs-pre-scoping');
    if (card.variant !== 'needs-pre-scoping') throw new Error('unreachable');
    expect(card.lines).toBe(1340);
    expect(card.files).toBe(31);
    expect(card.layered).toBe(false);
    expect(card.proposedSplit).toBeUndefined();
  });

  it('carries a cached proposedSplit for needs-pre-scoping only when one actually survived', () => {
    const ticket = makeTicket({
      labels: ['pipenzo:needs-pre-scoping'],
      refusal: {
        estimate: { changedLines: 1340, filesTouched: 31, layered: false },
        proposedSplit: [{ summary: 'Storage interface', changedLines: 90, filesTouched: 4 }],
      },
    });
    const card = classifyNeedsHumanCard(ticket);
    if (card.variant !== 'needs-pre-scoping') throw new Error('unreachable');
    expect(card.proposedSplit).toHaveLength(1);
    expect(card.proposedSplit?.[0]?.summary).toBe('Storage interface');
  });

  it('never fabricates a proposedSplit for a needs-pre-scoping ticket with no cached refusal', () => {
    const ticket = makeTicket({ labels: ['pipenzo:needs-pre-scoping'] });
    const card = classifyNeedsHumanCard(ticket);
    if (card.variant !== 'needs-pre-scoping') throw new Error('unreachable');
    expect(card.proposedSplit).toBeUndefined();
  });

  it('classifies a pipenzo:awaiting-stack-approval ticket, naming the real child count', () => {
    const ticket = makeTicket({
      labels: ['pipenzo:awaiting-stack-approval'],
      estimate: { lines: 212, files: 9, layered: true },
      stack: {
        parentId: null,
        childIds: ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'],
        index: null,
      },
    });
    const card = classifyNeedsHumanCard(ticket);
    expect(card.variant).toBe('awaiting-stack-approval');
    if (card.variant !== 'awaiting-stack-approval') throw new Error('unreachable');
    expect(card.childCount).toBe(2);
    expect(card.lines).toBe(212);
    expect(card.layered).toBe(true);
  });

  it('reports a zero child count for an awaiting-stack-approval ticket with nothing materialized yet', () => {
    const ticket = makeTicket({ labels: ['pipenzo:awaiting-stack-approval'] });
    const card = classifyNeedsHumanCard(ticket);
    if (card.variant !== 'awaiting-stack-approval') throw new Error('unreachable');
    expect(card.childCount).toBe(0);
  });

  it('classifies a pipenzo:interrupted ticket with its real phase and worktree branch', () => {
    const ticket = makeTicket({
      labels: ['pipenzo:interrupted'],
      phase: 'implement',
      worktree: { id: '00000000-0000-4000-8000-000000000004', branch: 'issue-92' },
    });
    const card = classifyNeedsHumanCard(ticket);
    expect(card.variant).toBe('interrupted');
    if (card.variant !== 'interrupted') throw new Error('unreachable');
    expect(card.phase).toBe('implement');
    expect(card.branch).toBe('issue-92');
  });

  it('never fabricates a worktree branch for an interrupted ticket that never provisioned one', () => {
    const ticket = makeTicket({ labels: ['pipenzo:interrupted'], phase: 'refine' });
    const card = classifyNeedsHumanCard(ticket);
    if (card.variant !== 'interrupted') throw new Error('unreachable');
    expect(card.branch).toBeUndefined();
  });

  it('classifies a pipenzo:merge-conflict ticket by label alone', () => {
    const ticket = makeTicket({ labels: ['pipenzo:merge-conflict'] });
    expect(classifyNeedsHumanCard(ticket).variant).toBe('merge-conflict');
  });

  it(`classifies a bare pipenzo:needs-human ticket with ${NEEDS_HUMAN_FAILED_ATTEMPT_THRESHOLD} or more attempts as failed`, () => {
    const ticket = makeTicket({
      labels: ['pipenzo:needs-human'],
      attempts: [
        { sessionId: 's1', tier: 'low', model: 'sonnet', outcome: 'gate_failed' },
        { sessionId: 's2', tier: 'mid', model: 'sonnet', outcome: 'gate_failed' },
        { sessionId: 's3', tier: 'mid', model: 'sonnet', outcome: 'timed_out' },
      ],
    });
    const card = classifyNeedsHumanCard(ticket);
    expect(card.variant).toBe('failed');
    if (card.variant !== 'failed') throw new Error('unreachable');
    expect(card.attemptCount).toBe(3);
    expect(card.last?.outcome).toBe('timed_out');
  });

  it('classifies a bare pipenzo:needs-human ticket with fewer than the threshold as generic', () => {
    const ticket = makeTicket({
      labels: ['pipenzo:needs-human'],
      attempts: [{ sessionId: 's1', tier: 'low', model: 'sonnet', outcome: 'denied' }],
    });
    const card = classifyNeedsHumanCard(ticket);
    expect(card.variant).toBe('generic');
    if (card.variant !== 'generic') throw new Error('unreachable');
    expect(card.attemptCount).toBe(1);
    expect(card.last?.outcome).toBe('denied');
  });

  it('classifies a needs-human ticket with zero attempts as generic, without fabricating a last attempt', () => {
    const ticket = makeTicket({ labels: ['pipenzo:needs-human'], attempts: [] });
    const card = classifyNeedsHumanCard(ticket);
    expect(card.variant).toBe('generic');
    if (card.variant !== 'generic') throw new Error('unreachable');
    expect(card.attemptCount).toBe(0);
    expect(card.last).toBeUndefined();
  });

  it('prioritizes needs-pre-scoping over a bare needs-human label carried alongside it', () => {
    const ticket = makeTicket({ labels: ['pipenzo:needs-human', 'pipenzo:needs-pre-scoping'] });
    expect(classifyNeedsHumanCard(ticket).variant).toBe('needs-pre-scoping');
  });

  it('prioritizes awaiting-stack-approval over interrupted, matching isGenericNeedsHuman\'s own label-check order', () => {
    const ticket = makeTicket({
      labels: ['pipenzo:awaiting-stack-approval', 'pipenzo:interrupted'],
    });
    expect(classifyNeedsHumanCard(ticket).variant).toBe('awaiting-stack-approval');
  });

  it('never returns claim-conflict or plan-review -- no real backend signal exists for either yet', () => {
    // A ticket carrying none of the four specific labels and no attempts is exactly the shape a
    // lost claim race or an unbuilt plan-review gate would produce today: it always falls back to
    // the honest 'generic' park rather than a variant this module cannot back with real data.
    const ticket = makeTicket({ labels: ['pipenzo:needs-human'], attempts: [] });
    const card = classifyNeedsHumanCard(ticket);
    expect(card.variant).not.toBe('claim-conflict');
    expect(card.variant).not.toBe('plan-review');
    expect(card.variant).toBe('generic');
  });
});
