import { describe, expect, it } from 'vitest';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { PublishService, type OwnedWorktreeLocator } from '../src/publish-service.js';
import type { GitCommandResult, PipenzoGitRunner } from '../src/pipenzo-git.js';

const TOKEN = 'test-token-pipenzo-publish';
const WORKTREE_ID = '11111111-2222-4333-8444-555555555555';
const HEAD_SHA = 'b'.repeat(40);
const WORKTREE_PATH = process.platform === 'win32' ? 'C:\\owned\\issue-178' : '/owned/issue-178';

const ok = (stdout = ''): GitCommandResult => ({ stdout, stderr: '', code: 0 });

const worktrees: OwnedWorktreeLocator = {
  ownedLocation: (id) =>
    id === WORKTREE_ID ? { id, path: WORKTREE_PATH, sourcePath: WORKTREE_PATH } : undefined,
};

const runGit: PipenzoGitRunner = async (args) => {
  if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return ok('true\n');
  if (args[0] === 'remote' && args[1] === 'get-url') {
    return ok('https://github.com/jortega0033/pipenzo.git\n');
  }
  if (args[0] === 'remote') return ok('origin\n');
  if (args[0] === 'symbolic-ref') return ok('refs/heads/issue-178\n');
  if (args[0] === 'rev-parse') return ok(`${HEAD_SHA}\n`);
  if (args[0] === 'status') return ok('');
  if (args[0] === 'push') return ok(`To github.com\n*\t${HEAD_SHA}:refs/heads/issue-178\t[new]\n`);
  return ok();
};

/** Every publish now requires a configured repository — the remote's push URL is checked. */
const REPO_ENV = { PIPENZO_GITHUB_REPO: 'jortega0033/pipenzo' } as const;

function buildApp(env: Record<string, string | undefined> = REPO_ENV) {
  const registry = new ProviderRegistry();
  return buildServer({
    registry,
    sessionManager: new SessionManager(registry, noopLogger),
    token: TOKEN,
    logger: noopLogger,
    publishService: new PublishService({
      worktrees,
      runGit,
      env,
      createPullRequestOpener: () => ({
        open: async (input) => ({
          number: 178,
          htmlUrl: 'https://github.com/jortega0033/pipenzo/pull/178',
          draft: input.draft,
        }),
      }),
    }),
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe('POST /v2/pipenzo/publish', () => {
  it('pushes a branch for an authenticated caller', async () => {
    const response = await buildApp().inject({
      method: 'POST',
      url: '/v2/pipenzo/publish',
      headers: auth,
      payload: { worktreeId: WORKTREE_ID, branch: 'issue-178', operation: 'push' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      worktreeId: WORKTREE_ID,
      remote: 'origin',
      branch: 'issue-178',
      headSha: HEAD_SHA,
      updatedRemote: true,
    });
  });

  it('opens a pull request when asked to, and returns its number and url', async () => {
    const response = await buildApp({
      ...REPO_ENV,
      PIPENZO_GITHUB_TOKEN: `${'gh'}${'p'}_routeTestToken000000001`,
    }).inject({
      method: 'POST',
      url: '/v2/pipenzo/publish',
      headers: auth,
      payload: {
        worktreeId: WORKTREE_ID,
        branch: 'issue-178',
        operation: 'push_and_open_pull_request',
        pullRequest: { title: 'Backend: publish service', body: 'Closes #178' },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().pullRequest).toMatchObject({ number: 178, baseRef: 'main' });
  });

  /**
   * The property the whole ticket rests on, expressed at the route: no bearer token, no publish.
   * An agent session's environment carries neither the daemon's port nor this token (see
   * publish-token-boundary.test.ts), so this is the door it cannot open.
   */
  it('rejects an unauthenticated caller before reaching the service', async () => {
    const response = await buildApp().inject({
      method: 'POST',
      url: '/v2/pipenzo/publish',
      payload: { worktreeId: WORKTREE_ID, branch: 'issue-178', operation: 'push' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthorized' });
  });

  it('rejects a browser-originated request, same as every other v2 route', async () => {
    const response = await buildApp().inject({
      method: 'POST',
      url: '/v2/pipenzo/publish',
      headers: { ...auth, origin: 'http://localhost:5173' },
      payload: { worktreeId: WORKTREE_ID, branch: 'issue-178', operation: 'push' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'browser_origin_forbidden' });
  });

  it('does not exist at all when no publish service is configured', async () => {
    const registry = new ProviderRegistry();
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/publish',
      headers: auth,
      payload: { worktreeId: WORKTREE_ID, branch: 'issue-178', operation: 'push' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a malformed body without echoing it back', async () => {
    for (const payload of [
      { worktreeId: 'not-a-uuid', branch: 'issue-178', operation: 'push' },
      { worktreeId: WORKTREE_ID, branch: '--force', operation: 'push' },
      { worktreeId: WORKTREE_ID, branch: 'issue-178', operation: 'push_and_open_pull_request' },
      { worktreeId: WORKTREE_ID, branch: 'issue-178', operation: 'push', pullRequest: { title: 't', body: '' } },
      { worktreeId: WORKTREE_ID, branch: 'issue-178', operation: 'delete_branch' },
      { worktreeId: WORKTREE_ID, branch: 'issue-178', operation: 'push', worktreePath: '/etc' },
    ]) {
      const response = await buildApp().inject({
        method: 'POST',
        url: '/v2/pipenzo/publish',
        headers: auth,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: 'invalid_request', error: 'invalid publish request' });
    }
  });

  it('maps a worktree it does not own onto 404 rather than attempting a push', async () => {
    const response = await buildApp().inject({
      method: 'POST',
      url: '/v2/pipenzo/publish',
      headers: auth,
      payload: {
        worktreeId: '99999999-2222-4333-8444-555555555555',
        branch: 'issue-178',
        operation: 'push',
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'worktree_not_found' });
  });

  it('reports a missing token as 412, distinctly from an authorization failure', async () => {
    const response = await buildApp(REPO_ENV).inject({
      method: 'POST',
      url: '/v2/pipenzo/publish',
      headers: auth,
      payload: {
        worktreeId: WORKTREE_ID,
        branch: 'issue-178',
        operation: 'push_and_open_pull_request',
        pullRequest: { title: 'Backend: publish service', body: '' },
      },
    });
    expect(response.statusCode).toBe(412);
    expect(response.json()).toMatchObject({ code: 'token_missing' });
    expect(JSON.stringify(response.json())).not.toMatch(/ghp_/);
  });
});
