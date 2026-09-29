import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import type { WorkspaceSwitcherRepo } from '../components/primitives/WorkspaceSwitcher.js';
import { repoMonogram } from './repo-picker.js';

/**
 * The workspace switcher's own business logic (issue #89): turning the workspace's connected-repos
 * list and the board's real ticket list into what `WorkspaceSwitcher.tsx` renders, and nothing more.
 *
 * `WorkspaceSwitcher.tsx`'s own doc comment says why this lives outside the component: the canvas
 * uses three different tail phrases depending on repo state ("N running", "N needs you", "idle"),
 * and that is a rule, not a rendering -- exactly the reason `repo-picker.ts` already pulled
 * `filterRepos`/`canToggle`/etc. out of `RepoPicker.tsx` rather than inlining them.
 *
 * ## Why there is no `defaultBranch` in the subline
 *
 * `Main.dc.html`'s canvas draws `main · 15 open · 2 running`, branch included. `pipenzo-repos-v1.ts`
 * is explicit about why the connected-repos list itself carries none of that: the branch, like the
 * open-issue count, is a property of the repository *now*, and the only place that is already paid
 * for is `pipenzoListRepos()` -- the full accessible-repository listing, which fans out to as many
 * as fifty GitHub requests. `ConnectedReposPanel.tsx` already refused to pay that price to decorate
 * a *static* list; the switcher is worse, not better, a candidate to pay it, since it renders in the
 * sidebar on every screen rather than behind a single "Settings" click. So the subline here is built
 * from what is already free -- the local ticket store's own lane counts, the same read the board
 * already makes -- and the branch segment is simply not there. A real branch beats a stale or
 * expensive one; a missing one beats both.
 */

export interface RepoTicketCounts {
  /** Every ticket this repo has open, across all four lanes -- not GitHub's own open-issue count,
   * which would count issues Pipenzo was never asked to track. */
  readonly open: number;
  /** Tickets in the Working lane: a phase is actively running. */
  readonly running: number;
  /** Tickets in the Needs-human lane: parked, waiting on a person. */
  readonly needsYou: number;
}

/** Tallies one repo's tickets out of the board's full, multi-repo list. */
export function ticketCountsForRepo(
  repoFullName: string,
  tickets: readonly PipenzoTicketViewV1[],
): RepoTicketCounts {
  let open = 0;
  let running = 0;
  let needsYou = 0;
  for (const ticket of tickets) {
    if (ticket.repo !== repoFullName) continue;
    open += 1;
    if (ticket.lane === 'working') running += 1;
    else if (ticket.lane === 'needs-human') needsYou += 1;
  }
  return { open, running, needsYou };
}

/**
 * `"{open} open · {tail}"`, the tail being whichever of the canvas's three phrases applies.
 *
 * `running` is checked before `needsYou`: an actively running phase is the more current fact about
 * a repo than a ticket parked waiting on a person, and the canvas never shows both tallies in one
 * subline for that reason -- each of its three sample rows carries exactly one tail phrase.
 */
export function repoSubline(counts: RepoTicketCounts): string {
  const tail =
    counts.running > 0
      ? `${counts.running} running`
      : counts.needsYou > 0
        ? `${counts.needsYou} needs you`
        : 'idle';
  return `${counts.open} open · ${tail}`;
}

/** The switcher's own row list, built from the connected-repos list and the board's real tickets --
 * never a mocked or hardcoded count. Order follows `repoFullNames`, which the daemon already
 * de-duplicates and sorts (see `ConnectedReposPanel.tsx`), so this adds no ordering of its own. */
export function buildWorkspaceSwitcherRepos(
  repoFullNames: readonly string[],
  tickets: readonly PipenzoTicketViewV1[],
): WorkspaceSwitcherRepo[] {
  return repoFullNames.map((fullName) => ({
    id: fullName,
    monogram: repoMonogram(fullName),
    name: fullName,
    subline: repoSubline(ticketCountsForRepo(fullName, tickets)),
  }));
}

/**
 * Which repo is active, given what the user last picked (if anything) and the current connected
 * list.
 *
 * `requested` wins when it is still connected -- a user's own choice should not be silently
 * overridden by, say, an unrelated ticket-list refetch. It stops winning the moment the repo it
 * names is no longer connected (removed from Settings, or never valid), at which point the first
 * repo in the list -- alphabetically first, since that is the order the daemon already answers in
 * -- becomes active instead of leaving the switcher pointed at a repo that no longer exists.
 * `undefined` only when nothing is connected at all.
 */
export function resolveActiveRepoId(
  repoFullNames: readonly string[],
  requested: string | undefined,
): string | undefined {
  if (requested !== undefined && repoFullNames.includes(requested)) return requested;
  return repoFullNames[0];
}

/** The footer note under the repo list, singular-aware -- `WorkspaceSwitcher`'s own `manageReposNote`
 * prop takes free-form `ReactNode` rather than deciding this itself (see its doc comment), so it is
 * decided here instead of being written inline at the one call site. */
export function manageReposNote(connectedCount: number): string {
  const subject = connectedCount === 1 ? 'this one is' : `these ${connectedCount} are`;
  const pronoun = connectedCount === 1 ? 'it' : 'one';
  return (
    `Only ${subject} polled. Adding or removing ${pronoun} opens the same searchable picker as ` +
    'first-run, in Settings.'
  );
}
