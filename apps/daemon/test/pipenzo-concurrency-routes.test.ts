import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { PipenzoConcurrencyStore } from '../src/pipenzo-concurrency-store.js';
import { PipenzoExecutionLimiter } from '../src/pipenzo-execution-limiter.js';

/** Settings' Concurrency panel routes (issue #126): read the workspace's execution-limit / run-
 *  budget settings, and change them with immediate effect on the live limiter. */

const TOKEN = 'test-token-pipenzo-concurrency';
const auth = { authorization: `Bearer ${TOKEN}` };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pipenzo-concurrency-routes-'));
  temporaryDirectories.push(directory);
  return join(directory, 'concurrency-v1.json');
}

function buildApp() {
  const registry = new ProviderRegistry();
  const store = new PipenzoConcurrencyStore(storePath());
  const limiter = new PipenzoExecutionLimiter(2);
  const app = buildServer({
    registry,
    sessionManager: new SessionManager(registry, noopLogger),
    token: TOKEN,
    logger: noopLogger,
    concurrencyStore: store,
    executionLimiter: limiter,
  });
  return { app, store, limiter };
}

describe('GET /v2/pipenzo/concurrency', () => {
  it('starts at the product defaults', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v2/pipenzo/concurrency',
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schemaVersion: 1, executionLimit: 2, runBudget: 'unlimited' });
  });

  it('reflects a value the store already holds', async () => {
    const { app, store } = buildApp();
    await store.update({ executionLimit: 4, runBudget: 'three_runs' });

    const response = await app.inject({
      method: 'GET',
      url: '/v2/pipenzo/concurrency',
      headers: auth,
    });
    expect(response.json()).toEqual({ schemaVersion: 1, executionLimit: 4, runBudget: 'three_runs' });
  });

  it('refuses an unauthenticated caller, like every other route on this surface', async () => {
    const { app } = buildApp();
    expect(
      (await app.inject({ method: 'GET', url: '/v2/pipenzo/concurrency' })).statusCode,
    ).toBe(401);
  });

  it('does not exist on a daemon assembled without a concurrency store/limiter', async () => {
    const registry = new ProviderRegistry();
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
    });
    expect(
      (await app.inject({ method: 'GET', url: '/v2/pipenzo/concurrency', headers: auth }))
        .statusCode,
    ).toBe(404);
  });
});

describe('PUT /v2/pipenzo/concurrency', () => {
  it('persists an execution-limit change and answers with the updated settings', async () => {
    const { app, store } = buildApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/concurrency',
      headers: auth,
      payload: { executionLimit: 3 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schemaVersion: 1, executionLimit: 3, runBudget: 'unlimited' });
    // ...and it actually persisted, not just the in-request echo.
    expect(await store.read()).toEqual({ schemaVersion: 1, executionLimit: 3, runBudget: 'unlimited' });
  });

  it('applies the new limit to the live limiter immediately, not only on the next restart', async () => {
    const { app, limiter } = buildApp();
    expect(limiter.limit).toBe(2);

    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/concurrency',
      headers: auth,
      payload: { executionLimit: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(limiter.limit).toBe(1);
  });

  it('persists a run-budget change independently of the execution limit', async () => {
    const { app, store } = buildApp();
    await store.update({ executionLimit: 4 });

    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/concurrency',
      headers: auth,
      payload: { runBudget: 'cap_200k_tokens' },
    });

    expect(response.json()).toEqual({
      schemaVersion: 1,
      executionLimit: 4,
      runBudget: 'cap_200k_tokens',
    });
  });

  it('refuses an execution limit outside the 1..4 bound without echoing the validator', async () => {
    const { app } = buildApp();
    for (const payload of [{ executionLimit: 0 }, { executionLimit: 5 }, { executionLimit: 2.5 }]) {
      const response = await app.inject({
        method: 'PUT',
        url: '/v2/pipenzo/concurrency',
        headers: auth,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('invalid_request');
      expect(JSON.stringify(response.json())).not.toMatch(/zod|issues|invalid_type/i);
    }
  });

  it('refuses an unrecognised run budget', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/concurrency',
      headers: auth,
      payload: { runBudget: 'ten_runs' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an empty body, which would silently succeed and change nothing', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/concurrency',
      headers: auth,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an unauthenticated caller', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/concurrency',
      payload: { executionLimit: 3 },
    });
    expect(response.statusCode).toBe(401);
  });

  it('does not exist on a daemon assembled without a concurrency store/limiter', async () => {
    const registry = new ProviderRegistry();
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
    });
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/concurrency',
      headers: auth,
      payload: { executionLimit: 3 },
    });
    expect(response.statusCode).toBe(404);
  });
});
