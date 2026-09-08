import type { PipenzoGitHubHealthV1 } from '@agent-dock/shared';
import { BoundedSseWriter, type SseOutput } from './sse-writer.js';

/**
 * The per-connection SSE writer for the GitHub connection-health stream (issue #257).
 *
 * ## Why this is not the phase-event stream's writer
 *
 * `BoundedPipenzoPhaseSseWriter` (`pipenzo-phase-events.ts`) serves an ordered, gap-free log: every
 * frame carries a `sequence`, a reconnect resumes with `Last-Event-ID`, and a cursor outside the
 * retained window is refused with `replay_gap` — because a board that silently missed a transition
 * renders a lane that is wrong.
 *
 * Connection health is a different kind of fact: a **latest-value snapshot**, not an event log. A
 * banner only ever needs "what is the connection's state right now", never every state it passed
 * through — a subscriber that reconnects after missing an intermediate `retrying` tick has lost
 * nothing, because the next tick (at most `DEFAULT_POLL_INTERVAL_MS` later, see
 * `pipenzo-reconciler.ts`) reports the current truth again. So there is no cursor, no replay window,
 * and no `replay_gap`: a dropped connection just reconnects and is handed the current value again.
 *
 * `sequence` still exists on the internal event shape only because `BoundedSseWriter<TEvent>`
 * requires one for its own bookkeeping (queueing order, the overflow frame's `lastSequence`); it is
 * never written to the wire and a client has no cursor protocol to speak.
 *
 * ## Overflow is a plain disconnect, not a protocol frame
 *
 * The phase stream's `stream_overflow` frame exists so a subscriber can tell "you missed data,
 * resume from here" apart from "the connection merely dropped". Health has no resume concept for
 * that frame to describe, so an overflowing subscriber (which, given the payload size and the
 * reconciler's own multi-second-at-fastest cadence, should not happen in practice) is simply
 * disconnected; the relay in `apps/desktop/electron` reconnects and receives the current value on
 * the new connection, exactly as it would after a network blip.
 */

const MAX_QUEUED_EVENTS = 8;
const MAX_QUEUED_BYTES = 64 * 1024;

interface PipenzoHealthStreamEvent {
  readonly sequence: number;
  readonly health: PipenzoGitHubHealthV1;
}

function healthFrame(event: PipenzoHealthStreamEvent): string {
  return `event: connection.health_changed\ndata: ${JSON.stringify(event.health)}\n\n`;
}

export class BoundedPipenzoHealthSseWriter extends BoundedSseWriter<PipenzoHealthStreamEvent> {
  constructor(output: SseOutput, onClose: () => void) {
    super(output, onClose, {
      maxQueuedEvents: MAX_QUEUED_EVENTS,
      maxQueuedBytes: MAX_QUEUED_BYTES,
      frameFor: healthFrame,
      isTerminal: () => false,
      // No wire-level "you missed data" signal exists for a latest-value stream -- see this file's
      // module comment. `finish(undefined)` just ends the connection like a normal stream close.
      overflowFrame: () => undefined,
    });
  }
}

/** Wraps a raw health reading with the writer's internal sequence, nothing more. */
export function toHealthStreamEvent(
  sequence: number,
  health: PipenzoGitHubHealthV1,
): PipenzoHealthStreamEvent {
  return { sequence, health };
}
