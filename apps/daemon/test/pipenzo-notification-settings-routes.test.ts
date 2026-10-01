import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { PipenzoNotificationSettingsStore } from '../src/pipenzo-notification-settings-store.js';

/** Settings' Notifications panel routes (issue #129): read the workspace's
 *  `refusal`/`medium`/`badge`/`sound` preferences, and change them. */

const TOKEN = 'test-token-pipenzo-notification-settings';
const auth = { authorization: `Bearer ${TOKEN}` };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pipenzo-notification-settings-routes-'));
  temporaryDirectories.push(directory);
  return join(directory, 'notification-settings-v1.json');
}

function buildApp() {
  const registry = new ProviderRegistry();
  const store = new PipenzoNotificationSettingsStore(storePath());
  const app = buildServer({
    registry,
    sessionManager: new SessionManager(registry, noopLogger),
    token: TOKEN,
    logger: noopLogger,
    notificationSettingsStore: store,
  });
  return { app, store };
}

describe('GET /v2/pipenzo/notification-settings', () => {
  it('starts at the product defaults', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v2/pipenzo/notification-settings',
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      refusal: true,
      medium: true,
      badge: true,
      sound: false,
    });
  });

  it('reflects a value the store already holds', async () => {
    const { app, store } = buildApp();
    await store.update({ refusal: false, sound: true });

    const response = await app.inject({
      method: 'GET',
      url: '/v2/pipenzo/notification-settings',
      headers: auth,
    });
    expect(response.json()).toEqual({
      schemaVersion: 1,
      refusal: false,
      medium: true,
      badge: true,
      sound: true,
    });
  });

  it('refuses an unauthenticated caller, like every other route on this surface', async () => {
    const { app } = buildApp();
    expect(
      (await app.inject({ method: 'GET', url: '/v2/pipenzo/notification-settings' })).statusCode,
    ).toBe(401);
  });

  it('does not exist on a daemon assembled without a notification settings store', async () => {
    const registry = new ProviderRegistry();
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
    });
    expect(
      (await app.inject({ method: 'GET', url: '/v2/pipenzo/notification-settings', headers: auth }))
        .statusCode,
    ).toBe(404);
  });
});

describe('PUT /v2/pipenzo/notification-settings', () => {
  it('persists a refusal change and answers with the updated settings', async () => {
    const { app, store } = buildApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/notification-settings',
      headers: auth,
      payload: { refusal: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      refusal: false,
      medium: true,
      badge: true,
      sound: false,
    });
    // ...and it actually persisted, not just the in-request echo.
    expect(await store.read()).toEqual({
      schemaVersion: 1,
      refusal: false,
      medium: true,
      badge: true,
      sound: false,
    });
  });

  it('persists a badge change independently of the other three fields', async () => {
    const { app, store } = buildApp();
    await store.update({ refusal: false });

    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/notification-settings',
      headers: auth,
      payload: { badge: false },
    });

    expect(response.json()).toEqual({
      schemaVersion: 1,
      refusal: false,
      medium: true,
      badge: false,
      sound: false,
    });
  });

  it('refuses a non-boolean value without echoing the validator', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/notification-settings',
      headers: auth,
      payload: { refusal: 'yes' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('invalid_request');
    expect(JSON.stringify(response.json())).not.toMatch(/zod|issues|invalid_type/i);
  });

  it('refuses an empty body, which would silently succeed and change nothing', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/notification-settings',
      headers: auth,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a request that tries to set a "high" field -- there is no such field on the wire', async () => {
    const { app, store } = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/notification-settings',
      headers: auth,
      payload: { high: false },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('invalid_request');
    // Nothing was persisted either -- still exactly the product defaults.
    expect(await store.read()).toEqual({
      schemaVersion: 1,
      refusal: true,
      medium: true,
      badge: true,
      sound: false,
    });
  });

  it('refuses a request that pairs a "high" field with an otherwise-valid one', async () => {
    const { app, store } = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/notification-settings',
      headers: auth,
      payload: { refusal: false, high: true },
    });
    expect(response.statusCode).toBe(400);
    expect(await store.read()).toEqual({
      schemaVersion: 1,
      refusal: true,
      medium: true,
      badge: true,
      sound: false,
    });
  });

  it('refuses an unrecognised field', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/notification-settings',
      headers: auth,
      payload: { refusal: true, extra: 'field' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an unauthenticated caller', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/notification-settings',
      payload: { refusal: false },
    });
    expect(response.statusCode).toBe(401);
  });

  it('does not exist on a daemon assembled without a notification settings store', async () => {
    const registry = new ProviderRegistry();
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
    });
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/notification-settings',
      headers: auth,
      payload: { refusal: false },
    });
    expect(response.statusCode).toBe(404);
  });
});
