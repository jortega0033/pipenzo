import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { PipenzoCaptureSettingsStore } from '../src/pipenzo-capture-settings-store.js';

/** The Models & gates screen's agent-captured panel routes (issue #470): read the workspace's
 *  `screenshotEnabled`/`escapeHatchEnabled` preference, and change it. */

const TOKEN = 'test-token-pipenzo-capture-settings';
const auth = { authorization: `Bearer ${TOKEN}` };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pipenzo-capture-settings-routes-'));
  temporaryDirectories.push(directory);
  return join(directory, 'capture-settings-v1.json');
}

function buildApp() {
  const registry = new ProviderRegistry();
  const store = new PipenzoCaptureSettingsStore(storePath());
  const app = buildServer({
    registry,
    sessionManager: new SessionManager(registry, noopLogger),
    token: TOKEN,
    logger: noopLogger,
    captureSettingsStore: store,
  });
  return { app, store };
}

describe('GET /v2/pipenzo/capture-settings', () => {
  it('starts at the product defaults', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v2/pipenzo/capture-settings',
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      screenshotEnabled: true,
      escapeHatchEnabled: false,
    });
  });

  it('reflects a value the store already holds', async () => {
    const { app, store } = buildApp();
    await store.update({ screenshotEnabled: false, escapeHatchEnabled: true });

    const response = await app.inject({
      method: 'GET',
      url: '/v2/pipenzo/capture-settings',
      headers: auth,
    });
    expect(response.json()).toEqual({
      schemaVersion: 1,
      screenshotEnabled: false,
      escapeHatchEnabled: true,
    });
  });

  it('refuses an unauthenticated caller, like every other route on this surface', async () => {
    const { app } = buildApp();
    expect(
      (await app.inject({ method: 'GET', url: '/v2/pipenzo/capture-settings' })).statusCode,
    ).toBe(401);
  });

  it('does not exist on a daemon assembled without a capture settings store', async () => {
    const registry = new ProviderRegistry();
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
    });
    expect(
      (await app.inject({ method: 'GET', url: '/v2/pipenzo/capture-settings', headers: auth }))
        .statusCode,
    ).toBe(404);
  });
});

describe('PUT /v2/pipenzo/capture-settings', () => {
  it('persists a screenshotEnabled change and answers with the updated settings', async () => {
    const { app, store } = buildApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/capture-settings',
      headers: auth,
      payload: { screenshotEnabled: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      screenshotEnabled: false,
      escapeHatchEnabled: false,
    });
    // ...and it actually persisted, not just the in-request echo.
    expect(await store.read()).toEqual({
      schemaVersion: 1,
      screenshotEnabled: false,
      escapeHatchEnabled: false,
    });
  });

  it('persists an escapeHatchEnabled change independently of screenshotEnabled', async () => {
    const { app, store } = buildApp();
    await store.update({ screenshotEnabled: false });

    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/capture-settings',
      headers: auth,
      payload: { escapeHatchEnabled: true },
    });

    expect(response.json()).toEqual({
      schemaVersion: 1,
      screenshotEnabled: false,
      escapeHatchEnabled: true,
    });
  });

  it('refuses a non-boolean value without echoing the validator', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/capture-settings',
      headers: auth,
      payload: { screenshotEnabled: 'yes' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('invalid_request');
    expect(JSON.stringify(response.json())).not.toMatch(/zod|issues|invalid_type/i);
  });

  it('refuses an empty body, which would silently succeed and change nothing', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/capture-settings',
      headers: auth,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an unrecognised field', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/capture-settings',
      headers: auth,
      payload: { screenshotEnabled: true, extra: 'field' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an unauthenticated caller', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/capture-settings',
      payload: { screenshotEnabled: false },
    });
    expect(response.statusCode).toBe(401);
  });

  it('does not exist on a daemon assembled without a capture settings store', async () => {
    const registry = new ProviderRegistry();
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
    });
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/capture-settings',
      headers: auth,
      payload: { screenshotEnabled: false },
    });
    expect(response.statusCode).toBe(404);
  });
});
