import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipenzoGitRunner } from '../src/pipenzo-git.js';
import { RepoCheckoutError, reposRoot, resolveRepoCheckout } from '../src/repo-checkout.js';

const REPO = { owner: 'octocat', repo: 'hello-world' };

/** Answers `remote get-url origin` with a fixed URL and everything else (`clone`) as success. */
function fakeGit(remoteUrl: string | undefined, cloneCode = 0): PipenzoGitRunner {
  return async (args) => {
    if (args[0] === 'remote') {
      if (remoteUrl === undefined) return { stdout: '', stderr: 'not a git repository', code: 128 };
      return { stdout: `${remoteUrl}\n`, stderr: '', code: 0 };
    }
    return { stdout: '', stderr: cloneCode === 0 ? '' : 'clone failed', code: cloneCode };
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

  it('clones into <root>/<owner>/<repo> when nothing is there yet', async () => {
    const calls: { args: readonly string[]; cwd: string; options?: unknown }[] = [];
    const runGit: PipenzoGitRunner = async (args, cwd, options) => {
      calls.push({ args, cwd, options });
      return { stdout: '', stderr: '', code: 0 };
    };

    const path = await resolveRepoCheckout(REPO, root, runGit);

    expect(path).toBe(join(root, 'octocat', 'hello-world'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      'clone',
      'https://github.com/octocat/hello-world.git',
      join(root, 'octocat', 'hello-world'),
    ]);
    // Same floor as publish-service.ts's push -- the user's own credential helper, never the
    // daemon's own GitHub token.
    expect(calls[0]?.options).toEqual({ credentialReachable: true });
  });

  it('reuses an existing checkout without cloning when its origin matches', async () => {
    const existing = join(root, 'octocat', 'hello-world');
    await mkdir(existing, { recursive: true });
    let cloneCalled = false;
    const runGit: PipenzoGitRunner = async (args) => {
      if (args[0] === 'clone') cloneCalled = true;
      return { stdout: 'https://github.com/octocat/hello-world.git\n', stderr: '', code: 0 };
    };

    const path = await resolveRepoCheckout(REPO, root, runGit);

    expect(path).toBe(existing);
    expect(cloneCalled).toBe(false);
  });

  it('reuses an existing checkout cloned over SSH, matched by owner/repo substring', async () => {
    const existing = join(root, 'octocat', 'hello-world');
    await mkdir(existing, { recursive: true });

    const path = await resolveRepoCheckout(
      REPO,
      root,
      fakeGit('git@github.com:octocat/hello-world.git'),
    );

    expect(path).toBe(existing);
  });

  it('refuses a same-path directory whose remote does not match, rather than using or recloning it', async () => {
    const existing = join(root, 'octocat', 'hello-world');
    await mkdir(existing, { recursive: true });

    await expect(
      resolveRepoCheckout(REPO, root, fakeGit('https://github.com/someone-else/hello-world.git')),
    ).rejects.toMatchObject({ code: 'path_conflict' } satisfies Partial<RepoCheckoutError>);
  });

  it('refuses a same-path directory that is not a git checkout at all', async () => {
    const existing = join(root, 'octocat', 'hello-world');
    await mkdir(existing, { recursive: true });

    await expect(
      resolveRepoCheckout(REPO, root, fakeGit(undefined)),
    ).rejects.toMatchObject({ code: 'path_conflict' } satisfies Partial<RepoCheckoutError>);
  });

  it('surfaces a failed clone as clone_failed rather than a bare git error', async () => {
    await expect(
      resolveRepoCheckout(REPO, root, fakeGit(undefined, 128)),
    ).rejects.toMatchObject({ code: 'clone_failed' } satisfies Partial<RepoCheckoutError>);
  });
});
