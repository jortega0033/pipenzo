import { useEffect, useState } from 'react';
import type { PipenzoGitHubHealthV1 } from '@agent-dock/shared';
import { Banner } from '../components/primitives/Banner.js';
import { Button } from '../components/primitives/Button.js';
import { formatClockTimeUtc, formatDurationShort } from './connection-health-format.js';

type RetryingHealth = Extract<PipenzoGitHubHealthV1, { state: 'retrying' }>;

/**
 * The connection-health banner cluster (#70/#71/#72/#73): one banner at a time, in the slot
 * `AppRoot.tsx` already gives `EnvironmentCredentialBanner` (issue #113) — a status banner sits
 * above `<App>` there, with no board of its own to sit on, which is exactly what #227 flagged
 * this cluster needs and #257's transport now supplies real data for.
 *
 * Driven entirely by `PipenzoGitHubHealthV1` (#230) off `usePipenzoGitHubHealth()`. Built
 * incrementally, one state per ticket: #70 adds `retrying`. Every other state renders nothing
 * until its own ticket adds a branch here — an unhandled state is silence, not a placeholder
 * banner guessing at copy nobody has written yet.
 */
export function ConnectionHealthBanner({
  health,
  onRetryNow,
}: {
  health: PipenzoGitHubHealthV1 | undefined;
  /**
   * "Retry now" (#70/#71's shared action, wired to `pollGitHubHealthNow` — issue #257's
   * "poll now" route). Optional so a caller that has not wired it yet still gets a banner, just
   * without the action row's button — the same shape `SyncStatusPill.onRefresh` established for
   * this cluster's sibling.
   */
  onRetryNow?: () => void;
}) {
  if (health?.state === 'retrying') {
    return <RetryingBanner health={health} onRetryNow={onRetryNow} />;
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
