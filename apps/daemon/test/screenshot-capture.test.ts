import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPTURE_RUNNER_SOURCE } from '../src/capture-runner-source.js';
import {
  ScreenshotCaptureExecutor,
  SCREENSHOT_EVIDENCE_SATISFIES_GATE,
  SCREENSHOT_PROVENANCE_V1,
  detectScreenshotCapability,
  type CaptureRunner,
} from '../src/screenshot-capture.js';

/**
 * Issue #139. The executor's job is to make three claims true, and the tests are mostly about the
 * third: the daemon owns every Playwright call, Playwright is the repository's own, and no
 * agent-authored string ever becomes a program.
 */

const ORIGIN = 'http://127.0.0.1:51733';
const temporaries: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pipenzo-capture-'));
  temporaries.push(directory);
  return directory;
}

afterEach(async () => {
  while (temporaries.length > 0) {
    const directory = temporaries.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

function manifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    captures: [
      {
        name: 'board',
        route: '/board',
        viewport: { width: 1280, height: 800 },
        waitForSelector: '[data-testid="board"]',
        actions: [{ type: 'fill', selector: 'input#title', value: 'hello' }],
      },
    ],
    ...overrides,
  };
}

/** A repository that has Playwright, without installing one: a resolvable stub package. */
async function repositoryWithPlaywright(): Promise<string> {
  const root = await scratch();
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'target' }), 'utf8');
  const pkg = join(root, 'node_modules', 'playwright');
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'playwright', version: '1.0.0', main: 'index.js' }),
    'utf8',
  );
  await writeFile(join(pkg, 'index.js'), 'module.exports = { chromium: {} };', 'utf8');
  return root;
}

function recordingRunner(response: unknown): CaptureRunner & { job?: unknown; scriptPath?: string } {
  const runner: CaptureRunner & { job?: unknown; scriptPath?: string } = {
    run: async (input) => {
      runner.job = input.job;
      runner.scriptPath = input.scriptPath;
      return { stdout: JSON.stringify(response), stderr: '', code: 0 };
    },
  };
  return runner;
}

describe('CAPTURE_RUNNER_SOURCE', () => {
  /**
   * The property the whole feature rests on. If a manifest value could reach this string, the
   * daemon would be executing agent-authored JavaScript next to the token vault — which README
   * names as the thing that would destroy the design.
   */
  it('is a fixed program with no interpolation site at all', () => {
    expect(CAPTURE_RUNNER_SOURCE).not.toContain('${');
    expect(CAPTURE_RUNNER_SOURCE).toContain('JSON.parse(await readStdin())');
  });

  it('makes the Playwright calls itself and evaluates nothing in the page', () => {
    for (const call of ['page.goto(', 'page.waitForSelector(', 'page.click(', 'page.fill(']) {
      expect(CAPTURE_RUNNER_SOURCE).toContain(call);
    }
    for (const forbidden of [
      'page.evaluate',
      'evaluateHandle',
      'addInitScript',
      'waitForFunction',
      'exposeFunction',
      'page.$eval',
    ]) {
      expect(CAPTURE_RUNNER_SOURCE, forbidden).not.toContain(forbidden);
    }
  });

  it('confines the page to the origin the daemon started', () => {
    expect(CAPTURE_RUNNER_SOURCE).toContain("context.route('**/*'");
    expect(CAPTURE_RUNNER_SOURCE).toContain('route.abort()');
    expect(CAPTURE_RUNNER_SOURCE).toContain('framenavigated');
    expect(CAPTURE_RUNNER_SOURCE).toContain('navigated off the dev-server origin');
  });

  it('parses as an ES module', async () => {
    const directory = await scratch();
    const file = join(directory, 'runner.mjs');
    await writeFile(file, CAPTURE_RUNNER_SOURCE, 'utf8');
    // `import()`ing it would run it; compiling it is the check that matters here.
    const { SourceTextModule } = await import('node:vm').catch(() => ({ SourceTextModule: undefined }) as never);
    if (!SourceTextModule) {
      // Node without --experimental-vm-modules: fall back to a syntax-only parse.
      expect(() => new Function(`return async () => {${CAPTURE_RUNNER_SOURCE.replace(/^import .*$/gm, '')}}`)).not.toThrow();
      return;
    }
    expect(() => new SourceTextModule(CAPTURE_RUNNER_SOURCE)).not.toThrow();
  });
});

describe('detectScreenshotCapability', () => {
  it('reports a repository with Playwright as available, without loading it', async () => {
    const capability = detectScreenshotCapability(await repositoryWithPlaywright());
    expect(capability).toMatchObject({ available: true, packageName: 'playwright' });
  });

  /** README: capability-detected, degrading to a *stated* reduced mode rather than an error. */
  it('states the reason when a repository has no Playwright', async () => {
    const root = await scratch();
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'bare' }), 'utf8');
    const capability = detectScreenshotCapability(root);
    expect(capability.available).toBe(false);
    expect(capability.available === false && capability.reason).toContain('no Playwright');
  });
});

describe('ScreenshotCaptureExecutor', () => {
  it('reports unavailable rather than failing when the repository has no Playwright', async () => {
    const root = await scratch();
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'bare' }), 'utf8');
    const result = await new ScreenshotCaptureExecutor({ runner: recordingRunner({}) }).capture({
      repositoryPath: root,
      origin: ORIGIN,
      manifest: manifest(),
      outputDirectory: join(root, 'shots'),
    });
    expect(result.status).toBe('unavailable');
  });

  it('hands the runner resolved absolute URLs on the daemon’s own origin, never raw routes', async () => {
    const root = await repositoryWithPlaywright();
    const runner = recordingRunner({ ok: true, results: [{ name: 'board', status: 'captured', outputPath: 'x.png', durationMs: 5 }] });
    await new ScreenshotCaptureExecutor({ runner }).capture({
      repositoryPath: root,
      origin: ORIGIN,
      manifest: manifest(),
      outputDirectory: join(root, 'shots'),
    });
    const job = runner.job as { origin: string; captures: { url: string; name: string }[] };
    expect(job.origin).toBe(ORIGIN);
    expect(job.captures[0]?.url).toBe('http://127.0.0.1:51733/board');
  });

  it('writes the fixed runner program outside the repository it is about to drive', async () => {
    const root = await repositoryWithPlaywright();
    const runner = recordingRunner({ ok: true, results: [] });
    const outputDirectory = join(root, 'shots');
    await new ScreenshotCaptureExecutor({ runner }).capture({
      repositoryPath: root,
      origin: ORIGIN,
      manifest: manifest(),
      outputDirectory,
    });
    expect(runner.scriptPath).toBe(join(outputDirectory, 'pipenzo-capture-runner.mjs'));
    expect(await readFile(runner.scriptPath!, 'utf8')).toBe(CAPTURE_RUNNER_SOURCE);
  });

  it('rejects a manifest that would leave the origin, before spawning anything', async () => {
    const root = await repositoryWithPlaywright();
    let spawned = false;
    const runner: CaptureRunner = {
      run: async () => {
        spawned = true;
        return { stdout: '{}', stderr: '', code: 0 };
      },
    };
    const result = await new ScreenshotCaptureExecutor({ runner }).capture({
      repositoryPath: root,
      origin: ORIGIN,
      manifest: manifest({
        captures: [
          {
            name: 'off',
            route: 'https://evil.example/x',
            viewport: { width: 1280, height: 800 },
            waitForSelector: 'body',
            actions: [],
          },
        ],
      }),
      outputDirectory: join(root, 'shots'),
    });
    expect(result.status).toBe('errored');
    expect(spawned).toBe(false);
  });

  it('carries the fixed provenance line and can never satisfy a gate', async () => {
    const root = await repositoryWithPlaywright();
    const runner = recordingRunner({
      ok: true,
      results: [{ name: 'board', status: 'captured', outputPath: 'board.png', durationMs: 12 }],
    });
    const result = await new ScreenshotCaptureExecutor({ runner }).capture({
      repositoryPath: root,
      origin: ORIGIN,
      manifest: manifest(),
      outputDirectory: join(root, 'shots'),
    });
    expect(result).toMatchObject({ status: 'completed', provenance: SCREENSHOT_PROVENANCE_V1 });
    expect(result.status === 'completed' && result.satisfiesGate).toBe(
      SCREENSHOT_EVIDENCE_SATISFIES_GATE,
    );
    expect(SCREENSHOT_EVIDENCE_SATISFIES_GATE).toBe(false);
  });

  /**
   * Missing evidence must look missing. A runner that answered about fewer captures than the
   * manifest named is the realistic way a shot would quietly disappear from an evidence block.
   */
  it('reports a capture the runner said nothing about as failed, never as absent', async () => {
    const root = await repositoryWithPlaywright();
    const runner = recordingRunner({ ok: true, results: [] });
    const result = await new ScreenshotCaptureExecutor({ runner }).capture({
      repositoryPath: root,
      origin: ORIGIN,
      manifest: manifest(),
      outputDirectory: join(root, 'shots'),
    });
    expect(result.status === 'completed' && result.shots).toEqual([
      {
        name: 'board',
        status: 'failed',
        reason: 'the capture runner reported no result for this capture',
        durationMs: 0,
      },
    ]);
  });

  it('treats unparseable runner output as an error, never as an empty success', async () => {
    const root = await repositoryWithPlaywright();
    const runner: CaptureRunner = {
      run: async () => ({ stdout: 'Segmentation fault', stderr: '', code: 139 }),
    };
    const result = await new ScreenshotCaptureExecutor({ runner }).capture({
      repositoryPath: root,
      origin: ORIGIN,
      manifest: manifest(),
      outputDirectory: join(root, 'shots'),
    });
    expect(result.status).toBe('errored');
  });
});
