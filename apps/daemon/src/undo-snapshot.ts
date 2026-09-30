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

/**
 * Whether this ticket's undo mechanism may ever be offered for an action graded `riskGrade`. Also
 * the shared check `captureUndoSnapshot`/`restoreUndoSnapshot` use for their own HIGH exclusion.
 *
 * Written as an allowlist (`'low' | 'medium'`), not a blocklist (`!== 'high'`), even though
 * `RiskGrade` has exactly three members at the type level and the two forms are equivalent for any
 * value TypeScript actually checked. They stop being equivalent the moment a value crosses a
 * runtime boundary TypeScript can't see through — and `UndoSnapshotV1` is documented above as
 * exactly that: "plain data a caller could hold onto and replay," not a value this module
 * necessarily constructed and typed itself. A blocklist fails *open* (treats it as undo-eligible)
 * on `undefined`, a typo, or a future fourth grade nobody's taught this module about yet; an
 * allowlist fails *closed* on the same inputs. CLAUDE.md hard rule 3 — "no exceptions, ever" — is a
 * fail-closed rule, so the check enforcing it has to be fail-closed too, not just correct for the
 * three values it was written against.
 */
export function isUndoAvailable(riskGrade: RiskGrade): boolean {
  return riskGrade === 'low' || riskGrade === 'medium';
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
 * Refuses to act on `absolute` if its current on-disk kind isn't one a filesystem-only restore can
 * safely handle. `captureUndoSnapshot` already refuses a path that *starts out* as a symlink or a
 * directory; this is the restore-side twin of that check, and it matters independently, not just
 * defensively. A snapshot is captured right before an action runs but can be restored much later —
 * seconds, minutes, an entire session — and nothing stops something else from swapping the path for
 * a symlink into a different in-worktree file in between. `assertInsideWorktree`'s containment
 * check alone would *not* catch that: it realpaths through symlinks on purpose (to catch an escape
 * via a symlinked ancestor directory), so a symlink whose target is still inside the worktree
 * passes containment cleanly even though writing through it — `fs.writeFile` follows symlinks by
 * default — would silently overwrite whatever file the symlink now points at instead of the path
 * the snapshot actually recorded. Checking again, right here, immediately before the write or
 * remove, is what closes that gap; a path that no longer exists at all is fine either way
 * (`writeFile` creates it fresh, and removing a path that isn't there is already a no-op).
 */
async function assertRestorableKind(absolute: string): Promise<void> {
  const metadata = await lstat(absolute).catch(() => undefined);
  if (!metadata) return;
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new UndoSnapshotError(
      'unsupported_path_kind',
      `${absolute} changed kind (symlink or directory) since it was snapshotted -- refusing to restore through it`,
    );
  }
}

/**
 * Captures the pre-action content of exactly `touchedPaths`, for later restore by
 * `restoreUndoSnapshot`. Throws `UndoSnapshotError('high_risk_blocked')` for a HIGH-graded action
 * without reading anything — see the module comment.
 */
export async function captureUndoSnapshot(input: CaptureUndoSnapshotInput): Promise<UndoSnapshotV1> {
  const { worktreeRoot, branch, touchedPaths, riskGrade } = input;
  const gitRunner = input.gitRunner ?? runGitCommand;

  if (!isUndoAvailable(riskGrade)) {
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
 * A read-only peek at whether `snapshot` is still restorable, without restoring anything --
 * `restoreUndoSnapshot`'s own expiry check (`headSha` against `snapshot.headShaAtSnapshot`),
 * factored out so a caller that only wants to render a live "Undo available" indicator (Pipenzo
 * issue #97's resolved-line UI) never has to actually touch the filesystem to find out. Mirrors
 * `restoreUndoSnapshot`'s own two refusal reasons exactly, so the two functions can never disagree
 * about whether a given snapshot is still good: `'high_risk_blocked'` for a HIGH-graded snapshot
 * (never produced by `captureUndoSnapshot`, but a snapshot is "plain data a caller could hold onto
 * and replay" per that function's own doc comment, so this checks again rather than trusting the
 * type), `'expired'` once a commit has landed on the branch since capture, and no reason at all
 * when it is still good.
 */
export async function isUndoSnapshotExpired(
  snapshot: UndoSnapshotV1,
  options: { readonly gitRunner?: PipenzoGitRunner } = {},
): Promise<{ readonly expired: boolean; readonly reason?: 'expired' | 'high_risk_blocked' }> {
  if (!isUndoAvailable(snapshot.riskGrade)) {
    return { expired: true, reason: 'high_risk_blocked' };
  }
  const gitRunner = options.gitRunner ?? runGitCommand;
  const currentSha = await headSha(snapshot.worktreeRoot, gitRunner);
  if (currentSha !== snapshot.headShaAtSnapshot) {
    return { expired: true, reason: 'expired' };
  }
  return { expired: false };
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
  if (!isUndoAvailable(snapshot.riskGrade)) {
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
    await assertRestorableKind(absolute);
    if (entry.existedBefore) {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, entry.content ?? Buffer.alloc(0));
    } else {
      await rm(absolute, { force: true });
    }
  }

  return { restored: true };
}
