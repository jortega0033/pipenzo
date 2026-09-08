import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import type { PipenzoGitHubHealthV1 } from '@agent-dock/shared';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import type { PipenzoHealthSource } from '../src/routes/pipenzo-health.js';

const TOKEN = 'test-token-pipenzo-health';
const auth = { authorization: `Bearer ${TOKEN}` };

/** A minimal stand-in for `PipenzoReconciler` -- only the members the route calls. */
class FakeHealthSource implements PipenzoHealthSource {
  #health: PipenzoGitHubHealthV1;
  #listeners = new Set<(health: PipenzoGitHubHealthV1) => void>();
  pollNowCalls = 0;

  constructor(initial: PipenzoGitHubHealthV1) {
    this.#health = initial;
  }

  health(): PipenzoGitHubHealthV1 {
    return this.#health;
  }

  subscribeHealth(listener: (health: PipenzoGitHubHealthV1) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  pollNow(): void {
    this.pollNowCalls += 1;
  }

  publish(health: PipenzoGitHubHealthV1): void {
    this.#health = health;
    for (const listener of this.#listeners) listener(health);
  }
}

const temporaryTeardowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const teardown of temporaryTeardowns.splice(0)) {
    await teardown();
  }
});

function buildApp(options: { withHealth?: boolean } = {}) {
  const registry = new ProviderRegistry();
  const source =
    options.withHealth === false ? undefined : new FakeHealthSource({ state: 'unknown' });
  return {
    source,
    app: buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
      ...(source ? { pipenzoHealth: source } : {}),
    }),
  };
}

describe('GET /v2/pipenzo/github/health/events', () => {
  it('is not registered at all when the daemon was built without a source', async () => {
    const { app } = buildApp({ withHealth: false });

    const response = await app.inject({
      method: 'GET',
      url: '/v2/pipenzo/github/health/events',
      headers: auth,
    });

    expect(response.statusCode).toBe(404);
  });

  it('requires the bearer token like every other route on this surface', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/github/health/events' });

    expect(response.statusCode).toBe(401);
  });

  it('sends the current value immediately, then a live update -- with no cursor or replay concept', async () => {
    const { app, source } = buildApp();

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const controller = new AbortController();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/v2/pipenzo/github/health/events`, {
        headers: auth,
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      const readUntil = async (predicate: (text: string) => boolean): Promise<void> => {
        while (!predicate(buffered)) {
          const { value, done } = await reader.read();
          if (done) return;
          buffered += decoder.decode(value, { stream: true });
        }
      };

      // The current ('unknown') value arrives without anyone publishing anything.
      await readUntil((text) => text.includes('connection.health_changed'));
      expect(buffered).toContain('"state":"unknown"');

      source!.publish({ state: 'healthy', lastCleanPollAt: 1_700_000_000_000 });
      await readUntil((text) => text.includes('"state":"healthy"'));

      const frames = buffered
        .split('\n\n')
        .filter((frame) => frame.includes('data: '))
        .map((frame) => JSON.parse(frame.split('data: ')[1]!) as PipenzoGitHubHealthV1);
      expect(frames.map((frame) => frame.state)).toEqual(['unknown', 'healthy']);
      // No `id:` line: unlike the phase stream, this has no cursor for a reconnect to resume from.
      expect(buffered).not.toContain('\nid: ');

      await reader.cancel().catch(() => undefined);
    } finally {
      controller.abort();
      await app.close();
    }
  }, 15_000);
});

describe('POST /v2/pipenzo/github/health/poll', () => {
  it('forces a poll and answers 204 before it finishes -- fire and forget', async () => {
    const { app, source } = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/github/health/poll',
      headers: auth,
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(source!.pollNowCalls).toBe(1);
  });

  it('is not registered at all when the daemon was built without a source', async () => {
    const { app } = buildApp({ withHealth: false });

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/github/health/poll',
      headers: auth,
    });

    expect(response.statusCode).toBe(404);
  });

  it('requires the bearer token like every other route on this surface', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'POST', url: '/v2/pipenzo/github/health/poll' });

    expect(response.statusCode).toBe(401);
  });
});
