import type { PipenzoRepoV1 } from '@agent-dock/shared';

/**
 * The repo picker's pure parts (issue #115): filtering, the monogram, the relative time, and the
 * two pieces of copy that count things.
 *
 * Separated from the component because each of them is a rule rather than a rendering — "archived
 * repositories can never be selected" is the ticket's actual acceptance criterion, and a rule
 * asserted through a rendered checkbox is a rule that a layout change can quietly break.
 */

/**
 * `owner/name` split for display. Returns the whole string as the name when it does not contain a
 * slash, which the wire schema forbids but which a defensive renderer should not crash on.
 */
export function splitFullName(fullName: string): { owner: string; name: string } {
  const slash = fullName.indexOf('/');
  if (slash < 0) return { owner: '', name: fullName };
  return { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

/**
 * The two-letter monogram in the row's icon well.
 *
 * Taken from the repository name rather than the owner: a picker is overwhelmingly one person's or
 * one org's repositories, so an owner-derived monogram would be the same two letters on every row.
 * Letters and digits only, because a name like `.github` would otherwise render as a lone dot.
 */
export function repoMonogram(fullName: string): string {
  const { name } = splitFullName(fullName);
  const alphanumeric = name.replace(/[^A-Za-z0-9]/g, '');
  return (alphanumeric.slice(0, 2) || '??').toLowerCase();
}

/**
 * "2h ago"-style relative time, matching the canvas's `updated 2h ago`.
 *
 * Coarse on purpose: this is a scanning aid in a list, not a timestamp. Anything under a minute is
 * "just now" rather than a second count that would re-render every second for no decision anyone
 * makes from it.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 53) return `${weeks}w ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * The filter.
 *
 * Case-insensitive substring over the full `owner/name`, and deliberately nothing cleverer. A user
 * typing into this box is looking for a repository they already know the name of, so a fuzzy match
 * that ranked `my-app` below `mailer-approvals` for the query `map` would be actively worse than a
 * substring test. Whitespace-trimmed, so a trailing space from a paste does not empty the list.
 */
export function filterRepos(
  repositories: readonly PipenzoRepoV1[],
  query: string,
): readonly PipenzoRepoV1[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return repositories;
  return repositories.filter((repo) => repo.fullName.toLowerCase().includes(needle));
}

/** `1 repo selected` / `N repos selected`, the canvas's exact wording including the zero case. */
export function selectionSummary(count: number): string {
  return count === 1 ? '1 repo selected' : `${count} repos selected`;
}

/** `Connect 1 repo` / `Connect N repos`, likewise. */
export function connectCtaLabel(count: number): string {
  return count === 1 ? 'Connect 1 repo' : `Connect ${count} repos`;
}

/**
 * Whether a repository may be selected at all.
 *
 * One exported predicate rather than an `archived` check written at each of the three places that
 * needs it — the row's click handler, the row's rendering, and the submit that must not send one.
 * The canvas states the reason: no pull request can be opened against an archived repository, and
 * Pipenzo needs write access to manage one at all.
 */
export function isSelectable(repo: PipenzoRepoV1): boolean {
  return !repo.archived;
}

/**
 * The selection, with anything unselectable removed.
 *
 * Applied at submit as well as at click, because the two are reachable independently: a repository
 * can be archived on GitHub *while* it sits selected in an open picker, and a refresh would then
 * leave a checked row that must not be sent. Filtering only on click would send it.
 */
export function selectableSelection(
  repositories: readonly PipenzoRepoV1[],
  selected: ReadonlySet<string>,
): readonly string[] {
  return repositories
    .filter((repo) => isSelectable(repo) && selected.has(repo.fullName))
    .map((repo) => repo.fullName);
}
