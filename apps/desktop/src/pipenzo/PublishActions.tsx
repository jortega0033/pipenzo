import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PipenzoPublishResultV1, PipenzoPullRequestInputV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Button } from '../components/primitives/Button.js';
import type { RiskLevel } from '../components/primitives/Chip.js';
import { HighApprovalCard } from '../components/primitives/HighApproval.js';
import { MediumApprovalInline, MediumApprovalResolved } from '../components/primitives/MediumApproval.js';
import { PreCommitment } from '../components/primitives/PreCommitment.js';
import { useAsyncAction } from './use-async-action.js';

/** How often the resolved-line UI re-checks whether Undo is still available (issue #97). Not a
 * countdown -- see `MediumApprovalResolved`'s own doc comment -- just a live poll of a fact
 * (`isUndoSnapshotExpired`'s real `git rev-parse HEAD` comparison) that can change at any moment a
 * commit lands on the branch, so it is re-checked periodically rather than once. */
const MEDIUM_UNDO_POLL_MS = 5_000;

/**
 * The resolved line for a MEDIUM action this screen actually gated end to end (issue #97): a real,
 * live `mediumApprovalStatus` poll drives whether Undo is offered, and a click genuinely calls
 * `undoMediumApproval` (issue #148's filesystem-only restore) rather than anything that pretends to
 * un-push a commit already on the remote -- see this file's own module comment on what Undo
 * honestly means for a push/PR-open action.
 */
function ResolvedMediumLine({
  ticketId,
  snapshotId,
  children,
}: {
  ticketId: string;
  snapshotId: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<'checking' | 'available' | 'unavailable' | 'restored'>(
    'checking',
  );
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      void getBridge()
        .mediumApprovalStatus({ ticketId, snapshotId })
        .then((status) => {
          if (cancelled) return;
          setState(status.available ? 'available' : 'unavailable');
        })
        .catch(() => {
          if (!cancelled) setState('unavailable');
        });
    };
    poll();
    const interval = setInterval(poll, MEDIUM_UNDO_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // `snapshotId` is stable for the lifetime of one resolved action -- a new one only ever arrives
    // by this component remounting under a fresh `key`, never by this effect re-running mid-poll.
  }, [ticketId, snapshotId]);

  const onUndo = () => {
    void getBridge()
      .undoMediumApproval({ ticketId, snapshotId })
      .then((outcome) => {
        if (mountedRef.current) setState(outcome.restored ? 'restored' : 'unavailable');
      })
      .catch(() => {
        if (mountedRef.current) setState('unavailable');
      });
  };

  if (state === 'restored') {
    return (
      <div className="ai-done">
        <span className="grow">
          {children} <b>Restored</b> — the touched files are back to their pre-approval content.
        </span>
      </div>
    );
  }

  // The first status round trip has not landed yet -- rendered as a plain, neutral line rather
  // than routing through `MediumApprovalResolved`'s `available: false` branch, which would
  // otherwise claim "a new commit has landed" before this has actually checked.
  if (state === 'checking') {
    return (
      <div className="ai-done">
        <span className="grow">{children}</span>
      </div>
    );
  }

  return (
    <MediumApprovalResolved undo={state === 'available' ? { available: true, onUndo } : { available: false }}>
      {children}
    </MediumApprovalResolved>
  );
}

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
 *
 * ## The MEDIUM inline approval flow's real daemon wiring (issue #97)
 *
 * `ticketId` is optional and, when given, is what turns the MEDIUM card from a purely local
 * `gating` toggle into the real thing: opening it captures a real pre-action undo snapshot
 * (`captureMediumApproval`, issue #148) over `touchedPaths` *before* the card is even shown --
 * "block run" in practice means the push/PR-open button stays hidden behind the card until a human
 * answers it, and the snapshot this ticket's Undo relies on already exists by the time they do.
 * Allow calls `decideMediumApproval('allow')`, which records the risk-score outcome daemon-side
 * (`recordRiskApprovalOutcome`, deliberately *not* resetting the score for a MEDIUM approval --
 * `risk-score.ts`'s own asymmetric reset rule) and then runs the real push/PR-open exactly as
 * before. Reject calls `decideMediumApproval('reject')` and runs nothing -- the gated action never
 * executes. A caller with no `ticketId` (every existing call site, and `DiffReviewScreen.tsx` until
 * it is threaded one -- see #95's own PR description) gets exactly the pre-#97 behaviour: Allow
 * proceeds, Reject aborts, neither call touches the daemon's risk store.
 *
 * A resolved MEDIUM push/PR-open renders `ResolvedMediumLine` instead of reverting to the plain
 * button row, with a real, live `mediumApprovalStatus` poll driving whether Undo is offered --
 * never a fake countdown (`undo-snapshot.ts`'s own doc comment: expiry is "has a commit landed on
 * this branch", not a timer). What Undo actually restores for *this* call site is worth being
 * honest about: a push does not itself rewrite any local file, so `touchedPaths` here is the
 * diff's own already-committed files, and Undo restores their local content -- it does not, and
 * cannot, un-push a commit already on the remote or close an opened pull request.
 */
export function PublishActions({
  worktreeId,
  branch,
  remote,
  pullRequest,
  risk,
  ticketId,
  touchedPaths = [],
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
  /** The ticket this diff belongs to (issue #97's own daemon wiring -- see the module comment
   * above). Optional: omitting it keeps the MEDIUM card's pre-#97 behaviour exactly, with no
   * `captureMediumApproval`/`decideMediumApproval` calls at all. */
  ticketId?: string;
  /** The diff's own touched files, relative to the worktree root -- `captureMediumApproval`'s
   * pre-action snapshot input. Ignored when `ticketId` is absent. */
  touchedPaths?: readonly string[];
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
  // The in-flight (or already-settled) `captureMediumApproval` call per gated kind, resolving to
  // `undefined` on failure or when `ticketId` is absent -- a `ref`, not state, specifically so
  // `allowMedium`/`rejectMedium` can `await` it directly rather than racing a human's click against
  // this component's own re-render. A snapshot id landing in state (for `ResolvedMediumLine`'s
  // props) is a *consequence* of this promise settling, not the source of truth for it.
  const captureRef = useRef<{ push?: Promise<string | undefined>; open_pr?: Promise<string | undefined> }>({});
  const [reason, setReason] = useState<{ push?: string; open_pr?: string }>({});
  // The snapshot id for an action this screen actually allowed and ran -- renders
  // `ResolvedMediumLine` in place of the plain button row for that kind, for the rest of this
  // component's life (there is no "un-resolve").
  const [resolved, setResolved] = useState<{ push?: string; open_pr?: string }>({});

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

  /**
   * Opens the MEDIUM card for `kind` and, when `ticketId` is given, starts its real pre-action undo
   * snapshot capture (issue #97/#148) -- the card renders immediately rather than waiting on that
   * round trip, since the pre-commitment/reason UI does not depend on it. `allowMedium`/
   * `rejectMedium` `await captureRef.current[kind]` themselves before deciding, so a human clicking
   * Allow/Reject faster than one local `git rev-parse` round trip can never race ahead of it.
   */
  const openMediumGate = (kind: 'push' | 'open_pr') => {
    setGating(kind);
    captureRef.current[kind] = ticketId
      ? getBridge()
          .captureMediumApproval({ ticketId, worktreeId, branch, touchedPaths: [...touchedPaths] })
          .then(({ snapshotId }) => snapshotId)
          .catch(() => undefined)
      : Promise.resolve(undefined);
  };

  const clickPush = () => {
    if (push.status === 'error') return void push.retry();
    if (risk === 'high') return setGating('push');
    if (risk === 'medium') return openMediumGate('push');
    runPush();
  };

  const clickOpenPr = () => {
    if (openPr.status === 'error') return void openPr.retry();
    if (risk === 'high') return setGating('open_pr');
    if (risk === 'medium') return openMediumGate('open_pr');
    runOpenPr();
  };

  /** A human clicked Allow on `kind`'s MEDIUM card. Awaits the real capture, records the real
   * approval outcome (when one was really captured against a ticket), then runs the action
   * regardless of whether that recording succeeded -- the human already made the one decision this
   * gate exists for, and a risk-score bookkeeping failure is not a reason to silently swallow their
   * Allow. */
  const allowMedium = (kind: 'push' | 'open_pr') => {
    const reasonText = reason[kind];
    setGating(null);
    setReason((s) => ({ ...s, [kind]: undefined }));
    void (captureRef.current[kind] ?? Promise.resolve(undefined))
      .then((id) => {
        if (!ticketId || !id) return;
        return getBridge()
          .decideMediumApproval({ ticketId, snapshotId: id, decision: 'allow', reason: reasonText })
          .then(
            () => setResolved((s) => ({ ...s, [kind]: id })),
            // Recording the outcome failed -- still resolve locally so `ResolvedMediumLine` offers
            // Undo, which only needs the daemon's already-captured snapshot, not this call having
            // succeeded.
            () => setResolved((s) => ({ ...s, [kind]: id })),
          );
      })
      .finally(() => (kind === 'push' ? runPush() : runOpenPr()));
  };

  /** A human clicked Reject on `kind`'s MEDIUM card. The gated action never runs -- there is no
   * code path from here to `runPush`/`runOpenPr`. */
  const rejectMedium = (kind: 'push' | 'open_pr') => {
    const reasonText = reason[kind];
    setGating(null);
    setReason((s) => ({ ...s, [kind]: undefined }));
    void (captureRef.current[kind] ?? Promise.resolve(undefined)).then((id) => {
      if (!ticketId || !id) return;
      void getBridge()
        .decideMediumApproval({ ticketId, snapshotId: id, decision: 'reject', reason: reasonText })
        .catch(() => {
          // Nothing left to do -- the action already did not run, which is Reject's whole
          // contract; a daemon-side bookkeeping failure here has no user-visible consequence.
        });
    });
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
            reason={reason.push ?? ''}
            onReasonChange={(value) => setReason((s) => ({ ...s, push: value }))}
            onReject={() => rejectMedium('push')}
            onAllow={() => allowMedium('push')}
          />
        ) : resolved.push ? (
          <ResolvedMediumLine ticketId={ticketId!} snapshotId={resolved.push}>
            <b>Allowed</b> — pushed {branch} to {remoteName}.
          </ResolvedMediumLine>
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
            reason={reason.open_pr ?? ''}
            onReasonChange={(value) => setReason((s) => ({ ...s, open_pr: value }))}
            onReject={() => rejectMedium('open_pr')}
            onAllow={() => allowMedium('open_pr')}
          />
        ) : resolved.open_pr ? (
          <ResolvedMediumLine ticketId={ticketId!} snapshotId={resolved.open_pr}>
            <b>Allowed</b> — pushed {branch} and opened a pull request.
          </ResolvedMediumLine>
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
