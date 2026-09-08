import type { PipenzoGitHubHealthV1 } from '@agent-dock/shared';
import type { PipenzoGitHubHealthEventsOptions } from '@agent-dock/client';
import { abortableDelay, isRetryableStreamError } from './stream-relay.js';

const DEFAULT_RECONNECT_DELAY_MS = 1_000;

export interface PipenzoHealthStreamOptions {
  signal: AbortSignal;
  events: (options: PipenzoGitHubHealthEventsOptions) => AsyncIterable<PipenzoGitHubHealthV1>;
  onEvent: (health: PipenzoGitHubHealthV1) => void;
  onRetry?: (error: unknown) => void;
  /** The stream is over until the app reconnects the client: a token or a frame the loop cannot fix. */
  onFatal?: (error: unknown) => void;
  reconnectDelayMs?: number;
}

/**
 * Relays the daemon's GitHub connection-health stream (#257) to the renderer.
 *
 * Deliberately simpler than `relayPipenzoPhaseEvents`: that relay exists to bridge an ordered,
 * gap-free log across a dropped connection, tracking a cursor and recovering from a bounded-window
 * refusal. Connection health has no such contract to honour -- it is a latest-value snapshot, and
 * the daemon hands a fresh connection the current value the instant it opens (see
 * `apps/daemon/src/routes/pipenzo-health.ts`). So a dropped connection here needs nothing more than
 * "try again": no cursor to carry across the gap, and no `replay_gap` this stream can even receive.
 */
export async function relayPipenzoGitHubHealthEvents(
  options: PipenzoHealthStreamOptions,
): Promise<void> {
  while (!options.signal.aborted) {
    try {
      for await (const health of options.events({ signal: options.signal })) {
        options.onEvent(health);
      }
    } catch (error) {
      if (options.signal.aborted) return;
      if (!isRetryableStreamError(error)) {
        options.onFatal?.(error);
        return;
      }
      options.onRetry?.(error);
    }

    if (options.signal.aborted) return;
    await abortableDelay(options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS, options.signal);
  }
}
