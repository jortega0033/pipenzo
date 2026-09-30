import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UndoSnapshotError,
  captureUndoSnapshot,
  isUndoAvailable,
  restoreUndoSnapshot,
  touchedPathsFromNumstat,
  type UndoSnapshotV1,
} from '../src/undo-snapshot.js';

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

  it(
    'rejects a touched path that escapes the worktree through a symlinked ancestor directory',
    async () => {
      const root = initRepo();
      const outsideDir = tempDir('pipenzo-undo-outside-');
      await writeFile(join(outsideDir, 'secret.txt'), 'outside content\n');

      const linkPath = join(root, 'linked');
      try {
        await symlink(outsideDir, linkPath, 'junction');
      } catch {
        // Creating a symlink/junction needs a privilege this sandbox may not have; the lexical
        // traversal test above already covers the non-symlink case, so skip rather than fail.
        return;
      }
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

  it(
    'refuses to snapshot a symlink itself rather than silently treating it as a plain file',
    async () => {
      // The symlink's target is deliberately *inside* the worktree, isolating "this touched path
      // is a symlink" from the separate "this touched path escapes the worktree" concern already
      // covered by the traversal tests above.
      const root = initRepo();
      const realFile = join(root, 'real.txt');
      await writeFile(realFile, 'real content\n');

      const linkPath = join(root, 'link.txt');
      try {
        await symlink(realFile, linkPath, 'file');
      } catch {
        return; // no symlink privilege in this sandbox; see the directory-junction test above
      }
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
