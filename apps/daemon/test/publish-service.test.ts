import { describe, expect, it } from 'vitest';
import type { PipenzoPublishRequestV1 } from '@agent-dock/shared';
import {
  DEFAULT_BASE_BRANCH,
  PublishService,
  PublishServiceError,
  parseGitHubRemoteUrl,
  type OwnedWorktreeLocation,
  type OwnedWorktreeLocator,
  type PullRequestOpener,
} from '../src/publish-service.js';
import {
  buildGitEnvironment,
  buildGitPushEnvironment,
  type GitCommandResult,
  type PipenzoGitRunner,
} from '../src/pipenzo-git.js';
import { GitHubClientError } from '../src/github-client.js';

const WORKTREE_ID = '11111111-2222-4333-8444-555555555555';
const HEAD_SHA = 'a'.repeat(40);
const WORKTREE_PATH = process.platform === 'win32' ? 'C:\\owned\\issue-177' : '/owned/issue-177';
const BRANCH = 'issue-177';

/**
 * Fixture credentials are assembled at runtime rather than written as literals, so no string in
 * this file matches a real GitHub token pattern on disk — the repository's own `gitleaks` gate
 * should never have to decide whether a test fixture is a leak.
 */
const fakeToken = (suffix: string): string => `${'gh'}${'p'}_${suffix}`;

/** A configured repository is a precondition of every publish now — see the remote-URL binding. */
const REPO_ENV = { PIPENZO_GITHUB_REPO: 'jortega0033/pipenzo' } as const;

function locator(location?: OwnedWorktreeLocation): OwnedWorktreeLocator {
  const resolved =
    location ?? ({ id: WORKTREE_ID, path: WORKTREE_PATH, sourcePath: WORKTREE_PATH } as const);
  return { ownedLocation: (id) => (id === resolved.id ? resolved : undefined) };
}

const ok = (stdout = ''): GitCommandResult => ({ stdout, stderr: '', code: 0 });
const failed = (stderr: string, code = 1): GitCommandResult => ({ stdout: '', stderr, code });

interface ScriptedGit {
  runGit: PipenzoGitRunner;
  invocations: string[][];
  options: Array<Record<string, unknown> | undefined>;
}

/** A scripted git, keyed on argv, plus a recording of every argv and option bag it was handed. */
function scriptedGit(overrides: Partial<Record<string, GitCommandResult>> = {}): ScriptedGit {
  const invocations: string[][] = [];
  const options: Array<Record<string, unknown> | undefined> = [];
  const defaults: Record<string, GitCommandResult> = {
    'rev-parse--is-inside-work-tree': ok('true\n'),
    remote: ok('origin\nupstream\n'),
    'remote-get-url': ok('https://github.com/jortega0033/pipenzo.git\n'),
    'symbolic-ref': ok(`refs/heads/${BRANCH}\n`),
    'rev-parse--verify': ok(`${HEAD_SHA}\n`),
    status: ok(''),
    push: ok(`To github.com\n*\t${HEAD_SHA}:refs/heads/${BRANCH}\t[new branch]\nDone\n`),
  };
  const runGit: PipenzoGitRunner = async (args, _cwd, callOptions) => {
    invocations.push([...args]);
    options.push(callOptions as Record<string, unknown> | undefined);
    const key =
      args[0] === 'rev-parse'
        ? args[1] === '--is-inside-work-tree'
          ? 'rev-parse--is-inside-work-tree'
          : 'rev-parse--verify'
        : args[0] === 'remote' && args[1] === 'get-url'
          ? 'remote-get-url'
          : (args[0] ?? '');
    return overrides[key] ?? defaults[key] ?? ok();
  };
  return { runGit, invocations, options };
}

function pushRequest(overrides: Record<string, unknown> = {}): PipenzoPublishRequestV1 {
  return {
    worktreeId: WORKTREE_ID,
    branch: BRANCH,
    operation: 'push',
    ...overrides,
  } as PipenzoPublishRequestV1;
}

function prRequest(pullRequest: Record<string, unknown> = {}): PipenzoPublishRequestV1 {
  return {
    worktreeId: WORKTREE_ID,
    branch: BRANCH,
    operation: 'push_and_open_pull_request',
    pullRequest: { title: 'Backend: GitHub API client', body: 'Closes #177', ...pullRequest },
  } as PipenzoPublishRequestV1;
}

function recordingOpener(): {
  opener: (token: string) => PullRequestOpener;
  tokens: string[];
  inputs: unknown[];
} {
  const tokens: string[] = [];
  const inputs: unknown[] = [];
  return {
    tokens,
    inputs,
    opener: (token) => {
      tokens.push(token);
      return {
        async open(input) {
          inputs.push(input);
          return { number: 42, htmlUrl: 'https://github.com/o/r/pull/42', draft: input.draft };
        },
      };
    },
  };
}

async function rejection(fn: () => Promise<unknown>): Promise<PublishServiceError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PublishServiceError) return error;
    throw error;
  }
  throw new Error('expected a PublishServiceError');
}

describe('the git environment', () => {
  it('starts from agentdock\u2019s reviewed default-deny floor, so no GitHub token reaches git', () => {
    const env = buildGitEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      APPDATA: 'C:/AppData',
      PIPENZO_GITHUB_TOKEN: fakeToken('publishServiceSecret0001'),
      GITHUB_TOKEN: fakeToken('publishServiceSecret0002'),
      GH_TOKEN: fakeToken('publishServiceSecret0003'),
      AGENT_DOCK_PORT: '4242',
      ANTHROPIC_API_KEY: 'sk-ant-should-not-be-here',
    });

    expect(Object.values(env).join('|')).not.toMatch(/gh[pousr]_/);
    expect(env.PIPENZO_GITHUB_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.AGENT_DOCK_PORT).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('keeps what a real git install needs, and no SSH agent on the default floor', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/home/dev',
      USERPROFILE: 'C:/Users/dev',
      APPDATA: 'C:/AppData/Roaming',
      LOCALAPPDATA: 'C:/AppData/Local',
      SYSTEMROOT: 'C:/Windows',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus',
      XDG_CONFIG_HOME: '/home/dev/.config',
    };
    const env = buildGitEnvironment(source);
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      USERPROFILE: 'C:/Users/dev',
      APPDATA: 'C:/AppData/Roaming',
      LOCALAPPDATA: 'C:/AppData/Local',
      SYSTEMROOT: 'C:/Windows',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    });
    // Commands that can execute repository-supplied hooks must not carry the user's SSH agent:
    // a hook with a live agent socket can authenticate as the user to anything it likes.
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
  });

  it('adds credential-helper reachability only on the push floor, still without any token', () => {
    const env = buildGitPushEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      SSH_AGENT_PID: '1234',
      GIT_SSH_COMMAND: 'ssh -i /home/dev/.ssh/id',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus',
      DISPLAY: ':0',
      XDG_CONFIG_HOME: '/home/dev/.config',
      XDG_RUNTIME_DIR: '/run/user/1000',
      PIPENZO_GITHUB_TOKEN: fakeToken('stillNotInThePushEnv001'),
    });
    expect(env).toMatchObject({
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      SSH_AGENT_PID: '1234',
      GIT_SSH_COMMAND: 'ssh -i /home/dev/.ssh/id',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus',
      DISPLAY: ':0',
      XDG_CONFIG_HOME: '/home/dev/.config',
      XDG_RUNTIME_DIR: '/run/user/1000',
    });
    expect(env.PIPENZO_GITHUB_TOKEN).toBeUndefined();
    expect(Object.values(env).join('|')).not.toMatch(/gh[pousr]_/);
  });
});

describe('parseGitHubRemoteUrl', () => {
  it('resolves every remote form git accepts', () => {
    const expected = { owner: 'jortega0033', repo: 'pipenzo' };
    for (const url of [
      'https://github.com/jortega0033/pipenzo.git',
      'https://github.com/jortega0033/pipenzo',
      'https://x-access-token:secret@github.com/jortega0033/pipenzo.git',
      'ssh://git@github.com/jortega0033/pipenzo.git',
      'git@github.com:jortega0033/pipenzo.git',
      'git@github.com:jortega0033/pipenzo',
    ]) {
      expect(parseGitHubRemoteUrl(url)).toEqual(expected);
    }
  });

  it('returns nothing for a host that is not github.com, or a shape that is not a repository', () => {
    for (const url of [
      'https://gitlab.com/jortega0033/pipenzo.git',
      'https://github.com.evil.test/jortega0033/pipenzo.git',
      'https://github.com/jortega0033',
      'https://github.com/a/b/c',
      '/local/path/to/repo',
      '',
    ]) {
      expect(parseGitHubRemoteUrl(url)).toBeUndefined();
    }
  });
});

describe('PublishService.publish — push', () => {
  it('pushes the resolved commit, not the ref, and carries no force or verify flag', async () => {
    const { runGit, invocations, options } = scriptedGit();
    const service = new PublishService({ worktrees: locator(), runGit, env: REPO_ENV });

    const result = await service.publish(pushRequest());

    expect(result).toMatchObject({
      worktreeId: WORKTREE_ID,
      remote: 'origin',
      branch: BRANCH,
      headSha: HEAD_SHA,
      updatedRemote: true,
    });
    expect(result.pullRequest).toBeUndefined();

    const pushIndex = invocations.findIndex((argv) => argv[0] === 'push');
    // The sha as the refspec source is what makes `headSha` a promise rather than a guess: a
    // commit landing after resolution cannot ride out under an approval that never saw it.
    expect(invocations[pushIndex]).toEqual([
      'push',
      '--porcelain',
      '--no-verify',
      'origin',
      `${HEAD_SHA}:refs/heads/${BRANCH}`,
    ]);
    // Only the push gets the wider, credential-reachable environment.
    expect(options[pushIndex]).toMatchObject({ credentialReachable: true });
    expect(options.filter((entry) => entry?.credentialReachable === true)).toHaveLength(1);
    expect(invocations.flat().join(' ')).not.toMatch(/--force|--delete|--mirror/);
  });

  it('reports an already-up-to-date remote as a successful no-op', async () => {
    const { runGit } = scriptedGit({
      push: ok(`To github.com\n=\t${HEAD_SHA}:refs/heads/${BRANCH}\t[up to date]\nDone\n`),
    });
    const service = new PublishService({ worktrees: locator(), runGit, env: REPO_ENV });
    expect((await service.publish(pushRequest())).updatedRemote).toBe(false);
  });

  it('never reads a GitHub token for a plain push', async () => {
    const { runGit } = scriptedGit();
    const opener = recordingOpener();
    const service = new PublishService({
      worktrees: locator(),
      runGit,
      env: { ...REPO_ENV, PIPENZO_GITHUB_TOKEN: fakeToken('neverReadForAPlainPush01') },
      createPullRequestOpener: opener.opener,
    });
    await service.publish(pushRequest());
    expect(opener.tokens).toEqual([]);
  });

  it('refuses a worktree id agentdock does not own, before running any git command', async () => {
    const { runGit, invocations } = scriptedGit();
    const service = new PublishService({ worktrees: locator(), runGit, env: REPO_ENV });
    const error = await rejection(() =>
      service.publish(pushRequest({ worktreeId: '99999999-2222-4333-8444-555555555555' })),
    );
    expect(error.code).toBe('worktree_not_found');
    expect(invocations).toHaveLength(0);
  });

  it('refuses when the owned path is not actually a git working tree', async () => {
    const { runGit } = scriptedGit({ 'rev-parse--is-inside-work-tree': ok('false\n') });
    const service = new PublishService({ worktrees: locator(), runGit, env: REPO_ENV });
    expect((await rejection(() => service.publish(pushRequest()))).code).toBe(
      'worktree_not_a_git_repository',
    );
  });

  it('refuses an unknown remote before running push', async () => {
    const { runGit, invocations } = scriptedGit({ remote: ok('origin\n') });
    const service = new PublishService({ worktrees: locator(), runGit, env: REPO_ENV });
    const error = await rejection(() => service.publish(pushRequest({ remote: 'fork' })));
    expect(error.code).toBe('remote_not_found');
    expect(invocations.some((argv) => argv[0] === 'push')).toBe(false);
  });

  /**
   * `.git/config` is shared across a repository's linked worktrees, so an agent working in one can
   * rewrite `remote.origin.pushurl`. Without this check a human approves "push to origin" and the
   * approved commit lands on a host of someone else's choosing.
   */
  it('refuses a remote whose push URL does not point at the configured repository', async () => {
    for (const url of [
      'https://github.com/attacker/exfil.git',
      'https://gitlab.com/jortega0033/pipenzo.git',
      'git@github.com.evil.test:jortega0033/pipenzo.git',
    ]) {
      const { runGit, invocations } = scriptedGit({ 'remote-get-url': ok(`${url}\n`) });
      const service = new PublishService({ worktrees: locator(), runGit, env: REPO_ENV });
      const error = await rejection(() => service.publish(pushRequest()));
      expect(error.code).toBe('remote_not_found');
      expect(invocations.some((argv) => argv[0] === 'push')).toBe(false);
    }
  });

  it('accepts the configured repository in any remote-URL form, case-insensitively', async () => {
    for (const url of [
      'git@github.com:JOrtega0033/Pipenzo.git',
      'ssh://git@github.com/jortega0033/pipenzo',
    ]) {
      const { runGit } = scriptedGit({ 'remote-get-url': ok(`${url}\n`) });
      const service = new PublishService({ worktrees: locator(), runGit, env: REPO_ENV });
      await expect(service.publish(pushRequest())).resolves.toMatchObject({ branch: BRANCH });
    }
  });

  /**
   * `refs/heads/*` lives in the repository's common directory, shared by every linked worktree.
   * Without this binding a worktree id alone would let ticket A push `main`, or ticket B's branch.
   */
  it('refuses to push a branch that is not the one this worktree has checked out', async () => {
    const { runGit, invocations } = scriptedGit({ 'symbolic-ref': ok('refs/heads/main\n') });
    const service = new PublishService({ worktrees: locator(), runGit, env: REPO_ENV });
    const error = await rejection(() => service.publish(pushRequest()));
    expect(error.code).toBe('branch_not_found');
    expect(error.message).toContain('not the branch checked out');
    expect(invocations.some((argv) => argv[0] === 'push')).toBe(false);
  });

  it('refuses a detached worktree, where symbolic-ref resolves nothing', async () => {
    const { runGit } = scriptedGit({ 'symbolic-ref': failed('', 1) });
    const service = new PublishService({ worktrees: locator(), runGit, env: REPO_ENV });
    expect((await rejection(() => service.publish(pushRequest()))).code).toBe('branch_not_found');
  });

  it('refuses a branch that does not resolve to a commit', async () => {
    const { runGit } = scriptedGit({ 'rev-parse--verify': failed('', 1) });
    const service = new PublishService({ worktrees: locator(), runGit, env: REPO_ENV });
    expect((await rejection(() => service.publish(pushRequest()))).code).toBe('branch_not_found');
  });

  it('refuses to push over uncommitted changes to tracked files, but ignores untracked ones', async () => {
    const dirty = new PublishService({
      worktrees: locator(),
      runGit: scriptedGit({ status: ok(' M src/index.ts\n') }).runGit,
      env: REPO_ENV,
    });
    expect((await rejection(() => dirty.publish(pushRequest()))).code).toBe('uncommitted_changes');

    const { runGit, invocations } = scriptedGit();
    await new PublishService({ worktrees: locator(), runGit, env: REPO_ENV }).publish(pushRequest());
    // The untracked exclusion is what keeps build output from producing agentdock issue #117's
    // false refusal on a repository that ships a dist/ or node_modules/.
    expect(invocations.find((argv) => argv[0] === 'status')).toEqual([
      'status',
      '--porcelain',
      '--untracked-files=no',
    ]);
  });

  it('separates a non-fast-forward rejection from a transport failure', async () => {
    const rejected = new PublishService({
      worktrees: locator(),
      runGit: scriptedGit({
        push: failed('! [rejected] issue-177 -> issue-177 (non-fast-forward)'),
      }).runGit,
      env: REPO_ENV,
    });
    expect((await rejection(() => rejected.publish(pushRequest()))).code).toBe('push_rejected');

    const broken = new PublishService({
      worktrees: locator(),
      runGit: scriptedGit({ push: failed('fatal: unable to access', 128) }).runGit,
      env: REPO_ENV,
    });
    expect((await rejection(() => broken.publish(pushRequest()))).code).toBe('push_failed');
  });

  it('redacts a credential that git echoed back in its own stderr', async () => {
    const leaked = `https://x-access-token:${fakeToken('leakedInGitStderr00001')}@github.com/o/r.git/`;
    const service = new PublishService({
      worktrees: locator(),
      runGit: scriptedGit({ push: failed(`fatal: unable to access ${leaked}`, 128) }).runGit,
      env: REPO_ENV,
    });
    const error = await rejection(() => service.publish(pushRequest()));
    expect(error.message).not.toContain('leakedInGitStderr00001');
    expect(error.message).toContain('[redacted]');
    // Redaction removes the secret, not the sentence: the host and repository survive so the
    // operator still has a diagnostic.
    expect(error.message).toContain('github.com/o/r.git');
  });

  it('rejects a branch name that could be read as a git option', async () => {
    const { runGit, invocations } = scriptedGit();
    const service = new PublishService({ worktrees: locator(), runGit, env: REPO_ENV });
    for (const branch of ['--force', '-x', 'a/../b', 'a//b', 'refs/heads/x.lock', 'x@{1}']) {
      const error = await rejection(() => service.publish(pushRequest({ branch })));
      expect(error.code).toBe('invalid_request');
    }
    expect(invocations).toHaveLength(0);
  });

  it('serializes: a second publish of the same branch is refused while one is running', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = scriptedGit();
    const runGit: PipenzoGitRunner = async (args, cwd, options) => {
      if (args[0] === 'push') await gate;
      return base.runGit(args, cwd, options);
    };
    const service = new PublishService({ worktrees: locator(), runGit, env: REPO_ENV });

    const first = service.publish(pushRequest());
    const second = await rejection(() => service.publish(pushRequest()));
    expect(second.code).toBe('publish_busy');
    release?.();
    await expect(first).resolves.toMatchObject({ branch: BRANCH });
  });

  it('serializes on the destination too, so two worktrees cannot push one branch at once', async () => {
    const other = '22222222-2222-4333-8444-555555555555';
    const worktrees: OwnedWorktreeLocator = {
      ownedLocation: (id) =>
        id === WORKTREE_ID || id === other
          ? { id, path: WORKTREE_PATH, sourcePath: WORKTREE_PATH }
          : undefined,
    };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = scriptedGit();
    const runGit: PipenzoGitRunner = async (args, cwd, options) => {
      if (args[0] === 'push') await gate;
      return base.runGit(args, cwd, options);
    };
    const service = new PublishService({ worktrees, runGit, env: REPO_ENV });

    const first = service.publish(pushRequest());
    const second = await rejection(() => service.publish(pushRequest({ worktreeId: other })));
    expect(second.code).toBe('publish_busy');
    release?.();
    await first;
  });
});

describe('PublishService.publish — push and open pull request', () => {
  it('pushes first, then opens the pull request against the configured repository', async () => {
    const { runGit, invocations } = scriptedGit();
    const opener = recordingOpener();
    const service = new PublishService({
      worktrees: locator(),
      runGit,
      env: { ...REPO_ENV, PIPENZO_GITHUB_TOKEN: fakeToken('onlyTheOctokitCallSees01') },
      createPullRequestOpener: opener.opener,
    });

    const result = await service.publish(prRequest());

    expect(invocations.some((argv) => argv[0] === 'push')).toBe(true);
    expect(result.pullRequest).toEqual({
      number: 42,
      htmlUrl: 'https://github.com/o/r/pull/42',
      baseRef: DEFAULT_BASE_BRANCH,
      draft: false,
    });
    expect(opener.inputs[0]).toMatchObject({
      ref: { owner: 'jortega0033', repo: 'pipenzo' },
      head: BRANCH,
      base: 'main',
      title: 'Backend: GitHub API client',
    });
  });

  it('honours an explicit base branch and the configured default override', async () => {
    const opener = recordingOpener();
    const env = {
      ...REPO_ENV,
      PIPENZO_GITHUB_TOKEN: fakeToken('baseBranchTestToken00001'),
      PIPENZO_GITHUB_BASE: 'develop',
    };
    const service = new PublishService({
      worktrees: locator(),
      runGit: scriptedGit().runGit,
      env,
      createPullRequestOpener: opener.opener,
    });

    expect((await service.publish(prRequest())).pullRequest?.baseRef).toBe('develop');
    expect((await service.publish(prRequest({ base: 'release/1.0' }))).pullRequest?.baseRef).toBe(
      'release/1.0',
    );
  });

  it('refuses a pull request that targets its own branch, before pushing', async () => {
    const { runGit, invocations } = scriptedGit();
    const service = new PublishService({
      worktrees: locator(),
      runGit,
      env: { ...REPO_ENV, PIPENZO_GITHUB_TOKEN: fakeToken('selfTargetTestToken00001') },
      createPullRequestOpener: recordingOpener().opener,
    });
    expect((await rejection(() => service.publish(prRequest({ base: BRANCH })))).code).toBe(
      'invalid_request',
    );
    expect(invocations.some((argv) => argv[0] === 'push')).toBe(false);
  });

  /**
   * The ordering property: a request that will be refused for a missing credential is refused
   * before it has a side effect. Otherwise the operator's natural retry — set the token, try
   * again — produces a second push and a duplicate pull request.
   */
  it('refuses a missing token before pushing anything', async () => {
    const { runGit, invocations } = scriptedGit();
    const service = new PublishService({
      worktrees: locator(),
      runGit,
      env: REPO_ENV,
      createPullRequestOpener: recordingOpener().opener,
    });
    expect((await rejection(() => service.publish(prRequest()))).code).toBe('token_missing');
    expect(invocations.some((argv) => argv[0] === 'push')).toBe(false);
  });

  it('refuses an unconfigured repository distinctly, and before any git command', async () => {
    const { runGit, invocations } = scriptedGit();
    const service = new PublishService({
      worktrees: locator(),
      runGit,
      env: { PIPENZO_GITHUB_TOKEN: fakeToken('repoNotConfiguredTest001') },
      createPullRequestOpener: recordingOpener().opener,
    });
    expect((await rejection(() => service.publish(prRequest()))).code).toBe(
      'repository_not_configured',
    );
    expect(invocations).toHaveLength(0);
  });

  it('maps a rejected token to token_missing and any other GitHub failure to pull_request_failed', async () => {
    const build = (error: GitHubClientError) =>
      new PublishService({
        worktrees: locator(),
        runGit: scriptedGit().runGit,
        env: { ...REPO_ENV, PIPENZO_GITHUB_TOKEN: fakeToken('errorMappingTestToken001') },
        createPullRequestOpener: () => ({
          open: async () => {
            throw error;
          },
        }),
      });

    expect(
      (
        await rejection(() =>
          build(new GitHubClientError('unauthorized', 'bad creds')).publish(prRequest()),
        )
      ).code,
    ).toBe('token_missing');
    expect(
      (
        await rejection(() =>
          build(new GitHubClientError('invalid_request', 'a pull request already exists')).publish(
            prRequest(),
          ),
        )
      ).code,
    ).toBe('pull_request_failed');
  });

  it('hands the token to the opener and to nothing else', async () => {
    const opener = recordingOpener();
    const token = fakeToken('theOnlyPlaceThisShouldGo');
    const { runGit, invocations } = scriptedGit();
    const service = new PublishService({
      worktrees: locator(),
      runGit,
      env: { ...REPO_ENV, PIPENZO_GITHUB_TOKEN: token },
      createPullRequestOpener: opener.opener,
    });

    const result = await service.publish(prRequest());

    expect(opener.tokens).toEqual([token]);
    // Not in any git argv...
    expect(invocations.flat().join(' ')).not.toContain(token);
    // ...and not in the response the renderer receives. (That the service retains no copy is a
    // source-level property, asserted in publish-token-boundary.test.ts — a runtime check cannot
    // see `#private` fields, so a runtime assertion here would pass vacuously.)
    expect(JSON.stringify(result)).not.toContain(token);
  });
});
