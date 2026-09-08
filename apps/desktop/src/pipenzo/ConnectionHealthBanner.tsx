import { useCallback, useEffect, useRef, useState } from 'react';
import type { PipenzoGitHubHealthV1 } from '@agent-dock/shared';
import { Banner } from '../components/primitives/Banner.js';
import { Button } from '../components/primitives/Button.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { Notice } from '../components/primitives/Notice.js';
import { formatClockTimeUtc, formatDurationShort } from './connection-health-format.js';
import { useAsyncAction } from './use-async-action.js';

type RetryingHealth = Extract<PipenzoGitHubHealthV1, { state: 'retrying' }>;
type UnreachableHealth = Extract<PipenzoGitHubHealthV1, { state: 'unreachable' }>;

/**
 * The connection-health banner cluster (#70/#71/#72/#73): one banner at a time, in the slot
 * `AppRoot.tsx` already gives `EnvironmentCredentialBanner` (issue #113) — a status banner sits
 * above `<App>` there, with no board of its own to sit on, which is exactly what #227 flagged
 * this cluster needs and #257's transport now supplies real data for.
 *
 * Driven entirely by `PipenzoGitHubHealthV1` (#230) off `usePipenzoGitHubHealth()`. Built
 * incrementally, one state per ticket: #70 adds `retrying`, #71 adds `unreachable`, #72 adds
 * `credential_rejected`, #73 adds the recovery banner, #75 adds the degraded-quota banner. Every
 * other state renders nothing until its own ticket adds a branch here — an unhandled state is
 * silence, not a placeholder banner guessing at copy nobody has written yet.
 */
export function ConnectionHealthBanner({
  health,
  loginName,
  connectedRepoCount,
  onRetryNow,
  onReauthenticate,
}: {
  health: PipenzoGitHubHealthV1 | undefined;
  /**
   * The signed-in GitHub login, for #73's "Signed in again as `<login>`". Optional the same way
   * the action callbacks are: without it, the recovery banner simply omits that clause rather
   * than guessing a name.
   */
  loginName?: string;
  /** How many repos are connected, for #73's "N repos reconnected". */
  connectedRepoCount?: number;
  /**
   * "Retry now" / "Poll now" (#70/#71/#75's shared action, wired to `pollGitHubHealthNow` —
   * issue #257's "poll now" route). Optional so a caller that has not wired it yet still gets a
   * banner, just without the action row's button — the same shape `SyncStatusPill.onRefresh`
   * established for this cluster's sibling.
   */
  onRetryNow?: () => void;
  /**
   * "Re-authenticate" (#72), wired in `AppRoot.tsx` to `disconnectGitHub()`. Async and returning
   * the daemon's own promise, not fire-and-forget: `CredentialRejectedBanner` awaits it to drive
   * a confirm dialog's pending state, the same shape `AccountPanel.tsx`'s "Disconnect GitHub"
   * already established for this exact channel -- see that component's doc comment for why a
   * disconnect reachable mid-run (which this banner is: it renders next to `<App>`, not only on
   * the pre-app gate) needs a confirmation and a re-entrancy guard, not a bare `onClick`.
   */
  onReauthenticate?: () => Promise<void>;
}) {
  const justRecovered = useJustRecovered(health);

  if (health?.state === 'retrying') {
    return <RetryingBanner health={health} onRetryNow={onRetryNow} />;
  }
  if (health?.state === 'unreachable') {
    return <UnreachableBanner health={health} onRetryNow={onRetryNow} />;
  }
  if (health?.state === 'credential_rejected') {
    return <CredentialRejectedBanner onReauthenticate={onReauthenticate} />;
  }
  if (health?.state === 'healthy' && justRecovered.shown) {
    return (
      <RecoveryBanner
        loginName={loginName}
        connectedRepoCount={connectedRepoCount}
        onDismiss={justRecovered.dismiss}
      />
    );
  }
  // Checked last, and only reachable once nothing more urgent already claimed the slot above: a
  // degraded quota reading alongside a failing state does not compete with that state's own
  // banner, and a dismissed-but-still-recovering moment does not get pre-empted by this either.
  if (health?.state === 'healthy' && health.quota?.degraded === true) {
    return <DegradedQuotaBanner onPollNow={onRetryNow} />;
  }
  return null;
}

/** #70's degraded "can't reach GitHub" banner: the plain container, a spinning warn-tinted icon,
 * a live countdown to the next attempt, and the mono "attempt N of M" readout. */
function RetryingBanner({
  health,
  onRetryNow,
}: {
  health: RetryingHealth;
  onRetryNow?: () => void;
}) {
  const remainingMs = useCountdown(health.nextAttemptAt);

  return (
    <Banner
      icon="spinner"
      variant="retrying"
      count={`attempt ${health.attempt} of ${health.maxAttempts}`}
      action={
        onRetryNow && (
          <Button size="sm" variant="ghost" onClick={onRetryNow}>
            Retry now
          </Button>
        )
      }
    >
      Can&apos;t reach GitHub — retrying in <b>{formatDurationShort(remainingMs)}</b>.{' '}
      {health.lastCleanPollAt !== undefined ? (
        <>
          The board is showing the last state that polled cleanly, at{' '}
          {formatClockTimeUtc(health.lastCleanPollAt)}.
        </>
      ) : (
        'The board has not completed a clean poll since this run of failures began.'
      )}
    </Banner>
  );
}

/**
 * #71's blocking "GitHub is unreachable" banner: the retry ladder is exhausted. Tinted (the one
 * place this whole notice family tints a container, per `Banner`'s own `blocking` variant), since
 * the label is the state model — nothing can start, change lane or push until the connection is
 * back, though a running agent keeps working in its own worktree regardless.
 *
 * The backoff readout is a snapshot at render time, not a live countdown like #70's: this state is
 * reached only once the ladder has already given up on a schedule of its own (`nextAttemptAt` is
 * genuinely absent whenever nothing is scheduled — see `pipenzo-health-v1.ts`), and a fresh
 * `health` push naturally re-renders this component whenever the number would meaningfully change.
 * A per-second timer here would tick toward a moment `#71`'s own reference design does not treat
 * as counting down, unlike #70's "retrying in 18s".
 */
function UnreachableBanner({
  health,
  onRetryNow,
}: {
  health: UnreachableHealth;
  onRetryNow?: () => void;
}) {
  const backoffMs =
    health.nextAttemptAt === undefined ? undefined : health.nextAttemptAt - Date.now();

  return (
    <Banner
      icon="x"
      tone="danger"
      variant="blocking"
      count={backoffMs === undefined ? undefined : `backoff ${formatDurationShort(backoffMs)}`}
      action={
        onRetryNow && (
          <Button size="sm" onClick={onRetryNow}>
            Retry now
          </Button>
        )
      }
    >
      <b>GitHub is unreachable.</b> {health.consecutiveFailures} polls failed since{' '}
      {formatClockTimeUtc(health.firstFailureAt)}. Labels are the state model, so nothing can
      start, change lane or push until it is back — running agents keep working in their
      worktrees.
    </Banner>
  );
}

/**
 * #72's blocking "your GitHub sign-in expired" banner: `credential_rejected`, the one health
 * state whose companion fields carry no attempt count and no `nextAttemptAt` at all
 * (`pipenzo-health-v1.ts`) -- because retrying a credential GitHub has already rejected does not
 * fix it. Only a human signing in again does, so unlike #70/#71's "Retry now" this banner's action
 * is `primary`, not the default weight, and there is no count in the `.b-act` row for the same
 * reason: nothing here is a number a user is waiting on.
 *
 * "Re-authenticate" does not open a new in-app sign-in surface of its own. It calls
 * `disconnectGitHub()` (see `AppRoot.tsx`), which forgets the now-useless stored credential and
 * lets the pre-app gate's own `routePipenzoStartup` route back to `ConnectScreen` -- the exact
 * flow that already runs `DeviceCodeStep` (#114) and already handles the daemon restart once a
 * fresh credential is stored. A second, parallel in-app re-auth surface would duplicate a flow
 * this app already gets right rather than reuse it.
 *
 * ## Why this confirms first, and why a ref guards it
 *
 * `AccountPanel.tsx`'s own doc comment says it plainly for its "Disconnect GitHub" button, which
 * calls this exact channel: forgetting the vault's credential restarts the daemon, and that
 * restart deliberately bypasses `killDaemon`'s graceful `sessions.cancelAll` -- on Windows
 * `child.kill()` is `TerminateProcess`, so in-flight sessions die uncancelled. That restart's own
 * comment says the bypass "would not be [acceptable] if this were ever reachable mid-run" and
 * names Settings' button as exactly that case; this banner is the second one. `useAsyncAction`'s
 * `pending` does not close the gap either -- its `callIdRef` only decides which *outcome* commits,
 * not whether a second call starts -- so the `writing` ref below is not belt-and-braces, it is the
 * actual guard, mirroring `AccountPanel.tsx`'s identical one for the identical reason (see #223,
 * the unbounded-restart bug repeating this channel produced once already; the underlying premise
 * that a disconnect is always a pre-app, no-sessions-running action is tracked as #224).
 */
function CredentialRejectedBanner({
  onReauthenticate,
}: {
  onReauthenticate?: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const reauth = useAsyncAction<void>();
  const writing = useRef(false);

  const closeConfirm = useCallback(() => {
    setConfirming(false);
    reauth.reset();
  }, [reauth]);

  const confirm = useCallback(() => {
    if (writing.current || !onReauthenticate) return;
    writing.current = true;
    void reauth.run(onReauthenticate).finally(() => {
      writing.current = false;
    });
  }, [onReauthenticate, reauth]);

  return (
    <>
      <Banner
        icon="warning"
        tone="danger"
        variant="blocking"
        action={
          onReauthenticate && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                reauth.reset();
                setConfirming(true);
              }}
            >
              Re-authenticate
            </Button>
          )
        }
      >
        <b>Your GitHub sign-in expired.</b> Pipenzo signs in with device flow and holds the token
        in the Electron-main vault; it was revoked or timed out. Reading issues, writing labels
        and opening pull requests all need it back.
      </Banner>
      <Dialog
        open={confirming}
        // Refused while the disconnect is on the wire, same as AccountPanel's: the daemon is being
        // restarted underneath this window, and a dialog that vanishes mid-restart reads as "it
        // finished" when nothing has yet.
        onClose={() => {
          if (!reauth.pending) closeConfirm();
        }}
        title="Re-authenticate with GitHub?"
        subtitle="This clears the stored token and restarts the daemon, then opens the sign-in flow again."
        width={520}
        actions={
          <>
            <Button onClick={closeConfirm} disabled={reauth.pending}>
              Not now
            </Button>
            <Button variant="primary" pending={reauth.pending} onClick={confirm}>
              {reauth.pending ? 'Restarting…' : 'Re-authenticate'}
            </Button>
          </>
        }
      >
        <div className="fieldset">
          <p className="set-sub">
            Anything running right now stops without a clean cancel — the daemon is handed its
            credential once, at startup, so signing in again means restarting it, and that restart
            does not wait for work in flight to wind down.
          </p>
          <p className="set-sub">
            Your worktrees, branches and ticket store stay exactly where they are. Signing in
            again is the same device flow as the first time.
          </p>
          {reauth.status === 'error' && (
            <Notice tone="danger" icon="warning" title="Could not restart">
              {reauth.error ?? 'The request failed.'} The rejected credential is still stored.
            </Notice>
          )}
        </div>
      </Dialog>
    </>
  );
}

/**
 * #73's recovery banner: the same slot reporting that the connection came back. Warn-toned, not
 * danger — this is good news, not a status — and dismissible, unlike every other banner in this
 * cluster: those report a live system state with no "acknowledge" gesture that would make sense,
 * where this one reports a single past event and Foundations.dc.html's own note says a blocking
 * state that vanishes silently is its own bug report, so the recovery gets an explicit banner a
 * human clears rather than one that fades on its own.
 *
 * A stated simplification: the design canvas's own example also names how many tickets "parked
 * while the token was gone" came back to Queued. Nothing in this codebase tracks which tickets
 * were affected during an outage window today -- `PipenzoReconciler` does not label or move a
 * ticket while unreachable, only stops reconciling it, so there is no real per-ticket signal here
 * to report without inventing one. `loginName` and `connectedRepoCount` are both real, already-
 * available data (`useGitHubConnection`/`useConnectedRepos`); the ticket clause is left out
 * rather than filled with an invented or approximate number.
 */
function RecoveryBanner({
  loginName,
  connectedRepoCount,
  onDismiss,
}: {
  loginName?: string;
  connectedRepoCount?: number;
  onDismiss: () => void;
}) {
  return (
    <Banner icon="info" tone="warn" onDismiss={onDismiss}>
      {loginName !== undefined ? (
        <>
          Signed in again as <b>{loginName}</b>
        </>
      ) : (
        'Signed in again'
      )}
      {connectedRepoCount !== undefined && (
        <>
          {' '}
          · {connectedRepoCount} {connectedRepoCount === 1 ? 'repo' : 'repos'} reconnected
        </>
      )}
      .
    </Banner>
  );
}

/**
 * #75's degraded-quota banner: below `DEGRADED_QUOTA_FRACTION` (`pipenzo-reconciler.ts`) remaining
 * GitHub rate limit, the reconciler has already widened its own poll interval -- this banner just
 * says so. Warn-toned, not danger, and the default (non-blocking) variant: the connection is fine
 * and every ticket still runs, only slower. `quota.degraded` is read directly off the wire rather
 * than re-derived from `remainingFraction` here, for the reason `pipenzo-health-v1.ts` carries the
 * flag in the first place -- the reconciler owns the threshold because it owns the interval, and a
 * second place recomputing "degraded" from the fraction is a second place free to disagree with it.
 */
function DegradedQuotaBanner({ onPollNow }: { onPollNow?: () => void }) {
  return (
    <Banner
      icon="warning"
      tone="warn"
      action={
        onPollNow && (
          <Button size="sm" variant="ghost" onClick={onPollNow}>
            Poll now
          </Button>
        )
      }
    >
      Below <b>15%</b> of this hour&apos;s GitHub rate limit. Poll intervals have widened and the
      board reads &quot;syncing slowly&quot; — degraded, not failed.
    </Banner>
  );
}

/**
 * Tracks the one transition #73 cares about: a failing state (`retrying`, `unreachable`,
 * `credential_rejected`) followed by `healthy`. `shown` stays true across re-renders once that
 * transition is observed -- surviving the health stream's own later `healthy` republishes, which
 * happen on every clean poll -- until either `dismiss()` is called or a *new* failure interrupts
 * it, which cancels the stale recovery notice rather than leaving it to read as current.
 *
 * Deliberately not derived from `health` alone: "just recovered" is a fact about a transition,
 * which no single snapshot can carry, so this is the one piece of state in the whole cluster that
 * has to live in a ref/state pair rather than be computed straight from the latest `health` value.
 */
function useJustRecovered(health: PipenzoGitHubHealthV1 | undefined): {
  shown: boolean;
  dismiss: () => void;
} {
  const previousState = useRef<PipenzoGitHubHealthV1['state'] | undefined>(undefined);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const previous = previousState.current;
    const wasFailing =
      previous === 'retrying' || previous === 'unreachable' || previous === 'credential_rejected';
    if (health?.state === 'healthy' && wasFailing) {
      setShown(true);
    } else if (health !== undefined && health.state !== 'healthy') {
      // A fresh failure means the earlier recovery is no longer today's news.
      setShown(false);
    }
    previousState.current = health?.state;
  }, [health]);

  const dismiss = useCallback(() => setShown(false), []);
  return { shown, dismiss };
}

/**
 * Live milliseconds remaining until `targetEpochMs`, re-rendering once a second while it is still
 * in the future so the banner's countdown actually counts down rather than reading a number frozen
 * at mount time. Stops ticking (and stops re-rendering) once the target has passed — the reconciler
 * publishes a fresh `health` with a new `nextAttemptAt` for the next attempt anyway, so there is
 * nothing useful left for this timer to do once it hits zero.
 */
function useCountdown(targetEpochMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const start = Date.now();
    setNow(start);
    if (targetEpochMs - start <= 0) return;
    // Clears itself from inside the tick, not just on unmount/re-target: without this, once the
    // countdown reaches zero the interval keeps firing once a second for as long as `health` goes
    // unchanged (up to `MAX_POLL_BACKOFF_MS` -- 15 minutes -- on the reconciler's own ladder),
    // which is exactly the silent-forever-ticking bug this comment used to just assert didn't
    // happen.
    const interval = setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      if (tick >= targetEpochMs) clearInterval(interval);
    }, 1_000);
    return () => clearInterval(interval);
  }, [targetEpochMs]);

  return Math.max(0, targetEpochMs - now);
}
