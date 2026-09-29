import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { LessonStore } from '../src/pipenzo-lesson-store.js';

/** Settings' lesson-memory panel routes (issue #128): list every saved lesson, and delete one. */

const TOKEN = 'test-token-pipenzo-lessons';
const auth = { authorization: `Bearer ${TOKEN}` };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pipenzo-lesson-routes-'));
  temporaryDirectories.push(directory);
  return join(directory, 'lessons-v1.json');
}

function buildApp() {
  const registry = new ProviderRegistry();
  const store = new LessonStore(storePath());
  const app = buildServer({
    registry,
    sessionManager: new SessionManager(registry, noopLogger),
    token: TOKEN,
    logger: noopLogger,
    lessonStore: store,
  });
  return { app, store };
}

describe('GET /v2/pipenzo/lessons', () => {
  it('starts empty', async () => {
    const { app } = buildApp();
    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/lessons', headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ lessons: [] });
  });

  it('lists a lesson the store already holds', async () => {
    const { app, store } = buildApp();
    const saved = await store.add({
      repo: 'octocat/hello-world',
      issueNumber: 94,
      text: 'On Windows the host sets Path, not PATH.',
    });

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/lessons', headers: auth });
    expect(response.json()).toEqual({ lessons: [saved] });
  });

  it('refuses an unauthenticated caller, like every other route on this surface', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/v2/pipenzo/lessons' })).statusCode).toBe(401);
  });

  it('does not exist on a daemon assembled without a lesson store', async () => {
    const registry = new ProviderRegistry();
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
    });
    expect(
      (await app.inject({ method: 'GET', url: '/v2/pipenzo/lessons', headers: auth })).statusCode,
    ).toBe(404);
  });
});

describe('POST /v2/pipenzo/lessons/delete', () => {
  it('removes exactly the named lesson and answers with the list afterward', async () => {
    const { app, store } = buildApp();
    const first = await store.add({ repo: 'octocat/a', issueNumber: 1, text: 'first' });
    const second = await store.add({ repo: 'octocat/a', issueNumber: 2, text: 'second' });

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/lessons/delete',
      headers: auth,
      payload: { id: first.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ lessons: [second] });
    // ...and it actually persisted, not just the in-request echo.
    expect((await store.list()).lessons).toEqual([second]);
  });

  it('answers 404 for a lesson that does not exist, and changes nothing', async () => {
    const { app, store } = buildApp();
    const saved = await store.add({ repo: 'octocat/a', issueNumber: 1, text: 'first' });

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/lessons/delete',
      headers: auth,
      payload: { id: '12345678-1234-4234-8234-123456789abc' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('lesson_not_found');
    expect((await store.list()).lessons).toEqual([saved]);
  });

  it('refuses a malformed body without echoing the validator', async () => {
    const { app } = buildApp();
    for (const payload of [{ id: 'not-a-uuid' }, { id: 1 }, { id: 'x', extra: true }, {}]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/lessons/delete',
        headers: auth,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('invalid_request');
      expect(JSON.stringify(response.json())).not.toMatch(/zod|issues|invalid_type/i);
    }
  });

  it('refuses an unauthenticated caller', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/lessons/delete',
      payload: { id: '12345678-1234-4234-8234-123456789abc' },
    });
    expect(response.statusCode).toBe(401);
  });
});
