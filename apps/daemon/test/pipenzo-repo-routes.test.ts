import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import { GitHubClientError, type GitHubRepository } from '../src/github-client.js';
import { ConnectedReposStore } from '../src/connected-repos-store.js';

/**
 * The repo picker's routes (issue #115).
 *
 * This file exists because the first review's process finding was that it did not: every other
 * Pipenzo route family ships with one, and three of that review's daemon-side defects — an
 * error-status map that was not the closed union its comment claimed, an outbound schema parse
 * outside its `try`, and a rate limit that did not bound what it said it bounded — were all
 * reachable only from here.
 */

const TOKEN = 'test-token-pipenzo-repos';
const auth = { authorization: `Bearer ${TOKEN}` };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pipenzo-repo-routes-'));
  temporaryDirectories.push(directory);
  return join(directory, 'connected-repos-v1.json');
}

const repository = (fullName: string, overrides: Partial<GitHubRepository> = {}): GitHubRepository => ({
  fullName,
  archived: false,
  defaultBranch: 'main',
  openIssues: 0,
  ...overrides,
});

function buildApp(
  options: { repositories?: readonly GitHubRepository[]; truncated?: boolean; fail?: GitHubClientError } = {},
) {
  const registry = new ProviderRegistry();
  const github = new FakeGitHubClient().seedRepositories(
    options.repositories ?? [repository('octocat/hello-world')],
    options.truncated ?? false,
  );
  let calls = 0;
  const store = new ConnectedReposStore(storePath());
  const app = buildServer({
    registry,
    sessionManager: new SessionManager(registry, noopLogger),
    token: TOKEN,
    logger: noopLogger,
    connectedRepos: store,
    pipenzoGitHubClient: () => {
      calls += 1;
      if (options.fail) {
        return {
          ...github,
          listAccessibleRepositories: async () => {
            throw options.fail;
          },
        } as never;
      }
      return github;
    },
  });
  return { app, store, githubCalls: () => calls };
}

describe('GET /v2/pipenzo/repos', () => {
  it('answers the listing the daemon collected', async () => {
    const { app } = buildApp({
      repositories: [repository('octocat/hello-world', { language: 'TypeScript', openIssues: 4 })],
    });

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/repos', headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      repositories: [
        {
          fullName: 'octocat/hello-world',
          archived: false,
          defaultBranch: 'main',
          language: 'TypeScript',
          openIssues: 4,
        },
      ],
      truncated: false,
    });
  });

  it('refuses an unauthenticated caller, like every other route on this surface', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/v2/pipenzo/repos' })).statusCode).toBe(401);
  });

  /**
   * The map's whole reason for existing. A rate limit reported as a gateway error is a failure the
   * caller retries into; a 401 reported as a 502 sends them to check their network instead of their
   * credential.
   */
  it('maps each GitHub failure onto its own status', async () => {
    for (const [code, status] of [
      ['unauthorized', 401],
      ['token_missing', 401],
      ['forbidden', 403],
      ['not_found', 404],
      ['rate_limited', 429],
      ['invalid_request', 400],
      ['network', 502],
      ['invalid_response', 502],
    ] as const) {
      const { app } = buildApp({ fail: new GitHubClientError(code, 'nope') });
      const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/repos', headers: auth });
      expect({ code, status: response.statusCode }).toEqual({ code, status });
      expect(response.json().code).toBe(code);
    }
  });

  /**
   * The bug this route had: a listing the outbound schema rejected escaped the `try` and became a
   * bare 500, which the picker could only offer to retry forever. It is a gateway error — the
   * daemon could not turn what GitHub said into an answer — and it says so.
   */
  it('answers 502 rather than 500 when the listing cannot be serialised', async () => {
    const { app } = buildApp({
      // A `defaultBranch` the wire schema forbids: the client's own normalizer would have refused
      // this, so reaching the schema means that normalization slipped.
      repositories: [repository('octocat/hello-world', { defaultBranch: '' })],
    });

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/repos', headers: auth });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe('invalid_response');
  });

  /**
   * The control that actually bounds the quota. One call fans out to as many as fifty GitHub
   * requests, so without this a renderer looping the channel spends an account's hourly quota in
   * about ten minutes — and the rate limit alone does not stop it.
   */
  it('serves repeat calls from cache rather than walking GitHub again', async () => {
    const { app, githubCalls } = buildApp();

    for (let index = 0; index < 5; index += 1) {
      expect(
        (await app.inject({ method: 'GET', url: '/v2/pipenzo/repos', headers: auth })).statusCode,
      ).toBe(200);
    }
    expect(githubCalls()).toBe(1);
  });

  it('does not cache a failure', async () => {
    const { app, githubCalls } = buildApp({ fail: new GitHubClientError('network', 'down') });
    await app.inject({ method: 'GET', url: '/v2/pipenzo/repos', headers: auth });
    await app.inject({ method: 'GET', url: '/v2/pipenzo/repos', headers: auth });
    // Otherwise a transient outage would pin the picker on an error for the whole TTL.
    expect(githubCalls()).toBe(2);
  });

  it('carries the truncation flag through', async () => {
    const { app } = buildApp({ truncated: true });
    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/repos', headers: auth });
    expect(response.json().truncated).toBe(true);
  });
});

describe('the connected-repos routes', () => {
  it('starts empty, and round-trips a selection', async () => {
    const { app } = buildApp();

    expect(
      (await app.inject({ method: 'GET', url: '/v2/pipenzo/repos/connected', headers: auth })).json(),
    ).toEqual({ repositories: [] });

    const put = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/repos/connected',
      headers: auth,
      payload: { repositories: ['octocat/hello-world'] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().repositories).toEqual(['octocat/hello-world']);

    const get = await app.inject({
      method: 'GET',
      url: '/v2/pipenzo/repos/connected',
      headers: auth,
    });
    expect(get.json().repositories).toEqual(['octocat/hello-world']);
  });

  it('replaces rather than appends, so unticking means something', async () => {
    const { app } = buildApp();
    const write = (repositories: string[]) =>
      app.inject({
        method: 'PUT',
        url: '/v2/pipenzo/repos/connected',
        headers: auth,
        payload: { repositories },
      });

    await write(['octocat/a', 'octocat/b']);
    expect((await write(['octocat/b'])).json().repositories).toEqual(['octocat/b']);
    expect((await write([])).json().repositories).toEqual([]);
  });

  it('refuses a malformed body without echoing the validator', async () => {
    const { app } = buildApp();
    for (const payload of [
      { repositories: ['not-a-repo-ref'] },
      { repositories: 'octocat/a' },
      { repositories: [], extra: true },
      {},
    ]) {
      const response = await app.inject({
        method: 'PUT',
        url: '/v2/pipenzo/repos/connected',
        headers: auth,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('invalid_request');
      // A validation error is a fixed shape, not a description of the daemon's internals.
      expect(JSON.stringify(response.json())).not.toMatch(/zod|issues|invalid_type/i);
    }
  });

  /** Every connected repository is one the reconciler polls, so the list is bounded. */
  it('refuses more repositories than the reconciler should be asked to poll', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/pipenzo/repos/connected',
      headers: auth,
      payload: {
        repositories: Array.from({ length: 51 }, (_, index) => `octocat/repo-${index}`),
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an unauthenticated caller on both verbs', async () => {
    const { app } = buildApp();
    expect(
      (await app.inject({ method: 'GET', url: '/v2/pipenzo/repos/connected' })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v2/pipenzo/repos/connected',
          payload: { repositories: [] },
        })
      ).statusCode,
    ).toBe(401);
  });
});
