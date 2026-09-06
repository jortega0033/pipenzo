import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCREENSHOT_PROVENANCE_LINES_V1, SCREENSHOT_TRUST_CLASSES } from '@agent-dock/shared';
import { ScreenshotEscapeHatchRunner } from '../src/screenshot-escape-hatch.js';
import { SCREENSHOT_EVIDENCE_SATISFIES_GATE } from '../src/screenshot-capture.js';
import {
  ScreenshotVerificationRunner,
  type BaselineWorktreeManager,
  type DevServerStarter,
} from '../src/screenshot-verification.js';

/**
 * Issue #141. The escape hatch is a *different trust class*, and almost every test here is about
 * that difference being real and visible rather than a sentence in a comment.
 */

const temporaries: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pipenzo-hatch-'));
  temporaries.push(directory);
  return directory;
}

afterEach(async () => {
  while (temporaries.length > 0) {
    const directory = temporaries.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

const COMMAND = { command: 'node', args: ['scripts/shots.mjs'] } as const;

describe('SCREENSHOT_TRUST_CLASSES', () => {
  /**
   * The two are secure for different reasons — a closed schema versus a human's review — so a
   * renderer must be able to say which applies. Collapsing them into one label would hide that.
   */
  it('names both classes and gives each its own provenance line', () => {
    expect([...SCREENSHOT_TRUST_CLASSES]).toEqual([
      'agent-proposed-manifest',
      'repo-authored-command',
    ]);
    expect(SCREENSHOT_PROVENANCE_LINES_V1['agent-proposed-manifest']).toContain(
      'agent-proposed manifest',
    );
    expect(SCREENSHOT_PROVENANCE_LINES_V1['repo-authored-command']).toContain('a human committed');
    for (const line of Object.values(SCREENSHOT_PROVENANCE_LINES_V1)) {
      // README: a screenshot "can never satisfy a gate", and both lines say so out loud.
      expect(line).toContain('never satisfies a gate');
    }
  });
});

describe('ScreenshotEscapeHatchRunner', () => {
  function runner(
    onSpawn: (input: {
      command: { command: string; args: readonly string[] };
      cwd: string;
      env: Record<string, string | undefined>;
    }) => { code: number; stderr: string } | Promise<{ code: number; stderr: string }>,
  ): ScreenshotEscapeHatchRunner {
    return new ScreenshotEscapeHatchRunner({ spawnCommand: async (input) => onSpawn(input) });
  }

  /**
   * The rule that keeps the trust classes from merging: the moment agent-authored strings become
   * input to a free-form command, the command's provenance stops being the only thing that
   * determined what ran.
   */
  it('hands the command three daemon-chosen values and nothing from the agent', async () => {
    const outputDirectory = join(await scratch(), 'shots');
    let seen: Record<string, string | undefined> = {};
    await runner((input) => {
      seen = input.env;
      return { code: 0, stderr: '' };
    }).run({
      command: COMMAND,
      cwd: await scratch(),
      origin: 'http://127.0.0.1:5199',
      port: 5199,
      outputDirectory,
    });

    expect(seen.PORT).toBe('5199');
    expect(seen.PIPENZO_ORIGIN).toBe('http://127.0.0.1:5199');
    expect(seen.PIPENZO_SCREENSHOT_DIR).toBe(outputDirectory);
    // No manifest reaches it, by any name.
    for (const key of Object.keys(seen)) {
      expect(key).not.toMatch(/MANIFEST|CAPTURE|SELECTOR|ROUTE/i);
    }
    // And the reviewed environment floor still applies: no credential for a reviewed script.
    expect(seen.PIPENZO_GITHUB_TOKEN).toBeUndefined();
  });

  it('collects the images the command wrote and labels them with the other trust class', async () => {
    const outputDirectory = join(await scratch(), 'shots');
    const result = await runner(async () => {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, 'board.png'), 'x', 'utf8');
      await writeFile(join(outputDirectory, 'detail.webp'), 'x', 'utf8');
      await writeFile(join(outputDirectory, 'notes.txt'), 'ignored', 'utf8');
      return { code: 0, stderr: '' };
    }).run({
      command: COMMAND,
      cwd: await scratch(),
      origin: 'http://127.0.0.1:5199',
      port: 5199,
      outputDirectory,
    });

    expect(result.status).toBe('completed');
    expect(result.status === 'completed' && result.shots.map((shot) => shot.name)).toEqual([
      'board',
      'detail',
    ]);
    expect(result.status === 'completed' && result.provenance).toBe(
      SCREENSHOT_PROVENANCE_LINES_V1['repo-authored-command'],
    );
    expect(result.status === 'completed' && result.satisfiesGate).toBe(
      SCREENSHOT_EVIDENCE_SATISFIES_GATE,
    );
  });

  /** A command that ran and wrote nothing produced no evidence. That is an error, not a pass. */
  it('treats an empty output directory as an error, never as an empty success', async () => {
    const outputDirectory = join(await scratch(), 'shots');
    const result = await runner(() => ({ code: 0, stderr: '' })).run({
      command: COMMAND,
      cwd: await scratch(),
      origin: 'http://127.0.0.1:5199',
      port: 5199,
      outputDirectory,
    });
    expect(result.status).toBe('errored');
    expect(result.status === 'errored' && result.reason).toContain('wrote no images');
  });

  it('reports a non-zero exit with the command’s own stderr', async () => {
    const result = await runner(() => ({ code: 3, stderr: 'chromium missing' })).run({
      command: COMMAND,
      cwd: await scratch(),
      origin: 'http://127.0.0.1:5199',
      port: 5199,
      outputDirectory: join(await scratch(), 'shots'),
    });
    expect(result.status).toBe('errored');
    expect(result.status === 'errored' && result.reason).toContain('chromium missing');
  });
});

describe('ScreenshotVerificationRunner trust-class selection', () => {
  async function repository(options: {
    playwright: boolean;
    pipenzo?: unknown;
  }): Promise<string> {
    const root = await scratch();
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'target', ...(options.pipenzo ? { pipenzo: options.pipenzo } : {}) }),
      'utf8',
    );
    if (options.playwright) {
      const pkg = join(root, 'node_modules', 'playwright');
      await mkdir(pkg, { recursive: true });
      await writeFile(
        join(pkg, 'package.json'),
        JSON.stringify({ name: 'playwright', version: '1.0.0', main: 'index.js' }),
        'utf8',
      );
      await writeFile(join(pkg, 'index.js'), 'module.exports={};', 'utf8');
    }
    return root;
  }

  function harness(sourcePath: string, worktreePath: string) {
    const locations = new Map([
      ['ticket', { id: 'ticket', path: worktreePath, sourcePath }],
      ['baseline-1', { id: 'baseline-1', path: worktreePath, sourcePath }],
    ]);
    const worktrees: BaselineWorktreeManager = {
      create: async (input) => ({
        id: 'baseline-1',
        workspaceId: 'a'.repeat(64),
        name: input.name,
        displayPath: input.name,
        status: 'ready' as const,
        createdAt: '2026-09-01T00:00:00.000Z',
      }),
      ownedLocation: (id) => locations.get(id),
      cleanup: async (id) => ({
        id,
        workspaceId: 'a'.repeat(64),
        name: id,
        displayPath: id,
        status: 'missing' as const,
        createdAt: '2026-09-01T00:00:00.000Z',
      }),
    };
    const devServer: DevServerStarter = {
      start: async (input) => ({
        origin: `http://127.0.0.1:${input.port}`,
        port: input.port,
        stop: async () => undefined,
      }),
    };
    return { worktrees, devServer };
  }

  const SERVE = { command: 'pnpm', args: ['dev'] };

  it('uses the escape hatch only when the repository has no Playwright', async () => {
    const source = await repository({
      playwright: false,
      pipenzo: { verify: { serve: SERVE, screenshot: COMMAND } },
    });
    const evidence = join(await scratch(), 'evidence');
    let hatchRuns = 0;
    const result = await new ScreenshotVerificationRunner({
      ...harness(source, source),
      escapeHatch: new ScreenshotEscapeHatchRunner({
        spawnCommand: async (input) => {
          hatchRuns += 1;
          await mkdir(String(input.env.PIPENZO_SCREENSHOT_DIR), { recursive: true });
          await writeFile(join(String(input.env.PIPENZO_SCREENSHOT_DIR), 'a.png'), 'x', 'utf8');
          return { code: 0, stderr: '' };
        },
      }),
    }).run({
      repositoryPath: source,
      worktreeId: 'ticket',
      baseCommit: 'a'.repeat(40),
      evidenceDirectory: evidence,
      manifest: { schemaVersion: 1, captures: [] },
    });

    expect(result.status).toBe('completed');
    expect(result.status === 'completed' && result.trustClass).toBe('repo-authored-command');
    // Baseline and head, same as the manifest path — the escape hatch is a different trust class,
    // not a different amount of evidence.
    expect(hatchRuns).toBe(2);
  });

  /**
   * The weaker trust class does not get to win by being listed. A repository with Playwright uses
   * the manifest path even when it also configures a free-form command.
   */
  it('prefers the agent-proposed manifest when Playwright is present, even if both are configured', async () => {
    const source = await repository({
      playwright: true,
      pipenzo: { verify: { serve: SERVE, screenshot: COMMAND } },
    });
    let hatchRuns = 0;
    const result = await new ScreenshotVerificationRunner({
      ...harness(source, source),
      escapeHatch: new ScreenshotEscapeHatchRunner({
        spawnCommand: async () => {
          hatchRuns += 1;
          return { code: 0, stderr: '' };
        },
      }),
    }).run({
      repositoryPath: source,
      worktreeId: 'ticket',
      baseCommit: 'b'.repeat(40),
      evidenceDirectory: join(await scratch(), 'evidence'),
      manifest: {
        schemaVersion: 1,
        captures: [
          {
            name: 'board',
            route: '/board',
            viewport: { width: 1280, height: 800 },
            waitForSelector: 'body',
            actions: [],
          },
        ],
      },
    });
    expect(result.status === 'completed' && result.trustClass).toBe('agent-proposed-manifest');
    expect(hatchRuns).toBe(0);
  });

  it('is unavailable, naming both missing options, when neither path exists', async () => {
    const source = await repository({ playwright: false, pipenzo: { verify: { serve: SERVE } } });
    const result = await new ScreenshotVerificationRunner({ ...harness(source, source) }).run({
      repositoryPath: source,
      worktreeId: 'ticket',
      baseCommit: 'c'.repeat(40),
      evidenceDirectory: join(await scratch(), 'evidence'),
      manifest: { schemaVersion: 1, captures: [] },
    });
    expect(result.status).toBe('unavailable');
    expect(result.status === 'unavailable' && result.reason).toContain('no Playwright');
    expect(result.status === 'unavailable' && result.reason).toContain(
      'pipenzo.verify.screenshot',
    );
  });

  /**
   * Same ownership rule as the serve command: the escape hatch is trusted because a human
   * committed it, and that is only true of the source repository — not of the worktree an agent
   * has had write access to.
   */
  it('reads the escape-hatch command from the source repository, never from the worktree', async () => {
    const source = await repository({ playwright: false, pipenzo: { verify: { serve: SERVE } } });
    const worktree = await repository({
      playwright: false,
      pipenzo: { verify: { serve: SERVE, screenshot: { command: 'node', args: ['-e', '0'] } } },
    });
    let hatchRuns = 0;
    const result = await new ScreenshotVerificationRunner({
      ...harness(source, worktree),
      escapeHatch: new ScreenshotEscapeHatchRunner({
        spawnCommand: async () => {
          hatchRuns += 1;
          return { code: 0, stderr: '' };
        },
      }),
    }).run({
      repositoryPath: source,
      worktreeId: 'ticket',
      baseCommit: 'd'.repeat(40),
      evidenceDirectory: join(await scratch(), 'evidence'),
      manifest: { schemaVersion: 1, captures: [] },
    });
    expect(result.status).toBe('unavailable');
    expect(hatchRuns).toBe(0);
  });
});
