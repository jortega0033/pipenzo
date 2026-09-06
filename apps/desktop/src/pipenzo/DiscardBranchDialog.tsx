import { useState } from 'react';
import { getBridge } from '../bridge.js';
import { Button } from '../components/primitives/Button.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { useAsyncAction } from './use-async-action.js';

function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The discard-branch confirmation (issue #112), wired to the daemon's real worktree cleanup route
 * -- `apps/daemon/src/worktree-manager.ts`'s reconciler-owned discard path, needed on day one
 * because a ticket abandoned mid-implement is exactly as real as one that gets pushed.
 *
 * The dirty-worktree case is genuinely two-step, not guessable up front:
 * `WorktreeManager#cleanupLocked` throws the identical `worktree_dirty` code whether the worktree
 * has real tracked changes or only untracked ones (build output, `node_modules`, ...), so there is
 * no way to tell from here which one a click will hit. The flow: try a plain cleanup first; if it
 * comes back `worktree_dirty`, offer the one thing that can legitimately resolve it (deleting
 * untracked files too) as an explicit second confirmation rather than silently retrying; if *that*
 * still comes back `worktree_dirty`, the dirtiness is real tracked-file changes, which is never
 * removable automatically (`worktreeCleanupRequestV2Schema`'s own comment) -- the dialog says so
 * plainly and offers nothing further to click, matching this design system's other fail-closed
 * refusals (`Conflict.tsx`'s "claimed by @someone-else" card has no action either).
 */
export function DiscardBranchDialog({
  open,
  onClose,
  worktreeId,
  branch,
  deleteBranch = true,
  onDiscarded,
}: {
  open: boolean;
  onClose: () => void;
  worktreeId: string;
  branch: string;
  /** Also `git branch -D` the branch after a successful removal. Defaults to true: a discarded
   * ticket's branch is exactly the thing this dialog exists to get rid of. */
  deleteBranch?: boolean;
  onDiscarded?: () => void;
}) {
  const discard = useAsyncAction<void>();
  const [lastErrorCode, setLastErrorCode] = useState<string>();
  const [retriedWithUntracked, setRetriedWithUntracked] = useState(false);

  const attempt = (deleteUntracked: boolean) => {
    setRetriedWithUntracked(deleteUntracked);
    void discard.run(async () => {
      try {
        await getBridge().cleanupWorktree(worktreeId, { deleteUntracked, deleteBranch });
        setLastErrorCode(undefined);
        onDiscarded?.();
      } catch (error) {
        setLastErrorCode(errorCodeOf(error));
        throw error;
      }
    });
  };

  const handleClose = () => {
    discard.reset();
    setLastErrorCode(undefined);
    setRetriedWithUntracked(false);
    onClose();
  };

  const isDirty = discard.status === 'error' && lastErrorCode === 'worktree_dirty';
  const hardRefusal = isDirty && retriedWithUntracked;
  const offerUntrackedRetry = isDirty && !retriedWithUntracked;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Discard branch"
      subtitle={<span className="mono">{branch}</span>}
      actions={
        <>
          <Button onClick={handleClose} disabled={discard.pending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            pending={discard.pending}
            disabled={hardRefusal}
            onClick={() => attempt(offerUntrackedRetry)}
          >
            {discard.pending
              ? 'Discarding…'
              : offerUntrackedRetry
                ? 'Also delete untracked files'
                : 'Discard branch'}
          </Button>
        </>
      }
    >
      <p>
        This deletes the worktree{deleteBranch ? ' and its branch' : ''} for <b>{branch}</b>. This
        cannot be undone.
      </p>
      {discard.status === 'error' && isDirty ? (
        hardRefusal ? (
          <span className="f-err" role="alert">
            This worktree has uncommitted changes to tracked files. Nothing was deleted — commit,
            stash, or discard those changes yourself first.
          </span>
        ) : (
          <span className="f-err" role="alert">
            This worktree has untracked files (build output, dependencies, ...). Discarding it will
            delete those too.
          </span>
        )
      ) : (
        discard.status === 'error' &&
        discard.error && (
          <span className="f-err" role="alert">
            {discard.error}
          </span>
        )
      )}
    </Dialog>
  );
}
