import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CreateSessionV2Request, OwnedWorktreeV2, RefineSpecV1 } from '@agent-dock/shared';
import {
  ImplementOrchestrator,
  ImplementOrchestratorError,
  buildImplementCommitMessage,
  type ImplementSessionEnd,
  type ImplementSessionPort,
  type ImplementWorktreeManager,
} from '../src/implement-orchestrator.js';
import { runGitCommand, type PipenzoGitRunner } from '../src/pipenzo-git.js';

/**
 * The daemon, not the agent, commits Implement's work (follow-up to the phase-session lockdown:
 * with no shell, a Claude implementer cannot `git commit`, so before this every run ended with
 * edited files and zero commits, and nothing ever reached Review or Publish).
 *
 * Real git, real worktree. The "agent" here is a session port that only writes files — it has no
 * git access at all — and every git command is recorded at the orchestrator's own runner, which is
 * the daemon-side `runGitCommand`.
 */

const WORKTREE_ID = '44444444-5555-4666-8777-888888888888';
const HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'] as const;

function spec(): RefineSpecV1 {
  return {
    schemaVersion: 1,
    issue: { repo: 'jortega0033/pipenzo', number: 180, title: 'Add a greeting file' },
    summary: 'Adds greeting.txt so the loop has something to commit.',
    acceptanceCriteria: [{ id: 'AC-1', kind: 'ubiquitous', text: 'The repo shall contain greeting.txt.' }],
    outOfScope: ['Anything else'],
    filesLikelyTouched: ['greeting.txt'],
    estimate: { changedLines: 1, filesTouched: 1, layered: false },
    openQuestions: [],
  };
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const result = await runGitCommand(args, cwd);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A source repository whose tracked `.husky/` hooks would each leave a marker file if they ran —
 * the shape of an agent-written hook in a real repository using `core.hooksPath`.
 */
async function sourceRepository(): Promise<{ root: string; source: string; markers: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pipenzo-implement-commit-'));
  const source = join(root, 'source');
  const markers = join(root, 'markers');
  await mkdir(source);
  await mkdir(markers);
  await git(['init', '--quiet', '--initial-branch=main'], source);
  await git(['config', 'user.name', 'Operator Name'], source);
  await git(['config', 'user.email', 'operator@example.test'], source);
  await git(['config', 'commit.gpgSign', 'false'], source);
  await git(['config', 'core.hooksPath', '.husky'], source);
  await mkdir(join(source, '.husky'));
  for (const hook of HOOKS) {
    const marker = join(markers, hook).replaceAll('\\', '/');
    await writeFile(join(source, '.husky', hook), `#!/bin/sh\necho ran > "${marker}"\n`);
    await chmod(join(source, '.husky', hook), 0o755);
  }
  await writeFile(join(source, 'README.md'), 'base\n');
  await git(['add', '--all'], source);
  // The base commit itself is test setup, so its hooks are skipped the ordinary way.
  await git(['-c', 'core.hooksPath=/nonexistent', 'commit', '--quiet', '-m', 'base'], source);
  return { root, source, markers };
}

function worktreeManager(root: string, source: string): ImplementWorktreeManager {
  const path = join(root, 'owned', 'issue-180');
  const created: OwnedWorktreeV2 = {
    id: WORKTREE_ID,
    workspaceId: 'c'.repeat(64),
    name: 'issue-180',
    displayPath: 'issue-180',
    status: 'ready',
    createdAt: '2026-09-29T00:00:00.000Z',
  };
  return {
    preview: async () => ({ secretRisk: false, includeFiles: [] }),
    create: async () => {
      await git(
        ['-c', 'core.hooksPath=/nonexistent', 'worktree', 'add', '--quiet', '--detach', path],
        source,
      );
      return created;
    },
    ownedLocation: (id) => (id === WORKTREE_ID ? { id, path, sourcePath: source } : undefined),
  };
}

/** The agent: writes files in its cwd and nothing else. No git, no shell. */
function agent(
  files: Record<string, string>,
  end: ImplementSessionEnd = 'completed',
): ImplementSessionPort & { requests: CreateSessionV2Request[] } {
  const requests: CreateSessionV2Request[] = [];
  return {
    requests,
    run: async (request) => {
      requests.push(request);
      for (const [name, content] of Object.entries(files)) {
        // Replace rather than overwrite: Windows marks a worktree's `.git` file hidden, and a
        // hidden file cannot be opened for plain truncating write.
        await rm(join(request.cwd, name), { force: true });
        await writeFile(join(request.cwd, name), content);
      }
      return { sessionId: '55555555-6666-4777-8888-999999999999', ended: Promise.resolve(end) };
    },
  };
}

function recordingDaemonGit(): { runGit: PipenzoGitRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runGit: async (args, cwd, options) => {
      calls.push([...args]);
      return runGitCommand(args, cwd, options);
    },
  };
}

// Real git on Windows spawns a process per command (and a shell per hook in the control step), so
// these run well past vitest's 5000ms default, the same reason #335 raised it elsewhere.
describe('the daemon commits what a completed Implement session wrote', { timeout: 60_000 }, () => {
  it('ends with a real commit on the ticket branch, authored as the operator, made by the daemon', async () => {
    const { root, source, markers } = await sourceRepository();
    const daemonGit = recordingDaemonGit();
    const orchestrator = new ImplementOrchestrator({
      worktrees: worktreeManager(root, source),
      sessions: agent({ 'greeting.txt': 'hello\n' }),
      runGit: daemonGit.runGit,
    });

    const result = await orchestrator.implement({
      spec: spec(),
      repositoryPath: source,
      provider: 'claude',
    });

    expect(result.commits).toHaveLength(1);
    expect(result.headCommit).toBe(result.commits[0]);
    const worktree = result.worktreePath;
    expect(await git(['rev-parse', 'refs/heads/issue-180'], worktree)).toBe(result.headCommit);
    expect(await git(['show', '--name-only', '--format=', result.headCommit], worktree)).toBe(
      'greeting.txt',
    );
    expect(await git(['log', '-1', '--format=%an <%ae>|%cn <%ce>', result.headCommit], worktree)).toBe(
      'Operator Name <operator@example.test>|Operator Name <operator@example.test>',
    );
    expect(await git(['log', '-1', '--format=%B', result.headCommit], worktree)).toBe(
      buildImplementCommitMessage(spec()).trim(),
    );
    expect(await git(['status', '--porcelain'], worktree)).toBe('');

    // The daemon's runner ran the commit, with every repository hook and fsmonitor switched off.
    const commit = daemonGit.calls.find((argv) => argv.includes('commit'));
    expect(commit).toBeDefined();
    expect(commit).toEqual(expect.arrayContaining(['--no-verify', 'core.fsmonitor=false']));
    expect(commit?.some((arg) => arg.startsWith('core.hooksPath='))).toBe(true);
    // ...and none of the four hooks the repository's tracked `.husky/` would have run did run.
    expect(await readdir(markers)).toEqual([]);

    // Control, so the assertion above means something: an ordinary commit in the same worktree
    // does run those hooks.
    await writeFile(join(worktree, 'control.txt'), 'control\n');
    await git(['add', 'control.txt'], worktree);
    await git(['commit', '--quiet', '-m', 'control'], worktree);
    expect((await readdir(markers)).sort()).toEqual([...HOOKS].sort());
  });

  // Issue #192: a session the daemon observed reach a terminal state with zero commits is exactly
  // the #191 incident's shape (a session that "succeeded" and touched nothing), so `collect()` now
  // throws `implement_empty_diff` instead of quietly returning an empty result -- for every terminal
  // state, not just `completed`, since a `failed`/`cancelled` session that also committed nothing
  // still deserves this same loud signal rather than a silently empty result. The worktree/git-level
  // guarantees these two tests actually exist to prove (nothing gets committed, a failed session's
  // half-finished edit is left on disk for a human) still hold either way -- only the "reports
  // nothing" half of the old expectation changed.
  it('throws implement_empty_diff, and commits nothing, when the session changed nothing', async () => {
    const { root, source } = await sourceRepository();
    const daemonGit = recordingDaemonGit();
    const orchestrator = new ImplementOrchestrator({
      worktrees: worktreeManager(root, source),
      sessions: agent({}),
      runGit: daemonGit.runGit,
    });
    let error: unknown;
    try {
      await orchestrator.implement({ spec: spec(), repositoryPath: source, provider: 'claude' });
    } catch (caught) {
      error = caught;
    }
    expect((error as ImplementOrchestratorError).code).toBe('implement_empty_diff');
    expect(daemonGit.calls.some((argv) => argv.includes('commit'))).toBe(false);
  });

  it('throws implement_empty_diff for a failed session, and never commits its half-finished edits', async () => {
    const { root, source } = await sourceRepository();
    const daemonGit = recordingDaemonGit();
    const orchestrator = new ImplementOrchestrator({
      worktrees: worktreeManager(root, source),
      sessions: agent({ 'greeting.txt': 'half\n' }, 'failed'),
      runGit: daemonGit.runGit,
    });
    let error: unknown;
    try {
      await orchestrator.implement({ spec: spec(), repositoryPath: source, provider: 'claude' });
    } catch (caught) {
      error = caught;
    }
    expect((error as ImplementOrchestratorError).code).toBe('implement_empty_diff');
    expect(daemonGit.calls.some((argv) => argv.includes('add') || argv.includes('commit'))).toBe(false);
    // The edit is still there for a human to look at, even though collect() now throws.
    // worktreeManager() above always places the one worktree it creates at this fixed path.
    expect(existsSync(join(root, 'owned', 'issue-180', 'greeting.txt'))).toBe(true);
  });

  /**
   * The worktree's `.git` file is inside the agent's working directory. Pointed at a git directory
   * the agent built, its config could name a clean filter or gpg program that `git add`/`git commit`
   * would execute in the daemon. The commit step refuses to run any git over such a worktree.
   */
  it('refuses to run git at all over a worktree whose .git pointer the session rewrote', async () => {
    const { root, source, markers } = await sourceRepository();
    const daemonGit = recordingDaemonGit();
    const evilGitDir = join(root, 'owned', 'issue-180', 'evil-gitdir').replaceAll('\\', '/');
    const orchestrator = new ImplementOrchestrator({
      worktrees: worktreeManager(root, source),
      sessions: agent({ 'greeting.txt': 'hello\n', '.git': `gitdir: ${evilGitDir}\n` }),
      runGit: daemonGit.runGit,
    });
    let error: unknown;
    try {
      await orchestrator.implement({ spec: spec(), repositoryPath: source, provider: 'claude' });
    } catch (caught) {
      error = caught;
    }
    expect((error as ImplementOrchestratorError).code).toBe('commit_failed');
    expect((error as ImplementOrchestratorError).message).toContain('.git pointer');
    expect(daemonGit.calls.some((argv) => argv.includes('add') || argv.includes('commit'))).toBe(false);
    expect(await readdir(markers)).toEqual([]);
  });

  /**
   * The reviewer's proof of concept, against real `git interpret-trailers`: every spec field is
   * Refine's model output, so a crafted repo, title or summary must not yield a forged trailer, an
   * extra subject line, or a closing keyword that would shut an unrelated issue on merge.
   */
  it('builds a message no spec field can forge trailers or closing keywords into', async () => {
    const hostile: RefineSpecV1 = {
      ...spec(),
      issue: {
        repo: 'evil/repo#1\n\nCo-authored-by: Mallory <m@evil.test>\nSigned-off-by: Mallory <m@evil.test>',
        number: 180,
        title: 'Fixes #99 and closes evil/other#3\nCo-authored-by: Mallory <m@evil.test>',
      },
      summary:
        'Looks harmless.\n\nFixes #42\nResolves https://github.com/x/y/issues/7\n\nCo-authored-by: Mallory <m@evil.test>',
    };
    const message = buildImplementCommitMessage(hostile);
    const dir = await mkdtemp(join(tmpdir(), 'pipenzo-commit-message-'));
    const file = join(dir, 'message.txt');
    await writeFile(file, `${message}\n`);
    expect(await git(['interpret-trailers', '--parse', file], dir)).toBe('');

    expect(message.split('\n')).toHaveLength(1); // no valid `Refs` line for a non-slug repo
    // Hostile title text stays on the one subject line (where git never reads trailers); the
    // summary and the non-slug repo contribute nothing at all.
    expect(message).not.toMatch(/Looks harmless|evil\/repo|Resolves/);
    expect(message).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s*:?\s*(#\d|[\w.-]+\/[\w.-]+#\d|https?:)/i);
    expect(message.endsWith('(#180)')).toBe(true);

    // A well-formed spec still gets its reference line, and a conventional `fix:` title survives.
    const plain = buildImplementCommitMessage({
      ...spec(),
      issue: { ...spec().issue, title: 'fix: handle empty input' },
    });
    expect(plain).toBe('fix: handle empty input (#180)\n\nRefs jortega0033/pipenzo#180');
  });

  it('refuses to commit a secret-shaped file the session left behind, and says so', async () => {
    const { root, source } = await sourceRepository();
    const orchestrator = new ImplementOrchestrator({
      worktrees: worktreeManager(root, source),
      sessions: agent({ 'greeting.txt': 'hello\n', '.env': 'TOKEN=leak\n' }),
    });
    let error: unknown;
    try {
      await orchestrator.implement({ spec: spec(), repositoryPath: source, provider: 'claude' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ImplementOrchestratorError);
    expect((error as ImplementOrchestratorError).code).toBe('commit_failed');
    expect((error as ImplementOrchestratorError).details).toEqual(['.env']);
    const worktree = join(root, 'owned', 'issue-180');
    // Nothing committed and nothing left staged.
    expect(await git(['rev-parse', 'HEAD'], worktree)).toBe(await git(['rev-parse', 'main'], source));
    expect(await git(['diff', '--cached', '--name-only'], worktree)).toBe('');
  });
});
