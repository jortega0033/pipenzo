import type { PipenzoPublishResultV1, PipenzoPullRequestInputV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Button } from '../components/primitives/Button.js';
import { useAsyncAction } from './use-async-action.js';

/**
 * DiffReview's three head actions (issues #69, #106, #112): Discard branch / Push branch / Push &
 * open PR, from DiffReview.dc.html's `.actions` row. Push branch and Push & open PR are the
 * canonical example issue #69 (pending-button wiring) is written against -- each is its own
 * `useAsyncAction`, so pushing does not disable "Push & open PR" or vice versa, and each holds
 * `.btn.pending` from the click until the daemon has genuinely confirmed a pushed commit (and, for
 * the PR button, an opened pull request) -- never a fixed-duration spinner. A failed publish
 * leaves the branch exactly as it was (`publish-service.ts` never leaves partial state on a thrown
 * error), so failure renders the same button re-labelled "Retry" rather than a reset form.
 *
 * This is the ONLY component in the desktop app that may call `getBridge().publishPipenzo(...)` --
 * and only from this button's own `onClick`, i.e. in direct response to the human click the
 * daemon-side publish gate requires (CLAUDE.md hard rule #1). Nothing here is reachable from an
 * agent session.
 */
export function PublishActions({
  worktreeId,
  branch,
  remote,
  pullRequest,
  onDiscardClick,
  discardDisabled = false,
  onPushed,
  onPullRequestOpened,
}: {
  worktreeId: string;
  branch: string;
  remote?: string;
  /** Required to enable "Push & open PR" -- see `buildPullRequestBody` (issue #111) for how the
   * title/body are assembled from the review report. */
  pullRequest?: PipenzoPullRequestInputV1;
  /** Opens the discard confirmation (ticket #112 owns the confirm dialog + the actual cleanup
   * call). Omit to hide the button entirely. */
  onDiscardClick?: () => void;
  discardDisabled?: boolean;
  onPushed?: (result: PipenzoPublishResultV1) => void;
  onPullRequestOpened?: (result: PipenzoPublishResultV1) => void;
}) {
  const push = useAsyncAction<PipenzoPublishResultV1>();
  const openPr = useAsyncAction<PipenzoPublishResultV1>();

  const runPush = () =>
    void push
      .run(() => getBridge().publishPipenzo({ worktreeId, branch, remote, operation: 'push' }))
      .then((result) => result && onPushed?.(result));

  const runOpenPr = () =>
    void openPr
      .run(() =>
        getBridge().publishPipenzo({
          worktreeId,
          branch,
          remote,
          operation: 'push_and_open_pull_request',
          pullRequest,
        }),
      )
      .then((result) => result && onPullRequestOpened?.(result));

  return (
    <div className="actions">
      {onDiscardClick && (
        <Button variant="danger" onClick={onDiscardClick} disabled={discardDisabled}>
          Discard branch
        </Button>
      )}
      <div className="stack">
        <Button
          icon="git-branch"
          pending={push.pending}
          onClick={push.status === 'error' ? () => void push.retry() : runPush}
        >
          {push.pending ? 'Pushing…' : push.status === 'error' ? 'Retry push' : 'Push branch'}
        </Button>
        {push.status === 'error' && push.error && (
          <span className="f-err" role="alert">
            {push.error}
          </span>
        )}
      </div>
      <div className="stack">
        <Button
          variant="primary"
          icon="git-pull-request"
          disabled={!pullRequest}
          pending={openPr.pending}
          onClick={openPr.status === 'error' ? () => void openPr.retry() : runOpenPr}
        >
          {openPr.pending
            ? 'Opening PR…'
            : openPr.status === 'error'
              ? 'Retry push & open PR'
              : 'Push & open PR'}
        </Button>
        {openPr.status === 'error' && openPr.error && (
          <span className="f-err" role="alert">
            {openPr.error}
          </span>
        )}
      </div>
    </div>
  );
}
