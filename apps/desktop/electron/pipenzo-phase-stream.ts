import {
  pipenzoPhaseReplayWindowV1Schema,
  type PipenzoPhaseEventV1,
  type PipenzoPhaseReplayWindowV1,
} from '@agent-dock/shared';
import { DaemonError, type PipenzoTicketEventsOptions } from '@agent-dock/client';
import { abortableDelay, isRetryableStreamError } from './stream-relay.js';

const DEFAULT_RECONNECT_DELAY_MS = 1_000;

/**
 * How many times in a row a `replay_gap` may arrive without a usable window before the relay gives
 * up rather than reconnecting again.
 *
 * Without a window there is no cursor to recover with, so the only reconnect available is the bare
 * one -- which is precisely the request that is refused once the buffer has wrapped. Retrying it is
 * the original bug, so it is bounded: a couple of attempts in case the window was momentarily
 * unreadable, then `onFatal`. The daemon's own route always reports a window, so reaching this
 * means something between the two is rewriting error bodies, and no amount of retrying will fix it.
 */
const MAX_UNDESCRIBED_GAPS = 3;

export interface PipenzoPhaseStreamOptions {
  signal: AbortSignal;
  events: (options: PipenzoTicketEventsOptions) => AsyncIterable<PipenzoPhaseEventV1>;
  onEvent: (event: PipenzoPhaseEventV1) => void;
  /**
   * A gap the cursor could not bridge: transitions happened that this relay will never deliver.
   * `window` is what the daemon can still serve, or `undefined` if it refused without saying --
   * either way the board's lanes are now suspect and a consumer should re-read the tickets it
   * shows rather than trust what it has.
   */
  onReplayGap?: (window: PipenzoPhaseReplayWindowV1 | undefined) => void;
  onRetry?: (error: unknown, lastEventId: string | undefined) => void;
  /** The stream is over until the app reconnects the client: a token or a frame the loop cannot fix. */
  onFatal?: (error: unknown) => void;
  reconnectDelayMs?: number;
}

/**
 * Relays the daemon's phase-change stream (#189), resuming from the last sequence actually
 * forwarded, because the board's correctness depends on not missing a transition: a card left in
 * the wrong lane looks exactly like a card in the right one.
 *
 * ## Why a `409` needs the window, not just a dropped cursor
 *
 * The daemon's replay buffer is bounded and its `earliestSequence` only ever climbs as old events
 * are evicted -- it never returns to zero for the life of the process. An absent `Last-Event-ID`
 * asks to resume from sequence 0, so once the buffer has wrapped even once, "drop the cursor and
 * reconnect" is refused with the same `replay_gap` that prompted it, and the relay reconnects into
 * a refusal every second for the rest of the daemon's life while the board silently stops updating.
 *
 * So the refusal is answered with the window the daemon reported alongside it: resubscribing at
 * `earliestSequence` asks for the oldest history that still exists, which is exactly the events
 * this relay is missing, and is a cursor the daemon accepts. (`earliestSequence - 1`, because the
 * header names the last event already *seen*.) Should the buffer wrap again between the refusal
 * and the reconnect, the next refusal carries a fresher window and the loop converges instead of
 * repeating itself.
 *
 * Extracted from `main.ts` so this is reachable from a test: the loop that could never recover was
 * previously inline in the Electron entrypoint, where nothing could exercise it.
 */
export async function relayPipenzoPhaseEvents(options: PipenzoPhaseStreamOptions): Promise<void> {
  let lastEventId: string | undefined;
  let undescribedGaps = 0;

  while (!options.signal.aborted) {
    try {
      for await (const event of options.events({
        signal: options.signal,
        ...(lastEventId === undefined ? {} : { lastEventId }),
      })) {
        lastEventId = String(event.sequence);
        // Any delivered event means the cursor is inside the window again.
        undescribedGaps = 0;
        options.onEvent(event);
      }
    } catch (error) {
      if (options.signal.aborted) return;
      if (error instanceof DaemonError && error.status === 409) {
        const window = replayWindowFrom(error);
        options.onReplayGap?.(window);
        if (window === undefined) {
          undescribedGaps += 1;
          if (undescribedGaps >= MAX_UNDESCRIBED_GAPS) {
            options.onFatal?.(error);
            return;
          }
        } else {
          undescribedGaps = 0;
        }
        lastEventId = resumeCursorFor(window);
      } else if (!isRetryableStreamError(error)) {
        options.onFatal?.(error);
        return;
      } else {
        options.onRetry?.(error, lastEventId);
      }
    }

    if (options.signal.aborted) return;
    await abortableDelay(options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS, options.signal);
  }
}

/**
 * The `Last-Event-ID` to reconnect with after a gap, or `undefined` to send none.
 *
 * `undefined` when the window starts at 0 (nothing has been evicted, so a bare reconnect is
 * accepted) and also when the daemon refused without reporting a window at all -- there is nothing
 * better to guess with. Those two cases are not equally recoverable, which is why the caller counts
 * the second: a bare reconnect is the right answer in the first and a losing bet in the second, so
 * it is tried a bounded number of times rather than forever.
 */
function resumeCursorFor(window: PipenzoPhaseReplayWindowV1 | undefined): string | undefined {
  if (window === undefined || window.earliestSequence === 0) return undefined;
  return String(window.earliestSequence - 1);
}

/** The daemon's reported window, or `undefined` if it sent something that isn't one. */
function replayWindowFrom(error: DaemonError): PipenzoPhaseReplayWindowV1 | undefined {
  const parsed = pipenzoPhaseReplayWindowV1Schema.safeParse(error.details);
  return parsed.success ? parsed.data : undefined;
}
