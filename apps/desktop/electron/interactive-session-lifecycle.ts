import type { AgentEventV2Envelope, AgentSessionV2 } from '@agent-dock/shared';
import { DaemonError, type SessionEventsOptions } from '@agent-dock/client';
import { abortableDelay, isRetryableStreamError } from './stream-relay.js';

const DEFAULT_RECONNECT_DELAY_MS = 250;

export interface InteractiveSessionStreamOptions {
  sessionId: string;
  signal: AbortSignal;
  events: (sessionId: string, options: SessionEventsOptions) => AsyncIterable<AgentEventV2Envelope>;
  snapshot?: (sessionId: string) => Promise<AgentSessionV2>;
  isActive: () => boolean;
  onEvent: (event: AgentEventV2Envelope) => void;
  onReplayGap?: (snapshot: AgentSessionV2) => void;
  onFatal?: (error: unknown) => void;
  onRetry?: (error: unknown, lastEventId: string | undefined) => void;
  reconnectDelayMs?: number;
}

/**
 * Relays one v2 stream and resumes from the last delivered sequence after a connection-local
 * failure (including `stream_overflow`). The daemon's replay window owns deduplication at the
 * cursor boundary; this loop stops only at a terminal event, explicit abort, or inactive session.
 */
export async function relayInteractiveSessionEvents(
  options: InteractiveSessionStreamOptions,
): Promise<void> {
  let lastEventId: string | undefined;

  while (!options.signal.aborted && options.isActive()) {
    try {
      for await (const event of options.events(options.sessionId, {
        signal: options.signal,
        ...(lastEventId === undefined ? {} : { lastEventId }),
      })) {
        lastEventId = String(event.sequence);
        options.onEvent(event);
        if (isTerminalSessionEvent(event)) return;
      }
    } catch (error) {
      if (options.signal.aborted || !options.isActive()) return;
      if (error instanceof DaemonError && error.status === 409 && options.snapshot) {
        try {
          const snapshot = await options.snapshot(options.sessionId);
          if (options.signal.aborted || !options.isActive()) return;
          options.onReplayGap?.(snapshot);
          lastEventId =
            snapshot.earliestSequence === 0 ? undefined : String(snapshot.earliestSequence - 1);
        } catch (snapshotError) {
          if (options.signal.aborted || !options.isActive()) return;
          if (!isRetryableStreamError(snapshotError)) {
            options.onFatal?.(snapshotError);
            return;
          }
          options.onRetry?.(snapshotError, lastEventId);
          await abortableDelay(
            options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
            options.signal,
          );
          continue;
        }
      } else if (!isRetryableStreamError(error)) {
        options.onFatal?.(error);
        return;
      }
      options.onRetry?.(error, lastEventId);
    }

    if (options.signal.aborted || !options.isActive()) return;
    await abortableDelay(options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS, options.signal);
  }
}

export class PendingInteractiveCreates {
  private closing = false;
  /** Issue #296: a *resettable* twin of `closing`, for a daemon restart rather than a real app
   * shutdown -- see `beginPause`'s doc comment for why this cannot just reuse `closing` itself. */
  private paused = false;
  private readonly pending = new Map<Promise<unknown>, AbortController>();

  get isClosing(): boolean {
    return this.closing;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  run<T>(
    start: (signal: AbortSignal) => Promise<T>,
    onResolved: (value: T) => void,
    onResolvedDuringShutdown?: (value: T) => Promise<void> | void,
  ): Promise<T> {
    if (this.closing) return Promise.reject(new Error('application is shutting down'));
    if (this.paused) return Promise.reject(new Error('daemon is restarting'));

    const controller = new AbortController();
    const tracked = Promise.resolve()
      .then(() => start(controller.signal))
      .then(async (value) => {
        if (this.closing || this.paused || controller.signal.aborted) {
          await onResolvedDuringShutdown?.(value);
          throw new Error(this.closing ? 'application is shutting down' : 'daemon is restarting');
        }
        onResolved(value);
        return value;
      })
      .finally(() => {
        this.pending.delete(tracked);
      });
    this.pending.set(tracked, controller);
    return tracked;
  }

  beginShutdown(): void {
    this.closing = true;
    this.abortAllPending('application is shutting down');
  }

  /**
   * Pauses new interactive-session creates and aborts every one already in flight, for the
   * duration of one daemon restart (issue #296) -- `main.ts`'s `restartDaemonForCredentialChange`
   * calls this the same way `killDaemon` calls `beginShutdown`, so a create that lands during the
   * restart's own cancellation window is aborted (or told to abort via
   * `run`'s `onResolvedDuringShutdown`) rather than left running uncancelled against a daemon child
   * that is about to be killed.
   *
   * Deliberately not `beginShutdown` reused for this: `closing` is permanent by design (the app
   * really is going away, and nothing should ever start a session again), while a restart is a
   * *pause* -- the daemon comes back, and interactive session creation has to work normally again
   * once it does. Reusing the one-way latch here would leave creates permanently rejected after the
   * very first credential change for the rest of the running session. `endPause` is the way back.
   */
  beginPause(reason: string): void {
    this.paused = true;
    this.abortAllPending(reason);
  }

  /** Ends a pause begun by `beginPause`. A no-op if nothing is paused (harmless if `killDaemon`'s
   * permanent `beginShutdown` raced this and already covers `run`'s guard via `closing`). */
  endPause(): void {
    this.paused = false;
  }

  private abortAllPending(reason: string): void {
    for (const controller of this.pending.values()) {
      controller.abort(new Error(reason));
    }
  }

  async waitForPending(timeoutMs: number): Promise<boolean> {
    if (this.pending.size === 0) return true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = Promise.allSettled([...this.pending.keys()]).then(() => true);
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return Promise.race([settled, timedOut]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }
}

function isTerminalSessionEvent(event: AgentEventV2Envelope): boolean {
  return (
    event.type === 'session.completed' ||
    event.type === 'session.failed' ||
    event.type === 'session.cancelled' ||
    event.type === 'session.interrupted'
  );
}
