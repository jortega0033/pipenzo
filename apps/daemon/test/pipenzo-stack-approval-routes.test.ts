import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import type { PipenzoTicketRecordV1, RefineSpecV1 } from '@agent-dock/shared';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import type { GitHubIssue } from '../src/github-client.js';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';
import { PipenzoPhaseMachine } from '../src/pipenzo-phase-machine.js';
import { PipenzoPhaseService } from '../src/pipenzo-phase-service.js';
import { OwnedWorktreeManager } from '../src/worktree-manager.js';
import { StackApprovalStore } from '../src/stack-approval-store.js';
import type { GateCommandRunner, CommandResult } from '../src/review-gates.js';

const TOKEN = 'test-token-stack-approval';
const TICKET_ID = '00000000-0000-4000-8000-000000000c01';
const OTHER_TICKET_ID = '00000000-0000-4000-8000-000000000c02';
const REPO = 'jortega0033/pipenzo';
const ISSUE_NUMBER = 108;
const auth = { authorization: `Bearer ${TOKEN}` };

const GIT_HEAVY_TIMEOUT_MS = 45_000;
const run = promisify(execFile);
const gitTempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    gitTempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

const noCommands: GateCommandRunner = {
  available: async () => false,
  run: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', code: 0 }),
};

function makeTicket(overrides: Partial<PipenzoTicketRecordV1> = {}): PipenzoTicketRecordV1 {
  return {
    schemaVersion: 1,
    ticketId: TICKET_ID,
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    lane: 'needs-human',
    phase: 'refine',
    labels: ['pipenzo:awaiting-stack-approval'],
    estimate: { lines: 212, files: 9, layered: true },
    taskType: 'feature',
    stack: { parentId: null, childIds: [], index: null },
    attempts: [],
    budget: { tokensUsed: 0, limit: 0 },
    risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
    precommits: [],
    etags: {},
    ...overrides,
  };
}

const PARTS: RefineSpecV1['proposedSplit'] = [
  { summary: 'Extract the shared capability schema', changedLines: 80, filesTouched: 3 },
  { summary: 'Wire the HTTP transport to it', changedLines: 70, filesTouched: 3 },
  { summary: 'Wire the stdio transport to it', changedLines: 62, filesTouched: 3 },
];

function stackSpec(): RefineSpecV1 {
  return {
    schemaVersion: 1,
    issue: { repo: REPO, number: ISSUE_NUMBER, title: 'Rework provider capability negotiation' },
    summary: 'Rework provider capability negotiation.',
    acceptanceCriteria: [{ id: 'AC-1', kind: 'ubiquitous', text: 'The daemon shall negotiate capabilities' }],
    outOfScope: ['Provider auth'],
    filesLikelyTouched: [],
    estimate: { changedLines: 212, filesTouched: 9, layered: true },
    openQuestions: [],
    proposedSplit: PARTS,
  };
}

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    owner: 'jortega0033',
    repo: 'pipenzo',
    number: ISSUE_NUMBER,
    title: 'Rework provider capability negotiation across all transports',
    body: '',
    state: 'open',
    labels: ['pipenzo:awaiting-stack-approval'],
    assignees: [],
    htmlUrl: `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    etag: undefined,
    ...overrides,
  };
}

async function realRepo(): Promise<{ repositoryPath: string; worktreeManager: OwnedWorktreeManager }> {
  const base = await mkdtemp(join(tmpdir(), 'pipenzo-stack-approval-routes-git-'));
  gitTempDirectories.push(base);
  const repositoryPath = join(base, 'repo');
  await mkdir(repositoryPath, { recursive: true });
  await run('git', ['init', '--initial-branch=main'], { cwd: repositoryPath });
  await run('git', ['config', 'user.name', 'Fixture'], { cwd: repositoryPath });
  await run('git', ['config', 'user.email', 'fixture@example.test'], { cwd: repositoryPath });
  await run('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repositoryPath });
  const worktreeManager = new OwnedWorktreeManager(join(base, 'owned'), join(base, 'worktrees.json'));
  await worktreeManager.load();
  return { repositoryPath, worktreeManager };
}

async function buildApp(
  options: { ticket?: Partial<PipenzoTicketRecordV1>; issue?: Partial<GitHubIssue> } = {},
) {
  const { repositoryPath, worktreeManager } = await realRepo();
  const storeBase = await mkdtemp(join(tmpdir(), 'pipenzo-stack-approval-routes-store-'));
  gitTempDirectories.push(storeBase);
  const registry = new ProviderRegistry();
  const tickets = new FileTicketStore(join(storeBase, 'tickets-v1'));
  tickets.create(makeTicket(options.ticket));
  // `machine.read()` treats the issue's own labels as authoritative (README's precedence rule), so
  // a test that wants the ticket to read as "not awaiting stack approval" has to say so here, not
  // just on the local ticket fixture above.
  const github = new FakeGitHubClient().seedIssue(makeIssue(options.issue));
  const machine = new PipenzoPhaseMachine({ tickets, github: () => github });
  const stackApprovalStore = new StackApprovalStore();
  const phaseService = new PipenzoPhaseService({
    refineSessions: { run: async () => ({ sessionId: 's', output: {}, toolsUsed: [] }) },
    reviewSessions: { run: async () => ({ sessionId: 's', findings: [], verdict: 'approved' as const }) },
    implementSessions: { run: async () => ({ sessionId: 's' }) },
    worktrees: worktreeManager,
    github: () => github,
    commands: noCommands,
    machine,
    tickets,
    logger: noopLogger,
  });

  return {
    tickets,
    github,
    repositoryPath,
    app: buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
      phaseMachine: machine,
      phaseService,
      stackApprovalStore,
    }),
  };
}

describe('POST /v2/pipenzo/tickets/risk/stack-approval/capture', () => {
  it(
    'captures the ticket\'s cached proposed split when it is genuinely awaiting stack approval',
    async () => {
      const { app } = await buildApp({ ticket: { spec: stackSpec() } });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/stack-approval/capture',
        headers: auth,
        payload: { ticketId: TICKET_ID },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ approvalId: expect.any(String), parts: PARTS });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses a ticket with no cached proposed split at all (e.g. parked by the blown-estimate path, not a stack verdict)',
    async () => {
      const { app } = await buildApp({ ticket: {} });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/stack-approval/capture',
        headers: auth,
        payload: { ticketId: TICKET_ID },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'ticket_not_found' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses a ticket that is not on pipenzo:awaiting-stack-approval, even with a spec attached',
    async () => {
      const { app } = await buildApp({
        ticket: { labels: ['pipenzo:working'], spec: stackSpec() },
        issue: { labels: ['pipenzo:working'] },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/stack-approval/capture',
        headers: auth,
        payload: { ticketId: TICKET_ID },
      });

      expect(response.statusCode).toBe(404);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it('rejects an unauthenticated request', async () => {
    const { app } = await buildApp({ ticket: { spec: stackSpec() } });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/risk/stack-approval/capture',
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /v2/pipenzo/tickets/risk/stack-approval/decide', () => {
  async function captured(built: Awaited<ReturnType<typeof buildApp>>) {
    const captureResponse = await built.app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/risk/stack-approval/capture',
      headers: auth,
      payload: { ticketId: TICKET_ID },
    });
    const { approvalId } = captureResponse.json() as { approvalId: string };
    return approvalId;
  }

  it(
    'refuses a reject with no reason at the wire level -- 400, and the approval is still pending afterward',
    async () => {
      const built = await buildApp({ ticket: { spec: stackSpec() } });
      const approvalId = await captured(built);

      const rejectNoReason = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/stack-approval/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, approvalId, decision: 'reject' },
      });
      expect(rejectNoReason.statusCode).toBe(400);
      expect(rejectNoReason.json()).toMatchObject({ code: 'invalid_request' });

      const rejectWithReason = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/stack-approval/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, approvalId, decision: 'reject', reason: 'too risky' },
      });
      expect(rejectWithReason.statusCode).toBe(200);
      expect(rejectWithReason.json()).toEqual({ decision: 'reject' });

      const comments = built.github.issueComments({ owner: 'jortega0033', repo: 'pipenzo' }, ISSUE_NUMBER);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toContain('too risky');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses a reject with a whitespace-only reason at the wire level',
    async () => {
      const built = await buildApp({ ticket: { spec: stackSpec() } });
      const approvalId = await captured(built);

      const response = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/stack-approval/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, approvalId, decision: 'reject', reason: '   ' },
      });
      expect(response.statusCode).toBe(400);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses an accept with no order, and an accept with no repositoryPath, at the wire level',
    async () => {
      const built = await buildApp({ ticket: { spec: stackSpec() } });
      const approvalId = await captured(built);

      const noOrder = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/stack-approval/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, approvalId, decision: 'accept', repositoryPath: built.repositoryPath },
      });
      expect(noOrder.statusCode).toBe(400);

      const noPath = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/stack-approval/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, approvalId, decision: 'accept', order: [0, 1, 2] },
      });
      expect(noPath.statusCode).toBe(400);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses an accept whose order is not an exact permutation of the captured parts -- 404, and creates nothing',
    async () => {
      const built = await buildApp({ ticket: { spec: stackSpec() } });
      const approvalId = await captured(built);

      const response = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/stack-approval/decide',
        headers: auth,
        payload: {
          ticketId: TICKET_ID,
          approvalId,
          decision: 'accept',
          order: [0, 1, 1],
          repositoryPath: built.repositoryPath,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'approval_not_found' });
      expect(built.tickets.list()).toHaveLength(1);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'accept: creates exactly the captured number of real child tickets, in the approved order, and the parent becomes a container',
    async () => {
      const built = await buildApp({ ticket: { spec: stackSpec() } });
      const approvalId = await captured(built);

      const response = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/stack-approval/decide',
        headers: auth,
        payload: {
          ticketId: TICKET_ID,
          approvalId,
          decision: 'accept',
          order: [2, 0, 1],
          repositoryPath: built.repositoryPath,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { decision: string; children: { ticketId: string; issueNumber: number }[] };
      expect(body.decision).toBe('accept');
      expect(body.children).toHaveLength(3);

      // Reordering actually changed the accepted order: entry 0 is PARTS[2]'s own estimate.
      const firstChild = built.tickets.get(body.children[0]!.ticketId);
      expect(firstChild?.estimate).toEqual({ lines: PARTS[2]!.changedLines, files: PARTS[2]!.filesTouched, layered: false });

      const parent = built.tickets.get(TICKET_ID);
      expect(parent?.stack.childIds).toEqual(body.children.map((child) => child.ticketId));
      // Every child genuinely got its own worktree.
      const worktreeIds = body.children.map((child) => built.tickets.get(child.ticketId)!.worktree!.id);
      expect(new Set(worktreeIds).size).toBe(3);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses a second decide on the same approval id -- a decision is never re-askable',
    async () => {
      const built = await buildApp({ ticket: { spec: stackSpec() } });
      const approvalId = await captured(built);

      const first = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/stack-approval/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, approvalId, decision: 'reject', reason: 'first' },
      });
      const second = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/stack-approval/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, approvalId, decision: 'reject', reason: 'second' },
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(404);
      expect(second.json()).toMatchObject({ code: 'approval_not_found' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses to decide a real approval under a different ticket id',
    async () => {
      const built = await buildApp({ ticket: { spec: stackSpec() } });
      const approvalId = await captured(built);

      const response = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/stack-approval/decide',
        headers: auth,
        payload: { ticketId: OTHER_TICKET_ID, approvalId, decision: 'reject', reason: 'wrong ticket' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'approval_not_found' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it('rejects an unauthenticated request', async () => {
    const built = await buildApp({ ticket: { spec: stackSpec() } });
    const response = await built.app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/risk/stack-approval/decide',
    });
    expect(response.statusCode).toBe(401);
  });
});
