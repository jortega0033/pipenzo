import { describe, expect, it } from 'vitest';
import type { PipenzoRepoV1 } from '@agent-dock/shared';
import {
  connectCtaLabel,
  filterRepos,
  isSelectable,
  relativeTime,
  repoMonogram,
  selectableSelection,
  selectionSummary,
  splitFullName,
} from '../../src/pipenzo/repo-picker.js';

const repo = (fullName: string, overrides: Partial<PipenzoRepoV1> = {}): PipenzoRepoV1 => ({
  fullName,
  archived: false,
  defaultBranch: 'main',
  openIssues: 0,
  ...overrides,
});

describe('splitFullName', () => {
  it('splits owner from name', () => {
    expect(splitFullName('octocat/hello-world')).toEqual({ owner: 'octocat', name: 'hello-world' });
  });

  /** The wire schema forbids it, but a renderer that crashes on bad data is worse than one that does not. */
  it('survives a value with no slash', () => {
    expect(splitFullName('hello-world')).toEqual({ owner: '', name: 'hello-world' });
  });
});

describe('repoMonogram', () => {
  /**
   * From the *name*, not the owner. A picker is overwhelmingly one account's repositories, so an
   * owner-derived monogram would print the same two letters on every row.
   */
  it('takes two letters from the repository name', () => {
    expect(repoMonogram('jortega0033/agentdock')).toBe('ag');
    expect(repoMonogram('octocat/Hello-World')).toBe('he');
  });

  it('skips punctuation rather than rendering it', () => {
    // `.github` would otherwise render as a lone dot in a 28px circle.
    expect(repoMonogram('octocat/.github')).toBe('gi');
    expect(repoMonogram('octocat/_')).toBe('??');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-01-10T00:00:00.000Z');

  it('is coarse, because it is a scanning aid rather than a timestamp', () => {
    expect(relativeTime('2026-01-09T22:00:00.000Z', now)).toBe('2h ago');
    expect(relativeTime('2026-01-09T23:58:00.000Z', now)).toBe('2m ago');
    expect(relativeTime('2026-01-07T00:00:00.000Z', now)).toBe('3d ago');
    expect(relativeTime('2025-12-13T00:00:00.000Z', now)).toBe('4w ago');
    expect(relativeTime('2024-01-10T00:00:00.000Z', now)).toBe('2y ago');
  });

  /** Anything under a minute would otherwise re-render every second for a decision nobody makes. */
  it('says "just now" rather than counting seconds', () => {
    expect(relativeTime('2026-01-09T23:59:30.000Z', now)).toBe('just now');
  });

  it('answers nothing for a value it cannot parse, rather than "NaN ago"', () => {
    expect(relativeTime('not a date', now)).toBe('');
  });
});

describe('filterRepos', () => {
  const repositories = [
    repo('octocat/hello-world'),
    repo('octocat/Spoon-Knife'),
    repo('jortega0033/pipenzo'),
  ];

  it('matches case-insensitively across the whole owner/name', () => {
    expect(filterRepos(repositories, 'SPOON').map((r) => r.fullName)).toEqual([
      'octocat/Spoon-Knife',
    ]);
    // A partial owner works, which is what makes one box enough for both halves.
    expect(filterRepos(repositories, 'jorte')).toHaveLength(1);
  });

  it('treats a blank or whitespace query as no filter', () => {
    expect(filterRepos(repositories, '')).toHaveLength(3);
    // A trailing space from a paste must not empty the list.
    expect(filterRepos(repositories, '  ')).toHaveLength(3);
    expect(filterRepos(repositories, ' pipenzo ')).toHaveLength(1);
  });
});

describe('the counting copy', () => {
  /** The canvas's exact wording, including that zero is a plain plural rather than a special case. */
  it('pluralises the selection summary', () => {
    expect(selectionSummary(0)).toBe('0 repos selected');
    expect(selectionSummary(1)).toBe('1 repo selected');
    expect(selectionSummary(7)).toBe('7 repos selected');
  });

  it('pluralises the CTA', () => {
    expect(connectCtaLabel(1)).toBe('Connect 1 repo');
    expect(connectCtaLabel(3)).toBe('Connect 3 repos');
  });
});

describe('selectability', () => {
  /**
   * The ticket's actual acceptance criterion: *archived repos listed but never selectable*. No
   * pull request can be opened against an archived repository, and Pipenzo needs write access to
   * manage one at all.
   */
  it('refuses an archived repository', () => {
    expect(isSelectable(repo('octocat/live'))).toBe(true);
    expect(isSelectable(repo('octocat/old', { archived: true }))).toBe(false);
  });

  it('keeps only the selectable repositories that are actually selected', () => {
    const repositories = [
      repo('octocat/a'),
      repo('octocat/b'),
      repo('octocat/archived', { archived: true }),
    ];
    expect(
      selectableSelection(repositories, new Set(['octocat/a', 'octocat/archived'])),
    ).toEqual(['octocat/a']);
  });

  /**
   * The case that motivates applying this at submit rather than only at click: a repository can be
   * archived on GitHub *while* it sits checked in an open picker. A refresh then leaves a checked
   * row that must not be sent, and filtering only in the click handler would send it.
   */
  it('drops a selection that became archived after it was made', () => {
    const selected = new Set(['octocat/a']);
    expect(selectableSelection([repo('octocat/a')], selected)).toEqual(['octocat/a']);
    expect(selectableSelection([repo('octocat/a', { archived: true })], selected)).toEqual([]);
  });

  it('ignores a selected name that is no longer in the listing at all', () => {
    // Access revoked, or the repository deleted. It simply is not offered.
    expect(selectableSelection([repo('octocat/a')], new Set(['octocat/gone']))).toEqual([]);
  });
});
