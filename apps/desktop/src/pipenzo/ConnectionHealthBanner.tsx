import { useEffect, useState } from 'react';
import type { PipenzoGitHubHealthV1 } from '@agent-dock/shared';
import { Banner } from '../components/primitives/Banner.js';
import { Button } from '../components/primitives/Button.js';
import { formatClockTimeUtc, formatDurationShort } from './connection-health-format.js';

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
 * `credential_rejected`. Every other state renders nothing until its own ticket adds a branch
 * here — an unhandled state is silence, not a placeholder banner guessing at copy nobody has
 * written yet.
 */
export function ConnectionHealthBanner({
  health,
  onRetryNow,
  onReauthenticate,
}: {
  health: PipenzoGitHubHealthV1 | undefined;
  /**
   * "Retry now" (#70/#71's shared action, wired to `pollGitHubHealthNow` — issue #257's
   * "poll now" route). Optional so a caller that has not wired it yet still gets a banner, just
   * without the action row's button — the same shape `SyncStatusPill.onRefresh` established for
   * this cluster's sibling.
   */
  onRetryNow?: () => void;
  /**
   * "Re-authenticate" (#72). Unlike `onRetryNow`, this one is wired to something real from the
   * start (`AppRoot.tsx` calls `disconnectGitHub()`) rather than shipping decorative, because a
   * revoked credential is not a thing polling harder ever fixes -- only a human signing in again
   * does, and #72's whole point is that this is the one banner offering that as the primary
   * action rather than a status.
   */
  onReauthenticate?: () => void;
}) {
  if (health?.state === 'retrying') {
    return <RetryingBanner health={health} onRetryNow={onRetryNow} />;
  }
  if (health?.state === 'unreachable') {
    return <UnreachableBanner health={health} onRetryNow={onRetryNow} />;
  }
  if (health?.state === 'credential_rejected') {
    return <CredentialRejectedBanner onReauthenticate={onReauthenticate} />;
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
 */
function CredentialRejectedBanner({ onReauthenticate }: { onReauthenticate?: () => void }) {
  return (
    <Banner
      icon="warning"
      tone="danger"
      variant="blocking"
      action={
        onReauthenticate && (
          <Button size="sm" variant="primary" onClick={onReauthenticate}>
            Re-authenticate
          </Button>
        )
      }
    >
      <b>Your GitHub sign-in expired.</b> Pipenzo signs in with device flow and holds the token in
      the Electron-main vault; it was revoked or timed out. Reading issues, writing labels and
      opening pull requests all need it back.
    </Banner>
  );
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
