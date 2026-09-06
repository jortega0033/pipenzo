import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureManifestV1 } from '@agent-dock/shared';
import { buildGitEnvironment } from './pipenzo-git.js';
import { CAPTURE_RUNNER_SOURCE } from './capture-runner-source.js';
import { resolveCaptureManifestSet, type ResolvedCapture } from './capture-manifest.js';

/**
 * The screenshot-verification executor (Pipenzo issue #139).
 *
 * README's rule, restated as three things this module does and one it refuses to do:
 *
 * - **The daemon owns every Playwright call.** The calls live in `CAPTURE_RUNNER_SOURCE`, a fixed
 *   daemon-authored program. The agent's manifest reaches it as JSON on stdin.
 * - **Navigation is confined to the ephemeral localhost origin the daemon started.** Checked
 *   before the spawn (`resolveCaptureUrl`, comparing resolved origins) and again inside the page
 *   (every request intercepted, every off-origin frame navigation failing the capture).
 * - **Playwright is the repository's own, and it does not run in this process.** It is resolved
 *   from the repository and imported by the child, which is spawned on `buildGitEnvironment()`'s
 *   reviewed floor — so the PAT this daemon holds is not in the environment of the browser
 *   automation library a repository happens to have vendored.
 * - **It refuses rather than degrading quietly.** No Playwright means `unavailable` with a stated
 *   reason, and a capture that failed is recorded as failed. A missing capability that looked like
 *   a passing one would make the evidence block worthless, which is the same argument
 *   `review-gates.ts` makes about an uninstalled scanner.
 *
 * ## And the thing it can never do
 *
 * Screenshot evidence **never satisfies a gate**. `SCREENSHOT_EVIDENCE_SATISFIES_GATE` is a
 * `false` constant rather than a convention, and the result type carries the fixed provenance line
 * README requires, so a renderer cannot present a capture as a machine-verified check.
 */

/** README: the capture "carries a fixed provenance line and can never satisfy a gate". */
export const SCREENSHOT_EVIDENCE_SATISFIES_GATE = false as const;
export const SCREENSHOT_PROVENANCE_V1 =
  'Captured by Pipenzo from an agent-proposed manifest, against a dev server the daemon started. Evidence only — this never satisfies a gate.';

export type PlaywrightPackageName = 'playwright' | '@playwright/test';
const PLAYWRIGHT_PACKAGES: readonly PlaywrightPackageName[] = ['playwright', '@playwright/test'];

export type ScreenshotCapabilityV1 =
  | {
      readonly available: true;
      readonly packageName: PlaywrightPackageName;
      /** The repository package.json the child resolves Playwright relative to. */
      readonly requireFrom: string;
    }
  | { readonly available: false; readonly reason: string };

/**
 * Capability detection, per README ("capability-detected; degrades to a stated-out-loud reduced
 * mode rather than an error").
 *
 * Resolution only — the module is never *loaded* here. Loading it would be the exact mistake this
 * module exists to avoid, and `require.resolve` answers the question being asked ("does this
 * repository have Playwright?") without executing any of it.
 */
export function detectScreenshotCapability(repositoryPath: string): ScreenshotCapabilityV1 {
  const requireFrom = join(repositoryPath, 'package.json');
  let resolver: NodeJS.Require;
  try {
    resolver = createRequire(requireFrom);
  } catch {
    return { available: false, reason: 'the repository path is not resolvable' };
  }
  for (const packageName of PLAYWRIGHT_PACKAGES) {
    try {
      resolver.resolve(packageName);
      return { available: true, packageName, requireFrom };
    } catch {
      // Try the next candidate. A missing package is the expected case, not an error.
    }
  }
  return {
    available: false,
    reason: 'this repository has no Playwright dependency; screenshot verification is off',
  };
}

export type CaptureShotStatus = 'captured' | 'failed';

export interface CaptureShotResult {
  readonly name: string;
  readonly status: CaptureShotStatus;
  /** Daemon-internal absolute path. Projected to the renderer as evidence, never as a path. */
  readonly outputPath?: string;
  readonly reason?: string;
  readonly durationMs: number;
}

export type CaptureRunResult =
  | {
      readonly status: 'completed';
      readonly provenance: string;
      readonly satisfiesGate: typeof SCREENSHOT_EVIDENCE_SATISFIES_GATE;
      readonly shots: readonly CaptureShotResult[];
    }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'errored'; readonly reason: string };

export interface CaptureRequest {
  /** Where Playwright is resolved from — the checkout being captured. */
  readonly repositoryPath: string;
  /** The dev server the daemon started. Loopback http only; asserted before anything runs. */
  readonly origin: string;
  /** The agent's proposal, still raw. Validated here, never earlier and never on trust. */
  readonly manifest: unknown;
  /** Where the PNGs land. Created if absent. */
  readonly outputDirectory: string;
}

export interface ScreenshotCaptureOptions {
  /** Per Playwright call. A hung selector must not hold the ticket's execution slot. */
  stepTimeoutMs?: number;
  /** For the whole child process, across every capture in the set. */
  runTimeoutMs?: number;
  /** Injection seam for tests. Production always spawns the real runner. */
  runner?: CaptureRunner;
}

/** Runs the fixed runner program with a JSON job on stdin. The one seam a test replaces. */
export interface CaptureRunner {
  run(input: {
    job: unknown;
    scriptPath: string;
    cwd: string;
    timeoutMs: number;
  }): Promise<{ stdout: string; stderr: string; code: number }>;
}

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_RUN_TIMEOUT_MS = 5 * 60_000;

export class ScreenshotCaptureExecutor {
  readonly #stepTimeoutMs: number;
  readonly #runTimeoutMs: number;
  readonly #runner: CaptureRunner;

  constructor(options: ScreenshotCaptureOptions = {}) {
    this.#stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.#runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.#runner = options.runner ?? new NodeCaptureRunner();
  }

  async capture(request: CaptureRequest): Promise<CaptureRunResult> {
    const capability = detectScreenshotCapability(request.repositoryPath);
    if (!capability.available) return { status: 'unavailable', reason: capability.reason };

    let resolved: readonly ResolvedCapture[];
    try {
      resolved = resolveCaptureManifestSet(request.manifest, request.origin).captures;
    } catch (error) {
      return {
        status: 'errored',
        reason: error instanceof Error ? error.message : 'the capture manifest was rejected',
      };
    }

    await mkdir(request.outputDirectory, { recursive: true });
    // Written next to the output rather than into the repository: the runner is the daemon's
    // program, and a repository must never be able to shadow or edit it.
    const scriptPath = join(request.outputDirectory, 'pipenzo-capture-runner.mjs');
    await writeFile(scriptPath, CAPTURE_RUNNER_SOURCE, 'utf8');

    const job = {
      requireFrom: capability.requireFrom,
      packageName: capability.packageName,
      origin: new URL(request.origin).origin,
      stepTimeoutMs: this.#stepTimeoutMs,
      captures: resolved.map(({ capture, url }) => ({
        name: capture.name,
        url: url.toString(),
        viewport: capture.viewport,
        waitForSelector: capture.waitForSelector,
        actions: capture.actions.map((action) => ({ ...action })),
        outputPath: join(request.outputDirectory, `${capture.name}.png`),
      })),
    };

    let outcome;
    try {
      outcome = await this.#runner.run({
        job,
        scriptPath,
        cwd: request.repositoryPath,
        timeoutMs: this.#runTimeoutMs,
      });
    } catch (error) {
      return {
        status: 'errored',
        reason: error instanceof Error ? error.message : 'the capture runner could not start',
      };
    }
    return this.#interpret(outcome, resolved);
  }

  #interpret(
    outcome: { stdout: string; stderr: string; code: number },
    resolved: readonly ResolvedCapture[],
  ): CaptureRunResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.stdout);
    } catch {
      // A runner that produced no parseable answer is an *error*, never an empty success. Nothing
      // downstream may read "no shots" as "nothing to show".
      return { status: 'errored', reason: 'the capture runner produced no readable result' };
    }
    const body = parsed as { ok?: unknown; reason?: unknown; results?: unknown };
    if (body.ok !== true) {
      return {
        status: 'errored',
        reason: typeof body.reason === 'string' ? body.reason.slice(0, 1_000) : 'capture failed',
      };
    }
    const rows = Array.isArray(body.results) ? body.results : [];
    const byName = new Map<string, CaptureShotResult>();
    for (const row of rows) {
      const shot = row as Partial<CaptureShotResult> & { name?: unknown };
      if (typeof shot.name !== 'string') continue;
      byName.set(shot.name, {
        name: shot.name,
        status: shot.status === 'captured' ? 'captured' : 'failed',
        ...(typeof shot.outputPath === 'string' ? { outputPath: shot.outputPath } : {}),
        ...(typeof shot.reason === 'string' ? { reason: shot.reason.slice(0, 1_000) } : {}),
        durationMs: typeof shot.durationMs === 'number' ? Math.max(0, shot.durationMs) : 0,
      });
    }
    // Every capture in the manifest gets a row, in the manifest's own order. A capture the runner
    // said nothing about is reported as failed rather than silently dropped — a shorter list than
    // the manifest is exactly how missing evidence would go unnoticed.
    return {
      status: 'completed',
      provenance: SCREENSHOT_PROVENANCE_V1,
      satisfiesGate: SCREENSHOT_EVIDENCE_SATISFIES_GATE,
      shots: resolved.map(
        ({ capture }): CaptureShotResult =>
          byName.get(capture.name) ?? {
            name: capture.name,
            status: 'failed',
            reason: 'the capture runner reported no result for this capture',
            durationMs: 0,
          },
      ),
    };
  }
}

/**
 * The real runner: `node <script>` with the job on stdin.
 *
 * `buildGitEnvironment()` rather than `process.env`, for the reason `pipenzo-git.ts` spells out —
 * this child loads the repository's own `node_modules`, which is human-committed but not
 * daemon-reviewed code, and it must not be able to read the credential this daemon holds.
 */
export class NodeCaptureRunner implements CaptureRunner {
  async run(input: {
    job: unknown;
    scriptPath: string;
    cwd: string;
    timeoutMs: number;
  }): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [input.scriptPath], {
        cwd: input.cwd,
        windowsHide: true,
        env: buildGitEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('the capture runner exceeded its time budget'));
      }, input.timeoutMs);
      timer.unref?.();

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < 4_000_000) stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 200_000) stderr += chunk;
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? 1 });
      });
      child.stdin.end(JSON.stringify(input.job));
    });
  }
}

/** Exported for the tests that assert the shape of what the daemon hands its own runner. */
export type CaptureJobCapture = {
  readonly name: CaptureManifestV1['name'];
  readonly url: string;
};
