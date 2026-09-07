import { DaemonError, DaemonUnavailableError } from '@agent-dock/client';

/**
 * The two decisions every SSE relay in the main process has to make the same way: whether a failure
 * is worth reconnecting for, and how to wait before doing so.
 *
 * Shared rather than duplicated because the two relays (`interactive-session-lifecycle.ts` for v2
 * session events, `pipenzo-phase-stream.ts` for #189's phase events) are the same loop over
 * different payloads, and a classifier that drifted between them would mean one stream silently
 * retrying an error the other correctly gives up on.
 */

/**
 * Whether reconnecting could plausibly succeed.
 *
 * A daemon that is restarting, a timeout, or an overload are all worth another attempt. A rejected
 * token or a frame that failed schema validation are not: retrying those is an infinite loop that
 * accomplishes nothing, so the caller surfaces them instead. `409` is deliberately absent -- it is
 * recoverable, but only by changing the cursor first, which is the caller's job.
 */
export function isRetryableStreamError(error: unknown): boolean {
  if (error instanceof DaemonUnavailableError) return true;
  return (
    error instanceof DaemonError &&
    (error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500)
  );
}

/** Sleeps, but gives the time back the moment the relay is aborted, so shutdown is not held up. */
export async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener('abort', done, { once: true });

    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
