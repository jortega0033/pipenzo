import { basename, dirname, resolve } from 'node:path';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isInsideWorktree, type RiskGrade } from './risk-classifier.js';
import { parseNumstat, renamedNewPath } from './review-gates.js';
import { runGitCommand, type PipenzoGitRunner } from './pipenzo-git.js';

/**
 * Filesystem-only undo for a MEDIUM-risk action (Pipenzo issue #148, a split of epic #6's
 * "Polish — notifications, risk classifier, worktree cleanup, audit trail").
 *
 * Three properties from the issue text, each with a corresponding design choice below:
 *
 * - **"Restore touched paths from pre-action worktree state"** — `captureUndoSnapshot` reads only
 *   the paths it's given, not the whole worktree, mirroring `risk-classifier.ts`'s own
 *   `RiskClassificationInput` in taking the action's own shape rather than reaching for global
 *   state. Callers that already know their diff's numstat (`review-gates.ts`'s `#readDiff`) can
 *   turn it into that path list with `touchedPathsFromNumstat` below instead of writing a second
 *   numstat parse.
 * - **"Valid until next commit on that branch"** — the snapshot records the worktree's `HEAD` sha
 *   at capture time; `restoreUndoSnapshot` re-reads `HEAD` and refuses if it has moved. This is a
 *   real git-state comparison, not a timestamp guess: a commit landing between capture and restore
 *   means the working tree has moved on in a way overwriting old bytes would corrupt (it would
 *   silently make the new commit's working-tree view stop matching what it just committed).
 * - **"Filesystem-only"** — `restoreUndoSnapshot` only ever calls `fs` read/write/rm on the
 *   recorded paths. It never runs `git reset`, `git checkout --`, or any other git mutation; the
 *   one git call this module makes (`rev-parse HEAD`) is read-only.
 *
 * **"Never at HIGH" (CLAUDE.md hard rule 3 / risk-classifier.ts)**: `captureUndoSnapshot` refuses
 * outright for a HIGH grade, so no snapshot — and therefore no restore entry point — can ever
 * exist for a HIGH-graded action. `restoreUndoSnapshot` independently re-checks the grade carried
 * on the snapshot it's handed before doing anything filesystem-affecting, on the theory that "never
 * at HIGH, no exceptions" must hold even against a snapshot some future caller assembled by hand
 * rather than through `captureUndoSnapshot`. Both checks are exercised directly in
 * `undo-snapshot.test.ts` rather than left as "unlikely to be called."
 */

export class UndoSnapshotError extends Error {
  constructor(
    readonly code: 'high_risk_blocked' | 'path_outside_worktree' | 'unsupported_path_kind' | 'git_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'UndoSnapshotError';
  }
}

export interface TouchedPathSnapshotEntry {
  /** Absolute path, already validated to resolve inside the worktree. */
  readonly path: string;
  readonly existedBefore: boolean;
  /** Present iff `existedBefore` — the file's exact pre-action bytes. */
  readonly content?: Buffer;
}

export interface UndoSnapshotV1 {
  /** Realpath'd at capture time. */
  readonly worktreeRoot: string;
  readonly branch: string;
  readonly headShaAtSnapshot: string;
  readonly riskGrade: RiskGrade;
  readonly capturedAt: string;
  readonly entries: readonly TouchedPathSnapshotEntry[];
}

export interface CaptureUndoSnapshotInput {
  readonly worktreeRoot: string;
  readonly branch: string;
  /** Absolute, or relative to `worktreeRoot`. Deduplicated internally. */
  readonly touchedPaths: readonly string[];
  readonly riskGrade: RiskGrade;
  /** Injection seam for tests. Production defaults to `runGitCommand`. */
  readonly gitRunner?: PipenzoGitRunner;
}

export type UndoOutcome =
  | { readonly restored: true }
  | { readonly restored: false; readonly reason: 'expired' | 'high_risk_blocked' };

/** Whether this ticket's undo mechanism may ever be offered for an action graded `riskGrade`.
 * `false` only for `'high'` — the one structural exclusion this module exists to enforce. Callers
 * building a UI or API entry point for "Undo" should gate on this before even rendering the
 * affordance, in addition to the enforcement inside `captureUndoSnapshot`/`restoreUndoSnapshot`. */
export function isUndoAvailable(riskGrade: RiskGrade): boolean {
  return riskGrade !== 'high';
}

/** Turns `git diff --numstat` output into an absolute touched-path list for
 * `captureUndoSnapshot`, reusing `review-gates.ts`'s own numstat parse and rename normalization
 * (issue #319) rather than a third, driftable pass over the format. */
export function touchedPathsFromNumstat(numstat: string, worktreeRoot: string): string[] {
  return parseNumstat(numstat).map((line) => resolve(worktreeRoot, renamedNewPath(line.path)));
}

async function headSha(worktreeRoot: string, gitRunner: PipenzoGitRunner): Promise<string> {
  const result = await gitRunner(['rev-parse', 'HEAD'], worktreeRoot);
  if (result.code !== 0) {
    throw new UndoSnapshotError(
      'git_unavailable',
      `could not read HEAD for ${worktreeRoot}: ${result.stderr.trim() || `git exited ${result.code}`}`,
    );
  }
  return result.stdout.trim();
}

/** Realpath's the nearest existing ancestor of `target` and rejoins the still-missing suffix.
 * Plain `fs.realpath` throws for a path that doesn't exist yet, which is the common case here — a
 * MEDIUM action's touched-path list routinely includes a file it is about to create. */
async function realExistingPath(target: string): Promise<string> {
  const suffix: string[] = [];
  let current = target;
  for (;;) {
    try {
      return resolve(await realpath(current), ...suffix);
    } catch {
      const parent = dirname(current);
      if (parent === current) return target; // reached the filesystem root; nothing left to resolve
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves `candidate` against `realRoot` and asserts the result stays inside the worktree.
 * `realRoot` must already be realpath'd by the caller. The containment check itself is done on
 * `realExistingPath(resolved)`, not on the lexically-resolved path directly — a plain
 * `path.relative` compare against `resolved` is unsound here for two independent reasons: (1) a
 * symlinked ancestor directory can make a lexically-fine path land outside the worktree once
 * resolved for real, and (2) on Windows, an absolute candidate built from a short (8.3) form of a
 * path (as `os.tmpdir()` and some callers can hand back) will never lexically match `realRoot`,
 * which `fs.realpath` always returns in long form, producing a false "outside" verdict for a path
 * that is genuinely inside. Resolving through the nearest existing ancestor's real path first, the
 * same way `worktree-manager.ts`'s own containment checks realpath their root before comparing,
 * avoids both failure modes with one check.
 */
async function assertInsideWorktree(realRoot: string, candidate: string): Promise<string> {
  const resolved = resolve(realRoot, candidate);
  const real = await realExistingPath(resolved);
  if (!isInsideWorktree(realRoot, real)) {
    throw new UndoSnapshotError('path_outside_worktree', `${candidate} resolves outside the worktree`);
  }
  return resolved;
}

/**
 * Captures the pre-action content of exactly `touchedPaths`, for later restore by
 * `restoreUndoSnapshot`. Throws `UndoSnapshotError('high_risk_blocked')` for a HIGH-graded action
 * without reading anything — see the module comment.
 */
export async function captureUndoSnapshot(input: CaptureUndoSnapshotInput): Promise<UndoSnapshotV1> {
  const { worktreeRoot, branch, touchedPaths, riskGrade } = input;
  const gitRunner = input.gitRunner ?? runGitCommand;

  if (riskGrade === 'high') {
    throw new UndoSnapshotError('high_risk_blocked', 'Undo is never offered for a HIGH-risk action');
  }

  const realRoot = await realpath(worktreeRoot);
  const sha = await headSha(worktreeRoot, gitRunner);

  const entries: TouchedPathSnapshotEntry[] = [];
  for (const rawPath of new Set(touchedPaths)) {
    const absolute = await assertInsideWorktree(realRoot, rawPath);
    const metadata = await lstat(absolute).catch(() => undefined);
    if (!metadata) {
      entries.push({ path: absolute, existedBefore: false });
      continue;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      // A symlink or a directory has no single byte-for-byte "pre-action content" this ticket's
      // restore contract can honor; refuse loudly rather than silently skipping the path and
      // handing back a snapshot that looks complete but isn't.
      throw new UndoSnapshotError(
        'unsupported_path_kind',
        `${rawPath} is not a plain file (symlink or directory) — undo cannot snapshot it`,
      );
    }
    entries.push({ path: absolute, existedBefore: true, content: await readFile(absolute) });
  }

  return {
    worktreeRoot: realRoot,
    branch,
    headShaAtSnapshot: sha,
    riskGrade,
    capturedAt: new Date().toISOString(),
    entries,
  };
}

/**
 * Restores `snapshot`'s touched paths to their pre-action content. Filesystem-only: no git command
 * this function runs (or calls out to) ever mutates history, the index, or refs.
 *
 * Refuses with `{ restored: false, reason: 'expired' }` when the worktree's branch has moved past
 * `snapshot.headShaAtSnapshot` — checked against `git rev-parse HEAD` at call time, not a stored
 * timestamp — and with `{ restored: false, reason: 'high_risk_blocked' }` for a HIGH-graded
 * snapshot (see the module comment for why this check exists even though `captureUndoSnapshot`
 * already refuses to produce one).
 */
export async function restoreUndoSnapshot(
  snapshot: UndoSnapshotV1,
  options: { readonly gitRunner?: PipenzoGitRunner } = {},
): Promise<UndoOutcome> {
  if (snapshot.riskGrade === 'high') {
    return { restored: false, reason: 'high_risk_blocked' };
  }

  const gitRunner = options.gitRunner ?? runGitCommand;
  const currentSha = await headSha(snapshot.worktreeRoot, gitRunner);
  if (currentSha !== snapshot.headShaAtSnapshot) {
    return { restored: false, reason: 'expired' };
  }

  const realRoot = await realpath(snapshot.worktreeRoot);
  for (const entry of snapshot.entries) {
    // Re-validated here too: a snapshot is plain data a caller could hold onto and replay later,
    // possibly against a mutated filesystem, so every write still earns its own containment check
    // rather than trusting whatever `captureUndoSnapshot` decided earlier.
    const absolute = await assertInsideWorktree(realRoot, entry.path);
    if (entry.existedBefore) {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, entry.content ?? Buffer.alloc(0));
    } else {
      await rm(absolute, { force: true });
    }
  }

  return { restored: true };
}
