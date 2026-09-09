import { execFile } from 'node:child_process';
import { buildGitEnvironment } from './pipenzo-git.js';
import type { CommandResult, GateCommandRunner } from './review-gates.js';

/**
 * The real `GateCommandRunner` behind the deterministic review gates (Pipenzo issue #184; the
 * interface is #181's).
 *
 * Every command it runs is repository-supplied in the way that matters: `pnpm build` runs the
 * repo's build script, `pnpm test` runs the repo's tests, and both execute code an agent has just
 * been editing. This daemon process holds a GitHub PAT. So the environment floor is
 * `buildGitEnvironment()` — agentdock's reviewed OS/runtime allowlist — for exactly the reason
 * `pipenzo-git.ts` states at length: repo-supplied code must not run with the token in its
 * environment. Note what that excludes: `PIPENZO_GITHUB_TOKEN`, and every `AGENT_DOCK_*` variable,
 * so a gate command cannot reach back into the daemon it was started by either.
 *
 * `available()` is a real probe rather than a `PATH` scan, because "installed" and "runnable" are
 * different facts and a gate that reports `skipped: not installed` should mean it. A missing
 * binary answers `false` and the gate records the absence; it never records a clean pass.
 */
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const AVAILABILITY_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 8 * 1024 * 1024;

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        env: buildGitEnvironment(),
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr, code: 0 });
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'number') return resolve({ stdout, stderr, code });
        reject(error);
      },
    );
  });
}

export class ExecFileGateCommands implements GateCommandRunner {
  readonly #cwd: string;
  readonly #timeoutMs: number;
  /** One probe per binary per daemon lifetime: the deterministic gates should not spawn one
   * `--version` run each -- several (build, typecheck and, since issue #283, lint) already share
   * the same `pnpm` executable and this cache is what keeps that to one probe. */
  readonly #probes = new Map<string, Promise<boolean>>();

  constructor(options: { probeCwd: string; timeoutMs?: number }) {
    this.#cwd = options.probeCwd;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async available(command: string): Promise<boolean> {
    const cached = this.#probes.get(command);
    if (cached) return cached;
    const probe = run(command, ['--version'], this.#cwd, AVAILABILITY_TIMEOUT_MS).then(
      // A non-zero exit still proves the binary exists and ran; only a failure to launch does not.
      () => true,
      () => false,
    );
    this.#probes.set(command, probe);
    return probe;
  }

  async run(command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
    try {
      return await run(command, args, cwd, this.#timeoutMs);
    } catch (error) {
      // A gate that could not launch is an *errored* gate, and the runner reports that through a
      // non-zero code rather than by throwing — a throw here would abort the whole review run and
      // lose the gates that already passed.
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : `${command} could not run`,
        code: 127,
      };
    }
  }
}
