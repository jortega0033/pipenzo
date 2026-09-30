import { describe, expect, it } from 'vitest';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import {
  ACTIVITY_FILTER_KEYS,
  ACTIVITY_FILTER_OPTIONS,
  countActivityFilters,
  filterActivityTickets,
  ticketMatchesActivityFilter,
} from '../../src/pipenzo/activity-filters.js';

const REPO = 'jortega0033/pipenzo';

function makeTicket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: '00000000-0000-4000-8000-000000000001',
    repo: REPO,
    issueNumber: 1,
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

describe('ACTIVITY_FILTER_OPTIONS', () => {
  it('lists exactly the five tabs from Activity.dc.html, in canvas order', () => {
    expect(ACTIVITY_FILTER_KEYS).toEqual(['all', 'publish', 'gate', 'risk', 'worktree']);
    expect(ACTIVITY_FILTER_OPTIONS.map((option) => option.label)).toEqual([
      'All',
      'Publishes',
      'Gates',
      'Risk',
      'Worktrees',
    ]);
  });
});

describe('ticketMatchesActivityFilter', () => {
  it('matches every ticket under "all"', () => {
    expect(ticketMatchesActivityFilter(makeTicket(), 'all')).toBe(true);
    expect(ticketMatchesActivityFilter(makeTicket({ labels: [] }), 'all')).toBe(true);
  });

  it('matches "publish" for a merged/closed ticket -- no pipenzo label left', () => {
    const merged = makeTicket({ lane: 'ready-for-review', labels: [] });
    expect(ticketMatchesActivityFilter(merged, 'publish')).toBe(true);
  });

  it('matches "publish" for a post-publish ci-failed or merge-conflict label', () => {
    expect(
      ticketMatchesActivityFilter(makeTicket({ labels: ['pipenzo:ci-failed'] }), 'publish'),
    ).toBe(true);
    expect(
      ticketMatchesActivityFilter(makeTicket({ labels: ['pipenzo:merge-conflict'] }), 'publish'),
    ).toBe(true);
  });

  it('does not match "publish" for a ticket still queued with a live label', () => {
    expect(
      ticketMatchesActivityFilter(makeTicket({ labels: ['pipenzo:queued'] }), 'publish'),
    ).toBe(false);
  });

  it('matches "gate" for ready-for-review (gates passed) and every gate-refusal label', () => {
    expect(
      ticketMatchesActivityFilter(makeTicket({ lane: 'ready-for-review', labels: [] }), 'gate'),
    ).toBe(true);
    expect(
      ticketMatchesActivityFilter(
        makeTicket({ labels: ['pipenzo:needs-pre-scoping'] }),
        'gate',
      ),
    ).toBe(true);
    expect(
      ticketMatchesActivityFilter(
        makeTicket({ labels: ['pipenzo:awaiting-stack-approval'] }),
        'gate',
      ),
    ).toBe(true);
    expect(
      ticketMatchesActivityFilter(makeTicket({ labels: ['pipenzo:needs-human'] }), 'gate'),
    ).toBe(true);
  });

  it('does not match "gate" for a plain queued or working ticket', () => {
    expect(ticketMatchesActivityFilter(makeTicket({ lane: 'queued' }), 'gate')).toBe(false);
    expect(
      ticketMatchesActivityFilter(makeTicket({ lane: 'working', labels: ['pipenzo:working'] }), 'gate'),
    ).toBe(false);
  });

  it('matches "risk" for a positive risk score, an armed promotion, or a mismatched precommit', () => {
    expect(
      ticketMatchesActivityFilter(
        makeTicket({ risk: { score: 4, lastResetAt: '2026-01-01T00:00:00.000Z' } }),
        'risk',
      ),
    ).toBe(true);
    expect(
      ticketMatchesActivityFilter(
        makeTicket({
          risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z', pendingPromotion: true },
        }),
        'risk',
      ),
    ).toBe(true);
    expect(
      ticketMatchesActivityFilter(
        makeTicket({
          precommits: [
            { action: 'edit a file', expect: 'tests pass', ifWrong: 'revert', outcome: 'tests failed', verdict: 'mismatch' },
          ],
        }),
        'risk',
      ),
    ).toBe(true);
  });

  it('does not match "risk" for a zero score, no promotion, and only matched precommits', () => {
    const ticket = makeTicket({
      risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
      precommits: [
        { action: 'edit a file', expect: 'tests pass', ifWrong: 'revert', outcome: 'tests passed', verdict: 'match' },
      ],
    });
    expect(ticketMatchesActivityFilter(ticket, 'risk')).toBe(false);
  });

  it('matches "worktree" only once Implement has provisioned one', () => {
    const withWorktree = makeTicket({
      worktree: { id: '11111111-1111-4111-8111-111111111111', branch: 'pipenzo/issue-1' },
    });
    expect(ticketMatchesActivityFilter(withWorktree, 'worktree')).toBe(true);
    expect(ticketMatchesActivityFilter(makeTicket(), 'worktree')).toBe(false);
  });
});

describe('filterActivityTickets', () => {
  it('returns every ticket, unchanged, for "all"', () => {
    const tickets = [makeTicket({ ticketId: 'a' }), makeTicket({ ticketId: 'b', labels: [] })];
    expect(filterActivityTickets(tickets, 'all')).toEqual(tickets);
  });

  it('narrows to only the tickets a real predicate matches', () => {
    const gateTicket = makeTicket({ ticketId: 'gate', lane: 'ready-for-review', labels: [] });
    const plainTicket = makeTicket({ ticketId: 'plain', lane: 'queued' });
    const filtered = filterActivityTickets([gateTicket, plainTicket], 'gate');
    expect(filtered).toEqual([gateTicket]);
  });
});

describe('countActivityFilters', () => {
  it('counts every tab against the real ticket list, "all" always equal to the true total', () => {
    const tickets = [
      makeTicket({ ticketId: 'merged', lane: 'ready-for-review', labels: [] }), // publish + gate
      makeTicket({
        ticketId: 'risky',
        lane: 'working',
        labels: ['pipenzo:working'],
        risk: { score: 6, lastResetAt: '2026-01-01T00:00:00.000Z' },
      }), // risk
      makeTicket({
        ticketId: 'worktreed',
        lane: 'working',
        labels: ['pipenzo:working'],
        worktree: { id: '22222222-2222-4222-8222-222222222222', branch: 'pipenzo/issue-3' },
      }), // worktree
      makeTicket({ ticketId: 'queued', lane: 'queued' }), // none
    ];

    const counts = countActivityFilters(tickets);

    expect(counts).toEqual({
      all: 4,
      publish: 1,
      gate: 1,
      risk: 1,
      worktree: 1,
    });
    expect(counts.all).toBe(tickets.length);
  });

  it('reports zero for every tab against an empty ticket list', () => {
    expect(countActivityFilters([])).toEqual({
      all: 0,
      publish: 0,
      gate: 0,
      risk: 0,
      worktree: 0,
    });
  });
});
