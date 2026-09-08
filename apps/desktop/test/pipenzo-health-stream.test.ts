import { describe, expect, it, vi } from 'vitest';
import type { PipenzoGitHubHealthV1 } from '@agent-dock/shared';
import { DaemonError, UnauthorizedError } from '@agent-dock/client';
import { relayPipenzoGitHubHealthEvents } from '../electron/pipenzo-health-stream.js';

/**
 * A subscription that fails before yielding anything, the way the client does when the daemon
 * refuses the request at the HTTP layer rather than mid-stream.
 */
function refusingStream(error: unknown): AsyncIterable<PipenzoGitHubHealthV1> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
  };
}

describe('pipenzo GitHub health stream relay', () => {
  it('forwards every value the daemon sends, with no cursor to negotiate', async () => {
    const controller = new AbortController();
    const delivered: string[] = [];

    await relayPipenzoGitHubHealthEvents({
      signal: controller.signal,
      reconnectDelayMs: 0,
      events: async function* () {
        yield { state: 'unknown' } as PipenzoGitHubHealthV1;
        yield { state: 'healthy', lastCleanPollAt: 1 } as PipenzoGitHubHealthV1;
        controller.abort();
      },
      onEvent: (health) => delivered.push(health.state),
    });

    expect(delivered).toEqual(['unknown', 'healthy']);
  });

  it('reconnects after a retryable failure and keeps delivering -- no lastEventId to carry across it', async () => {
    const controller = new AbortController();
    const delivered: string[] = [];
    const onRetry = vi.fn();
    let attempts = 0;

    await relayPipenzoGitHubHealthEvents({
      signal: controller.signal,
      reconnectDelayMs: 0,
      events: async function* () {
        attempts += 1;
        if (attempts === 1) {
          yield { state: 'unknown' } as PipenzoGitHubHealthV1;
          throw new DaemonError('the health stream overflowed', 429);
        }
        yield { state: 'healthy', lastCleanPollAt: 1 } as PipenzoGitHubHealthV1;
        controller.abort();
      },
      onEvent: (health) => delivered.push(health.state),
      onRetry,
    });

    expect(attempts).toBe(2);
    expect(delivered).toEqual(['unknown', 'healthy']);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('stops on an error reconnecting cannot fix', async () => {
    let attempts = 0;
    const onFatal = vi.fn();

    await relayPipenzoGitHubHealthEvents({
      signal: new AbortController().signal,
      reconnectDelayMs: 0,
      events: () => {
        attempts += 1;
        return refusingStream(new UnauthorizedError());
      },
      onEvent: () => {},
      onFatal,
    });

    expect(attempts).toBe(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]?.[0]).toBeInstanceOf(UnauthorizedError);
  });
});
