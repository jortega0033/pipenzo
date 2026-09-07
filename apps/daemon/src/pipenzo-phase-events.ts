import type {
  PipenzoLabelV1,
  PipenzoLaneV1,
  PipenzoPhaseEventV1,
  PipenzoPhaseReplayWindowV1,
  PipenzoPhaseStreamErrorV1,
  PipenzoPhaseV1,
} from '@agent-dock/shared';
import { BoundedSseWriter, type SseOutput } from './sse-writer.js';

/**
 * The ticket-scoped event bus the phase machine publishes to on every committed change
 * (Pipenzo issue #189), plus the per-connection SSE writer that serves it.
 *
 * See `packages/shared/src/pipenzo-phase-events-v1.ts` for why phase changes cannot ride the
 * session stream and why one daemon-wide stream beats one stream per ticket. This file is the
 * daemon half: a bounded ring buffer, a fan-out, and the frame format.
 *
 * ## Bounded on purpose
 *
 * The buffer retains a fixed number of events and then drops the oldest. A daemon that ran for a
 * week would otherwise hold every transition it ever made, and the board only ever needs enough
 * history to cover a dropped connection. A subscriber that asks for a cursor older than the window
 * is refused with `replay_gap` rather than handed a silently truncated history -- the same contract
 * the v2 session stream offers, for the same reason: a board that quietly missed three transitions
 * renders a lane that is wrong, and nothing downstream can tell.
 */
const MAX_RETAINED_EVENTS = 512;

const MAX_QUEUED_EVENTS = 256;
const MAX_QUEUED_BYTES = 1024 * 1024;

export interface PipenzoPhaseChange {
  readonly ticketId: string;
  readonly fromLane: PipenzoLaneV1;
  readonly toLane: PipenzoLaneV1;
  readonly phase: PipenzoPhaseV1;
  readonly labels: readonly PipenzoLabelV1[];
}

export type PipenzoPhaseEventListener = (event: PipenzoPhaseEventV1) => void;

export class PipenzoPhaseEventBus {
  readonly #events: PipenzoPhaseEventV1[] = [];
  readonly #listeners = new Set<PipenzoPhaseEventListener>();
  #nextSequence = 0;

  constructor(
    private readonly maxRetainedEvents: number = MAX_RETAINED_EVENTS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Appends a change and fans it out. Returns the published envelope so a caller that wants to
   * report what it just published (a route, a test) does not have to reconstruct it.
   *
   * A listener that throws is isolated: publishing is called from inside the phase machine's write
   * path, and one subscriber's broken socket must not turn a committed GitHub label write into a
   * thrown transition.
   */
  publish(change: PipenzoPhaseChange): PipenzoPhaseEventV1 {
    const event: PipenzoPhaseEventV1 = {
      type: 'ticket.phase_changed',
      sequence: this.#nextSequence++,
      ticketId: change.ticketId,
      fromLane: change.fromLane,
      toLane: change.toLane,
      phase: change.phase,
      labels: [...change.labels],
      at: this.now().toISOString(),
    };

    this.#events.push(event);
    if (this.#events.length > this.maxRetainedEvents) {
      this.#events.splice(0, this.#events.length - this.maxRetainedEvents);
    }

    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A subscriber's failure is its own; the write that produced this event already committed.
      }
    }
    return event;
  }

  /**
   * The window a reconnect may resume from. `earliestSequence` is the oldest event still retained;
   * `nextSequence` is the sequence the next publish will take, so a subscriber fully caught up
   * passes exactly that and receives no replay.
   */
  replayWindow(): PipenzoPhaseReplayWindowV1 {
    return {
      earliestSequence: this.#events[0]?.sequence ?? this.#nextSequence,
      nextSequence: this.#nextSequence,
    };
  }

  /** Replays the retained window from `sinceSequence`, then delivers live events. */
  subscribe(sinceSequence: number, listener: PipenzoPhaseEventListener): () => void {
    for (const event of this.#events) {
      if (event.sequence >= sinceSequence) listener(event);
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Test/diagnostic view of the retained window. */
  get retained(): readonly PipenzoPhaseEventV1[] {
    return this.#events;
  }
}

function eventFrame(event: PipenzoPhaseEventV1): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function overflowFrame(lastSequence: number | undefined): string {
  const error: PipenzoPhaseStreamErrorV1 = {
    type: 'stream.error',
    code: 'stream_overflow',
    ...(lastSequence === undefined ? {} : { lastSequence }),
  };
  return `event: ${error.type}\ndata: ${JSON.stringify(error)}\n\n`;
}

/**
 * Per-connection writer for the phase stream. The bounded backpressure state machine is the shared
 * one in `sse-writer.ts` -- this supplies only the frame format and the queue limits, exactly as
 * `v2-sse-writer.ts` does, so the two protocols cannot drift apart on this path.
 *
 * `isTerminal` is always false: unlike a session stream, which ends when its session reaches a
 * terminal state, the board stream has no last event. It ends when the subscriber disconnects or
 * the daemon stops.
 */
export class BoundedPipenzoPhaseSseWriter extends BoundedSseWriter<PipenzoPhaseEventV1> {
  constructor(output: SseOutput, onClose: () => void) {
    super(output, onClose, {
      maxQueuedEvents: MAX_QUEUED_EVENTS,
      maxQueuedBytes: MAX_QUEUED_BYTES,
      frameFor: eventFrame,
      isTerminal: () => false,
      overflowFrame,
    });
  }
}
