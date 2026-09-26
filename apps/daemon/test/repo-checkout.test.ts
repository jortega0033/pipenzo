import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipenzoGitRunner } from '../src/pipenzo-git.js';
import { RepoCheckoutError, reposRoot, resolveRepoCheckout } from '../src/repo-checkout.js';

const REPO = { owner: 'octocat', repo: 'hello-world' };

/** For the "directory already exists" branch: answers `remote get-url origin` only, and throws on
 * any other call so a test asserting no clone happens can't pass for the wrong reason. */
function fakeExistingRemote(url: string | undefined, code = url === undefined ? 128 : 0): PipenzoGitRunner {
  return async (args) => {
    if (args[0] === 'remote') {
      if (url === undefined) return { stdout: '', stderr: 'fatal: not a git repository', code };
      return { stdout: `${url}\n`, stderr: '', code };
    }
    throw new Error(`unexpected git call in an existing-checkout test: ${args.join(' ')}`);
  };
}

/** For the "nothing there yet" branch: `clone --no-checkout` -> `symbolic-ref` -> `checkout`. */
function fakeClone(options: {
  cloneCode?: number;
  branch?: string;
  branchCode?: number;
  checkoutCode?: number;
} = {}): PipenzoGitRunner {
  const { cloneCode = 0, branch = 'main', branchCode = 0, checkoutCode = 0 } = options;
  return async (args) => {
    if (args[0] === 'clone') {
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
      return { stdout: '', stderr: checkoutCode === 0 ? '' : 'checkout failed', code: checkoutCode };
    }
    throw new Error(`unexpected git call in a clone test: ${args.join(' ')}`);
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
    expect(calls[0]?.options).toEqual({ credentialReachable: true });

    expect(calls[1]?.args).toEqual(['symbolic-ref', '--short', 'HEAD']);
    expect(calls[1]?.cwd).toBe(targetDir);
    expect(calls[1]?.options).toBeUndefined();

    expect(calls[2]?.args).toEqual(['checkout', '--quiet', 'trunk']);
    expect(calls[2]?.cwd).toBe(targetDir);
    expect(calls[2]?.options).toBeUndefined();
  });

  it('reuses an existing checkout without cloning when its origin matches', async () => {
    const existing = join(root, 'octocat', 'hello-world');
    await mkdir(existing, { recursive: true });

    const path = await resolveRepoCheckout(
      REPO,
      root,
      fakeExistingRemote('https://github.com/octocat/hello-world.git'),
    );

    expect(path).toBe(existing);
  });

  it('reuses an existing checkout cloned over SSH', async () => {
    const existing = join(root, 'octocat', 'hello-world');
    await mkdir(existing, { recursive: true });

    const path = await resolveRepoCheckout(
      REPO,
      root,
      fakeExistingRemote('git@github.com:octocat/hello-world.git'),
    );

    expect(path).toBe(existing);
  });

  it('reuses an existing checkout whose remote has a trailing slash', async () => {
    const existing = join(root, 'octocat', 'hello-world');
    await mkdir(existing, { recursive: true });

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

  it('surfaces a failed clone as clone_failed', async () => {
    await expect(
      resolveRepoCheckout(REPO, root, fakeClone({ cloneCode: 128 })),
    ).rejects.toMatchObject({ code: 'clone_failed' } satisfies Partial<RepoCheckoutError>);
  });

  it('surfaces a failure to read the default branch after a successful clone as clone_failed', async () => {
    await expect(
      resolveRepoCheckout(REPO, root, fakeClone({ branchCode: 128 })),
    ).rejects.toMatchObject({ code: 'clone_failed' } satisfies Partial<RepoCheckoutError>);
  });

  it('surfaces a failed checkout after a successful clone as clone_failed', async () => {
    await expect(
      resolveRepoCheckout(REPO, root, fakeClone({ checkoutCode: 1 })),
    ).rejects.toMatchObject({ code: 'clone_failed' } satisfies Partial<RepoCheckoutError>);
  });
});
