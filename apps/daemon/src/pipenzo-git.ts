import { execFile } from 'node:child_process';
import { buildBaseProcessEnvironment, copyCanonicalEnvKeys } from '@agent-dock/agent-runtime';

/**
 * The one hardened `git` invocation every Pipenzo daemon-side module shares (issue #178).
 *
 * ## Why this exists at all
 *
 * agentdock's own `git` call sites hand children `{ ...process.env }`, and that was correct for
 * agentdock: nothing in its daemon process held a credential, so inheriting the environment cost
 * it nothing. Pipenzo's daemon holds a GitHub PAT. That single change invalidates the reasoning
 * behind every one of those call sites at once, because `git worktree add` fires the repository's
 * `post-checkout` hook, `git status` can invoke a `core.fsmonitor` command, and a checkout runs
 * `filter.*.smudge` — all of which resolve from a `.git` directory an agent working in a linked
 * worktree can write to. Repo-supplied code executing with a `repo`-scoped PAT in its environment
 * would defeat the property this whole design rests on, from the side nobody was looking at.
 *
 * So: one module, one reviewed floor, and a source-level test
 * (`publish-token-boundary.test.ts`) asserting no `execFile('git'` site in `apps/daemon/src`
 * builds its environment any other way.
 *
 * ## Two floors, not one
 *
 * `buildGitEnvironment()` is the default: agentdock's reviewed OS/runtime allowlist plus the two
 * `GIT_*` behaviour flags. It carries no agent socket and no session bus, which is deliberate —
 * these are the commands that can run repository-supplied hooks, and handing a hook the user's
 * `SSH_AUTH_SOCK` would let it authenticate as the user to anything the agent chose.
 *
 * `buildGitPushEnvironment()` adds exactly the keys a credential helper needs to be reachable at
 * all — SSH agent, `GIT_SSH_COMMAND`, the Linux secret-service bus, XDG config. Without them an
 * SSH remote cannot push, `libsecret` cannot answer, and an XDG-configured `credential.helper` is
 * invisible; with `GIT_TERMINAL_PROMPT=0` that surfaces as an opaque failure, and the obvious
 * field fix for an opaque failure is `{ ...process.env }`, which is how this hardening would have
 * been undone in a hurry. It is used by exactly one command — the push — and that command carries
 * `--no-verify`, so no repository hook runs inside this wider environment.
 *
 * Note what is on neither floor: `PIPENZO_GITHUB_TOKEN`, and every `AGENT_DOCK_*` variable.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Reachability keys for the user's own credential helper, and nothing else. Each one is here
 * because without it a real-world push configuration silently cannot authenticate:
 * `SSH_AUTH_SOCK`/`SSH_AGENT_PID` for an SSH remote, `GIT_SSH_COMMAND` for a custom SSH binary,
 * `DBUS_SESSION_BUS_ADDRESS`/`DISPLAY` for Linux `libsecret`, `XDG_CONFIG_HOME`/`XDG_RUNTIME_DIR`
 * for a helper configured outside `$HOME/.gitconfig`.
 */
export const GIT_CREDENTIAL_REACHABILITY_ENV_KEYS = Object.freeze([
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'GIT_SSH_COMMAND',
  'SSH_AGENT_PID',
  'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
] as const);

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface RunGitOptions {
  /** Widens the environment to reach a credential helper. Only the push sets this. */
  readonly credentialReachable?: boolean;
  readonly timeoutMs?: number;
}

/** Injection seam for tests. Production always uses `runGitCommand`. */
export type PipenzoGitRunner = (
  args: readonly string[],
  cwd: string,
  options?: RunGitOptions,
) => Promise<GitCommandResult>;

function gitBehaviourFlags(target: Record<string, string | undefined>): void {
  // No interactive prompt: a missing credential must fail fast rather than hang a daemon request
  // for the full command timeout.
  target.GIT_TERMINAL_PROMPT = '0';
  target.GIT_OPTIONAL_LOCKS = '0';
}

/** The default floor. Use this for every git command except the push. */
export function buildGitEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const target = buildBaseProcessEnvironment(env);
  gitBehaviourFlags(target);
  return target;
}

/** The push floor: the default plus credential-helper reachability. See the module comment. */
export function buildGitPushEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const target = buildBaseProcessEnvironment(env);
  copyCanonicalEnvKeys(env, GIT_CREDENTIAL_REACHABILITY_ENV_KEYS, target);
  gitBehaviourFlags(target);
  return target;
}

export class GitCommandFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitCommandFailure';
  }
}

/**
 * Runs one git command. A non-zero exit is a *result*, not a throw — every caller has a different
 * opinion about which exit codes are expected (a missing branch, an already-up-to-date push), and
 * flattening them into one exception would lose that. Only a failure to run git at all (missing
 * binary, timeout, buffer overflow) rejects.
 */
export function runGit(
  args: readonly string[],
  cwd: string,
  options: RunGitOptions = {},
): Promise<GitCommandResult> {
  return new Promise<GitCommandResult>((resolvePromise, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER,
        env: options.credentialReachable ? buildGitPushEnvironment() : buildGitEnvironment(),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ stdout, stderr, code: 0 });
          return;
        }
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'number') {
          resolvePromise({ stdout, stderr, code });
          return;
        }
        reject(new GitCommandFailure(`git ${args[0] ?? ''} could not run: ${error.message}`));
      },
    );
  });
}

export const runGitCommand: PipenzoGitRunner = (args, cwd, options) => runGit(args, cwd, options);
