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
 * Whether a repository may be *newly chosen*.
 *
 * One exported predicate rather than an `archived` check written at each place that needs it. The
 * canvas states the reason: no pull request can be opened against an archived repository, and
 * Pipenzo needs write access to manage one at all.
 */
export function isSelectable(repo: PipenzoRepoV1): boolean {
  return !repo.archived;
}

/**
 * Whether a click on this row should do anything.
 *
 * Asymmetric on purpose: an archived repository can never be **ticked**, but one that is already
 * connected can always be **unticked**. Without the second half, a repository archived after it was
 * connected would be permanently stuck in the list with no control anywhere in this screen able to
 * remove it.
 */
export function canToggle(repo: PipenzoRepoV1, checked: boolean): boolean {
  return isSelectable(repo) || checked;
}

/**
 * What a save writes: the selection itself, sorted.
 *
 * This deliberately does **not** filter against the current listing, and that is the whole point.
 * `PUT /repos/connected` replaces the list, so filtering here would silently delete every connected
 * repository that happens to be invisible right now — access revoked, org SSO lapsed, permission
 * dropped to read-only, or simply beyond a truncated page cap. `pipenzo-repos-v1.ts` says in as
 * many words that the connected list has to *survive* a repository temporarily disappearing from
 * the listing, and an earlier draft of this function was exactly the filtered copy it warns
 * against.
 *
 * Removal stays possible because the set is what the user edits: unticking a row removes it here.
 * A row nobody can see is a row nobody unticked, so it is kept.
 */
export function selectionToSave(selected: ReadonlySet<string>): readonly string[] {
  return [...selected].sort((a, b) => a.localeCompare(b));
}

/**
 * The connected repositories this listing does not contain.
 *
 * Surfaced rather than silently carried: "three of your connected repositories are not in this
 * list and are being kept" is a fact the user needs in order to understand a count that does not
 * match the ticked boxes in front of them.
 */
export function unlistedSelection(
  repositories: readonly PipenzoRepoV1[],
  selected: ReadonlySet<string>,
): readonly string[] {
  const listed = new Set(repositories.map((repo) => repo.fullName));
  return [...selected].filter((fullName) => !listed.has(fullName)).sort();
}
