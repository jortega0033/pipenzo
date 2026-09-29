import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { ConnectedReposStore } from '../src/connected-repos-store.js';
import type { RepoRef } from '../src/github-client.js';
import { RepoCheckoutError } from '../src/repo-checkout.js';
import type { RepoCheckoutResolver } from '../src/routes/pipenzo-checkout.js';

/**
 * `POST /v2/pipenzo/repos/checkout` (issues #342/#344). `repo-checkout.test.ts` owns what a
 * resolution does on disk; this file owns what the route lets through to it and what it reports.
 */

const TOKEN = 'test-token-pipenzo-checkout';
const auth = { authorization: `Bearer ${TOKEN}` };
const CHECKOUT_PATH = join(tmpdir(), 'pipenzo-repos', 'octocat', 'hello-world');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

async function buildApp(
  options: { connected?: readonly string[]; resolve?: (ref: RepoRef) => Promise<string> } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'pipenzo-checkout-routes-'));
  temporaryDirectories.push(directory);
  const store = new ConnectedReposStore(join(directory, 'connected-repos-v1.json'));
  await store.replace(options.connected ?? ['octocat/hello-world']);
  const resolved: RepoRef[] = [];
  const checkouts: RepoCheckoutResolver = {
    resolve: async (ref) => {
      resolved.push(ref);
      return (options.resolve ?? (async () => CHECKOUT_PATH))(ref);
    },
  };
  const registry = new ProviderRegistry();
  const app = buildServer({
    registry,
    sessionManager: new SessionManager(registry, noopLogger),
    token: TOKEN,
    logger: noopLogger,
    connectedRepos: store,
    repoCheckouts: checkouts,
  });
  return { app, resolved };
}

function post(app: Awaited<ReturnType<typeof buildApp>>['app'], payload: unknown, headers = auth) {
  return app.inject({ method: 'POST', url: '/v2/pipenzo/repos/checkout', headers, payload: payload as never });
}

describe('POST /v2/pipenzo/repos/checkout', () => {
  it('resolves a connected repository to its managed checkout', async () => {
    const { app, resolved } = await buildApp();

    const response = await post(app, { repo: 'octocat/hello-world' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ repo: 'octocat/hello-world', repositoryPath: CHECKOUT_PATH });
    expect(resolved).toEqual([{ owner: 'octocat', repo: 'hello-world' }]);
  });

  it("resolves with the connected entry's own spelling when the request differs only in case", async () => {
    const { app, resolved } = await buildApp({ connected: ['OctoCat/Hello-World'] });

    const response = await post(app, { repo: 'octocat/hello-world' });

    expect(response.statusCode).toBe(200);
    expect(response.json().repo).toBe('OctoCat/Hello-World');
    expect(resolved).toEqual([{ owner: 'OctoCat', repo: 'Hello-World' }]);
  });

  it('refuses a repository that is not connected, without resolving (so without cloning) anything', async () => {
    const { app, resolved } = await buildApp({ connected: ['octocat/hello-world'] });

    const response = await post(app, { repo: 'someone-else/anything' });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('repository_not_connected');
    expect(resolved).toEqual([]);
  });

  it('refuses a malformed request without echoing it', async () => {
    const { app, resolved } = await buildApp();

    const response = await post(app, { repo: 'not a repo', extra: true });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'invalid_request', error: 'invalid checkout request' });
    expect(resolved).toEqual([]);
  });

  it('never resolves a dot-segment repository name onto the clone root, even when it is on the connected list', async () => {
    const { app, resolved } = await buildApp({ connected: ['octocat/..'] });

    const response = await post(app, { repo: 'octocat/..' });

    expect(response.statusCode).toBe(400);
    expect(resolved).toEqual([]);
  });

  it('reports a path conflict as 409 with the resolver’s own message', async () => {
    const { app } = await buildApp({
      resolve: async () => {
        throw new RepoCheckoutError('path_conflict', 'already exists but is not a checkout');
      },
    });

    const response = await post(app, { repo: 'octocat/hello-world' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: 'path_conflict',
      error: 'already exists but is not a checkout',
    });
  });

  it('reports a repository name the clone root refuses to map as 400', async () => {
    const { app } = await buildApp({
      resolve: async () => {
        throw new RepoCheckoutError('invalid_repository', 'refusing to use "hello." as a directory');
      },
    });

    const response = await post(app, { repo: 'octocat/hello-world' });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('invalid_repository');
  });

  it('reports a failed clone as 502', async () => {
    const { app } = await buildApp({
      resolve: async () => {
        throw new RepoCheckoutError('clone_failed', 'git clone failed: repository not found');
      },
    });

    const response = await post(app, { repo: 'octocat/hello-world' });

    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe('clone_failed');
  });

  it('flattens an unrecognized failure to a fixed message rather than forwarding its text', async () => {
    const { app } = await buildApp({
      resolve: async () => {
        throw new Error('git could not run: spawn git ENOENT at C:\\secret\\path');
      },
    });

    const response = await post(app, { repo: 'octocat/hello-world' });

    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe('clone_failed');
    expect(response.json().error).not.toContain('secret');
  });

  it('requires the daemon bearer token like every other Pipenzo route', async () => {
    const { app, resolved } = await buildApp();

    const response = await post(app, { repo: 'octocat/hello-world' }, { authorization: 'Bearer wrong' });

    expect(response.statusCode).toBe(401);
    expect(resolved).toEqual([]);
  });

  it('does not exist on a daemon assembled without a checkout resolver', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pipenzo-checkout-routes-'));
    temporaryDirectories.push(directory);
    const registry = new ProviderRegistry();
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
      connectedRepos: new ConnectedReposStore(join(directory, 'connected-repos-v1.json')),
    });

    const response = await post(app, { repo: 'octocat/hello-world' });

    expect(response.statusCode).toBe(404);
  });
});
