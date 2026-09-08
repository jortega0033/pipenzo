import { describe, expect, it } from 'vitest';
import type { PipenzoRepoV1 } from '@agent-dock/shared';
import {
  canToggle,
  connectCtaLabel,
  filterRepos,
  isSelectable,
  relativeTime,
  repoMonogram,
  selectionSummary,
  selectionToSave,
  settingsSaveCtaLabel,
  splitFullName,
  unlistedSelection,
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

  /**
   * Settings (issue #125) reopens the same picker to edit an existing list, where "Connect 2 repos"
   * would describe the wrong half of a press that also *disconnects* whatever was unticked.
   */
  it('says save rather than connect in the Settings framing', () => {
    expect(settingsSaveCtaLabel(1)).toBe('Save 1 repo');
    expect(settingsSaveCtaLabel(3)).toBe('Save 3 repos');
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

  /**
   * Asymmetric, and the second half is the load-bearing one: a repository archived *after* it was
   * connected would otherwise be stuck in the list with no control on this screen able to remove it.
   */
  it('lets an archived row be unticked but never ticked', () => {
    const archived = repo('octocat/old', { archived: true });
    expect(canToggle(archived, false)).toBe(false);
    expect(canToggle(archived, true)).toBe(true);

    const live = repo('octocat/live');
    expect(canToggle(live, false)).toBe(true);
    expect(canToggle(live, true)).toBe(true);
  });
});

describe('selectionToSave', () => {
  it('is the selection itself, sorted and stable', () => {
    expect(selectionToSave(new Set(['octocat/zebra', 'octocat/apple']))).toEqual([
      'octocat/apple',
      'octocat/zebra',
    ]);
  });

  /**
   * The bug the review found, and the reason this function takes no listing at all.
   *
   * The save replaces the whole list, so filtering the selection against the *current* listing
   * silently deletes every connected repository that happens to be invisible right now — access
   * revoked, org SSO lapsed, permission dropped to read-only, or simply beyond a truncated page
   * cap. `pipenzo-repos-v1.ts` says in as many words that the connected list must survive exactly
   * that, and the filtered version was the thing it warns against.
   *
   * Removal still works, because the set is what the user edits: unticking removes it here.
   */
  it('keeps a connected repository that is not in the listing at all', () => {
    expect(selectionToSave(new Set(['octocat/invisible', 'octocat/visible']))).toEqual([
      'octocat/invisible',
      'octocat/visible',
    ]);
  });

  it('drops what the user unticked, because that is what unticking is', () => {
    const selected = new Set(['octocat/a', 'octocat/b']);
    selected.delete('octocat/b');
    expect(selectionToSave(selected)).toEqual(['octocat/a']);
  });
});

describe('unlistedSelection', () => {
  /** So the user can be told *why* the count does not match the ticked boxes in front of them. */
  it('names the connected repositories this listing does not contain', () => {
    const repositories = [repo('octocat/a'), repo('octocat/archived', { archived: true })];
    expect(
      unlistedSelection(repositories, new Set(['octocat/a', 'octocat/archived', 'octocat/gone'])),
    ).toEqual(['octocat/gone']);
  });

  it('is empty when everything selected is on screen', () => {
    expect(unlistedSelection([repo('octocat/a')], new Set(['octocat/a']))).toEqual([]);
  });
});
