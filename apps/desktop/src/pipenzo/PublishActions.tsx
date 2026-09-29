import { useState } from 'react';
import type { PipenzoPublishResultV1, PipenzoPullRequestInputV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Button } from '../components/primitives/Button.js';
import type { RiskLevel } from '../components/primitives/Chip.js';
import { HighApprovalCard } from '../components/primitives/HighApproval.js';
import { MediumApprovalInline } from '../components/primitives/MediumApproval.js';
import { PreCommitment } from '../components/primitives/PreCommitment.js';
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
 * and only from this button's own `onClick`, or from an approval card's `onApprove` below (still a
 * direct human click, never an automatic retry -- CLAUDE.md hard rule #4), i.e. in direct response
 * to the human click the daemon-side publish gate requires (CLAUDE.md hard rule #1). Nothing here
 * is reachable from an agent session.
 *
 * ## The `risk` gate (issue #157/#160, CLAUDE.md hard rule #3)
 *
 * `risk` is `ReviewReportV1.risk` (`review-gates.ts`'s real classification of the diff's own
 * touched-file paths -- see that module's doc comment), threaded down through `DiffReviewHead`'s
 * `stat.risk`. HIGH never auto-allows: a HIGH-graded push or PR-open renders `HighApprovalCard`
 * first and only calls the real `publishPipenzo` bridge call from that card's own `onApprove`.
 * MEDIUM renders the lighter `MediumApprovalInline` the same way. LOW (or `risk` absent, matching
 * `DiffReviewStat.risk`'s own "nothing to report" convention) pushes directly, exactly as before
 * this ticket -- an approval step for a diff nothing has flagged would be friction this rule does
 * not ask for.
 */
export function PublishActions({
  worktreeId,
  branch,
  remote,
  pullRequest,
  risk,
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
  /** The diff's publish-gate risk grade (`DiffReviewStat.risk`). Absent has the same meaning it
   * has there: nothing has graded this diff, so neither action is gated. */
  risk?: RiskLevel;
  /** Opens the discard confirmation (ticket #112 owns the confirm dialog + the actual cleanup
   * call). Omit to hide the button entirely. */
  onDiscardClick?: () => void;
  discardDisabled?: boolean;
  onPushed?: (result: PipenzoPublishResultV1) => void;
  onPullRequestOpened?: (result: PipenzoPublishResultV1) => void;
}) {
  const push = useAsyncAction<PipenzoPublishResultV1>();
  const openPr = useAsyncAction<PipenzoPublishResultV1>();
  // Which action's approval card is open, if any -- at most one at a time, matching the canvas's
  // own single-card approval flow. `null` is the ordinary, ungated button row.
  const [gating, setGating] = useState<'push' | 'open_pr' | null>(null);

  const remoteName = remote ?? 'origin';

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

  const clickPush = () => {
    if (push.status === 'error') return void push.retry();
    if (risk === 'high' || risk === 'medium') return setGating('push');
    runPush();
  };

  const clickOpenPr = () => {
    if (openPr.status === 'error') return void openPr.retry();
    if (risk === 'high' || risk === 'medium') return setGating('open_pr');
    runOpenPr();
  };

  // The pre-commitment record (issue #157's own approval cards both require one): what publishing
  // actually promises, in terms `publish-service.ts` genuinely holds -- no force-push, no branch
  // deletion, a rejected non-fast-forward changes nothing (see that module's own `#push` doc
  // comment). Real for either action; the PR-open half of the sentence only applies when gating
  // `open_pr`.
  const precommit = (gatingKind: 'push' | 'open_pr') => (
    <PreCommitment status="pending">
      <PreCommitment.Row k="action">
        Push {branch} to {remoteName}
        {gatingKind === 'open_pr' && pullRequest
          ? `, then open a pull request against ${pullRequest.base ?? 'the default branch'}`
          : ''}
      </PreCommitment.Row>
      <PreCommitment.Row k="expect">
        A fast-forward update on {remoteName}/{branch}, no force-push
      </PreCommitment.Row>
      <PreCommitment.Row k="if_wrong">
        A rejected (non-fast-forward) push changes nothing -- surfaced for a retry, never forced
      </PreCommitment.Row>
    </PreCommitment>
  );

  const command = (gatingKind: 'push' | 'open_pr') =>
    gatingKind === 'open_pr'
      ? `git push ${remoteName} ${branch}\nOpen a pull request: ${branch} → ${pullRequest?.base ?? 'the default branch'}`
      : `git push ${remoteName} ${branch}`;

  return (
    <div className="actions">
      {onDiscardClick && (
        <Button variant="danger" onClick={onDiscardClick} disabled={discardDisabled}>
          Discard branch
        </Button>
      )}
      <div className="stack">
        {gating === 'push' && risk === 'high' ? (
          <HighApprovalCard
            kindLine={`push · publish gate · ${branch} → ${remoteName}`}
            description="This diff touches a security-, auth-, or migration-sensitive path (the risk grade on the diff stat row above). Approving pushes the commit exactly as reviewed -- nothing here re-runs the diff or lets you edit it first."
            command={command('push')}
            precommit={precommit('push')}
            onReject={() => setGating(null)}
            onApprove={() => {
              setGating(null);
              runPush();
            }}
            footNote="No Undo at HIGH · no auto-allow, ever (CLAUDE.md hard rule #3)."
          />
        ) : gating === 'push' && risk === 'medium' ? (
          <MediumApprovalInline
            question={`Push ${branch} to ${remoteName}?`}
            command={command('push')}
            precommit={precommit('push')}
            notificationNote="This diff is graded MEDIUM risk -- review the touched files before allowing."
            onReject={() => setGating(null)}
            onAllow={() => {
              setGating(null);
              runPush();
            }}
          />
        ) : (
          <>
            <Button icon="git-branch" pending={push.pending} onClick={clickPush}>
              {push.pending ? 'Pushing…' : push.status === 'error' ? 'Retry push' : 'Push branch'}
            </Button>
            {push.status === 'error' && push.error && (
              <span className="f-err" role="alert">
                {push.error}
              </span>
            )}
          </>
        )}
      </div>
      <div className="stack">
        {gating === 'open_pr' && risk === 'high' ? (
          <HighApprovalCard
            kindLine={`push & open PR · publish gate · ${branch} → ${pullRequest?.base ?? 'the default branch'}`}
            description="This diff touches a security-, auth-, or migration-sensitive path (the risk grade on the diff stat row above). Approving pushes the commit and opens the pull request exactly as reviewed -- nothing here re-runs the diff or lets you edit it first."
            command={command('open_pr')}
            precommit={precommit('open_pr')}
            onReject={() => setGating(null)}
            onApprove={() => {
              setGating(null);
              runOpenPr();
            }}
            footNote="No Undo at HIGH · no auto-allow, ever (CLAUDE.md hard rule #3)."
          />
        ) : gating === 'open_pr' && risk === 'medium' ? (
          <MediumApprovalInline
            question={`Push ${branch} and open a pull request?`}
            command={command('open_pr')}
            precommit={precommit('open_pr')}
            notificationNote="This diff is graded MEDIUM risk -- review the touched files before allowing."
            onReject={() => setGating(null)}
            onAllow={() => {
              setGating(null);
              runOpenPr();
            }}
          />
        ) : (
          <>
            <Button
              variant="primary"
              icon="git-pull-request"
              disabled={!pullRequest}
              pending={openPr.pending}
              onClick={clickOpenPr}
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
          </>
        )}
      </div>
    </div>
  );
}
