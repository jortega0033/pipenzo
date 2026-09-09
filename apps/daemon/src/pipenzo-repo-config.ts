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
 * }, "conventions": "Tests live in test/, not __tests__/." } }
 * ```
 *
 * Every subprocess Pipenzo starts runs with `shell: false` (`pipenzo-git.ts`, `gate-commands.ts`),
 * and a config format that accepted `"pnpm dev && curl evil"` would have quietly reintroduced a
 * shell at the one place a repository gets to name a command. Argv arrays make that shape
 * unrepresentable rather than merely discouraged.
 *
 * `conventions` (issue #284) is the one field here that is not a command: free-form prose a
 * maintainer states once — repo norms Refine and Review would otherwise need restated per issue.
 * It sits beside `verify` rather than inside it because it is read by different phases for a
 * different purpose (guidance folded into a prompt, not a subprocess to run), but the trust class
 * and the ownership rule below are identical, which is why it lives in the same file under the
 * same key rather than a new one.
 *
 * ## The ownership rule, which is the actual security question
 *
 * Every field here is trusted *because a human committed it*. That is only true of the source
 * repository's `package.json` — the one on the operator's disk that they cloned and review. It is
 * **not** true of the copy inside a ticket worktree, which an agent has had write access to for
 * the whole Implement phase. So `readPipenzoRepoConfig()` takes the **source repository path**,
 * and every caller (`screenshot-verification.ts`, and `pipenzo-phase-service.ts`'s `refine()`/
 * `review()` for `conventions`) passes the source path — `ownedLocation().sourcePath` where a
 * worktree is in play, never the worktree itself. An agent that edits `package.json` in its
 * worktree changes what gets built and tested, which the review gates are there to catch; it does
 * not change what the daemon runs or what guidance a future Refine/Review pass reads. `conventions`
 * makes this matter in a new way `verify` did not: it feeds directly into an LLM prompt, so if it
 * were ever read from the worktree, a ticket's own diff could inject instructions into its next
 * Review pass — exactly the prompt-injection shape the source/worktree split exists to close off.
 */

export interface PipenzoCommandConfig {
  readonly command: string;
  readonly args: readonly string[];
}

/** Bounds `pipenzo.conventions` (issue #284). Generous for real prose -- several pages -- while
 * still refusing to fold an unbounded file into every Refine/Review prompt this repo ever runs. */
const MAX_CONVENTIONS_CHARS = 8_000;

export interface PipenzoRepoConfig {
  /** The dev server the daemon starts for a capture. Absent means screenshot verification is off. */
  readonly serve?: PipenzoCommandConfig;
  /** The free-form escape hatch (#141), for repositories without Playwright. */
  readonly screenshot?: PipenzoCommandConfig;
  /** Repo-wide conventions for Refine and Review (issue #284), folded into each phase's prompt.
   * Free-form prose, not a structured schema -- see this module's own doc comment for why. */
  readonly conventions?: string;
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
 * Reads `pipenzo.verify` and `pipenzo.conventions` out of a repository's `package.json`.
 *
 * A missing `package.json`, a missing `pipenzo` key, and a missing `verify`/`conventions` key are
 * all the same ordinary answer — an empty config — because "this repository has not opted into
 * screenshot verification" (or into stating conventions) is the common case and is not a failure.
 * A `pipenzo` key that is present and malformed *is* a failure: a repository that tried to
 * configure this and got it wrong must not be treated as one that never tried.
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
  // `verify` and `conventions` are independent keys (issue #284 added the second beside the
  // first), so a repository that sets only one must not silently lose the other -- each is parsed
  // on its own, not gated behind the other being present.
  const { verify, conventions } = pipenzo as { verify?: unknown; conventions?: unknown };

  let serve: PipenzoCommandConfig | undefined;
  let screenshot: PipenzoCommandConfig | undefined;
  if (verify !== undefined && verify !== null) {
    if (typeof verify !== 'object') {
      throw new PipenzoRepoConfigError('invalid_config', 'pipenzo.verify must be an object');
    }
    const record = verify as { serve?: unknown; screenshot?: unknown };
    serve = parseCommand(record.serve, 'pipenzo.verify.serve');
    screenshot = parseCommand(record.screenshot, 'pipenzo.verify.screenshot');
  }

  const parsedConventions = parseConventions(conventions);

  return {
    ...(serve ? { serve } : {}),
    ...(screenshot ? { screenshot } : {}),
    ...(parsedConventions !== undefined ? { conventions: parsedConventions } : {}),
  };
}

function parseConventions(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new PipenzoRepoConfigError('invalid_config', 'pipenzo.conventions must be a string');
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_CONVENTIONS_CHARS) {
    throw new PipenzoRepoConfigError(
      'invalid_config',
      `pipenzo.conventions must be at most ${MAX_CONVENTIONS_CHARS} characters`,
    );
  }
  return trimmed;
}
