import { spawn } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SCREENSHOT_PROVENANCE_LINES_V1 } from '@agent-dock/shared';
import { buildGitEnvironment } from './pipenzo-git.js';
import type { PipenzoCommandConfig } from './pipenzo-repo-config.js';
import {
  SCREENSHOT_EVIDENCE_SATISFIES_GATE,
  type CaptureRunResult,
  type CaptureShotResult,
} from './screenshot-capture.js';

/**
 * The `pipenzo.verify.screenshot` escape hatch (Pipenzo issue #141).
 *
 * README puts this in its own trust class, and is precise about why:
 *
 * > The `pipenzo.verify.screenshot` escape hatch for repos without Playwright stays a free-form
 * > command — that one is a *different trust class*, because it is repo-authored and
 * > human-committed, so a person has already reviewed it, exactly like a build script.
 *
 * It is worth being blunt about what this module gives up, because the answer is "most of what
 * #138 and #139 were built to enforce":
 *
 * | | agent-proposed manifest | this |
 * |---|---|---|
 * | who wrote the instructions | the model, this run | a human, in a reviewed commit |
 * | vocabulary | two actions, closed schema | whatever the command does |
 * | who makes the browser calls | the daemon, from a fixed program | the repository's command |
 * | origin confinement | enforced twice | none — the command can reach anything |
 *
 * That trade is acceptable for exactly one reason, and it is not "screenshots are low risk". It is
 * that this command has the same provenance as `pnpm build`, which the deterministic gates already
 * run. A repository that can make Pipenzo run its build script can already run arbitrary code on
 * this machine; adding a second reviewed script does not widen that.
 *
 * ## What is deliberately *not* passed to it
 *
 * **The agent's capture manifest.** Not the routes, not the selectors, not the fill values, not
 * even the manifest's names. That is the one rule that keeps the trust classes from merging: the
 * moment agent-authored strings become input to a free-form command, the command's provenance
 * stops being the only thing that determined what ran. This module passes the port, the origin and
 * an output directory — three daemon-chosen values — and nothing else.
 *
 * The environment floor is `buildGitEnvironment()`, same as the build gate and the dev server, so
 * a reviewed script still cannot read the daemon's PAT.
 */

export type EscapeHatchErrorCode = 'not_configured' | 'command_failed' | 'no_output';

export interface EscapeHatchRequest {
  readonly command: PipenzoCommandConfig;
  /** The checkout to run in — the ticket worktree or the baseline checkout. */
  readonly cwd: string;
  /** The dev server the daemon started for this run. */
  readonly origin: string;
  readonly port: number;
  readonly outputDirectory: string;
}

export interface EscapeHatchOptions {
  timeoutMs?: number;
  /** Injection seam for tests. Production always spawns the repository's own command. */
  spawnCommand?: (input: {
    command: PipenzoCommandConfig;
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
  }) => Promise<{ code: number; stderr: string }>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/**
 * Runs the repository's own capture command and collects whatever images it wrote.
 *
 * "Whatever it wrote" is the honest description and the reason the result shape is different from
 * the manifest path's: there is no manifest to pair the output against, so a shot is named after
 * its file and nothing here can claim a particular picture was taken. A caller that wanted the
 * before/after pairing the manifest path gives gets it by filename, which is the repository's
 * choice to make consistent.
 */
export class ScreenshotEscapeHatchRunner {
  readonly #timeoutMs: number;
  readonly #spawn: NonNullable<EscapeHatchOptions['spawnCommand']>;

  constructor(options: EscapeHatchOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#spawn = options.spawnCommand ?? spawnRepoCommand;
  }

  async run(request: EscapeHatchRequest): Promise<CaptureRunResult> {
    await mkdir(request.outputDirectory, { recursive: true });
    // Three daemon-chosen values, and nothing derived from the agent's manifest. See the module
    // comment: this is what keeps the two trust classes from quietly becoming one.
    const env: Record<string, string | undefined> = {
      ...buildGitEnvironment(),
      PORT: String(request.port),
      PIPENZO_PORT: String(request.port),
      PIPENZO_ORIGIN: request.origin,
      PIPENZO_SCREENSHOT_DIR: request.outputDirectory,
    };

    let outcome: { code: number; stderr: string };
    try {
      outcome = await this.#spawn({
        command: request.command,
        cwd: request.cwd,
        env,
        timeoutMs: this.#timeoutMs,
      });
    } catch (error) {
      return {
        status: 'errored',
        reason: error instanceof Error ? error.message : 'the capture command could not run',
      };
    }
    if (outcome.code !== 0) {
      return {
        status: 'errored',
        reason: `pipenzo.verify.screenshot exited ${outcome.code}: ${outcome.stderr.slice(0, 500)}`.trim(),
      };
    }

    const shots = await collectImages(request.outputDirectory);
    if (shots.length === 0) {
      // An empty output directory is an error, not an empty success. A command that ran and wrote
      // nothing produced no evidence, and an evidence block showing "0 screenshots, all fine" is
      // the same failure mode `review-gates.ts` refuses for an uninstalled scanner.
      return {
        status: 'errored',
        reason: 'pipenzo.verify.screenshot wrote no images to PIPENZO_SCREENSHOT_DIR',
      };
    }
    return {
      status: 'completed',
      provenance: SCREENSHOT_PROVENANCE_LINES_V1['repo-authored-command'],
      satisfiesGate: SCREENSHOT_EVIDENCE_SATISFIES_GATE,
      shots,
    };
  }
}

async function collectImages(directory: string): Promise<CaptureShotResult[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const shots: CaptureShotResult[] = [];
  for (const entry of entries.sort()) {
    const dot = entry.lastIndexOf('.');
    if (dot < 0 || !IMAGE_EXTENSIONS.has(entry.slice(dot).toLowerCase())) continue;
    const outputPath = join(directory, entry);
    try {
      if (!(await stat(outputPath)).isFile()) continue;
    } catch {
      continue;
    }
    shots.push({
      name: entry.slice(0, dot),
      status: 'captured',
      outputPath,
      durationMs: 0,
    });
  }
  return shots;
}

function spawnRepoCommand(input: {
  command: PipenzoCommandConfig;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command.command, [...input.command.args], {
      cwd: input.cwd,
      windowsHide: true,
      // No shell, for the same reason `pipenzo-repo-config.ts` refuses shell strings: the argv is
      // the repository's, and it stays argv.
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: input.env,
    });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('pipenzo.verify.screenshot exceeded its time budget'));
    }, input.timeoutMs);
    timer.unref?.();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
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
      resolve({ code: code ?? 1, stderr });
    });
  });
}
