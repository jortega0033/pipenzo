import { describe, expect, it } from 'vitest';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import {
  filterReposForPalette,
  filterTicketsForPalette,
  paletteLaneTitle,
  paletteLaneTone,
  paletteTicketLabel,
} from '../../src/pipenzo/command-palette-data.js';

function makeTicket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: '00000000-0000-4000-8000-000000000001',
    repo: 'jortega0033/pipenzo',
    issueNumber: 85,
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

describe('paletteTicketLabel', () => {
  it('uses the cached title when there is one', () => {
    expect(paletteTicketLabel({ title: 'Batch tray badge updates', issueNumber: 85 })).toBe(
      'Batch tray badge updates',
    );
  });

  it('falls back to "Issue #N" with no cached title, matching the board card', () => {
    expect(paletteTicketLabel({ title: undefined, issueNumber: 94 })).toBe('Issue #94');
  });
});

describe('paletteLaneTitle / paletteLaneTone', () => {
  it('has a title and a tone for every board lane', () => {
    expect(paletteLaneTitle('queued')).toBe('Queued');
    expect(paletteLaneTitle('working')).toBe('Working');
    expect(paletteLaneTitle('ready-for-review')).toBe('Ready for review');
    expect(paletteLaneTitle('needs-human')).toBe('Needs human');

    expect(paletteLaneTone('queued')).toBe('neutral');
    expect(paletteLaneTone('working')).toBe('warn');
    expect(paletteLaneTone('ready-for-review')).toBe('ok');
    expect(paletteLaneTone('needs-human')).toBe('danger');
  });
});

describe('filterTicketsForPalette', () => {
  const tickets = [
    makeTicket({ ticketId: 'a', issueNumber: 85, title: 'Batch tray badge updates' }),
    makeTicket({ ticketId: 'b', issueNumber: 94, title: 'Sanitize environment' }),
    makeTicket({ ticketId: 'c', issueNumber: 188, title: undefined }),
  ];

  it('returns everything (capped) for an empty query', () => {
    expect(filterTicketsForPalette(tickets, '')).toEqual(tickets);
  });

  it('matches a bare issue number', () => {
    expect(filterTicketsForPalette(tickets, '94').map((t) => t.ticketId)).toEqual(['b']);
  });

  it('matches an issue number with a leading #', () => {
    expect(filterTicketsForPalette(tickets, '#85').map((t) => t.ticketId)).toEqual(['a']);
  });

  it('matches a title substring, case-insensitively', () => {
    expect(filterTicketsForPalette(tickets, 'SANITIZE').map((t) => t.ticketId)).toEqual(['b']);
  });

  it('matches the "Issue #N" fallback label for a ticket with no cached title', () => {
    expect(filterTicketsForPalette(tickets, 'issue #188').map((t) => t.ticketId)).toEqual(['c']);
  });

  it('returns nothing for a query that matches no ticket', () => {
    expect(filterTicketsForPalette(tickets, 'does-not-exist')).toEqual([]);
  });

  it('caps results at the given limit', () => {
    expect(filterTicketsForPalette(tickets, '', 2)).toHaveLength(2);
  });
});

describe('filterReposForPalette', () => {
  const repos = ['jortega0033/pipenzo', 'jortega0033/agentdock', 'octocat/hello-world'];

  it('returns everything (capped) for an empty query', () => {
    expect(filterReposForPalette(repos, '')).toEqual(repos);
  });

  it('matches a case-insensitive substring of the full owner/name', () => {
    expect(filterReposForPalette(repos, 'PIPENZO')).toEqual(['jortega0033/pipenzo']);
  });

  it('matches on the owner alone', () => {
    expect(filterReposForPalette(repos, 'jortega0033')).toEqual([
      'jortega0033/pipenzo',
      'jortega0033/agentdock',
    ]);
  });

  it('returns nothing for a query that matches no repo', () => {
    expect(filterReposForPalette(repos, 'does-not-exist')).toEqual([]);
  });

  it('caps results at the given limit', () => {
    expect(filterReposForPalette(repos, '', 1)).toHaveLength(1);
  });
});
