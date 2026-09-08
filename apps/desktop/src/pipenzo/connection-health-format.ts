/**
 * Small, deterministic time formatters for the connection-health banners (#70/#71/#72/#73).
 *
 * Kept pure and separate from the components so the countdown/backoff/clock-time math is testable
 * on its own, without mounting React or faking a component's internal timers.
 */

/**
 * "18s" under a minute, "8m" at or above it — matches `Foundations.dc.html`'s own examples
 * ("retrying in 18s", "backoff 8m"). Never negative: a duration that has already elapsed reads as
 * "0s" rather than counting past zero.
 */
export function formatDurationShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.round(totalSeconds / 60)}m`;
}

/**
 * "14:02" — 24-hour clock time, fixed to UTC rather than the system's local zone.
 *
 * A stated simplification rather than a hidden one: the canvas's own examples are bare HH:MM with
 * no timezone marker, and rendering in the viewer's local zone would make this function's output
 * depend on where the desktop happens to be running — which is exactly what made pinning it worth
 * doing for tests that must produce the same string on any CI runner's timezone. A future ticket
 * can switch to local time once there is a reason to.
 */
export function formatClockTimeUtc(epochMs: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(epochMs));
}
