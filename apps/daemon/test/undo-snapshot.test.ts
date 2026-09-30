import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RiskGrade } from '../src/risk-classifier.js';
import {
  UndoSnapshotError,
  captureUndoSnapshot,
  isUndoAvailable,
  isUndoSnapshotExpired,
  restoreUndoSnapshot,
  touchedPathsFromNumstat,
  type UndoSnapshotV1,
} from '../src/undo-snapshot.js';

/**
 * Whether this sandbox can create a symlink/junction at all. Creating one needs a privilege
 * ordinary Windows accounts don't have without Developer Mode or an elevated prompt, so the
 * traversal/symlink-kind tests below need to know this *before* deciding to run, not discover it
 * mid-test. Probed once, synchronously, at module load, with a throwaway link the try/finally
 * cleans up immediately -- so a real privilege loss shows up as a `skipped` test in the run
 * summary (visible, not silently swallowed as a false pass), rather than either a hard failure on
 * a sandbox that was never going to have the privilege, or a middle-of-test `return` that vitest
 * has no way to distinguish from "this test had nothing left to assert."
 */
const SYMLINK_SUPPORTED = (() => {
  const probeDir = mkdtempSync(join(tmpdir(), 'pipenzo-undo-symlink-probe-'));
  try {
    symlinkSync(join(probeDir, 'target'), join(probeDir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})();

/**
 * Every test in the `captureUndoSnapshot`/`restoreUndoSnapshot` describe block spawns real `git`
 * subprocesses (`init`, two `config`s, one or more `commit`s), matching
 * `pipenzo-worktree-lifecycle.test.ts`/`worktree-trust.test.ts`'s own documented reason for raising
 * their timeout past vitest's 5000ms default: a process spawn costs 100-300ms on Windows even when
 * idle, and this file's own two-commit tests (expiry) push well past 5s under concurrent
 * full-workspace test load.
 */
const GIT_HEAVY_TIMEOUT_MS = 30_000;

const temporaryDirectories: string[] = [];

// maxRetries/retryDelay matches this codebase's other real-git-repo test cleanups (e.g.
// pipenzo-worktree-lifecycle.test.ts, worktree-trust.test.ts): on Windows, deleting a directory
// right after a `git` subprocess exits can transiently fail with EBUSY/EPERM while the OS still
// holds a handle open, and retrying briefly clears it without weakening the test itself.
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, windowsHide: true });
}

function initRepo(): string {
  const root = tempDir('pipenzo-undo-');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  return root;
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message, '--allow-empty']);
}

function headSha(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim();
}

describe('isUndoAvailable', () => {
  it('is available for LOW and MEDIUM, and only refused for HIGH', () => {
    expect(isUndoAvailable('low')).toBe(true);
    expect(isUndoAvailable('medium')).toBe(true);
    expect(isUndoAvailable('high')).toBe(false);
  });

  it('refuses (fails closed) for a value that is not one of the three known grades', () => {
    // isUndoAvailable is written as an allowlist specifically so this doesn't default to true.
    // TypeScript can't produce this value through captureUndoSnapshot's own typed input, but
    // UndoSnapshotV1 is documented as data a caller can hold onto and replay -- so a value that
    // skipped that typing (a stale enum from a future version, a deserialization bug, a typo some
    // other module introduces) must still be refused, not silently treated as undo-eligible.
    expect(isUndoAvailable('critical' as unknown as RiskGrade)).toBe(false);
    expect(isUndoAvailable(undefined as unknown as RiskGrade)).toBe(false);
  });
});

describe('captureUndoSnapshot / restoreUndoSnapshot', () => {
  it(
    'restores a modified file to its exact pre-action bytes',
    async () => {
      const root = initRepo();
      const filePath = join(root, 'src', 'greeting.ts');
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, 'export const greeting = "hello";\n');
      commitAll(root, 'seed');
      const original = await readFile(filePath);

      const snapshot = await captureUndoSnapshot({
        worktreeRoot: root,
        branch: 'main',
        touchedPaths: [filePath],
        riskGrade: 'medium',
      });

      // The MEDIUM action runs and mutates the file (including a byte that would trip a naive
      // string-only compare, to prove the restore is byte-for-byte).
      await writeFile(
        filePath,
        Buffer.concat([Buffer.from('export const greeting = "goodbye";\n'), Buffer.from([0xff, 0x00])]),
      );
      expect((await readFile(filePath)).equals(original)).toBe(false);

      const outcome = await restoreUndoSnapshot(snapshot);

      expect(outcome).toEqual({ restored: true });
      expect((await readFile(filePath)).equals(original)).toBe(true);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'removes a file the action created, since it did not exist pre-action',
    async () => {
      const root = initRepo();
      commitAll(root, 'seed'); // establishes HEAD before anything else touches the tree
      const createdPath = join(root, 'src', 'new-file.ts');

      const snapshot = await captureUndoSnapshot({
        worktreeRoot: root,
        branch: 'main',
        touchedPaths: [createdPath],
        riskGrade: 'medium',
      });

      await mkdir(dirname(createdPath), { recursive: true });
      await writeFile(createdPath, 'export const x = 1;\n');
      expect(existsSync(createdPath)).toBe(true);

      const outcome = await restoreUndoSnapshot(snapshot);

      expect(outcome).toEqual({ restored: true });
      expect(existsSync(createdPath)).toBe(false);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses to restore once a new commit has landed on the branch, and performs no write',
    async () => {
      const root = initRepo();
      const filePath = join(root, 'file.txt');
      await writeFile(filePath, 'original\n');
      commitAll(root, 'seed');

      const snapshot = await captureUndoSnapshot({
        worktreeRoot: root,
        branch: 'main',
        touchedPaths: [filePath],
        riskGrade: 'medium',
      });

      await writeFile(filePath, 'mutated by the action\n');
      commitAll(root, 'a real commit lands on this branch after the snapshot');

      const outcome = await restoreUndoSnapshot(snapshot);

      expect(outcome).toEqual({ restored: false, reason: 'expired' });
      expect(await readFile(filePath, 'utf8')).toBe('mutated by the action\n');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'detects expiry by comparing the real HEAD sha, not by trusting the snapshot blindly',
    async () => {
      const root = initRepo();
      const filePath = join(root, 'file.txt');
      await writeFile(filePath, 'original\n');
      commitAll(root, 'seed');
      const snapshot = await captureUndoSnapshot({
        worktreeRoot: root,
        branch: 'main',
        touchedPaths: [filePath],
        riskGrade: 'medium',
      });
      expect(snapshot.headShaAtSnapshot).toBe(headSha(root));

      commitAll(root, 'moves HEAD');
      expect(headSha(root)).not.toBe(snapshot.headShaAtSnapshot);
      expect(await restoreUndoSnapshot(snapshot)).toEqual({ restored: false, reason: 'expired' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'never creates a snapshot for a HIGH-graded action',
    async () => {
      const root = initRepo();
      commitAll(root, 'seed');

      const attempt = captureUndoSnapshot({
        worktreeRoot: root,
        branch: 'main',
        touchedPaths: [join(root, 'apps', 'daemon', 'src', 'security', 'token-guard.ts')],
        riskGrade: 'high',
      });

      await expect(attempt).rejects.toBeInstanceOf(UndoSnapshotError);
      await expect(attempt).rejects.toMatchObject({ code: 'high_risk_blocked' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses (fails closed) to snapshot an action whose riskGrade is not one of the three known grades',
    async () => {
      const root = initRepo();
      commitAll(root, 'seed');

      const attempt = captureUndoSnapshot({
        worktreeRoot: root,
        branch: 'main',
        touchedPaths: [join(root, 'file.txt')],
        // Neither a valid RiskGrade nor reachable through captureUndoSnapshot's own typed input in
        // practice -- simulates a caller that bypassed the type system (a stale value, a bad cast).
        riskGrade: 'critical' as unknown as RiskGrade,
      });

      await expect(attempt).rejects.toMatchObject({ code: 'high_risk_blocked' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses (fails closed) to restore a snapshot whose riskGrade is not one of the three known grades, and performs no write',
    async () => {
      const root = initRepo();
      const filePath = join(root, 'file.txt');
      await writeFile(filePath, 'original\n');
      commitAll(root, 'seed');

      const malformedSnapshot: UndoSnapshotV1 = {
        worktreeRoot: root,
        branch: 'main',
        headShaAtSnapshot: headSha(root),
        riskGrade: 'critical' as unknown as RiskGrade,
        capturedAt: new Date().toISOString(),
        entries: [{ path: filePath, existedBefore: true, content: Buffer.from('original\n') }],
      };

      await writeFile(filePath, 'tampered\n');
      const outcome = await restoreUndoSnapshot(malformedSnapshot);

      expect(outcome).toEqual({ restored: false, reason: 'high_risk_blocked' });
      expect(await readFile(filePath, 'utf8')).toBe('tampered\n');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses to restore a HIGH-graded snapshot even if one is assembled by hand, and performs no write',
    async () => {
      // A HIGH snapshot can never come from captureUndoSnapshot (the previous test proves that),
      // but "never at HIGH, no exceptions" (CLAUDE.md hard rule 3) must hold structurally, not
      // just "in the one path we wrote" -- so restoreUndoSnapshot must refuse this on its own even
      // when handed a snapshot object that didn't go through captureUndoSnapshot at all.
      const root = initRepo();
      const filePath = join(root, 'security', 'token-guard.ts');
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, 'original-secure-content\n');
      commitAll(root, 'seed');

      const forgedHighSnapshot: UndoSnapshotV1 = {
        worktreeRoot: root,
        branch: 'main',
        headShaAtSnapshot: headSha(root),
        riskGrade: 'high',
        capturedAt: new Date().toISOString(),
        entries: [{ path: filePath, existedBefore: true, content: Buffer.from('original-secure-content\n') }],
      };

      await writeFile(filePath, 'tampered-by-the-high-risk-action\n');
      const outcome = await restoreUndoSnapshot(forgedHighSnapshot);

      expect(outcome).toEqual({ restored: false, reason: 'high_risk_blocked' });
      expect(await readFile(filePath, 'utf8')).toBe('tampered-by-the-high-risk-action\n');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'rejects a touched path that escapes the worktree via lexical traversal',
    async () => {
      const root = initRepo();
      commitAll(root, 'seed');

      await expect(
        captureUndoSnapshot({
          worktreeRoot: root,
          branch: 'main',
          touchedPaths: [join(root, '..', 'outside.txt')],
          riskGrade: 'medium',
        }),
      ).rejects.toMatchObject({ code: 'path_outside_worktree' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it.skipIf(!SYMLINK_SUPPORTED)(
    'rejects a touched path that escapes the worktree through a symlinked ancestor directory',
    async () => {
      const root = initRepo();
      const outsideDir = tempDir('pipenzo-undo-outside-');
      await writeFile(join(outsideDir, 'secret.txt'), 'outside content\n');

      const linkPath = join(root, 'linked');
      await symlink(outsideDir, linkPath, 'junction');
      commitAll(root, 'seed');

      await expect(
        captureUndoSnapshot({
          worktreeRoot: root,
          branch: 'main',
          touchedPaths: [join(linkPath, 'secret.txt')],
          riskGrade: 'medium',
        }),
      ).rejects.toMatchObject({ code: 'path_outside_worktree' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it.skipIf(!SYMLINK_SUPPORTED)(
    'refuses to snapshot a symlink itself rather than silently treating it as a plain file',
    async () => {
      // The symlink's target is deliberately *inside* the worktree, isolating "this touched path
      // is a symlink" from the separate "this touched path escapes the worktree" concern already
      // covered by the traversal tests above.
      const root = initRepo();
      const realFile = join(root, 'real.txt');
      await writeFile(realFile, 'real content\n');

      const linkPath = join(root, 'link.txt');
      await symlink(realFile, linkPath, 'file');
      commitAll(root, 'seed');

      await expect(
        captureUndoSnapshot({
          worktreeRoot: root,
          branch: 'main',
          touchedPaths: [linkPath],
          riskGrade: 'medium',
        }),
      ).rejects.toMatchObject({ code: 'unsupported_path_kind' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it.skipIf(!SYMLINK_SUPPORTED)(
    'refuses to restore through a path that was swapped for a symlink after the snapshot was captured',
    async () => {
      // The gap this closes: assertInsideWorktree's containment check realpaths through symlinks
      // on purpose (to catch an escape via a symlinked ancestor), so a symlink whose target is
      // still inside the worktree passes containment cleanly. Without a kind re-check right before
      // the write, restoreUndoSnapshot would follow that symlink and silently clobber whatever file
      // it now points at -- a different file than the one the snapshot actually recorded.
      const root = initRepo();
      const touchedPath = join(root, 'file.txt');
      await writeFile(touchedPath, 'original\n');
      const decoyPath = join(root, 'decoy.txt');
      await writeFile(decoyPath, 'decoy content that must survive untouched\n');
      commitAll(root, 'seed');

      const snapshot = await captureUndoSnapshot({
        worktreeRoot: root,
        branch: 'main',
        touchedPaths: [touchedPath],
        riskGrade: 'medium',
      });

      // The MEDIUM action (or something else entirely) removes the original file and swaps a
      // symlink into its place, pointing at a different in-worktree file.
      await rm(touchedPath, { force: true });
      await symlink(decoyPath, touchedPath, 'file');

      await expect(restoreUndoSnapshot(snapshot)).rejects.toMatchObject({ code: 'unsupported_path_kind' });
      // The decoy must be untouched: restore must never have followed the symlink to write there.
      expect(await readFile(decoyPath, 'utf8')).toBe('decoy content that must survive untouched\n');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'rejects a touched path outside the worktree even when passed as a bare absolute path',
    async () => {
      const root = initRepo();
      const outsideDir = tempDir('pipenzo-undo-outside-');
      commitAll(root, 'seed');

      await expect(
        captureUndoSnapshot({
          worktreeRoot: root,
          branch: 'main',
          touchedPaths: [join(outsideDir, 'anything.txt')],
          riskGrade: 'medium',
        }),
      ).rejects.toMatchObject({ code: 'path_outside_worktree' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'deduplicates a touched path listed more than once',
    async () => {
      const root = initRepo();
      const filePath = join(root, 'file.txt');
      await writeFile(filePath, 'v1\n');
      commitAll(root, 'seed');

      const snapshot = await captureUndoSnapshot({
        worktreeRoot: root,
        branch: 'main',
        touchedPaths: [filePath, filePath],
        riskGrade: 'medium',
      });

      expect(snapshot.entries).toHaveLength(1);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});

describe('isUndoSnapshotExpired', () => {
  it(
    'reports not expired right after capture, with no filesystem write',
    async () => {
      const root = initRepo();
      const filePath = join(root, 'file.txt');
      await writeFile(filePath, 'original\n');
      commitAll(root, 'seed');
      const snapshot = await captureUndoSnapshot({
        worktreeRoot: root,
        branch: 'main',
        touchedPaths: [filePath],
        riskGrade: 'medium',
      });

      expect(await isUndoSnapshotExpired(snapshot)).toEqual({ expired: false });
      // Never restored -- the real content on disk is untouched.
      expect(await readFile(filePath, 'utf8')).toBe('original\n');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'reports expired once a commit lands on the branch, agreeing with restoreUndoSnapshot',
    async () => {
      const root = initRepo();
      const filePath = join(root, 'file.txt');
      await writeFile(filePath, 'original\n');
      commitAll(root, 'seed');
      const snapshot = await captureUndoSnapshot({
        worktreeRoot: root,
        branch: 'main',
        touchedPaths: [filePath],
        riskGrade: 'medium',
      });

      commitAll(root, 'a real commit lands on this branch after the snapshot');

      expect(await isUndoSnapshotExpired(snapshot)).toEqual({ expired: true, reason: 'expired' });
      expect(await restoreUndoSnapshot(snapshot)).toEqual({ restored: false, reason: 'expired' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it('reports high_risk_blocked for a HIGH-graded snapshot, without reading git at all', async () => {
    const snapshot: UndoSnapshotV1 = {
      worktreeRoot: '/does/not/matter',
      branch: 'main',
      headShaAtSnapshot: 'a'.repeat(40),
      riskGrade: 'high' as RiskGrade,
      capturedAt: '2026-01-01T00:00:00.000Z',
      entries: [],
    };
    const gitRunner = vi.fn();

    expect(await isUndoSnapshotExpired(snapshot, { gitRunner })).toEqual({
      expired: true,
      reason: 'high_risk_blocked',
    });
    expect(gitRunner).not.toHaveBeenCalled();
  });
});

describe('touchedPathsFromNumstat', () => {
  it('resolves a plain numstat path under the worktree root', () => {
    const root = process.platform === 'win32' ? 'C:\\owned\\issue-148' : '/owned/issue-148';
    const numstat = '3\t1\tsrc/a.ts\n';
    expect(touchedPathsFromNumstat(numstat, root)).toEqual([join(root, 'src', 'a.ts')]);
  });

  it('resolves a renamed path to its new (current) location, not the numstat rename shorthand', () => {
    const root = process.platform === 'win32' ? 'C:\\owned\\issue-148' : '/owned/issue-148';
    const numstat = '0\t0\t{old => new}/b.ts\n';
    expect(touchedPathsFromNumstat(numstat, root)).toEqual([join(root, 'new', 'b.ts')]);
  });
});
