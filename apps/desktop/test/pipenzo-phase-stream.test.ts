import { describe, expect, it, vi } from 'vitest';
import type { PipenzoPhaseEventV1, PipenzoPhaseReplayWindowV1 } from '@agent-dock/shared';
import { DaemonError, UnauthorizedError } from '@agent-dock/client';
import { relayPipenzoPhaseEvents } from '../electron/pipenzo-phase-stream.js';

const TICKET_ID = '123e4567-e89b-42d3-a456-426614174000';

function phaseEvent(sequence: number): PipenzoPhaseEventV1 {
  return {
    type: 'ticket.phase_changed',
    sequence,
    ticketId: TICKET_ID,
    fromLane: 'queued',
    toLane: 'working',
    phase: 'implement',
    labels: ['pipenzo:working'],
    at: '2026-09-07T00:00:00.000Z',
  };
}

function replayGap(window?: unknown): DaemonError {
  return new DaemonError('requested phase history is unavailable', 409, 'replay_gap', window);
}

/**
 * A subscription that fails before yielding anything, the way the client does when the daemon
 * refuses the request at the HTTP layer rather than mid-stream.
 */
function refusingStream(error: unknown): AsyncIterable<PipenzoPhaseEventV1> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
  };
}

/**
 * A stand-in for the daemon's `GET /v2/pipenzo/tickets/events`, applying the same accept rule the
 * route applies: a `Last-Event-ID` resolves to `+ 1` and is served only if it lands inside the
 * bounded window, and is refused with `replay_gap` (plus the window) otherwise.
 *
 * `earliestSequence` is what makes this a regression test rather than a unit test of arithmetic.
 * The daemon's window only ever climbs, so a relay that answers a refusal by dropping its cursor
 * asks for sequence 0 again on the next attempt and is refused identically, forever.
 */
function boundedPhaseStream(window: PipenzoPhaseReplayWindowV1, retained: number[]) {
  const attempts: Array<string | undefined> = [];
  return {
    attempts,
    events: async function* (options: { lastEventId?: string; signal?: AbortSignal }) {
      attempts.push(options.lastEventId);
      if (attempts.length > 20) throw new Error('relay never converged on an accepted cursor');
      const since = options.lastEventId === undefined ? 0 : Number(options.lastEventId) + 1;
      if (since < window.earliestSequence || since > window.nextSequence) throw replayGap(window);
      for (const sequence of retained) {
        if (sequence >= since) yield phaseEvent(sequence);
      }
    },
  };
}

describe('pipenzo phase stream relay', () => {
  it('recovers from a replay gap and reaches a working subscription', async () => {
    // A daemon whose 512-entry buffer has wrapped: nothing below 600 exists any more.
    const window = { earliestSequence: 600, nextSequence: 610 };
    const daemon = boundedPhaseStream(window, [600, 601, 602]);
    const controller = new AbortController();
    const delivered: number[] = [];
    const onReplayGap = vi.fn();

    await relayPipenzoPhaseEvents({
      signal: controller.signal,
      reconnectDelayMs: 0,
      events: daemon.events,
      onReplayGap,
      onEvent: (event) => {
        delivered.push(event.sequence);
        if (event.sequence === 602) controller.abort();
      },
    });

    // First attempt is a bare subscribe (sequence 0), refused. The second must ask for a cursor the
    // daemon accepts -- not another bare subscribe, which is the loop this test exists to catch.
    expect(daemon.attempts).toEqual([undefined, '599']);
    expect(delivered).toEqual([600, 601, 602]);
    expect(onReplayGap).toHaveBeenCalledTimes(1);
    expect(onReplayGap).toHaveBeenCalledWith(window);
  });

  it('resubscribes bare when the daemon has evicted nothing yet', async () => {
    // The window still starts at 0, so there is no cursor below it to name and a bare subscribe is
    // the accepted resume. Guards the `earliestSequence - 1` arithmetic against reaching for -1.
    const daemon = boundedPhaseStream({ earliestSequence: 0, nextSequence: 0 }, [0]);
    const controller = new AbortController();
    const delivered: number[] = [];

    await relayPipenzoPhaseEvents({
      signal: controller.signal,
      reconnectDelayMs: 0,
      events: async function* (options) {
        if (daemon.attempts.length === 0) {
          daemon.attempts.push(options.lastEventId);
          throw replayGap({ earliestSequence: 0, nextSequence: 0 });
        }
        yield* daemon.events(options);
      },
      onEvent: (event) => {
        delivered.push(event.sequence);
        controller.abort();
      },
    });

    expect(daemon.attempts).toEqual([undefined, undefined]);
    expect(delivered).toEqual([0]);
  });

  it('gives up on a gap the daemon refuses to describe instead of retrying it forever', async () => {
    // A 409 whose body carried no usable window leaves no cursor to recover with, so the only
    // reconnect available is the bare one -- exactly the request being refused. Retrying that is
    // the original bug, so it must be bounded and then reported, not repeated indefinitely.
    let attempts = 0;
    const onReplayGap = vi.fn();
    const onFatal = vi.fn();

    await relayPipenzoPhaseEvents({
      signal: new AbortController().signal,
      reconnectDelayMs: 0,
      events: () => {
        attempts += 1;
        if (attempts > 10) throw new Error('relay retried an unrecoverable gap forever');
        return refusingStream(replayGap({ earliestSequence: 'nonsense' }));
      },
      onEvent: () => {},
      onReplayGap,
      onFatal,
    });

    expect(attempts).toBe(3);
    expect(onReplayGap).toHaveBeenCalledTimes(3);
    expect(onReplayGap).toHaveBeenCalledWith(undefined);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('resumes after the last delivered sequence when a retryable failure drops the stream', async () => {
    const attempts: Array<string | undefined> = [];
    const controller = new AbortController();
    const onRetry = vi.fn();
    const delivered: number[] = [];

    await relayPipenzoPhaseEvents({
      signal: controller.signal,
      reconnectDelayMs: 0,
      events: async function* (options) {
        attempts.push(options.lastEventId);
        if (attempts.length === 1) {
          yield phaseEvent(7);
          throw new DaemonError('the Pipenzo phase stream overflowed', 429);
        }
        yield phaseEvent(8);
        controller.abort();
      },
      onEvent: (event) => delivered.push(event.sequence),
      onRetry,
    });

    expect(attempts).toEqual([undefined, '7']);
    expect(delivered).toEqual([7, 8]);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('stops on an error reconnecting cannot fix', async () => {
    const attempts: string[] = [];
    const onFatal = vi.fn();

    await relayPipenzoPhaseEvents({
      signal: new AbortController().signal,
      reconnectDelayMs: 0,
      events: () => {
        attempts.push('subscribe');
        return refusingStream(new UnauthorizedError());
      },
      onEvent: () => {},
      onFatal,
    });

    expect(attempts).toHaveLength(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]?.[0]).toBeInstanceOf(UnauthorizedError);
  });
});
