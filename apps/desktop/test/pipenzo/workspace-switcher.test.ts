import { describe, expect, it } from 'vitest';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import {
  buildWorkspaceSwitcherRepos,
  manageReposNote,
  repoSubline,
  resolveActiveRepoId,
  ticketCountsForRepo,
} from '../../src/pipenzo/workspace-switcher.js';

const ticket = (overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 => ({
  schemaVersion: 1,
  ticketId: '00000000-0000-4000-8000-000000000001',
  repo: 'jortega0033/pipenzo',
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
});

describe('ticketCountsForRepo', () => {
  it('tallies open, running and needs-you separately, ignoring other repos', () => {
    const tickets = [
      ticket({ ticketId: 'a', repo: 'jortega0033/pipenzo', lane: 'queued' }),
      ticket({ ticketId: 'b', repo: 'jortega0033/pipenzo', lane: 'working' }),
      ticket({ ticketId: 'c', repo: 'jortega0033/pipenzo', lane: 'working' }),
      ticket({ ticketId: 'd', repo: 'jortega0033/pipenzo', lane: 'needs-human' }),
      ticket({ ticketId: 'e', repo: 'jortega0033/pipenzo', lane: 'ready-for-review' }),
      // A different repo's tickets must not leak into this repo's tally.
      ticket({ ticketId: 'f', repo: 'octocat/hello-world', lane: 'working' }),
    ];

    expect(ticketCountsForRepo('jortega0033/pipenzo', tickets)).toEqual({
      open: 5,
      running: 2,
      needsYou: 1,
    });
  });

  it('is all zeroes for a repo with no tickets', () => {
    expect(ticketCountsForRepo('jortega0033/pipenzo', [])).toEqual({
      open: 0,
      running: 0,
      needsYou: 0,
    });
  });
});

describe('repoSubline', () => {
  it('reports idle when nothing is running or needs a human', () => {
    expect(repoSubline({ open: 3, running: 0, needsYou: 0 })).toBe('3 open · idle');
  });

  it('reports the running count when something is running', () => {
    expect(repoSubline({ open: 15, running: 2, needsYou: 0 })).toBe('15 open · 2 running');
  });

  it('reports needs-you when nothing is running but something needs a human', () => {
    expect(repoSubline({ open: 5, running: 0, needsYou: 1 })).toBe('5 open · 1 needs you');
  });

  /** The canvas never shows both tallies in one subline -- a running phase is the more current
   * fact, so it wins the tie. */
  it('prefers running over needs-you when both are non-zero', () => {
    expect(repoSubline({ open: 9, running: 1, needsYou: 4 })).toBe('9 open · 1 running');
  });
});

describe('buildWorkspaceSwitcherRepos', () => {
  it('builds one row per connected repo, in list order, with real counts', () => {
    const tickets = [
      ticket({ ticketId: 'a', repo: 'jortega0033/agentdock', lane: 'working' }),
      ticket({ ticketId: 'b', repo: 'jortega0033/agentdock', lane: 'working' }),
      ticket({ ticketId: 'c', repo: 'jortega0033/pipenzo', lane: 'queued' }),
    ];

    const rows = buildWorkspaceSwitcherRepos(
      ['jortega0033/agentdock', 'jortega0033/pipenzo'],
      tickets,
    );

    expect(rows).toEqual([
      {
        id: 'jortega0033/agentdock',
        monogram: 'ag',
        name: 'jortega0033/agentdock',
        subline: '2 open · 2 running',
      },
      {
        id: 'jortega0033/pipenzo',
        monogram: 'pi',
        name: 'jortega0033/pipenzo',
        subline: '1 open · idle',
      },
    ]);
  });

  it('is empty when nothing is connected', () => {
    expect(buildWorkspaceSwitcherRepos([], [])).toEqual([]);
  });
});

describe('resolveActiveRepoId', () => {
  const REPOS = ['jortega0033/agentdock', 'jortega0033/pipenzo'];

  it('keeps the requested repo when it is still connected', () => {
    expect(resolveActiveRepoId(REPOS, 'jortega0033/pipenzo')).toBe('jortega0033/pipenzo');
  });

  it('falls back to the first connected repo when nothing was requested', () => {
    expect(resolveActiveRepoId(REPOS, undefined)).toBe('jortega0033/agentdock');
  });

  it('falls back to the first connected repo when the requested one is no longer connected', () => {
    expect(resolveActiveRepoId(REPOS, 'octocat/hello-world')).toBe('jortega0033/agentdock');
  });

  it('is undefined when nothing is connected at all', () => {
    expect(resolveActiveRepoId([], 'jortega0033/pipenzo')).toBeUndefined();
  });
});

describe('manageReposNote', () => {
  it('uses singular phrasing for exactly one connected repo', () => {
    expect(manageReposNote(1)).toBe(
      'Only this one is polled. Adding or removing it opens the same searchable picker as ' +
        'first-run, in Settings.',
    );
  });

  it('uses plural phrasing, with the count, for more than one', () => {
    expect(manageReposNote(3)).toBe(
      'Only these 3 are polled. Adding or removing one opens the same searchable picker as ' +
        'first-run, in Settings.',
    );
  });
});
