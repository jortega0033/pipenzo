import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import type { CreateSessionV2Request, RefineSpecV1 } from '@agent-dock/shared';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { PipenzoPhaseService } from '../src/pipenzo-phase-service.js';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import { GitHubClientError, type GitHubIssue } from '../src/github-client.js';
import type { CommandResult, GateCommandRunner } from '../src/review-gates.js';
import type { GitCommandResult, PipenzoGitRunner } from '../src/pipenzo-git.js';
import type { ImplementWorktreeManager } from '../src/implement-orchestrator.js';

const TOKEN = 'test-token-pipenzo-phases';
const WORKTREE_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const SESSION_ID = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const REPO_PATH = process.platform === 'win32' ? 'C:\\repos\\pipenzo' : '/repos/pipenzo';
const WORKTREE_PATH = process.platform === 'win32' ? 'C:\\owned\\issue-184' : '/owned/issue-184';
const REPO_ENV = { PIPENZO_GITHUB_REPO: 'jortega0033/pipenzo' } as const;
const auth = { authorization: `Bearer ${TOKEN}` };

const scratch: string[] = [];
afterAll(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

function spec(overrides: Partial<RefineSpecV1> = {}): RefineSpecV1 {
  return {
    schemaVersion: 1,
    issue: { repo: 'jortega0033/pipenzo', number: 184, title: 'Expose the phases as routes' },
    summary: 'Give Refine, Implement and Review real daemon routes.',
    acceptanceCriteria: [
      { id: 'AC-1', kind: 'ubiquitous', text: 'The daemon shall expose a refine route' },
    ],
    outOfScope: ['Routing model tiers'],
    filesLikelyTouched: ['apps/daemon/src/routes/pipenzo-phases.ts'],
    estimate: { changedLines: 400, filesTouched: 8, layered: false },
    openQuestions: [],
    ...overrides,
  };
}

const REFINE_SPEC_JSON = JSON.stringify(spec());

const DRAFT_JSON = JSON.stringify({
  schemaVersion: 1,
  title: 'Show an unread badge on the tray icon when a ticket is ready for review',
  acceptanceCriteria: [
    {
      id: 'AC-1',
      kind: 'event',
      text: 'When a ticket reaches ready-for-review, the tray icon shall show an unread badge',
    },
  ],
  outOfScope: ['sounds'],
  estimate: { changedLines: 40, filesTouched: 1, layered: false },
  openQuestions: [],
});

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    owner: 'jortega0033',
    repo: 'pipenzo',
    number: 184,
    title: 'Expose the phases as routes',
    body: 'The five backend modules exist but only publish has a route.',
    state: 'open',
    labels: [],
    assignees: [],
    htmlUrl: 'https://github.com/jortega0033/pipenzo/issues/184',
    updatedAt: '2026-09-01T00:00:00.000Z',
    etag: undefined,
    ...overrides,
  };
}

const ok = (stdout = ''): GitCommandResult => ({ stdout, stderr: '', code: 0 });

const runGit: PipenzoGitRunner = async (args) => {
  if (args[0] === 'rev-parse' && String(args[3] ?? '').startsWith('refs/heads/')) {
    return ok(`${HEAD_SHA}\n`);
  }
  if (args[0] === 'rev-parse') return ok(`${BASE_SHA}\n`);
  if (args[0] === 'switch') return ok('');
  if (args[0] === 'rev-list') return ok(`${'c'.repeat(40)}\n${HEAD_SHA}\n`);
  if (args[0] === 'diff' && args[1] === '--numstat') return ok(`10\t2\tsrc/a.ts\n`);
  if (args[0] === 'diff') return ok('diff --git a/src/a.ts b/src/a.ts\n');
  return ok();
};

const worktrees: ImplementWorktreeManager & { ownedLocation: (id: string) => unknown } = {
  preview: async () => ({ secretRisk: false, includeFiles: [] }),
  create: async () => ({
    id: WORKTREE_ID,
    workspaceId: 'a'.repeat(64),
    name: 'issue-184',
    displayPath: 'issue-184',
    status: 'ready' as const,
    createdAt: '2026-09-01T00:00:00.000Z',
  }),
  ownedLocation: (id: string) =>
    id === WORKTREE_ID ? { id, path: WORKTREE_PATH, sourcePath: REPO_PATH } : undefined,
};

/** Every gate binary absent: the deterministic gates record `skipped`, never a clean pass. */
const noCommands: GateCommandRunner = {
  available: async () => false,
  run: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', code: 0 }),
};

interface Harness {
  github?: FakeGitHubClient;
  refineOutput?: string;
  draftOutput?: string;
  reviewPayload?: unknown;
  commands?: GateCommandRunner;
  env?: Record<string, string | undefined>;
  withGitHub?: boolean;
  onSession?: (request: CreateSessionV2Request) => void;
}

function buildApp(harness: Harness = {}) {
  const registry = new ProviderRegistry();
  const github = harness.github ?? new FakeGitHubClient().seedIssue(issue());
  const service = new PipenzoPhaseService({
    refineSessions: {
      run: async (request) => {
        harness.onSession?.(request);
        // The drafter (issue #84) shares this port with Refine on purpose -- it is read-only for
        // the same reason. Which payload to answer with is decided by which prompt arrived.
        const drafting = request.prompt.startsWith('Someone described a problem');
        return {
          sessionId: SESSION_ID,
          output: JSON.parse(
            drafting ? (harness.draftOutput ?? DRAFT_JSON) : (harness.refineOutput ?? REFINE_SPEC_JSON),
          ),
          toolsUsed: ['Read', 'Grep'],
        };
      },
    },
    reviewSessions: {
      run: async () => ({
        sessionId: SESSION_ID,
        findings: [],
        verdict: 'approved' as const,
        ...(harness.reviewPayload as object | undefined),
      }),
    },
    implementSessions: {
      run: async (request) => {
        harness.onSession?.(request);
        return { sessionId: SESSION_ID };
      },
    },
    worktrees: worktrees as never,
    ...(harness.withGitHub === false ? {} : { github: () => github }),
    commands: harness.commands ?? noCommands,
    runGit,
    env: harness.env ?? REPO_ENV,
  });
  return {
    github,
    app: buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
      phaseService: service,
    }),
  };
}

describe('POST /v2/pipenzo/refine', () => {
  it('reads the issue, runs the phase and answers with a validated spec', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/refine',
      headers: auth,
      payload: {
        issueNumber: 184,
        repositoryPath: REPO_PATH,
        provider: 'claude',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionId: SESSION_ID,
      toolsUsed: ['Read', 'Grep'],
      spec: { issue: { number: 184 } },
    });
  });

  /**
   * The negative that makes Refine "read-only by construction" worth claiming at the route: a
   * session that used a tool outside the allowlist fails the phase, and it fails it even though
   * the spec it produced was perfectly valid.
   */
  it('fails the phase when the session used a tool outside the read-only allowlist', async () => {
    const registry = new ProviderRegistry();
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
      phaseService: new PipenzoPhaseService({
        refineSessions: {
          run: async () => ({
            sessionId: SESSION_ID,
            output: JSON.parse(REFINE_SPEC_JSON),
            toolsUsed: ['Read', 'Write'],
          }),
        },
        reviewSessions: { run: async () => ({ sessionId: SESSION_ID, findings: [] }) },
        implementSessions: { run: async () => ({ sessionId: SESSION_ID }) },
        worktrees: worktrees as never,
        github: () => new FakeGitHubClient().seedIssue(issue()),
        commands: noCommands,
        runGit,
        env: REPO_ENV,
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/refine',
      headers: auth,
      payload: { issueNumber: 184, repositoryPath: REPO_PATH, provider: 'claude' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'read_only_violation', details: ['Write'] });
  });

  it('reports a spec that fails the v1 schema as 422 rather than as a session failure', async () => {
    const { app } = buildApp({ refineOutput: JSON.stringify({ schemaVersion: 1 }) });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/refine',
      headers: auth,
      payload: { issueNumber: 184, repositoryPath: REPO_PATH, provider: 'claude' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'spec_invalid' });
  });

  it('reports an unconfigured repository as 412', async () => {
    const { app } = buildApp({ env: {} });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/refine',
      headers: auth,
      payload: { issueNumber: 184, repositoryPath: REPO_PATH, provider: 'claude' },
    });
    expect(response.statusCode).toBe(412);
    expect(response.json()).toMatchObject({ code: 'repository_not_configured' });
  });
});

describe('POST /v2/pipenzo/implement', () => {
  /**
   * The property the ticket exists for: the renderer asks for a session inside the ticket's
   * worktree and is answered with an id, a branch and a base commit. The worktree's real path is
   * on the daemon's side of this response and stays there.
   */
  it('starts a session in the ticket worktree without disclosing the worktree path', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/implement',
      headers: auth,
      payload: { spec: spec(), repositoryPath: REPO_PATH, provider: 'claude' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      worktreeId: WORKTREE_ID,
      branch: 'issue-184',
      baseCommit: BASE_SHA,
      sessionId: SESSION_ID,
    });
    expect(response.body).not.toContain(WORKTREE_PATH);
    expect(response.body).not.toContain('owned');
  });

  it('appends the operator’s extra instructions to the spec-derived prompt', async () => {
    let seen: CreateSessionV2Request | undefined;
    const { app } = buildApp({ onSession: (request) => (seen = request) });
    await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/implement',
      headers: auth,
      payload: {
        spec: spec(),
        repositoryPath: REPO_PATH,
        provider: 'claude',
        extraInstructions: 'Prefer the existing route helper.',
      },
    });
    expect(seen?.prompt).toContain('Acceptance criteria');
    expect(seen?.prompt).toContain('Prefer the existing route helper.');
    expect(seen?.prompt).toContain('not replace it');
  });

  it('collects the commits afterwards, still addressed by worktree id', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/implement/result',
      headers: auth,
      payload: { worktreeId: WORKTREE_ID, branch: 'issue-184', baseCommit: BASE_SHA },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ headCommit: HEAD_SHA, commits: ['c'.repeat(40), HEAD_SHA] });
    expect(response.body).not.toContain(WORKTREE_PATH);
  });

  it('answers 404 for a worktree the daemon does not own', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/implement/result',
      headers: auth,
      payload: {
        worktreeId: '00000000-1111-4222-8333-444444444444',
        branch: 'issue-184',
        baseCommit: BASE_SHA,
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'worktree_not_found' });
  });
});

describe('POST /v2/pipenzo/review', () => {
  it('runs the gates for a worktree named by id and returns the report', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/review',
      headers: auth,
      payload: {
        spec: spec(),
        worktreeId: WORKTREE_ID,
        baseCommit: BASE_SHA,
        headCommit: HEAD_SHA,
        implementerTier: 'mid',
        reviewer: { provider: 'claude', model: 'reviewer-model', tier: 'mid' },
        verifier: { provider: 'codex', model: 'verifier-model', tier: 'frontier' },
      },
    });
    expect(response.statusCode).toBe(200);
    const report = response.json();
    expect(report.outcome).toBe('approved');
    expect(report.diffScope.implementation.changedLines).toBe(12);
    expect(response.body).not.toContain(WORKTREE_PATH);
  });

  it('refuses a verifier weaker than the implementer before running anything', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/review',
      headers: auth,
      payload: {
        spec: spec(),
        worktreeId: WORKTREE_ID,
        baseCommit: BASE_SHA,
        headCommit: HEAD_SHA,
        implementerTier: 'frontier',
        reviewer: { provider: 'claude', model: 'reviewer-model', tier: 'mid' },
        verifier: { provider: 'codex', model: 'verifier-model', tier: 'cheap' },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'verifier_tier_too_low' });
  });
});

describe('POST /v2/pipenzo/issues/claim', () => {
  it('assigns, re-reads uncached, and reports the ticket as claimed', async () => {
    const { app, github } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/issues/claim',
      headers: auth,
      payload: { issueNumber: 184, assignee: 'jortega0033' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'claimed', assignees: ['jortega0033'] });
    // The re-read is a second request, not the write's own echo — that is the whole rule.
    expect(github.calls.map((call) => call.method)).toEqual(['assignIssue', 'getIssue']);
  });

  it('refuses when somebody else already holds the ticket', async () => {
    const github = new FakeGitHubClient().seedIssue(issue({ assignees: ['someone-else'] }));
    const { app } = buildApp({ github });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/issues/claim',
      headers: auth,
      payload: { issueNumber: 184, assignee: 'jortega0033' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: 'claimed_elsewhere',
      assignees: ['someone-else', 'jortega0033'],
    });
  });

  it('maps a GitHub rate limit onto 429 rather than a generic failure', async () => {
    const github = new FakeGitHubClient().seedIssue(issue());
    github.failNext('assignIssue', new GitHubClientError('rate_limited', 'rate limit reached'));
    const { app } = buildApp({ github });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/issues/claim',
      headers: auth,
      payload: { issueNumber: 184, assignee: 'jortega0033' },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'github_rate_limited' });
  });
});

describe('POST /v2/pipenzo/issues', () => {
  it('creates an issue and answers 201 with its number and url', async () => {
    const github = new FakeGitHubClient().setNextIssueNumber(900);
    const { app } = buildApp({ github });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/issues',
      headers: auth,
      payload: { title: 'Drafted from an idea', body: 'Acceptance criteria...' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      issueNumber: 900,
      htmlUrl: 'https://github.com/jortega0033/pipenzo/issues/900',
    });
  });
});

describe('the phase routes as a surface', () => {
  const routes = [
    '/v2/pipenzo/refine',
    '/v2/pipenzo/implement',
    '/v2/pipenzo/implement/result',
    '/v2/pipenzo/review',
    '/v2/pipenzo/issues/claim',
    '/v2/pipenzo/issues',
    '/v2/pipenzo/capabilities',
    '/v2/pipenzo/issues/draft',
  ];

  it('rejects an unauthenticated caller on every phase route', async () => {
    const { app } = buildApp();
    for (const url of routes) {
      const response = await app.inject({ method: 'POST', url, payload: {} });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('rejects a browser-originated request on every phase route', async () => {
    const { app } = buildApp();
    for (const url of routes) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { ...auth, origin: 'http://localhost:5173' },
        payload: {},
      });
      expect(response.statusCode, url).toBe(403);
      expect(response.json()).toMatchObject({ code: 'browser_origin_forbidden' });
    }
  });

  it('does not exist at all when no phase service is configured', async () => {
    const registry = new ProviderRegistry();
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
    });
    for (const url of routes) {
      const response = await app.inject({ method: 'POST', url, headers: auth, payload: {} });
      expect(response.statusCode, url).toBe(404);
    }
  });

  /** A rejected body carries issue text and spec text. It is never echoed back. */
  it('rejects a malformed body without echoing it back', async () => {
    const { app } = buildApp();
    for (const [url, payload] of [
      ['/v2/pipenzo/refine', { issueNumber: 0, repositoryPath: REPO_PATH, provider: 'claude' }],
      ['/v2/pipenzo/refine', { issueNumber: 1, repositoryPath: REPO_PATH, provider: 'gemini' }],
      ['/v2/pipenzo/implement', { spec: { schemaVersion: 2 }, repositoryPath: REPO_PATH, provider: 'claude' }],
      // A path where a worktree id belongs: the route has no field to accept it.
      ['/v2/pipenzo/review', { spec: spec(), worktreePath: WORKTREE_PATH, baseCommit: BASE_SHA, headCommit: HEAD_SHA, implementerTier: 'mid', reviewer: { provider: 'claude', model: 'm', tier: 'mid' }, verifier: { provider: 'claude', model: 'm', tier: 'mid' } }],
      ['/v2/pipenzo/issues/claim', { issueNumber: 184, assignee: 'not a login' }],
      ['/v2/pipenzo/issues', { title: '', body: '' }],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, headers: auth, payload });
      expect(response.statusCode, url).toBe(400);
      expect(response.json().code).toBe('invalid_request');
      expect(response.body).not.toContain('schemaVersion');
      expect(response.body).not.toContain(WORKTREE_PATH);
    }
  });
});

/**
 * Issue #124's backing route: a real probe of a real repository, and a reason attached to every
 * "no". A capability panel whose toggles had no probe behind them would be exactly the unstated
 * reduced mode README says must not happen.
 */
describe('POST /v2/pipenzo/capabilities', () => {
  it('reports Playwright as unavailable, with a reason, for a repository without it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipenzo-cap-'));
    scratch.push(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'bare' }), 'utf8');
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/capabilities',
      headers: auth,
      payload: { repositoryPath: root },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: 1,
      screenshot: { available: false },
      escapeHatch: { configured: false },
      activeTrustClass: null,
    });
    expect(response.json().screenshot.reason).toContain('no Playwright');
  });

  it('reports the escape hatch when the repository committed one, and names the trust class', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipenzo-cap-'));
    scratch.push(root);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'hatch',
        pipenzo: { verify: { screenshot: { command: 'node', args: ['shots.mjs'] } } },
      }),
      'utf8',
    );
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/capabilities',
      headers: auth,
      payload: { repositoryPath: root },
    });
    expect(response.json()).toMatchObject({
      escapeHatch: { configured: true },
      activeTrustClass: 'repo-authored-command',
    });
  });

  /**
   * A repository that tried to configure this and got it wrong must not look like one that never
   * tried -- that is a reason to fix a typo, not a reason to shrug.
   */
  it('reports a malformed pipenzo block as a reason rather than as "not configured"', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipenzo-cap-'));
    scratch.push(root);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'broken', pipenzo: { verify: { screenshot: 'node shots.mjs' } } }),
      'utf8',
    );
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/capabilities',
      headers: auth,
      payload: { repositoryPath: root },
    });
    expect(response.json().escapeHatch).toMatchObject({ configured: false });
    expect(response.json().escapeHatch.reason).toContain('pipenzo.verify.screenshot');
  });
});

/**
 * Issue #83's claim pre-flight, end to end on the route. The rule is README's Team-usage one:
 * assign, then re-read uncached, then compare -- and both halves happen daemon-side so a renderer
 * cannot execute only the first.
 */
describe('the claim pre-flight identity rule', () => {
  it('resolves the assignee from the token when the caller names none', async () => {
    const github = new FakeGitHubClient()
      .seedAuthenticatedLogin('jortega0033')
      .seedIssue(issue());
    const { app } = buildApp({ github });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/issues/claim',
      headers: auth,
      payload: { issueNumber: 184 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'claimed', assignees: ['jortega0033'] });
    expect(github.calls.map((call) => call.method)).toEqual([
      'getAuthenticatedLogin',
      'assignIssue',
      'getIssue',
    ]);
  });

  /**
   * The re-read is what decides the race, and it is a second request rather than the write's own
   * echo -- an echo cannot see an assignment that landed a millisecond later.
   */
  it('loses the race to an assignment that landed between the write and the re-read', async () => {
    const github = new FakeGitHubClient().seedAuthenticatedLogin('jortega0033').seedIssue(issue());
    const { app } = buildApp({ github });
    // Somebody else got there first; the write still succeeds because GitHub's assign is additive.
    await github.assignIssue({ owner: 'jortega0033', repo: 'pipenzo' }, 184, 'someone-else');
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/issues/claim',
      headers: auth,
      payload: { issueNumber: 184 },
    });
    expect(response.json()).toMatchObject({
      outcome: 'claimed_elsewhere',
      assignees: ['someone-else', 'jortega0033'],
    });
  });
});

/**
 * Issue #84's route. The property worth asserting here is the separation: drafting creates
 * nothing, and the fake GitHub client proves it by never being asked to.
 */
describe('POST /v2/pipenzo/issues/draft', () => {
  it('drafts a structured issue from free text and creates nothing', async () => {
    const { app, github } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/issues/draft',
      headers: auth,
      payload: {
        idea: 'the tray icon never tells me a PR is ready',
        repositoryPath: REPO_PATH,
        provider: 'claude',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionId: SESSION_ID,
      draft: { title: expect.stringContaining('unread badge') },
    });
    // Nothing reached GitHub. Filing is a separate, human-clicked call.
    expect(github.calls).toEqual([]);
  });

  it('reports a draft that fails the v1 schema as 422, not as a session failure', async () => {
    const { app } = buildApp({ draftOutput: JSON.stringify({ schemaVersion: 1 }) });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/issues/draft',
      headers: auth,
      payload: { idea: 'anything', repositoryPath: REPO_PATH, provider: 'claude' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'spec_invalid' });
  });
});
