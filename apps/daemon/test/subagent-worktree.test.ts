import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SubagentGraphStore } from '../src/subagent-graph-store.js';
import { OwnedWorktreeManager, WorktreeManagerError } from '../src/worktree-manager.js';

/**
 * Every test here drives real Git, and a process spawn on Windows costs 100-300 ms before the
 * command does anything. The slowest body measures ~10.6 s idle, against the 10-20 s budgets these
 * carried -- roughly 1.5-2x headroom, on a runner this repository has already measured itself
 * losing to: issue #60 records this very file taking 8.1 s isolated and
 * exceeding 15 s in the full run (see the `run()` note below).
 *
 * Sized from that measurement rather than raised until the file went quiet. Nothing in these
 * bodies waits on a poll or a sleep that a bigger number would hide, so there is no wrong wait to
 * paper over. One budget for the file rather than eight bespoke ones is the deliberate trade: it
 * costs a fast negative-path test a slower failure if it ever regresses into spawning Git, and
 * buys a number that stays true as these bodies change.
 */
const GIT_HEAVY_TIMEOUT_MS = 45_000;

const execFileAsync = promisify(execFile);
const id = (suffix: string) => `123e4567-e89b-42d3-a456-4266141740${suffix}`;

/**
 * Real `git` subprocess spawns dominate this suite's wall-clock time, especially on Windows under
 * CI's parallel-worker contention (issue #60: this file exceeded 15s in the full run but passed
 * isolated in 8.1s). Logs any call slower than 500ms to make the actually-slow stage visible in CI
 * output instead of only a generic per-test timeout.
 */
async function run(command: string, args: string[], options: { cwd: string }): Promise<string> {
  const startedAt = Date.now();
  const { stdout } = await execFileAsync(command, args, options);
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > 500) {
    console.warn(`[subagent-worktree] slow git stage (${elapsedMs}ms): ${args.join(' ')}`);
  }
  return stdout;
}

describe('subagent graph store', () => {
  it('preserves nested parentage and refuses cross-session control', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-dock-subagents-'));
    try {
      const store = new SubagentGraphStore(join(root, 'graph.json'));
      const base = {
        provider: 'codex' as const,
        status: 'running' as const,
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
        workspace: { kind: 'shared' as const, displayName: 'repo' },
        controls: { steer: false, interrupt: false, cancel: false },
      };
      store.upsert({ ...base, id: id('01'), sessionId: id('00'), name: 'parent' });
      store.upsert({
        ...base,
        id: id('02'),
        sessionId: id('00'),
        parentId: id('01'),
        name: 'child',
      });
      expect(store.graph(id('00')).nodes.map((node) => [node.id, node.parentId])).toEqual([
        [id('01'), undefined],
        [id('02'), id('01')],
      ]);
      await expect(
        store.control({ sessionId: id('03'), agentId: id('02'), action: 'cancel' }),
      ).resolves.toBe('not_found');
      expect(() =>
        store.upsert({
          ...base,
          id: id('04'),
          sessionId: id('03'),
          parentId: id('01'),
          name: 'crossover',
        }),
      ).toThrow(/parent/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('owned worktree manager', () => {
  // Shared across every `it` below: the expensive part (a real git repo with a real commit) is
  // built once in beforeAll instead of once per assertion, so splitting this scenario into
  // separately-timed, separately-diagnosable stages doesn't multiply the real subprocess cost that
  // makes this file slow in the first place (issue #60's "split oversized integration scenarios
  // where useful" without adding git spawns). `it`s within a `describe` still run in file order, so
  // the later stages intentionally build on state the earlier ones left behind, exactly as the
  // single monolithic test previously did sequentially inside itself.
  let base: string;
  let repo: string;
  let owned: string;
  let manager: OwnedWorktreeManager;
  let created: Awaited<ReturnType<OwnedWorktreeManager['create']>>;
  let recovered: OwnedWorktreeManager;
  let target: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'agent-dock-worktrees-'));
    repo = join(base, 'repo');
    owned = join(base, 'owned');
    await mkdir(repo);
    await run('git', ['init'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), 'fixture');
    await writeFile(join(repo, '.gitignore'), '.env\n');
    await writeFile(join(repo, '.env'), 'SECRET=never-log');
    await writeFile(join(repo, '.worktreeinclude'), '.env\n');
    await run('git', ['add', 'README.md', '.gitignore', '.worktreeinclude'], { cwd: repo });
    await run(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-m',
        'fixture',
      ],
      { cwd: repo },
    );
    manager = new OwnedWorktreeManager(owned, join(base, 'worktrees.json'));
    await manager.load();
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('previews ignored/include risks without leaking secret content', async () => {
    const preview = await manager.preview({ cwd: repo, name: 'child' });
    expect(preview).toMatchObject({
      includeFiles: ['.env'],
      secretRisk: true,
      requiresConfirmation: true,
    });
    expect(JSON.stringify(preview)).not.toContain('SECRET=never-log');
  }, GIT_HEAVY_TIMEOUT_MS);

  it('rejects an invalid ref before creating anything', async () => {
    await expect(
      manager.create({ cwd: repo, name: 'invalid', ref: '--help', confirmIncludeCopy: true }),
    ).rejects.toMatchObject({ code: 'invalid_ref' } satisfies Partial<WorktreeManagerError>);
  }, GIT_HEAVY_TIMEOUT_MS);

  it('creates a worktree, persists it, and a freshly-loaded manager instance recovers it', async () => {
    created = await manager.create({ cwd: repo, name: 'child', confirmIncludeCopy: true });
    target = join(owned, (await readdir(owned))[0]!);
    expect(
      JSON.parse(await readFile(join(base, 'worktrees.json'), 'utf8')).worktrees,
    ).toContainEqual(expect.objectContaining({ id: created.id, status: 'ready' }));
    recovered = new OwnedWorktreeManager(owned, join(base, 'worktrees.json'));
    await recovered.load();
    expect(await recovered.list()).toContainEqual(
      expect.objectContaining({ id: created.id, status: 'ready' }),
    );
  }, GIT_HEAVY_TIMEOUT_MS);

  it('never cleans a worktree a caller has since made dirty', async () => {
    await writeFile(join(target, '.env'), 'SECRET=changed-after-copy');
    expect(
      await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: target }),
    ).not.toContain('.env');
    await expect(recovered.cleanup(created.id)).rejects.toMatchObject({
      code: 'worktree_dirty',
    } satisfies Partial<WorktreeManagerError>);
    expect((await recovered.list()).find((item) => item.id === created.id)?.status).toBe('dirty');
  }, GIT_HEAVY_TIMEOUT_MS);

  it('refuses an untracked-only worktree by default, but removes it with deleteUntracked (issue #117)', async () => {
    const untracked = await manager.create({
      cwd: repo,
      name: 'untracked',
      confirmIncludeCopy: true,
    });
    const state = JSON.parse(await readFile(join(base, 'worktrees.json'), 'utf8')) as {
      worktrees: Array<{ id: string; targetPath: string }>;
    };
    const untrackedTarget = state.worktrees.find((entry) => entry.id === untracked.id)!.targetPath;
    await writeFile(join(untrackedTarget, 'build-output.tmp'), 'not committed');

    await expect(manager.cleanup(untracked.id)).rejects.toMatchObject({
      code: 'worktree_dirty',
    } satisfies Partial<WorktreeManagerError>);

    const cleaned = await manager.cleanup(untracked.id, { deleteUntracked: true });
    expect(cleaned.status).toBe('missing');
  }, GIT_HEAVY_TIMEOUT_MS);

  it('deletes the worktree branch when deleteBranch is set (issue #117)', async () => {
    await run('git', ['branch', 'feature-x'], { cwd: repo });
    const branched = await manager.create({
      cwd: repo,
      name: 'branched',
      ref: 'feature-x',
      confirmIncludeCopy: true,
    });
    expect(branched.branch).toBe('feature-x');

    const cleaned = await manager.cleanup(branched.id, { deleteBranch: true });
    expect(cleaned.status).toBe('missing');
    expect(await run('git', ['branch', '--list', 'feature-x'], { cwd: repo })).toBe('');
  }, GIT_HEAVY_TIMEOUT_MS);

  it('queues concurrent create() calls against the same source repo instead of throwing worktree_busy (issue #118)', async () => {
    const [first, second] = await Promise.all([
      manager.create({ cwd: repo, name: 'concurrent-a', confirmIncludeCopy: true }),
      manager.create({ cwd: repo, name: 'concurrent-b', confirmIncludeCopy: true }),
    ]);
    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
    expect(first.id).not.toBe(second.id);
    const ids = (await manager.list()).map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
  }, GIT_HEAVY_TIMEOUT_MS);

  it('queues concurrent cleanup() calls against the same source repo instead of throwing worktree_busy (issue #118)', async () => {
    const [a, b] = await Promise.all([
      manager.create({ cwd: repo, name: 'concurrent-cleanup-a', confirmIncludeCopy: true }),
      manager.create({ cwd: repo, name: 'concurrent-cleanup-b', confirmIncludeCopy: true }),
    ]);
    const [cleanedA, cleanedB] = await Promise.all([
      manager.cleanup(a.id),
      manager.cleanup(b.id),
    ]);
    expect(cleanedA.status).toBe('missing');
    expect(cleanedB.status).toBe('missing');
  }, GIT_HEAVY_TIMEOUT_MS);
});
