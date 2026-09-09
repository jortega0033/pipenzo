import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PipenzoRepoConfigError,
  readPipenzoRepoConfig,
} from '../src/pipenzo-repo-config.js';
import {
  ScreenshotExecutionSlot,
  ScreenshotVerificationRunner,
  reserveEphemeralPort,
  type BaselineWorktreeManager,
  type DevServerStarter,
} from '../src/screenshot-verification.js';
import { ScreenshotCaptureExecutor, type CaptureRunner } from '../src/screenshot-capture.js';

/**
 * Issue #140: the second checkout, the second dev-server run, the injected port, and the serial
 * slot. Each of those is a cost README insists is counted rather than hidden, so most of these
 * tests are about the accounting being real.
 */

const temporaries: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pipenzo-verify-'));
  temporaries.push(directory);
  return directory;
}

afterEach(async () => {
  while (temporaries.length > 0) {
    const directory = temporaries.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

const MANIFEST = {
  schemaVersion: 1,
  captures: [
    {
      name: 'board',
      route: '/board',
      viewport: { width: 1280, height: 800 },
      waitForSelector: '[data-testid="board"]',
      actions: [],
    },
  ],
};

async function repository(pipenzo?: unknown): Promise<string> {
  const root = await scratch();
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'target', ...(pipenzo ? { pipenzo } : {}) }),
    'utf8',
  );
  const pkg = join(root, 'node_modules', 'playwright');
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'playwright', version: '1.0.0', main: 'index.js' }),
    'utf8',
  );
  await writeFile(join(pkg, 'index.js'), 'module.exports = {};', 'utf8');
  return root;
}

const SERVE_CONFIG = { verify: { serve: { command: 'pnpm', args: ['dev'] } } };

interface Harness {
  worktrees: BaselineWorktreeManager;
  devServer: DevServerStarter & { ports: number[]; cwds: string[] };
  created: string[];
  cleaned: string[];
}

async function harness(sourcePath: string, worktreePath: string): Promise<Harness> {
  const created: string[] = [];
  const cleaned: string[] = [];
  const locations = new Map<string, { id: string; path: string; sourcePath: string }>([
    ['ticket', { id: 'ticket', path: worktreePath, sourcePath }],
  ]);
  let next = 0;
  const worktrees: BaselineWorktreeManager = {
    create: async (input) => {
      next += 1;
      const id = `baseline-${next}`;
      const path = join(sourcePath, '..', `baseline-${next}`);
      created.push(`${input.name}@${input.ref ?? 'HEAD'}`);
      // The baseline checkout resolves Playwright from itself, so it needs the same stub.
      await mkdir(join(path, 'node_modules', 'playwright'), { recursive: true });
      await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'baseline' }), 'utf8');
      await writeFile(
        join(path, 'node_modules', 'playwright', 'package.json'),
        JSON.stringify({ name: 'playwright', version: '1.0.0', main: 'index.js' }),
        'utf8',
      );
      await writeFile(join(path, 'node_modules', 'playwright', 'index.js'), 'module.exports={};', 'utf8');
      locations.set(id, { id, path, sourcePath });
      return {
        id,
        workspaceId: 'a'.repeat(64),
        name: input.name,
        displayPath: input.name,
        status: 'ready' as const,
        createdAt: '2026-09-01T00:00:00.000Z',
      };
    },
    ownedLocation: (id) => locations.get(id),
    cleanup: async (id) => {
      cleaned.push(id);
      return {
        id,
        workspaceId: 'a'.repeat(64),
        name: id,
        displayPath: id,
        status: 'missing' as const,
        createdAt: '2026-09-01T00:00:00.000Z',
      };
    },
  };
  const devServer: DevServerStarter & { ports: number[]; cwds: string[] } = {
    ports: [],
    cwds: [],
    start: async (input) => {
      devServer.ports.push(input.port);
      devServer.cwds.push(input.cwd);
      return {
        origin: `http://127.0.0.1:${input.port}`,
        port: input.port,
        stop: async () => undefined,
      };
    },
  };
  return { worktrees, devServer, created, cleaned };
}

function captureExecutor(): ScreenshotCaptureExecutor {
  const runner: CaptureRunner = {
    run: async () => ({
      stdout: JSON.stringify({
        ok: true,
        results: [{ name: 'board', status: 'captured', outputPath: 'board.png', durationMs: 4 }],
      }),
      stderr: '',
      code: 0,
    }),
  };
  return new ScreenshotCaptureExecutor({ runner });
}

describe('readPipenzoRepoConfig', () => {
  it('treats an absent pipenzo key as "not opted in", not as an error', async () => {
    expect(await readPipenzoRepoConfig(await repository())).toEqual({});
  });

  it('reads explicit argv for serve and screenshot', async () => {
    const root = await repository({
      verify: {
        serve: { command: 'pnpm', args: ['dev'] },
        screenshot: { command: 'node', args: ['scripts/shots.mjs'] },
      },
    });
    expect(await readPipenzoRepoConfig(root)).toEqual({
      serve: { command: 'pnpm', args: ['dev'] },
      screenshot: { command: 'node', args: ['scripts/shots.mjs'] },
    });
  });

  /**
   * The shape rule that matters: a shell string is unrepresentable. Every Pipenzo subprocess runs
   * with `shell: false`, and a config format that accepted `"pnpm dev && curl evil"` would have
   * quietly put a shell back at the one place a repository names a command.
   */
  it('refuses a shell string, a path, and an option-looking command', async () => {
    for (const serve of [
      'pnpm dev && curl evil',
      { command: 'pnpm dev && curl evil' },
      { command: '../../bin/sh' },
      { command: '--eval' },
      { command: 'pnpm', args: ['dev\n; curl evil'] },
    ]) {
      const root = await repository({ verify: { serve } });
      await expect(readPipenzoRepoConfig(root)).rejects.toBeInstanceOf(PipenzoRepoConfigError);
    }
  });

  it('fails rather than silently ignoring a malformed pipenzo block', async () => {
    const root = await repository({ verify: 'yes please' });
    await expect(readPipenzoRepoConfig(root)).rejects.toBeInstanceOf(PipenzoRepoConfigError);
  });

  /**
   * Issue #284: repo-wide Refine/Review conventions, the same trust class and file as `verify` --
   * a human committed both, so both are read from the same key rather than a new surface.
   */
  describe('conventions', () => {
    it('reads a stated conventions string', async () => {
      const root = await repository({ conventions: 'Tests live in test/, not __tests__/.' });
      expect(await readPipenzoRepoConfig(root)).toEqual({
        conventions: 'Tests live in test/, not __tests__/.',
      });
    });

    /**
     * `verify` and `conventions` are independent keys, not one gating the other -- a repository
     * that states conventions without configuring screenshot verification (the common case,
     * expected to be more common than the reverse) must not silently lose them.
     */
    it('is read independently of whether verify is configured at all', async () => {
      const conventionsOnly = await repository({ conventions: 'Prefer named exports.' });
      expect(await readPipenzoRepoConfig(conventionsOnly)).toEqual({
        conventions: 'Prefer named exports.',
      });

      const both = await repository({
        verify: { serve: { command: 'pnpm', args: ['dev'] } },
        conventions: 'Prefer named exports.',
      });
      expect(await readPipenzoRepoConfig(both)).toEqual({
        serve: { command: 'pnpm', args: ['dev'] },
        conventions: 'Prefer named exports.',
      });
    });

    it('treats an absent or blank conventions string as not configured, not as empty prose', async () => {
      expect(await readPipenzoRepoConfig(await repository({}))).toEqual({});
      expect(await readPipenzoRepoConfig(await repository({ conventions: '   ' }))).toEqual({});
    });

    it('trims surrounding whitespace', async () => {
      const root = await repository({ conventions: '  Prefer named exports.  \n' });
      expect(await readPipenzoRepoConfig(root)).toEqual({ conventions: 'Prefer named exports.' });
    });

    it('rejects a non-string value rather than silently ignoring it', async () => {
      const root = await repository({ conventions: ['not', 'a', 'string'] });
      await expect(readPipenzoRepoConfig(root)).rejects.toBeInstanceOf(PipenzoRepoConfigError);
    });

    /** Generous for real prose, but bounded against folding an unbounded file into every future
     * Refine/Review prompt this repository ever runs. */
    it('accepts up to 8,000 characters and rejects one character more', async () => {
      const atLimit = await repository({ conventions: 'x'.repeat(8_000) });
      expect(await readPipenzoRepoConfig(atLimit)).toEqual({ conventions: 'x'.repeat(8_000) });

      const overLimit = await repository({ conventions: 'x'.repeat(8_001) });
      await expect(readPipenzoRepoConfig(overLimit)).rejects.toBeInstanceOf(PipenzoRepoConfigError);
    });
  });
});

describe('ScreenshotExecutionSlot', () => {
  /**
   * README's stated reason is the dev server's port; the deeper one is that a screenshot is a
   * comparison, and two dev servers competing for one machine produce pairs that differ for
   * reasons nobody can attribute to the diff.
   */
  it('runs one capture at a time, in the order they queued', async () => {
    const slot = new ScreenshotExecutionSlot();
    const order: string[] = [];
    let concurrent = 0;
    let peak = 0;
    const work = (name: string) =>
      slot.run(async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        order.push(name);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
      });
    await Promise.all([work('a'), work('b'), work('c')]);
    expect(peak).toBe(1);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('releases the slot when the work throws, rather than wedging the queue', async () => {
    const slot = new ScreenshotExecutionSlot();
    await expect(
      slot.run(async () => {
        throw new Error('capture blew up');
      }),
    ).rejects.toThrow('capture blew up');
    await expect(slot.run(async () => 'next')).resolves.toBe('next');
    expect(slot.queueDepth).toBe(0);
  });
});

describe('reserveEphemeralPort', () => {
  it('hands back a real, free loopback port', async () => {
    const port = await reserveEphemeralPort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65_536);
  });
});

describe('ScreenshotVerificationRunner', () => {
  it('takes a second checkout of the base commit and a second dev-server run', async () => {
    const source = await repository(SERVE_CONFIG);
    const worktree = await repository();
    const h = await harness(source, worktree);
    const result = await new ScreenshotVerificationRunner({
      worktrees: h.worktrees,
      devServer: h.devServer,
      capture: captureExecutor(),
    }).run({
      repositoryPath: source,
      worktreeId: 'ticket',
      baseCommit: 'a'.repeat(40),
      evidenceDirectory: join(await scratch(), 'evidence'),
      manifest: MANIFEST,
    });

    expect(result.status).toBe('completed');
    // The checkout is at the base commit, and it is named after it.
    expect(h.created).toEqual([`pipenzo-baseline-${'a'.repeat(12)}@${'a'.repeat(40)}`]);
    // Two dev-server runs, one per checkout, on two different daemon-chosen ports.
    expect(h.devServer.ports).toHaveLength(2);
    expect(new Set(h.devServer.ports).size).toBe(2);
    expect(h.devServer.cwds[1]).toBe(worktree);
  });

  it('reports both costs rather than hiding them', async () => {
    const source = await repository(SERVE_CONFIG);
    const h = await harness(source, await repository());
    const result = await new ScreenshotVerificationRunner({
      worktrees: h.worktrees,
      devServer: h.devServer,
      capture: captureExecutor(),
    }).run({
      repositoryPath: source,
      worktreeId: 'ticket',
      baseCommit: 'b'.repeat(40),
      evidenceDirectory: join(await scratch(), 'evidence'),
      manifest: MANIFEST,
    });
    expect(result.status === 'completed' && result.cost).toMatchObject({
      extraCheckout: true,
      extraDevServerRun: true,
    });
    expect(result.status === 'completed' && typeof result.cost.slotWaitMs).toBe('number');
  });

  it('removes the disposable baseline checkout afterwards, even on the happy path', async () => {
    const source = await repository(SERVE_CONFIG);
    const h = await harness(source, await repository());
    await new ScreenshotVerificationRunner({
      worktrees: h.worktrees,
      devServer: h.devServer,
      capture: captureExecutor(),
    }).run({
      repositoryPath: source,
      worktreeId: 'ticket',
      baseCommit: 'c'.repeat(40),
      evidenceDirectory: join(await scratch(), 'evidence'),
      manifest: MANIFEST,
    });
    expect(h.cleaned).toEqual(['baseline-1']);
  });

  /**
   * The ownership rule. The command's whole claim to being trusted is that a human committed it,
   * and that is only true of the source repository — the agent has had write access to the
   * worktree's package.json for the entire Implement phase.
   */
  it('reads the serve command from the source repository, never from the ticket worktree', async () => {
    const source = await repository();
    const worktree = await repository({
      verify: { serve: { command: 'node', args: ['-e', 'require("fs")'] } },
    });
    const h = await harness(source, worktree);
    const result = await new ScreenshotVerificationRunner({
      worktrees: h.worktrees,
      devServer: h.devServer,
      capture: captureExecutor(),
    }).run({
      repositoryPath: source,
      worktreeId: 'ticket',
      baseCommit: 'd'.repeat(40),
      evidenceDirectory: join(await scratch(), 'evidence'),
      manifest: MANIFEST,
    });
    expect(result).toMatchObject({ status: 'unavailable' });
    expect(h.devServer.ports).toHaveLength(0);
  });

  it('is unavailable, with a reason, when the repository configures no dev server', async () => {
    const source = await repository();
    const h = await harness(source, await repository());
    const result = await new ScreenshotVerificationRunner({
      worktrees: h.worktrees,
      devServer: h.devServer,
      capture: captureExecutor(),
    }).run({
      repositoryPath: source,
      worktreeId: 'ticket',
      baseCommit: 'e'.repeat(40),
      evidenceDirectory: join(await scratch(), 'evidence'),
      manifest: MANIFEST,
    });
    expect(result.status).toBe('unavailable');
    expect(result.status === 'unavailable' && result.reason).toContain('pipenzo.verify.serve');
  });

  it('never runs two tickets’ captures at once, even when both are started together', async () => {
    const slot = new ScreenshotExecutionSlot();
    const source = await repository(SERVE_CONFIG);
    const h = await harness(source, await repository());
    let concurrent = 0;
    let peak = 0;
    const devServer: DevServerStarter = {
      start: async (input) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          origin: `http://127.0.0.1:${input.port}`,
          port: input.port,
          stop: async () => {
            concurrent -= 1;
          },
        };
      },
    };
    const runner = new ScreenshotVerificationRunner({
      worktrees: h.worktrees,
      devServer,
      capture: captureExecutor(),
      slot,
    });
    const request = {
      repositoryPath: source,
      worktreeId: 'ticket',
      baseCommit: 'f'.repeat(40),
      evidenceDirectory: join(await scratch(), 'evidence'),
      manifest: MANIFEST,
    };
    await Promise.all([runner.run(request), runner.run(request)]);
    expect(peak).toBe(1);
  });
});
