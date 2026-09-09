import { describe, expect, it, vi } from 'vitest';
import type { AgentEventV2Envelope, AgentSessionV2 } from '@agent-dock/shared';
import { DaemonError, UnauthorizedError } from '@agent-dock/client';
import {
  PendingInteractiveCreates,
  relayInteractiveSessionEvents,
} from '../electron/interactive-session-lifecycle.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const EXECUTION_ID = '123e4567-e89b-42d3-a456-426614174001';

function completed(sequence: number): AgentEventV2Envelope {
  return {
    type: 'session.completed',
    sessionId: SESSION_ID,
    executionId: EXECUTION_ID,
    sequence,
    timestamp: '2026-08-31T00:00:00.000Z',
  };
}

function sessionSnapshot(earliestSequence: number): AgentSessionV2 {
  return {
    id: SESSION_ID,
    provider: 'claude',
    transport: 'test-interactive',
    cwd: 'C:\\workspace',
    status: 'active',
    selection: {
      transport: 'test-interactive',
      enabled: [],
      unavailableOptional: [],
      possibleEffects: [],
      effectsComplete: true,
    },
    executionId: EXECUTION_ID,
    acceptedWork: 'accepted',
    startedAt: '2026-08-31T00:00:00.000Z',
    earliestSequence,
  };
}

describe('interactive session lifecycle', () => {
  it('resumes a failed stream after the last delivered sequence', async () => {
    const first = {
      ...completed(0),
      type: 'session.status' as const,
      status: 'active' as const,
    };
    const eventCalls: Array<{ lastEventId?: string }> = [];
    const onEvent = vi.fn();
    let attempt = 0;

    await relayInteractiveSessionEvents({
      sessionId: SESSION_ID,
      signal: new AbortController().signal,
      isActive: () => true,
      reconnectDelayMs: 0,
      onEvent,
      events: (_sessionId, options) => {
        eventCalls.push({ lastEventId: options.lastEventId });
        attempt += 1;
        return (async function* () {
          if (attempt === 1) {
            yield first;
            throw new DaemonError('protocol-v2 event stream overflowed after sequence 0', 429);
          }
          yield completed(1);
        })();
      },
    });

    expect(eventCalls).toEqual([{ lastEventId: undefined }, { lastEventId: '0' }]);
    expect(onEvent.mock.calls.map(([event]) => event.sequence)).toEqual([0, 1]);
  });

  it('recovers a replay gap from the daemon snapshot boundary', async () => {
    const eventCalls: Array<{ lastEventId?: string }> = [];
    const onReplayGap = vi.fn();
    let attempt = 0;

    await relayInteractiveSessionEvents({
      sessionId: SESSION_ID,
      signal: new AbortController().signal,
      isActive: () => true,
      reconnectDelayMs: 0,
      snapshot: async () => sessionSnapshot(5),
      onReplayGap,
      onEvent: () => undefined,
      events: (_sessionId, options) => {
        eventCalls.push({ lastEventId: options.lastEventId });
        attempt += 1;
        return (async function* () {
          if (attempt === 1) throw new DaemonError('requested event history is unavailable', 409);
          yield completed(5);
        })();
      },
    });

    expect(eventCalls).toEqual([{ lastEventId: undefined }, { lastEventId: '4' }]);
    expect(onReplayGap).toHaveBeenCalledWith(sessionSnapshot(5));
  });

  it('surfaces a permanent stream error without retrying', async () => {
    const events = vi.fn(() =>
      (async function* () {
        yield* [];
        throw new UnauthorizedError();
      })(),
    );
    const onFatal = vi.fn();

    await relayInteractiveSessionEvents({
      sessionId: SESSION_ID,
      signal: new AbortController().signal,
      isActive: () => true,
      reconnectDelayMs: 0,
      onEvent: () => undefined,
      onFatal,
      events,
    });

    expect(events).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]?.[0]).toBeInstanceOf(UnauthorizedError);
  });

  it('aborts admitted creates and cleans up any session that still resolves', async () => {
    const creates = new PendingInteractiveCreates();
    let resolveCreate: ((value: string) => void) | undefined;
    let createSignal: AbortSignal | undefined;
    const registered: string[] = [];
    const cleanedUp: string[] = [];
    const create = creates.run(
      (signal) =>
        new Promise<string>((resolve) => {
          createSignal = signal;
          resolveCreate = resolve;
        }),
      (sessionId) => registered.push(sessionId),
      (sessionId) => {
        cleanedUp.push(sessionId);
      },
    );

    await Promise.resolve();
    creates.beginShutdown();
    expect(createSignal?.aborted).toBe(true);
    const waiting = creates.waitForPending(1_000);
    await expect(
      creates.run(
        async () => 'late',
        () => {},
      ),
    ).rejects.toThrow(/shutting down/);
    resolveCreate?.(SESSION_ID);

    await expect(waiting).resolves.toBe(true);
    await expect(create).rejects.toThrow(/shutting down/);
    expect(registered).toEqual([]);
    expect(cleanedUp).toEqual([SESSION_ID]);
  });

  /**
   * Issue #296: the same failure shape `beginShutdown` closes for a real app shutdown, but for a
   * daemon restart -- which `beginShutdown` cannot be reused for, since it is a one-way latch and a
   * restart is meant to come back from. `beginPause` aborts an in-flight create and rejects a new
   * one the same way, and unlike `beginShutdown` it never claims to be "shutting down".
   */
  it('aborts admitted creates and rejects new ones during a pause, distinctly from shutdown', async () => {
    const creates = new PendingInteractiveCreates();
    let resolveCreate: ((value: string) => void) | undefined;
    let createSignal: AbortSignal | undefined;
    const registered: string[] = [];
    const cleanedUp: string[] = [];
    const create = creates.run(
      (signal) =>
        new Promise<string>((resolve) => {
          createSignal = signal;
          resolveCreate = resolve;
        }),
      (sessionId) => registered.push(sessionId),
      (sessionId) => {
        cleanedUp.push(sessionId);
      },
    );

    await Promise.resolve();
    expect(creates.isPaused).toBe(false);
    creates.beginPause('daemon is restarting for a credential change');
    expect(creates.isPaused).toBe(true);
    expect(creates.isClosing).toBe(false);
    expect(createSignal?.aborted).toBe(true);

    const waiting = creates.waitForPending(1_000);
    await expect(
      creates.run(
        async () => 'late',
        () => {},
      ),
    ).rejects.toThrow(/restarting/);
    resolveCreate?.(SESSION_ID);

    await expect(waiting).resolves.toBe(true);
    await expect(create).rejects.toThrow(/restarting/);
    expect(registered).toEqual([]);
    expect(cleanedUp).toEqual([SESSION_ID]);
  });

  /**
   * The half `beginShutdown` cannot offer at all: creation must work normally again once the
   * restart it was paused for finishes, not stay rejected for the rest of the running session.
   */
  it('lets creates through again once a pause ends', async () => {
    const creates = new PendingInteractiveCreates();
    creates.beginPause('daemon is restarting for a credential change');
    await expect(
      creates.run(
        async () => 'during-pause',
        () => {},
      ),
    ).rejects.toThrow(/restarting/);

    creates.endPause();
    expect(creates.isPaused).toBe(false);

    const registered: string[] = [];
    await expect(
      creates.run(
        async () => 'after-pause',
        (sessionId) => registered.push(sessionId),
      ),
    ).resolves.toBe('after-pause');
    expect(registered).toEqual(['after-pause']);
  });

  /**
   * `closing` and `paused` are independent booleans in `run`'s guard (`this.closing ||
   * this.paused`), deliberately not one merged flag -- a real shutdown racing a restart's own
   * `endPause` (in `restartDaemonForCredentialChange`'s `finally`) must not reopen the gate just
   * because the restart's own pause happened to end. `isClosing` is permanent regardless of what
   * `paused` does around it.
   */
  it('keeps rejecting once closed even if an unrelated pause ends', async () => {
    const creates = new PendingInteractiveCreates();
    creates.beginPause('daemon is restarting for a credential change');
    creates.beginShutdown();
    creates.endPause();

    expect(creates.isPaused).toBe(false);
    expect(creates.isClosing).toBe(true);
    await expect(
      creates.run(
        async () => 'too-late',
        () => {},
      ),
    ).rejects.toThrow(/shutting down/);
  });
});
