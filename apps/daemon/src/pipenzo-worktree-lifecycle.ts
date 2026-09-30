import type { Logger } from '@agent-dock/agent-runtime';
import type { PipenzoLaneV1, PipenzoTicketWorktreeV1 } from '@agent-dock/shared';
import { WorktreeManagerError } from './worktree-manager.js';
import type { FileTicketStore } from './pipenzo-ticket-store.js';
import { runGitCommand, type PipenzoGitRunner } from './pipenzo-git.js';

/**
 * Terminal-state worktree cleanup (Pipenzo issue #159).
 *
 * `OwnedWorktreeManager.cleanup(id, options)` (`worktree-manager.ts`) is agentdock's own primitive,
 * already fixed to do exactly what this ticket needs at the git level -- an untracked-only worktree
 * is removable with `deleteUntracked`, a successful removal can also `git branch -D` the worktree's
 * branch with `deleteBranch`, and any *tracked* change always refuses with `worktree_dirty`
 * (`jortega0033/agentdock#117`, closed, landed in this repo via #120/#121). Nothing here changes
 * that method. This module is the missing other half: **finding** the worktree a terminal ticket
 * state owns, and **deciding never to force it**.
 *
 * ## Why the ticket record needs a `worktree` field written onto it at all
 *
 * `PipenzoImplementOrchestrator` hands a worktree id back to whoever called `implement()`, and until
 * now nothing persisted it anywhere the daemon could find again without a person re-supplying it
 * (the desktop's own "Discard worktree" dialog holds the id in React state, which is fine for a
 * human-clicked action but useless to code that runs on a polling tick or a label transition with no
 * renderer in the loop). `attachTicketWorktree` is the one write that makes automatic terminal-state
 * cleanup possible at all: `PipenzoPhaseService.implement()` calls it, best-effort, right after a
 * dispatch succeeds.
 *
 * ## Never force anything the caller has not seen
 *
 * `cleanupTerminalWorktree` never passes `deleteUntracked`. An operator-clicked discard is a human
 * looking at a diff and choosing to throw it away; an automatic sweep triggered by a GitHub label or
 * a poll tick is not that, so a worktree that is dirty for *any* reason -- tracked or merely
 * untracked -- is retained and reported, never removed. `deleteBranch: true` is always passed to
 * `cleanup()` too, for whatever caller of the generic worktree API *did* record a branch on the
 * manager's own store.
 *
 * ## Why the branch sweep does not stop at `cleanup()`'s own `deleteBranch`
 *
 * `OwnedWorktreeManager`'s `deleteBranch` deletes the ref its *own* `create()` was told to resolve
 * the worktree's base commit from (`WorktreeCreateRequestV2.ref`) — not a branch created *inside*
 * the worktree afterward. `ImplementOrchestrator.start()` does exactly that: it creates the worktree
 * detached, then runs `git checkout -b <ticket branch>` inside it (`#createBranch`) — a second,
 * later git operation the manager's own record never learns about. So for every worktree Pipenzo's
 * own Implement phase actually creates, the manager's internal `record.branch` is unset and its own
 * `deleteBranch` is a no-op; relying on it alone would satisfy this ticket's wiring on paper while
 * leaving the real ticket branch behind on every run. This module runs the one git command that
 * actually deletes it -- `git branch -D <ticket.worktree.branch>` against the *source* repository,
 * using the same hardened, credential-free environment (`pipenzo-git.ts`) every other daemon-side
 * git call in this repo uses -- scoped to exactly the branch this worktree's own record names, never
 * a caller-supplied one, so it can never reach a branch unrelated to the ticket that owned it. Both
 * deletions are best-effort and swallow their own failure (already deleted, checked out elsewhere,
 * never actually a local branch), the same as `OwnedWorktreeManager.cleanupLocked`'s own.
 *
 * ## What "terminal" means here, honestly
 *
 * Two of the epic's four named terminal states are real, already-modeled transitions this module's
 * callers wire straight into: a ticket's GitHub issue closing (`pipenzo-reconciler.ts`, covering
 * both a PR merge and a manual close-without-merging identically, since either way the worktree's
 * work is done and nothing in this module's job needs to tell them apart) and the phase machine's
 * own `working`/`ready-for-review` -> `queued` move, which its own module doc already names "an
 * abandoned attempt returned to the queue" (`routes/pipenzo-tickets.ts`'s transition route). A third
 * -- "stack child superseded" -- has no design yet to wire to: nothing in this codebase decomposes
 * an oversized ticket into a stack and re-runs that decomposition (`pipenzoTicketStackV1Schema`'s
 * `childIds`/`parentId` exist as a schema, unused by any code path), so there is no event a
 * "superseded" cleanup could trigger on. Left unbuilt rather than invented; see the PR description.
 */

export type PipenzoTicketTerminalReasonV1 = 'issue_closed' | 'abandoned';

/** The slice of `OwnedWorktreeManager` this module uses. */
export interface TerminalWorktreeCleanupPort {
  cleanup(
    id: string,
    options?: { deleteUntracked?: boolean; deleteBranch?: boolean },
  ): Promise<unknown>;
  /**
   * Same slice `OwnedWorktreeLocator`/`ImplementWorktreeManager` already expose elsewhere in this
   * daemon. Read *before* `cleanup()` runs — a worktree the manager has just removed resolves to
   * `undefined` (its status flips to `missing`), so the source path for the branch sweep has to be
   * captured while the worktree is still known-ready.
   */
  ownedLocation(id: string): { sourcePath: string } | undefined;
}

/** Local-only ticket-record access: reads and writes the store directly, never GitHub. */
export type TicketWorktreeStorePort = Pick<FileTicketStore, 'get' | 'update'>;

export type TerminalWorktreeCleanupOutcome =
  /** The ticket carries no worktree (never provisioned, or already cleaned up). Not an error. */
  | { readonly outcome: 'no_worktree' }
  /** Removed, and the ticket record no longer names it. */
  | { readonly outcome: 'cleaned' }
  /** `worktree_dirty`: surfaced, not swallowed, and nothing was deleted. */
  | { readonly outcome: 'retained_dirty' }
  /** Some other `WorktreeManagerError` (locked, already external, not found, …). Also non-fatal to
   *  the caller -- logged here, and the ticket's `worktree` field is left exactly as it was so a
   *  later poll or transition gets another chance. */
  | { readonly outcome: 'cleanup_failed'; readonly error: string };

/**
 * Best-effort: records `worktree` onto a ticket right after Implement provisions one.
 *
 * Mirrors `PipenzoPhaseService`'s existing `#reportRefusal`/`#reportBlownEstimate` shape -- logged
 * and swallowed, never thrown -- for the same reason those are: a dispatch that already started a
 * real session and returned a real worktree id to its caller must not fail *because* a secondary
 * bookkeeping write did. Losing this write only means a later terminal-state sweep has nothing to
 * find for this ticket, which is the same "nothing to clean up yet" state a ticket that never
 * reached Implement is already in -- not data loss, just a missed cleanup.
 */
export function attachTicketWorktree(
  tickets: TicketWorktreeStorePort,
  ticketId: string,
  worktree: PipenzoTicketWorktreeV1,
  logger?: Logger,
): void {
  const ticket = tickets.get(ticketId);
  if (!ticket) {
    logger?.warn('pipenzo: could not attach a worktree to an unknown ticket', { ticketId });
    return;
  }
  try {
    tickets.update(ticketId, { ...ticket, worktree });
  } catch (error) {
    logger?.warn('pipenzo: could not record this ticket’s worktree', {
      ticketId,
      worktreeId: worktree.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * True for exactly the lane move the phase machine's own module doc calls an abandoned attempt:
 * dispatched work (`working`) or a finished attempt awaiting review (`ready-for-review`) sent back
 * to the queue. Every other pair that lands on `queued` -- including `queued` -> `queued` itself --
 * is not this: a ticket that was never dispatched has nothing to abandon.
 */
export function isAbandonedToQueue(previousLane: PipenzoLaneV1, nextLane: PipenzoLaneV1): boolean {
  return nextLane === 'queued' && (previousLane === 'working' || previousLane === 'ready-for-review');
}

/**
 * The one cleanup call every terminal-state caller in this ticket shares.
 *
 * No-ops quietly when the ticket has no recorded worktree -- reached whenever a ticket never got as
 * far as Implement, or a previous call already cleaned it up, and neither is worth a warning. Never
 * raises `deleteUntracked`; see this module's doc comment for why an automated sweep must not.
 */
export async function cleanupTerminalWorktree(options: {
  readonly tickets: TicketWorktreeStorePort;
  readonly worktrees: TerminalWorktreeCleanupPort;
  readonly ticketId: string;
  readonly reason: PipenzoTicketTerminalReasonV1;
  readonly logger?: Logger;
  /** Injection seam for tests. Production always uses `runGitCommand`. */
  readonly runGit?: PipenzoGitRunner;
}): Promise<TerminalWorktreeCleanupOutcome> {
  const { tickets, worktrees, ticketId, reason, logger, runGit = runGitCommand } = options;
  const ticket = tickets.get(ticketId);
  if (!ticket?.worktree) return { outcome: 'no_worktree' };
  const { id: worktreeId, branch } = ticket.worktree;
  // Captured before `cleanup()` runs -- see `TerminalWorktreeCleanupPort.ownedLocation`'s own
  // comment for why the order matters. `undefined` here (an already-orphaned or missing worktree)
  // just means the branch sweep below has nowhere to run; the worktree cleanup call is unaffected.
  const location = worktrees.ownedLocation(worktreeId);

  try {
    await worktrees.cleanup(worktreeId, { deleteBranch: true });
  } catch (error) {
    if (error instanceof WorktreeManagerError && error.code === 'worktree_dirty') {
      logger?.warn('pipenzo: worktree retained after a terminal-state cleanup refusal (dirty)', {
        ticketId,
        worktreeId,
        reason,
      });
      return { outcome: 'retained_dirty' };
    }
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn('pipenzo: terminal-state worktree cleanup failed', {
      ticketId,
      worktreeId,
      reason,
      error: message,
    });
    return { outcome: 'cleanup_failed', error: message };
  }

  // The branch sweep (issue #159): see this module's doc comment for why `cleanup()`'s own
  // `deleteBranch` is not enough on its own for a Pipenzo-created worktree. Best-effort and
  // swallowed the same way `OwnedWorktreeManager.cleanupLocked` swallows its own branch deletion --
  // the worktree is already gone by this point regardless of whether the branch goes with it.
  if (location) {
    await runGit(['branch', '-D', '--', branch], location.sourcePath).catch(() => undefined);
  }

  try {
    const { worktree: _cleaned, ...withoutWorktree } = ticket;
    tickets.update(ticketId, withoutWorktree);
  } catch (error) {
    // The worktree and its branch are already gone at this point -- reporting this as a cleanup
    // failure would send an operator looking for a worktree that no longer exists. Logged so the
    // stale `worktree` field left on the record is at least visible.
    logger?.warn('pipenzo: worktree cleanup succeeded but the ticket record could not be updated', {
      ticketId,
      worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { outcome: 'cleaned' };
}
