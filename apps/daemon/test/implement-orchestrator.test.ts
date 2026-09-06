import { describe, expect, it } from 'vitest';
import type { CreateSessionV2Request, OwnedWorktreeV2, RefineSpecV1 } from '@agent-dock/shared';
import {
  ImplementOrchestrator,
  ImplementOrchestratorError,
  buildImplementPrompt,
  ticketBranchName,
  type ImplementSessionPort,
  type ImplementWorktreeManager,
} from '../src/implement-orchestrator.js';
import type { GitCommandResult, PipenzoGitRunner } from '../src/pipenzo-git.js';
import { WorktreeManagerError } from '../src/worktree-manager.js';

const WORKTREE_ID = '44444444-5555-4666-8777-888888888888';
const SESSION_ID = '55555555-6666-4777-8888-999999999999';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const REPO_PATH = process.platform === 'win32' ? 'C:\\repos\\pipenzo' : '/repos/pipenzo';
const WORKTREE_PATH = process.platform === 'win32' ? 'C:\\owned\\issue-180' : '/owned/issue-180';

/**
 * The raw issue text. It is defined here and never handed to the orchestrator, which is the
 * point: the seeding property is enforced by the signature, so this string has no route into a
 * prompt even if someone later edits the template.
 */
const RAW_ISSUE_BODY =
  'Creates the ticket worktree via agentdock and starts a session seeded with the refine spec.';

function spec(overrides: Partial<RefineSpecV1> = {}): RefineSpecV1 {
  return {
    schemaVersion: 1,
    issue: { repo: 'jortega0033/pipenzo', number: 180, title: 'Backend: Implement orchestration' },
    summary: 'Provision the ticket worktree and run one implement session against the spec.',
    acceptanceCriteria: [
      { id: 'AC-1', kind: 'ubiquitous', text: 'The orchestrator shall create one worktree per ticket.' },
      {
        id: 'AC-2',
        kind: 'event',
        text: 'When the session completes, the orchestrator shall report the commits it produced.',
      },
    ],
    outOfScope: ['Retry ladders', 'The risk classifier'],
    filesLikelyTouched: ['apps/daemon/src/implement-orchestrator.ts'],
    estimate: { changedLines: 260, filesTouched: 3, layered: false },
    openQuestions: [],
    ...overrides,
  };
}

const ok = (stdout = ''): GitCommandResult => ({ stdout, stderr: '', code: 0 });
const failed = (stderr: string, code = 1): GitCommandResult => ({ stdout: '', stderr, code });

interface Harness {
  worktrees: ImplementWorktreeManager;
  sessions: ImplementSessionPort;
  runGit: PipenzoGitRunner;
  gitInvocations: string[][];
  sessionRequests: CreateSessionV2Request[];
  worktreeCreates: unknown[];
}

function harness(options: {
  secretRisk?: boolean;
  git?: Partial<Record<string, GitCommandResult>>;
  createError?: unknown;
  sessionError?: unknown;
  locateWorktree?: boolean;
} = {}): Harness {
  const gitInvocations: string[][] = [];
  const sessionRequests: CreateSessionV2Request[] = [];
  const worktreeCreates: unknown[] = [];

  const created: OwnedWorktreeV2 = {
    id: WORKTREE_ID,
    workspaceId: 'c'.repeat(64),
    name: 'issue-180',
    displayPath: 'issue-180',
    status: 'ready',
    createdAt: '2026-09-06T00:00:00.000Z',
  };

  const worktrees: ImplementWorktreeManager = {
    preview: async () => ({
      secretRisk: options.secretRisk === true,
      includeFiles: options.secretRisk === true ? ['.env.local'] : [],
    }),
    create: async (input) => {
      worktreeCreates.push(input);
      if (options.createError) throw options.createError;
      return created;
    },
    ownedLocation: (id) =>
      options.locateWorktree === false || id !== WORKTREE_ID
        ? undefined
        : { id, path: WORKTREE_PATH, sourcePath: REPO_PATH },
  };

  const sessions: ImplementSessionPort = {
    run: async (request) => {
      sessionRequests.push(request);
      if (options.sessionError) throw options.sessionError;
      return { sessionId: SESSION_ID };
    },
  };

  const defaults: Record<string, GitCommandResult> = {
    'rev-parse-HEAD': ok(`${BASE_SHA}\n`),
    switch: ok(''),
    'rev-parse-branch': ok(`${HEAD_SHA}\n`),
    'rev-list': ok(`${'c'.repeat(40)}\n${HEAD_SHA}\n`),
  };
  const runGit: PipenzoGitRunner = async (args) => {
    gitInvocations.push([...args]);
    const key =
      args[0] === 'rev-parse'
        ? args[args.length - 1] === 'HEAD^{commit}'
          ? 'rev-parse-HEAD'
          : 'rev-parse-branch'
        : (args[0] ?? '');
    return options.git?.[key] ?? defaults[key] ?? ok();
  };

  return { worktrees, sessions, runGit, gitInvocations, sessionRequests, worktreeCreates };
}

function orchestrator(h: Harness): ImplementOrchestrator {
  return new ImplementOrchestrator({
    worktrees: h.worktrees,
    sessions: h.sessions,
    runGit: h.runGit,
  });
}

async function rejection(fn: () => Promise<unknown>): Promise<ImplementOrchestratorError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ImplementOrchestratorError) return error;
    throw error;
  }
  throw new Error('expected an ImplementOrchestratorError');
}

describe('ticketBranchName', () => {
  it('derives one branch per ticket, never from caller input', () => {
    expect(ticketBranchName(180)).toBe('issue-180');
  });

  it('refuses an issue number that is not a positive integer', () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => ticketBranchName(value)).toThrowError(ImplementOrchestratorError);
    }
  });
});

describe('ImplementOrchestrator.implement', () => {
  it('provisions the worktree, creates the ticket branch, runs one session, reports commits', async () => {
    const h = harness();
    const result = await orchestrator(h).implement({
      spec: spec(),
      repositoryPath: REPO_PATH,
      provider: 'claude',
    });

    expect(result).toMatchObject({
      worktreeId: WORKTREE_ID,
      worktreePath: WORKTREE_PATH,
      branch: 'issue-180',
      baseCommit: BASE_SHA,
      headCommit: HEAD_SHA,
      sessionId: SESSION_ID,
    });
    expect(result.commits).toEqual(['c'.repeat(40), HEAD_SHA]);

    // agentdock's own worktree manager, not a parallel worktree concept.
    expect(h.worktreeCreates[0]).toMatchObject({
      cwd: REPO_PATH,
      name: 'issue-180',
      confirmIncludeCopy: true,
    });

    // agentdock creates owned worktrees detached; the ticket's branch is made daemon-side.
    expect(h.gitInvocations.find((argv) => argv[0] === 'switch')).toEqual([
      'switch',
      '--create',
      'issue-180',
      '--no-guess',
    ]);
    // Every git argv terminates option parsing before a caller-influenced value.
    for (const argv of h.gitInvocations.filter((entry) => entry[0] === 'rev-parse')) {
      expect(argv).toContain('--end-of-options');
    }
  });

  it('runs the session inside the worktree, never the source repository', async () => {
    const h = harness();
    await orchestrator(h).implement({ spec: spec(), repositoryPath: REPO_PATH, provider: 'claude' });
    expect(h.sessionRequests[0]?.cwd).toBe(WORKTREE_PATH);
    expect(h.sessionRequests[0]?.cwd).not.toBe(REPO_PATH);
  });

  it('passes a caller-pinned model through, and omits it when there is none', async () => {
    const withModel = harness();
    await orchestrator(withModel).implement({
      spec: spec(),
      repositoryPath: REPO_PATH,
      provider: 'claude',
      model: 'claude-sonnet-4-5',
    });
    expect(withModel.sessionRequests[0]?.model).toBe('claude-sonnet-4-5');

    const without = harness();
    await orchestrator(without).implement({
      spec: spec(),
      repositoryPath: REPO_PATH,
      provider: 'codex',
    });
    expect(without.sessionRequests[0]?.model).toBeUndefined();
  });

  it('reports no commits when the session committed nothing', async () => {
    const h = harness({ git: { 'rev-parse-branch': ok(`${BASE_SHA}\n`) } });
    const result = await orchestrator(h).implement({
      spec: spec(),
      repositoryPath: REPO_PATH,
      provider: 'claude',
    });
    expect(result.commits).toEqual([]);
    expect(h.gitInvocations.some((argv) => argv[0] === 'rev-list')).toBe(false);
  });

  it('refuses a spec that is not a valid v1 refine spec, before touching anything', async () => {
    const h = harness();
    const error = await rejection(() =>
      orchestrator(h).implement({
        spec: { schemaVersion: 1 } as unknown as RefineSpecV1,
        repositoryPath: REPO_PATH,
        provider: 'claude',
      }),
    );
    expect(error.code).toBe('invalid_spec');
    expect(h.worktreeCreates).toHaveLength(0);
    expect(h.gitInvocations).toHaveLength(0);
  });

  /**
   * Fail closed. `.worktreeinclude` is repo-authored, so a repository that lists a `.env` would
   * otherwise have it silently copied next to the agent on every ticket.
   */
  it('refuses a secret-shaped include copy unless a human acknowledged it', async () => {
    const refused = harness({ secretRisk: true });
    const error = await rejection(() =>
      orchestrator(refused).implement({
        spec: spec(),
        repositoryPath: REPO_PATH,
        provider: 'claude',
      }),
    );
    expect(error.code).toBe('worktree_secret_risk');
    expect(error.details).toEqual(['.env.local']);
    expect(refused.worktreeCreates).toHaveLength(0);

    const acknowledged = harness({ secretRisk: true });
    await expect(
      orchestrator(acknowledged).implement({
        spec: spec(),
        repositoryPath: REPO_PATH,
        provider: 'claude',
        acknowledgeIncludeSecretRisk: true,
      }),
    ).resolves.toMatchObject({ branch: 'issue-180' });
  });

  it('translates an untrusted workspace distinctly from any other worktree failure', async () => {
    const untrusted = harness({
      createError: new WorktreeManagerError('workspace_untrusted', 'Workspace is not trusted'),
    });
    expect(
      (
        await rejection(() =>
          orchestrator(untrusted).implement({
            spec: spec(),
            repositoryPath: REPO_PATH,
            provider: 'claude',
          }),
        )
      ).code,
    ).toBe('workspace_untrusted');

    const busy = harness({
      createError: new WorktreeManagerError('invalid_ref', 'Worktree ref does not resolve'),
    });
    const error = await rejection(() =>
      orchestrator(busy).implement({ spec: spec(), repositoryPath: REPO_PATH, provider: 'claude' }),
    );
    expect(error.code).toBe('worktree_failed');
    expect(error.details).toEqual(['invalid_ref']);
  });

  it('fails cleanly when the new worktree cannot be located', async () => {
    const h = harness({ locateWorktree: false });
    expect(
      (
        await rejection(() =>
          orchestrator(h).implement({ spec: spec(), repositoryPath: REPO_PATH, provider: 'claude' }),
        )
      ).code,
    ).toBe('worktree_failed');
  });

  it('fails the phase when the ticket branch cannot be created, rather than running the session', async () => {
    const h = harness({ git: { switch: failed('fatal: a branch named issue-180 already exists') } });
    const error = await rejection(() =>
      orchestrator(h).implement({ spec: spec(), repositoryPath: REPO_PATH, provider: 'claude' }),
    );
    expect(error.code).toBe('branch_failed');
    expect(h.sessionRequests).toHaveLength(0);
  });

  it('wraps a session-layer failure as session_failed', async () => {
    const h = harness({ sessionError: new Error('provider transport unavailable') });
    const error = await rejection(() =>
      orchestrator(h).implement({ spec: spec(), repositoryPath: REPO_PATH, provider: 'claude' }),
    );
    expect(error.code).toBe('session_failed');
    expect(error.message).toContain('provider transport unavailable');
  });
});

describe('buildImplementPrompt', () => {
  /**
   * README's Implement step: a fresh session seeded *only* with the spec. Here that is a property
   * of the signature — `buildImplementPrompt` takes a `RefineSpecV1` and nothing else, so there is
   * no parameter through which the raw issue body could arrive.
   */
  it('is seeded from the spec alone, with no route for the raw issue text', () => {
    const prompt = buildImplementPrompt(spec());
    expect(prompt).not.toContain(RAW_ISSUE_BODY);
    expect(buildImplementPrompt.length).toBe(1);
  });

  it('renders the agreement a reviewer would check the diff against', () => {
    const prompt = buildImplementPrompt(spec({ openQuestions: ['Which store owns the branch name?'] }));
    expect(prompt).toContain('jortega0033/pipenzo#180');
    expect(prompt).toContain('AC-1');
    expect(prompt).toContain('AC-2');
    expect(prompt).toContain('Retry ladders');
    expect(prompt).toContain('apps/daemon/src/implement-orchestrator.ts');
    expect(prompt).toContain('260 changed lines');
    expect(prompt).toContain('Which store owns the branch name?');
  });

  it('omits the optional sections rather than rendering empty headings', () => {
    const prompt = buildImplementPrompt(spec({ filesLikelyTouched: [], openQuestions: [] }));
    expect(prompt).not.toContain('Files the refine phase expects');
    expect(prompt).not.toContain('Open questions');
  });

  it('tells the implementer it cannot publish, since attempting it is a wasted turn', () => {
    const prompt = buildImplementPrompt(spec());
    expect(prompt).toContain('cannot push');
    expect(prompt).toContain('pull request');
  });
});
