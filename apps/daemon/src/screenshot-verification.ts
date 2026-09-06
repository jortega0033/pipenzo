import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import {
  SCREENSHOT_PROVENANCE_LINES_V1,
  type OwnedWorktreeV2,
  type ScreenshotTrustClassV1,
} from '@agent-dock/shared';
import { buildGitEnvironment } from './pipenzo-git.js';
import { readPipenzoRepoConfig, type PipenzoCommandConfig } from './pipenzo-repo-config.js';
import {
  ScreenshotCaptureExecutor,
  detectScreenshotCapability,
  type CaptureRunResult,
  SCREENSHOT_EVIDENCE_SATISFIES_GATE,
} from './screenshot-capture.js';
import { ScreenshotEscapeHatchRunner } from './screenshot-escape-hatch.js';

/**
 * Baseline capture and the serial execution slot (Pipenzo issue #140).
 *
 * README counts two non-token costs against a ticket honestly rather than hiding them, and this
 * module is where both become real:
 *
 * > **screenshot verification's baseline capture is a second checkout of the base commit and a
 * > second dev-server run per ticket** — real wall-clock and real disk, not free — and the capture
 * > step takes the execution slot **serially** (the capture manifest carries a port the daemon
 * > injects, so two concurrent captures cannot collide on the dev server's default port).
 *
 * ## The slot is a real mutex, not a convention
 *
 * `ScreenshotExecutionSlot` serialises the whole capture step across every ticket in the daemon.
 * The stated reason in README is port collision, and that is the immediate one — but the deeper
 * one is that a screenshot is a *comparison*, and two dev servers competing for CPU on one machine
 * produce before/after pairs that differ for reasons nobody can attribute to the diff. A capture
 * that races is not slower evidence; it is worse evidence.
 *
 * The port is chosen per run and injected, so even the serialisation failing open would not put
 * two servers on one port. Belt and braces, in that order: the slot is the belt.
 *
 * ## What the baseline actually costs, said out loud
 *
 * A second owned worktree at the base commit, and a second run of the repository's dev server.
 * `BaselineCost` is returned alongside the evidence so a ticket's budget view can show it, because
 * a cost the operator cannot see is a cost they cannot decide about.
 *
 * The baseline worktree is agentdock's `OwnedWorktreeManager`, not a parallel concept — same
 * reasoning as `implement-orchestrator.ts`: trust gating, per-repository serialisation and cleanup
 * already live there, and a second worktree mechanism would be a second set of all three.
 */

/* -------------------------------------------------------------- the slot */

/**
 * One capture at a time, daemon-wide.
 *
 * A promise chain rather than a counter: it holds FIFO order, it cannot leak a permit on a throw
 * (the `finally` runs on both paths), and it needs no polling. A caller that never releases would
 * block the queue, so `run()` owns the release rather than handing one out.
 */
export class ScreenshotExecutionSlot {
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  /** How many runs are queued behind the one holding the slot. For the budget view. */
  get queueDepth(): number {
    return this.#depth;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.#depth += 1;
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      this.#depth -= 1;
      release();
    }
  }
}

/* --------------------------------------------------------- the dev server */

export interface DevServerHandle {
  readonly origin: string;
  readonly port: number;
  stop(): Promise<void>;
}

export type DevServerErrorCode = 'not_configured' | 'no_free_port' | 'did_not_listen' | 'exited';

export class DevServerError extends Error {
  readonly code: DevServerErrorCode;

  constructor(code: DevServerErrorCode, message: string) {
    super(message);
    this.name = 'DevServerError';
    this.code = code;
  }
}

/** Asks the OS for a free loopback port and immediately gives it back. */
export function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', () => reject(new DevServerError('no_free_port', 'no free loopback port')));
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() =>
        port > 0
          ? resolve(port)
          : reject(new DevServerError('no_free_port', 'no free loopback port')),
      );
    });
  });
}

function portAccepts(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export interface DevServerStarter {
  start(input: {
    command: PipenzoCommandConfig;
    cwd: string;
    port: number;
    readyTimeoutMs: number;
  }): Promise<DevServerHandle>;
}

/**
 * Starts the repository's own dev server on a port the daemon chose.
 *
 * The port is injected through the environment (`PORT`, plus `PIPENZO_PORT` for a script that
 * wants to be explicit about where the number came from) rather than appended to argv, because
 * argv is the repository's to write and appending to it would change a command a human reviewed.
 *
 * The environment floor is `buildGitEnvironment()` for the reason `gate-commands.ts` gives: this
 * is a repository's own script, running next to a daemon that holds a PAT, and it has no business
 * being able to read it. `PIPENZO_GITHUB_TOKEN` is not on that floor.
 */
export class SpawnDevServer implements DevServerStarter {
  async start(input: {
    command: PipenzoCommandConfig;
    cwd: string;
    port: number;
    readyTimeoutMs: number;
  }): Promise<DevServerHandle> {
    const child: ChildProcess = spawn(input.command.command, [...input.command.args], {
      cwd: input.cwd,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...buildGitEnvironment(), PORT: String(input.port), PIPENZO_PORT: String(input.port) },
    });
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    const stop = async (): Promise<void> => {
      if (exited || child.killed) return;
      child.kill();
      // A dev server that ignores SIGTERM would otherwise hold its port past the next run, which
      // is the collision the injected port and the slot both exist to prevent.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
        timer.unref?.();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    };

    const deadline = Date.now() + input.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        throw new DevServerError('exited', 'the dev server exited before it accepted a connection');
      }
      if (await portAccepts(input.port, 1_000)) {
        return { origin: `http://127.0.0.1:${input.port}`, port: input.port, stop };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await stop();
    throw new DevServerError('did_not_listen', 'the dev server did not accept a connection in time');
  }
}

/* ---------------------------------------------------------- the baseline */

/** The slice of `OwnedWorktreeManager` the baseline checkout uses. */
export interface BaselineWorktreeManager {
  create(input: {
    cwd: string;
    name: string;
    ref?: string;
    confirmIncludeCopy: true;
  }): Promise<OwnedWorktreeV2>;
  ownedLocation(id: string): { id: string; path: string; sourcePath: string } | undefined;
  cleanup(
    worktreeId: string,
    options?: { deleteUntracked?: boolean; deleteBranch?: boolean },
  ): Promise<OwnedWorktreeV2>;
}

/** The two costs README insists are counted rather than hidden. */
export interface BaselineCost {
  /** True when a second checkout of the base commit was actually made for this run. */
  readonly extraCheckout: boolean;
  /** True when a second dev-server run happened for this run. */
  readonly extraDevServerRun: boolean;
  readonly baselineMs: number;
  readonly headMs: number;
  /** How long this run waited for the serial capture slot. Real wall-clock, attributed. */
  readonly slotWaitMs: number;
}

export type ScreenshotVerificationResult =
  | {
      readonly status: 'completed';
      /**
       * Which of README's two trust classes produced this evidence (issue #141). Always reported,
       * never inferred by a renderer: the two are secure for different reasons, and a reader has
       * to know which reason applies to the picture in front of them.
       */
      readonly trustClass: ScreenshotTrustClassV1;
      readonly provenance: string;
      readonly satisfiesGate: typeof SCREENSHOT_EVIDENCE_SATISFIES_GATE;
      readonly baseline: CaptureRunResult;
      readonly head: CaptureRunResult;
      readonly cost: BaselineCost;
    }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'errored'; readonly reason: string };

export interface ScreenshotVerificationRequest {
  /** The source repository. Its `package.json` is the human-committed one — see the config module. */
  readonly repositoryPath: string;
  /** The ticket's own worktree, already carrying the implement session's commits. */
  readonly worktreeId: string;
  readonly baseCommit: string;
  /** Where the evidence lands; `baseline/` and `head/` are created beneath it. */
  readonly evidenceDirectory: string;
  readonly manifest: unknown;
}

export interface ScreenshotVerificationOptions {
  worktrees: BaselineWorktreeManager;
  slot?: ScreenshotExecutionSlot;
  devServer?: DevServerStarter;
  capture?: ScreenshotCaptureExecutor;
  escapeHatch?: ScreenshotEscapeHatchRunner;
  readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 120_000;

export class ScreenshotVerificationRunner {
  readonly #worktrees: BaselineWorktreeManager;
  readonly #slot: ScreenshotExecutionSlot;
  readonly #devServer: DevServerStarter;
  readonly #capture: ScreenshotCaptureExecutor;
  readonly #escapeHatch: ScreenshotEscapeHatchRunner;
  readonly #readyTimeoutMs: number;

  constructor(options: ScreenshotVerificationOptions) {
    this.#worktrees = options.worktrees;
    this.#slot = options.slot ?? new ScreenshotExecutionSlot();
    this.#devServer = options.devServer ?? new SpawnDevServer();
    this.#capture = options.capture ?? new ScreenshotCaptureExecutor();
    this.#escapeHatch = options.escapeHatch ?? new ScreenshotEscapeHatchRunner();
    this.#readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  async run(request: ScreenshotVerificationRequest): Promise<ScreenshotVerificationResult> {
    const location = this.#worktrees.ownedLocation(request.worktreeId);
    if (!location) return { status: 'errored', reason: 'no such owned worktree' };

    // Read from the *source* repository, never the ticket worktree: the agent has had write access
    // to the worktree's package.json for the whole Implement phase, and this command's entire
    // claim to being trusted is that a human committed it.
    let serve: PipenzoCommandConfig | undefined;
    let escapeHatchCommand: PipenzoCommandConfig | undefined;
    try {
      const config = await readPipenzoRepoConfig(location.sourcePath);
      serve = config.serve;
      escapeHatchCommand = config.screenshot;
    } catch (error) {
      return {
        status: 'errored',
        reason: error instanceof Error ? error.message : 'the repository config is unreadable',
      };
    }
    if (!serve) {
      return {
        status: 'unavailable',
        reason:
          'this repository configures no pipenzo.verify.serve command; screenshot verification is off',
      };
    }

    /**
     * Which trust class this run uses, decided here and only here.
     *
     * README's rule: the agent-proposed manifest is the path, and `pipenzo.verify.screenshot` is
     * "the escape hatch for repos without Playwright". So Playwright decides. A repository with
     * Playwright does not get to swap in a free-form command by also configuring one — that would
     * let the weaker trust class win by being listed, rather than by being the only option.
     */
    const capability = detectScreenshotCapability(location.sourcePath);
    const escapeHatch = capability.available ? undefined : escapeHatchCommand;
    if (!capability.available && !escapeHatch) {
      return {
        status: 'unavailable',
        reason: `${capability.reason}, and this repository configures no pipenzo.verify.screenshot command either`,
      };
    }
    const trustClass: ScreenshotTrustClassV1 = escapeHatch
      ? 'repo-authored-command'
      : 'agent-proposed-manifest';

    const queuedAt = Date.now();
    return this.#slot.run(async () => {
      const slotWaitMs = Date.now() - queuedAt;
      return this.#runInSlot(request, location, serve, trustClass, escapeHatch, slotWaitMs);
    });
  }

  async #runInSlot(
    request: ScreenshotVerificationRequest,
    location: { path: string; sourcePath: string },
    serve: PipenzoCommandConfig,
    trustClass: ScreenshotTrustClassV1,
    escapeHatch: PipenzoCommandConfig | undefined,
    slotWaitMs: number,
  ): Promise<ScreenshotVerificationResult> {
    let baselineWorktreeId: string | undefined;
    try {
      // The second checkout README counts as a real cost: a detached owned worktree at the base
      // commit, so the "before" picture is of the code as it was, not of the code with the change
      // reverted by hand.
      const baselineWorktree = await this.#worktrees.create({
        cwd: location.sourcePath,
        name: `pipenzo-baseline-${request.baseCommit.slice(0, 12)}`,
        ref: request.baseCommit,
        confirmIncludeCopy: true,
      });
      baselineWorktreeId = baselineWorktree.id;
      const baselineLocation = this.#worktrees.ownedLocation(baselineWorktree.id);
      if (!baselineLocation) {
        return { status: 'errored', reason: 'the baseline checkout could not be located' };
      }

      const baselineStarted = Date.now();
      const baseline = await this.#captureAt(
        baselineLocation.path,
        serve,
        escapeHatch,
        request.manifest,
        join(request.evidenceDirectory, 'baseline'),
      );
      const baselineMs = Date.now() - baselineStarted;

      const headStarted = Date.now();
      const head = await this.#captureAt(
        location.path,
        serve,
        escapeHatch,
        request.manifest,
        join(request.evidenceDirectory, 'head'),
      );
      const headMs = Date.now() - headStarted;

      return {
        status: 'completed',
        trustClass,
        provenance: SCREENSHOT_PROVENANCE_LINES_V1[trustClass],
        satisfiesGate: SCREENSHOT_EVIDENCE_SATISFIES_GATE,
        baseline,
        head,
        cost: {
          extraCheckout: true,
          extraDevServerRun: true,
          baselineMs,
          headMs,
          slotWaitMs,
        },
      };
    } catch (error) {
      return {
        status: 'errored',
        reason: error instanceof Error ? error.message : 'screenshot verification failed',
      };
    } finally {
      if (baselineWorktreeId) {
        // The baseline is disposable by construction — a detached checkout of an existing commit
        // that nothing wrote to. `deleteUntracked` is safe here for that reason and is not a
        // licence the ticket worktree ever gets.
        await this.#worktrees
          .cleanup(baselineWorktreeId, { deleteUntracked: true })
          .catch(() => undefined);
      }
    }
  }

  /** One dev server, one port, one capture set — started and stopped inside the slot. */
  async #captureAt(
    cwd: string,
    serve: PipenzoCommandConfig,
    escapeHatch: PipenzoCommandConfig | undefined,
    manifest: unknown,
    outputDirectory: string,
  ): Promise<CaptureRunResult> {
    const port = await reserveEphemeralPort();
    let server: DevServerHandle;
    try {
      server = await this.#devServer.start({
        command: serve,
        cwd,
        port,
        readyTimeoutMs: this.#readyTimeoutMs,
      });
    } catch (error) {
      return {
        status: 'errored',
        reason: error instanceof Error ? error.message : 'the dev server did not start',
      };
    }
    try {
      // Note what the escape hatch is *not* handed: the manifest. Three daemon-chosen values reach
      // a repo-authored command, and no agent-authored string does — see
      // `screenshot-escape-hatch.ts` for why that is what keeps the two trust classes apart.
      return escapeHatch
        ? await this.#escapeHatch.run({
            command: escapeHatch,
            cwd,
            origin: server.origin,
            port: server.port,
            outputDirectory,
          })
        : await this.#capture.capture({
            repositoryPath: cwd,
            origin: server.origin,
            manifest,
            outputDirectory,
          });
    } finally {
      await server.stop().catch(() => undefined);
    }
  }
}
