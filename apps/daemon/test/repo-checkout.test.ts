import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipenzoGitRunner } from '../src/pipenzo-git.js';
import {
  RepoCheckoutError,
  RepoCheckouts,
  reposRoot,
  resolveRepoCheckout,
} from '../src/repo-checkout.js';

const REPO = { owner: 'octocat', repo: 'hello-world' };
const HEAD_SHA = 'a'.repeat(40);

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** What a *finished* clone leaves on disk: a `.git` directory with an index in it. The index is the
 * piece `clone --no-checkout` never writes and the first real `checkout` always does. */
async function makeFinishedCheckout(dir: string): Promise<void> {
  await mkdir(join(dir, '.git'), { recursive: true });
  await writeFile(join(dir, '.git', 'index'), 'DIRC');
}

/** What *our own* clone that died between `clone --no-checkout` and `checkout` leaves on disk: the
 * `.git` directory, the right origin, no index -- the exact state the old fast path trusted -- plus
 * the `pipenzo-managed` marker this module writes right after its fetch. */
async function makeInterruptedClone(dir: string, { marker = true } = {}): Promise<void> {
  await mkdir(join(dir, '.git', 'objects'), { recursive: true });
  await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  if (marker) await writeFile(join(dir, '.git', 'pipenzo-managed'), 'ours\n');
}

/** A git runner that answers only the matching-origin probe, and fails the test on anything else --
 * so a "refused, nothing deleted" test cannot pass by having quietly recloned. */
const MATCHING_ORIGIN_ONLY: PipenzoGitRunner = async (args) => {
  if (args[0] === 'remote') {
    return { stdout: 'https://github.com/octocat/hello-world.git\n', stderr: '', code: 0 };
  }
  throw new Error(`unexpected git call: ${args.join(' ')}`);
};

/** A directory junction on Windows (no privilege needed), a symlink elsewhere. */
async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(target, path, 'junction');
}

/** For the "directory already exists" branch: answers `remote get-url origin` and the
 * `rev-parse HEAD^{commit}` populated-checkout probe only, and throws on any other call so a test
 * asserting no clone happens can't pass for the wrong reason. */
function fakeExistingRemote(
  url: string | undefined,
  code = url === undefined ? 128 : 0,
  headCode = 0,
): PipenzoGitRunner {
  return async (args) => {
    if (args[0] === 'remote') {
      if (url === undefined) return { stdout: '', stderr: 'fatal: not a git repository', code };
      return { stdout: `${url}\n`, stderr: '', code };
    }
    if (args[0] === 'rev-parse') {
      return headCode === 0
        ? { stdout: `${HEAD_SHA}\n`, stderr: '', code: 0 }
        : { stdout: '', stderr: 'fatal: Needed a single revision', code: headCode };
    }
    throw new Error(`unexpected git call in an existing-checkout test: ${args.join(' ')}`);
  };
}

/**
 * For the "nothing there yet" branch: `clone --no-checkout` -> `symbolic-ref` -> `checkout`.
 *
 * Materializes what real git would leave on disk -- a successful clone creates `<target>/.git`, a
 * successful checkout writes the index -- so a follow-up call in the same test sees the directory
 * state it would really see, rather than an empty temp root that makes every retry look fresh.
 * `cloneThrows` models the one failure that does *not* come back as an exit code: a clone killed by
 * its timeout after it had already created the directory.
 */
function fakeClone(
  options: {
    cloneCode?: number;
    cloneThrows?: boolean;
    branch?: string;
    branchCode?: number;
    checkoutCode?: number;
  } = {},
): PipenzoGitRunner {
  const { cloneCode = 0, cloneThrows = false, branch = 'main', branchCode = 0, checkoutCode = 0 } =
    options;
  return async (args, cwd) => {
    if (args[0] === 'clone') {
      const target = args[3]!;
      if (cloneThrows) {
        await mkdir(join(target, '.git'), { recursive: true });
        throw new Error('git clone could not run: timed out');
      }
      if (cloneCode === 0) await mkdir(join(target, '.git'), { recursive: true });
      return { stdout: '', stderr: cloneCode === 0 ? '' : 'clone failed', code: cloneCode };
    }
    if (args[0] === 'symbolic-ref') {
      return {
        stdout: branchCode === 0 ? `${branch}\n` : '',
        stderr: branchCode === 0 ? '' : 'fatal: ref HEAD is not a symbolic ref',
        code: branchCode,
      };
    }
    if (args[0] === 'checkout') {
      if (checkoutCode === 0) await writeFile(join(cwd, '.git', 'index'), 'DIRC');
      return { stdout: '', stderr: checkoutCode === 0 ? '' : 'checkout failed', code: checkoutCode };
    }
    throw new Error(`unexpected git call in a clone test: ${args.join(' ')}`);
  };
}

/** Records every call's first argument, delegating to `inner`. */
function recording(inner: PipenzoGitRunner): { runGit: PipenzoGitRunner; verbs: string[] } {
  const verbs: string[] = [];
  return {
    verbs,
    runGit: async (args, cwd, options) => {
      verbs.push(args[0] ?? '');
      return inner(args, cwd, options);
    },
  };
}

describe('reposRoot', () => {
  it('defaults to <stateDir>/repos', () => {
    expect(reposRoot('/state', {})).toBe(join('/state', 'repos'));
  });

  it('honours PIPENZO_REPOS_DIR the same way AGENT_DOCK_STATE_DIR overrides the state dir', () => {
    expect(reposRoot('/state', { PIPENZO_REPOS_DIR: 'D:\\Projects' })).toBe('D:\\Projects');
  });

  it('falls back to the default for a blank override rather than an empty path', () => {
    expect(reposRoot('/state', { PIPENZO_REPOS_DIR: '   ' })).toBe(join('/state', 'repos'));
  });
});

describe('resolveRepoCheckout', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pipenzo-repo-checkout-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('fetches with --no-checkout under the credential-reachable floor, then checks out under the default one', async () => {
    const calls: { args: readonly string[]; cwd: string; options?: unknown }[] = [];
    const runGit: PipenzoGitRunner = async (args, cwd, options) => {
      calls.push({ args, cwd, options });
      return fakeClone({ branch: 'trunk' })(args, cwd, options);
    };

    const path = await resolveRepoCheckout(REPO, root, runGit);
    const targetDir = join(root, 'octocat', 'hello-world');

    expect(path).toBe(targetDir);
    expect(calls.map((call) => call.args[0])).toEqual(['clone', 'symbolic-ref', 'checkout']);

    expect(calls[0]?.args).toEqual([
      'clone',
      '--no-checkout',
      'https://github.com/octocat/hello-world.git',
      targetDir,
    ]);
    // Only the fetch sees the wider, credential-reachable floor -- never Pipenzo's own GitHub token,
    // and never the calls that populate a working tree (see the module's own doc comment on why).
    // It also gets a longer timeout than pipenzo-git's two-minute default, since it is the one
    // network-bound call here.
    expect(calls[0]?.options).toEqual({ credentialReachable: true, timeoutMs: 10 * 60_000 });

    expect(calls[1]?.args).toEqual(['symbolic-ref', '--short', 'HEAD']);
    expect(calls[1]?.cwd).toBe(targetDir);
    expect(calls[1]?.options).toBeUndefined();

    expect(calls[2]?.args).toEqual(['checkout', '--quiet', 'trunk']);
    expect(calls[2]?.cwd).toBe(targetDir);
    expect(calls[2]?.options).toBeUndefined();

    // The ownership marker is what later lets an interrupted clone be identified as ours.
    expect(await exists(join(targetDir, '.git', 'pipenzo-managed'))).toBe(true);
  });

  it('claims the target directory before cloning, so git clones into a directory this call made', async () => {
    const targetDir = join(root, 'octocat', 'hello-world');
    let existedAtClone: boolean | undefined;
    const runGit: PipenzoGitRunner = async (args, cwd, options) => {
      if (args[0] === 'clone') {
        existedAtClone = await exists(targetDir);
        expect(await readdir(targetDir)).toEqual([]);
      }
      return fakeClone()(args, cwd, options);
    };

    await expect(resolveRepoCheckout(REPO, root, runGit)).resolves.toBe(targetDir);
    expect(existedAtClone).toBe(true);
  });

  it('never removes a directory another caller claimed: a racing second call refuses instead of cloning over or deleting it', async () => {
    const targetDir = join(root, 'octocat', 'hello-world');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Call A: blocked inside its clone, having already claimed the directory.
    const first = resolveRepoCheckout(REPO, root, async (args, cwd, options) => {
      if (args[0] === 'clone') await gate;
      return fakeClone()(args, cwd, options);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await exists(targetDir)).toBe(true);

    // Call B, bypassing `RepoCheckouts`: sees A's claimed (still empty) directory, is not a checkout.
    await expect(
      resolveRepoCheckout(REPO, root, fakeExistingRemote(undefined)),
    ).rejects.toMatchObject({ code: 'path_conflict' });
    expect(await exists(targetDir)).toBe(true);

    release();
    await expect(first).resolves.toBe(targetDir);
    expect(await exists(join(targetDir, '.git', 'index'))).toBe(true);
  });

  it.each([
    ['a trailing dot (Windows strips it, aliasing "hello-world")', { owner: 'octocat', repo: 'hello-world.' }],
    ['a trailing space', { owner: 'octocat', repo: 'hello-world ' }],
    ['all dots', { owner: 'octocat', repo: '...' }],
    ['a dot-dot segment', { owner: 'octocat', repo: '..' }],
    ['a .git suffix (aliases the same remote)', { owner: 'octocat', repo: 'hello-world.GIT' }],
    ['a Windows device name', { owner: 'octocat', repo: 'con' }],
    ['a path separator', { owner: 'octocat', repo: 'a\\..\\..\\escape' }],
    ['a dot-dot owner', { owner: '..', repo: 'hello-world' }],
  ])('refuses a repository reference with %s, before touching the disk or git', async (_label, ref) => {
    const runGit: PipenzoGitRunner = async (args) => {
      throw new Error(`git should not have been invoked, but was: ${args.join(' ')}`);
    };

    await expect(resolveRepoCheckout(ref, root, runGit)).rejects.toMatchObject({
      code: 'invalid_repository',
    } satisfies Partial<RepoCheckoutError>);
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses an owner directory that is a symlink/junction, without following it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pipenzo-outside-'));
    try {
      await linkDirectory(outside, join(root, 'octocat'));
      await expect(
        resolveRepoCheckout(REPO, root, async (args) => {
          throw new Error(`git should not have been invoked: ${args.join(' ')}`);
        }),
      ).rejects.toMatchObject({ code: 'path_conflict' });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a target that is a symlink/junction to a real checkout elsewhere, and does not delete what it points at', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pipenzo-outside-'));
    try {
      // Shaped exactly like a deletable interrupted clone -- through the link.
      await makeInterruptedClone(outside);
      await mkdir(join(root, 'octocat'));
      await linkDirectory(outside, join(root, 'octocat', 'hello-world'));

      await expect(resolveRepoCheckout(REPO, root, MATCHING_ORIGIN_ONLY)).rejects.toMatchObject({
        code: 'path_conflict',
      });
      expect(await exists(join(outside, '.git', 'pipenzo-managed'))).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a clone root that is itself a symlink/junction', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pipenzo-outside-'));
    const linkedRoot = join(root, 'linked-root');
    try {
      await linkDirectory(outside, linkedRoot);
      await expect(
        resolveRepoCheckout(REPO, linkedRoot, async (args) => {
          throw new Error(`git should not have been invoked: ${args.join(' ')}`);
        }),
      ).rejects.toMatchObject({ code: 'path_conflict' });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reuses an existing checkout without cloning when its origin matches', async () => {
    const existing = join(root, 'octocat', 'hello-world');
    await makeFinishedCheckout(existing);

    const path = await resolveRepoCheckout(
      REPO,
      root,
      fakeExistingRemote('https://github.com/octocat/hello-world.git'),
    );

    expect(path).toBe(existing);
  });

  it('reuses an existing checkout cloned over SSH', async () => {
    const existing = join(root, 'octocat', 'hello-world');
    await makeFinishedCheckout(existing);

    const path = await resolveRepoCheckout(
      REPO,
      root,
      fakeExistingRemote('git@github.com:octocat/hello-world.git'),
    );

    expect(path).toBe(existing);
  });

  it('reuses an existing checkout whose remote has a trailing slash', async () => {
    const existing = join(root, 'octocat', 'hello-world');
    await makeFinishedCheckout(existing);

    const path = await resolveRepoCheckout(
      REPO,
      root,
      fakeExistingRemote('https://github.com/octocat/hello-world.git/'),
    );

    expect(path).toBe(existing);
  });

  it('refuses a same-path checkout of a similarly-named repo, not just a same-path substring match', async () => {
    const existing = join(root, 'octocat', 'hello-world');
    await mkdir(existing, { recursive: true });

    await expect(
      resolveRepoCheckout(
        REPO,
        root,
        fakeExistingRemote('https://github.com/octocat/hello-world-fork.git'),
      ),
    ).rejects.toMatchObject({ code: 'path_conflict' } satisfies Partial<RepoCheckoutError>);
  });

  it('refuses a same-path checkout whose remote is on a different host, even with the right owner/repo path', async () => {
    const existing = join(root, 'octocat', 'hello-world');
    await mkdir(existing, { recursive: true });

    await expect(
      resolveRepoCheckout(
        REPO,
        root,
        fakeExistingRemote('https://evil.example/octocat/hello-world.git'),
      ),
    ).rejects.toMatchObject({ code: 'path_conflict' } satisfies Partial<RepoCheckoutError>);
  });

  it('refuses a same-path directory that is not a git checkout at all', async () => {
    const existing = join(root, 'octocat', 'hello-world');
    await mkdir(existing, { recursive: true });

    await expect(
      resolveRepoCheckout(REPO, root, fakeExistingRemote(undefined)),
    ).rejects.toMatchObject({ code: 'path_conflict' } satisfies Partial<RepoCheckoutError>);
  });

  it('refuses a same-path directory that is a git repo with no origin remote configured', async () => {
    const existing = join(root, 'octocat', 'hello-world');
    await mkdir(existing, { recursive: true });

    await expect(
      resolveRepoCheckout(REPO, root, fakeExistingRemote(undefined, 2)),
    ).rejects.toMatchObject({ code: 'path_conflict' } satisfies Partial<RepoCheckoutError>);
  });

  it('refuses a file occupying the target path, without ever invoking git', async () => {
    const ownerDir = join(root, 'octocat');
    await mkdir(ownerDir, { recursive: true });
    await writeFile(join(ownerDir, 'hello-world'), 'not a directory');
    const runGit: PipenzoGitRunner = async (args) => {
      throw new Error(`git should not have been invoked, but was: ${args.join(' ')}`);
    };

    await expect(resolveRepoCheckout(REPO, root, runGit)).rejects.toMatchObject({
      code: 'path_conflict',
    } satisfies Partial<RepoCheckoutError>);
  });

  /*
   * Failure *and recovery*. Every test below makes the second call too: the original versions of
   * these asserted only the first call's rejection, which is exactly how a first call that left a
   * half-populated directory behind -- and a second call that then trusted it -- went unnoticed.
   */

  it('surfaces a failed clone as clone_failed, and the next call clones afresh', async () => {
    const targetDir = join(root, 'octocat', 'hello-world');
    await expect(
      resolveRepoCheckout(REPO, root, fakeClone({ cloneCode: 128 })),
    ).rejects.toMatchObject({ code: 'clone_failed' } satisfies Partial<RepoCheckoutError>);
    expect(await exists(targetDir)).toBe(false);

    const retry = recording(fakeClone());
    await expect(resolveRepoCheckout(REPO, root, retry.runGit)).resolves.toBe(targetDir);
    expect(retry.verbs).toEqual(['clone', 'symbolic-ref', 'checkout']);
  });

  it('surfaces a failure to read the default branch as clone_failed, removes the partial clone, and the next call clones afresh', async () => {
    const targetDir = join(root, 'octocat', 'hello-world');
    await expect(
      resolveRepoCheckout(REPO, root, fakeClone({ branchCode: 128 })),
    ).rejects.toMatchObject({ code: 'clone_failed' } satisfies Partial<RepoCheckoutError>);
    // The clone step had created `<target>/.git` by then; it must not survive the failed call.
    expect(await exists(targetDir)).toBe(false);

    const retry = recording(fakeClone());
    await expect(resolveRepoCheckout(REPO, root, retry.runGit)).resolves.toBe(targetDir);
    expect(retry.verbs).toEqual(['clone', 'symbolic-ref', 'checkout']);
  });

  it('surfaces a failed checkout as clone_failed, removes the partial clone, and the next call clones afresh rather than returning an empty checkout', async () => {
    const targetDir = join(root, 'octocat', 'hello-world');
    await expect(
      resolveRepoCheckout(REPO, root, fakeClone({ checkoutCode: 1 })),
    ).rejects.toMatchObject({ code: 'clone_failed' } satisfies Partial<RepoCheckoutError>);
    expect(await exists(targetDir)).toBe(false);

    // The bug this guards: with the partial clone left behind, this second call used to take the
    // "directory exists, origin matches" fast path and return the empty checkout without cloning.
    const retry = recording(fakeClone());
    await expect(resolveRepoCheckout(REPO, root, retry.runGit)).resolves.toBe(targetDir);
    expect(retry.verbs).toEqual(['clone', 'symbolic-ref', 'checkout']);
    expect(await exists(join(targetDir, '.git', 'index'))).toBe(true);
  });

  it('removes a partial clone when git itself fails to run (e.g. killed by its timeout) and rethrows', async () => {
    const targetDir = join(root, 'octocat', 'hello-world');
    await expect(
      resolveRepoCheckout(REPO, root, fakeClone({ cloneThrows: true })),
    ).rejects.toThrow(/timed out/);
    expect(await exists(targetDir)).toBe(false);
  });

  it('reclones a directory our own previous clone left with the right origin but no checkout (daemon killed between the two steps)', async () => {
    const targetDir = join(root, 'octocat', 'hello-world');
    await makeInterruptedClone(targetDir);
    await writeFile(join(targetDir, '.git', 'objects', 'stale-pack'), 'from the dead clone');

    const calls: string[] = [];
    const runGit: PipenzoGitRunner = async (args, cwd, options) => {
      calls.push(args[0] ?? '');
      if (args[0] === 'remote') {
        return { stdout: 'https://github.com/octocat/hello-world.git\n', stderr: '', code: 0 };
      }
      return fakeClone()(args, cwd, options);
    };

    await expect(resolveRepoCheckout(REPO, root, runGit)).resolves.toBe(targetDir);
    // No `rev-parse`: with no index there is nothing to verify -- it is removed and recloned.
    expect(calls).toEqual(['remote', 'clone', 'symbolic-ref', 'checkout']);
    expect(await exists(join(targetDir, '.git', 'objects', 'stale-pack'))).toBe(false);
    expect(await exists(join(targetDir, '.git', 'index'))).toBe(true);
  });

  /*
   * The security review's High finding: "no index + matching origin" alone is not proof a directory
   * is ours. Each of these is shaped like an interrupted clone in every other respect, and each
   * must be refused with everything in it left exactly where it was.
   */

  it('never wipes a matching-origin, never-checked-out directory holding real untracked work when Pipenzo did not clone it (no marker)', async () => {
    const targetDir = join(root, 'octocat', 'hello-world');
    await makeInterruptedClone(targetDir, { marker: false });
    await writeFile(join(targetDir, 'notes.md'), 'hours of somebody’s work');

    await expect(resolveRepoCheckout(REPO, root, MATCHING_ORIGIN_ONLY)).rejects.toMatchObject({
      code: 'path_conflict',
    } satisfies Partial<RepoCheckoutError>);
    expect(await exists(join(targetDir, 'notes.md'))).toBe(true);
    expect(await exists(join(targetDir, '.git', 'HEAD'))).toBe(true);
  });

  it('never wipes a matching-origin, never-checked-out directory with nothing but .git when Pipenzo did not clone it (no marker)', async () => {
    const targetDir = join(root, 'octocat', 'hello-world');
    await makeInterruptedClone(targetDir, { marker: false });

    await expect(resolveRepoCheckout(REPO, root, MATCHING_ORIGIN_ONLY)).rejects.toMatchObject({
      code: 'path_conflict',
    });
    expect(await exists(join(targetDir, '.git', 'HEAD'))).toBe(true);
  });

  it('never wipes our own interrupted clone once anything but .git is in it (a half-finished checkout, or files dropped in since)', async () => {
    const targetDir = join(root, 'octocat', 'hello-world');
    await makeInterruptedClone(targetDir);
    await writeFile(join(targetDir, 'untracked.txt'), 'keep me');

    await expect(resolveRepoCheckout(REPO, root, MATCHING_ORIGIN_ONLY)).rejects.toMatchObject({
      code: 'path_conflict',
    });
    expect(await exists(join(targetDir, 'untracked.txt'))).toBe(true);
    expect(await exists(join(targetDir, '.git', 'pipenzo-managed'))).toBe(true);
  });

  it('refuses, and does not delete, a matching-origin checkout that has an index but no resolvable HEAD', async () => {
    const targetDir = join(root, 'octocat', 'hello-world');
    await makeFinishedCheckout(targetDir);
    await writeFile(join(targetDir, 'someones-work.txt'), 'keep me');

    await expect(
      resolveRepoCheckout(
        REPO,
        root,
        fakeExistingRemote('https://github.com/octocat/hello-world.git', 0, 128),
      ),
    ).rejects.toMatchObject({ code: 'path_conflict' } satisfies Partial<RepoCheckoutError>);
    expect(await exists(join(targetDir, 'someones-work.txt'))).toBe(true);
  });

  it('refuses, and does not delete, a matching-origin directory whose .git is a file (a linked worktree or submodule)', async () => {
    const targetDir = join(root, 'octocat', 'hello-world');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, '.git'), 'gitdir: /elsewhere/.git/worktrees/hello-world\n');

    await expect(
      resolveRepoCheckout(
        REPO,
        root,
        fakeExistingRemote('https://github.com/octocat/hello-world.git'),
      ),
    ).rejects.toMatchObject({ code: 'path_conflict' } satisfies Partial<RepoCheckoutError>);
    expect(await readdir(targetDir)).toEqual(['.git']);
  });
});

describe('RepoCheckouts', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pipenzo-repo-checkouts-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('joins concurrent resolutions of one repository (case-insensitively) onto a single clone', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verbs: string[] = [];
    const runGit: PipenzoGitRunner = async (args, cwd, options) => {
      verbs.push(args[0] ?? '');
      if (args[0] === 'clone') await gate;
      return fakeClone()(args, cwd, options);
    };
    const checkouts = new RepoCheckouts(root, runGit);

    const first = checkouts.resolve(REPO);
    const second = checkouts.resolve({ owner: 'OctoCat', repo: 'Hello-World' });
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(join(root, 'octocat', 'hello-world'));
    expect(b).toBe(a);
    expect(verbs.filter((verb) => verb === 'clone')).toHaveLength(1);
  });

  it('releases a failed resolution so the next request retries instead of joining a dead promise', async () => {
    let attempt = 0;
    const runGit: PipenzoGitRunner = async (args, cwd, options) => {
      if (args[0] === 'clone') attempt += 1;
      return fakeClone({ checkoutCode: attempt === 1 ? 1 : 0 })(args, cwd, options);
    };
    const checkouts = new RepoCheckouts(root, runGit);

    await expect(checkouts.resolve(REPO)).rejects.toMatchObject({ code: 'clone_failed' });
    await expect(checkouts.resolve(REPO)).resolves.toBe(join(root, 'octocat', 'hello-world'));
    expect(attempt).toBe(2);
  });
});
