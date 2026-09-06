import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The repository's own screenshot-verification configuration (Pipenzo issues #140, #141).
 *
 * README names one of these settings directly — `pipenzo.verify.screenshot` — and describes its
 * trust class precisely: it is "repo-authored and human-committed, so a person has already
 * reviewed it, exactly like a build script." That sentence decides where this configuration lives
 * and what shape it has.
 *
 * **Where.** In the repository's own `package.json`, under a `pipenzo` key. A file a human commits
 * and a reviewer sees in a diff, alongside the `scripts` block it is a sibling of. Not a dotfile
 * an agent could write into a worktree unnoticed — see the ownership rule below.
 *
 * **What shape.** Explicit argv, never a shell string:
 *
 * ```json
 * { "pipenzo": { "verify": {
 *     "serve": { "command": "pnpm", "args": ["dev"] },
 *     "screenshot": { "command": "pnpm", "args": ["exec", "capture-evidence"] }
 * } } }
 * ```
 *
 * Every subprocess Pipenzo starts runs with `shell: false` (`pipenzo-git.ts`, `gate-commands.ts`),
 * and a config format that accepted `"pnpm dev && curl evil"` would have quietly reintroduced a
 * shell at the one place a repository gets to name a command. Argv arrays make that shape
 * unrepresentable rather than merely discouraged.
 *
 * ## The ownership rule, which is the actual security question
 *
 * These commands are trusted *because a human committed them*. That is only true of the source
 * repository's `package.json` — the one on the operator's disk that they cloned and review. It is
 * **not** true of the copy inside a ticket worktree, which an agent has had write access to for
 * the whole Implement phase. So `readPipenzoRepoConfig()` takes the **source repository path**,
 * and the callers in `screenshot-verification.ts` pass `ownedLocation().sourcePath`, never the
 * worktree. An agent that edits `package.json` in its worktree changes what gets built and tested,
 * which the review gates are there to catch; it does not change what the daemon runs.
 */

export interface PipenzoCommandConfig {
  readonly command: string;
  readonly args: readonly string[];
}

export interface PipenzoRepoConfig {
  /** The dev server the daemon starts for a capture. Absent means screenshot verification is off. */
  readonly serve?: PipenzoCommandConfig;
  /** The free-form escape hatch (#141), for repositories without Playwright. */
  readonly screenshot?: PipenzoCommandConfig;
}

export type PipenzoRepoConfigErrorCode = 'unreadable' | 'invalid_config';

export class PipenzoRepoConfigError extends Error {
  readonly code: PipenzoRepoConfigErrorCode;

  constructor(code: PipenzoRepoConfigErrorCode, message: string) {
    super(message);
    this.name = 'PipenzoRepoConfigError';
    this.code = code;
  }
}

/**
 * A command name. No path separators, no `..`, no shell metacharacters, no leading dash.
 *
 * The leading-dash rule matters for the same reason it does in `pipenzo-publish-v1.ts`'s branch
 * names: a value that starts with `-` is read as an option by whatever eventually receives it.
 */
const COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

function parseCommand(value: unknown, where: string): PipenzoCommandConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') {
    throw new PipenzoRepoConfigError('invalid_config', `${where} must be an object`);
  }
  const record = value as { command?: unknown; args?: unknown };
  if (typeof record.command !== 'string' || !COMMAND_PATTERN.test(record.command)) {
    throw new PipenzoRepoConfigError(
      'invalid_config',
      `${where}.command must be a plain executable name`,
    );
  }
  const rawArgs = record.args ?? [];
  if (!Array.isArray(rawArgs) || rawArgs.length > 32) {
    throw new PipenzoRepoConfigError(
      'invalid_config',
      `${where}.args must be an array of at most 32 strings`,
    );
  }
  const args: string[] = [];
  for (const arg of rawArgs) {
    if (typeof arg !== 'string' || arg.length > 512) {
      throw new PipenzoRepoConfigError('invalid_config', `${where}.args must be strings`);
    }
    // No control characters. Everything else is allowed: these are argv entries handed to
    // `execFile`/`spawn` with `shell: false`, so a space or a quote is a literal, not a separator.
    if ([...arg].some((character) => character.charCodeAt(0) < 0x20)) {
      throw new PipenzoRepoConfigError(
        'invalid_config',
        `${where}.args must not contain control characters`,
      );
    }
    args.push(arg);
  }
  return { command: record.command, args };
}

/**
 * Reads `pipenzo.verify` out of a repository's `package.json`.
 *
 * A missing `package.json`, a missing `pipenzo` key and a missing `verify` key are all the same
 * ordinary answer — an empty config — because "this repository has not opted into screenshot
 * verification" is the common case and is not a failure. A `pipenzo` key that is present and
 * malformed *is* a failure: a repository that tried to configure this and got it wrong must not be
 * treated as one that never tried.
 */
export async function readPipenzoRepoConfig(
  sourceRepositoryPath: string,
): Promise<PipenzoRepoConfig> {
  let raw: string;
  try {
    raw = await readFile(join(sourceRepositoryPath, 'package.json'), 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PipenzoRepoConfigError('unreadable', 'the repository package.json is not valid JSON');
  }
  const pipenzo = (parsed as { pipenzo?: unknown } | null)?.pipenzo;
  if (pipenzo === undefined || pipenzo === null) return {};
  if (typeof pipenzo !== 'object') {
    throw new PipenzoRepoConfigError('invalid_config', 'pipenzo must be an object');
  }
  const verify = (pipenzo as { verify?: unknown }).verify;
  if (verify === undefined || verify === null) return {};
  if (typeof verify !== 'object') {
    throw new PipenzoRepoConfigError('invalid_config', 'pipenzo.verify must be an object');
  }
  const record = verify as { serve?: unknown; screenshot?: unknown };
  const serve = parseCommand(record.serve, 'pipenzo.verify.serve');
  const screenshot = parseCommand(record.screenshot, 'pipenzo.verify.screenshot');
  return {
    ...(serve ? { serve } : {}),
    ...(screenshot ? { screenshot } : {}),
  };
}
