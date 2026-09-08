import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { OwnedWorktreeManager } from '../src/worktree-manager.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';
import { resolveWorkspaceIdentity } from '../src/workspace-identity.js';

/**
 * Both tests drive real Git through the worktree routes, and a process spawn on Windows costs
 * 100-300 ms before the command runs. The trust-admission body measures ~9.5 s idle against the
 * 15 s it carried -- 1.6x headroom, the tightest on this branch -- and it timed out at that 15 s
 * twice while reproducing the CI conditions locally, in runs where nothing else failed.
 *
 * (An earlier pass on this branch reverted this change on a mis-measurement of 4.7 s, which a
 * guardrail review was right to challenge. 9.5 s is the number the file actually produces.)
 *
 * Sized from that measurement, not raised until the file went quiet: every step awaits a real
 * response, so there is no wrong wait for a bigger number to hide. 45 s is ~5x the measured cost
 * and still fails a genuine hang far inside the job's 20-minute limit.
 */
const GIT_HEAVY_TIMEOUT_MS = 45_000;

const TOKEN = 'test-token-worktree-routes';
const run = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-dock-worktree-routes-'));
  temporaryDirectories.push(path);
  return path;
}

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await run('git', ['init'], { cwd: path });
  await writeFile(join(path, 'README.md'), 'fixture');
  await run('git', ['add', 'README.md'], { cwd: path });
  await run('git', [
    '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.test',
    'commit', '-m', 'fixture',
  ], { cwd: path });
}

async function buildApp(base: string, trustStore: WorkspaceTrustStore) {
  const registry = new ProviderRegistry();
  const sessionManager = new SessionManager(registry, noopLogger);
  const worktreeManager = new OwnedWorktreeManager(
    join(base, 'owned'),
    join(base, 'worktrees.json'),
    undefined,
    trustStore,
  );
  await worktreeManager.load();
  return buildServer({
    registry,
    sessionManager,
    token: TOKEN,
    logger: noopLogger,
    trustStore,
    worktreeManager,
  });
}

describe('POST /v2/worktrees* trust admission', () => {
  it('returns 409 workspace_untrusted for preview and create against an untrusted repository', async () => {
    const base = await temporaryDirectory();
    const repo = join(base, 'repo');
    await initRepo(repo);
    const trustStore = new WorkspaceTrustStore(join(base, 'trust.json'));
    const app = await buildApp(base, trustStore);

    const preview = await app.inject({
      method: 'POST',
      url: '/v2/worktrees/preview',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { cwd: repo, name: 'child' },
    });
    expect(preview.statusCode).toBe(409);
    expect(preview.json()).toMatchObject({ code: 'workspace_untrusted' });

    const create = await app.inject({
      method: 'POST',
      url: '/v2/worktrees',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { cwd: repo, name: 'child', confirmIncludeCopy: true },
    });
    expect(create.statusCode).toBe(409);
    expect(create.json()).toMatchObject({ code: 'workspace_untrusted' });
  }, GIT_HEAVY_TIMEOUT_MS);

  it('allows preview and create once the repository is trusted, and cleanup 409s again after revocation', async () => {
    const base = await temporaryDirectory();
    const repo = join(base, 'repo');
    await initRepo(repo);
    const trustStore = new WorkspaceTrustStore(join(base, 'trust.json'));
    const identity = await resolveWorkspaceIdentity(repo);
    await trustStore.setTrusted(identity);
    const app = await buildApp(base, trustStore);

    const preview = await app.inject({
      method: 'POST',
      url: '/v2/worktrees/preview',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { cwd: repo, name: 'child' },
    });
    expect(preview.statusCode).toBe(200);

    const create = await app.inject({
      method: 'POST',
      url: '/v2/worktrees',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { cwd: repo, name: 'child', confirmIncludeCopy: true },
    });
    expect(create.statusCode).toBe(201);
    const worktreeId = create.json().id as string;

    await trustStore.finishRevocation(identity);

    const cleanup = await app.inject({
      method: 'POST',
      url: '/v2/worktrees/cleanup',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { worktreeId },
    });
    expect(cleanup.statusCode).toBe(409);
    expect(cleanup.json()).toMatchObject({ code: 'workspace_untrusted' });
  }, GIT_HEAVY_TIMEOUT_MS);
});
