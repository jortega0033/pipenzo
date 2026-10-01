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
import { PlanReviewStore } from '../src/plan-review-store.js';
import type { GateCommandRunner, CommandResult } from '../src/review-gates.js';

const TOKEN = 'test-token-plan-review';
const TICKET_ID = '00000000-0000-4000-8000-000000000d01';
const REPO = 'jortega0033/pipenzo';
const ISSUE_NUMBER = 98;
const auth = { authorization: `Bearer ${TOKEN}` };

const GIT_HEAVY_TIMEOUT_MS = 45_000;
const run = promisify(execFile);
const gitTempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    gitTempDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
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
    labels: ['pipenzo:needs-human'],
    estimate: { lines: 38, files: 2, layered: false },
    taskType: 'chore',
    stack: { parentId: null, childIds: [], index: null },
    attempts: [],
    budget: { tokensUsed: 0, limit: 0 },
    risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
    precommits: [],
    etags: {},
    ...overrides,
  };
}

function planSpec(): RefineSpecV1 {
  return {
    schemaVersion: 1,
    issue: { repo: REPO, number: ISSUE_NUMBER, title: 'Persist poll ETags per repo and resource' },
    summary: 'Persist poll ETags per repo and resource in the ticket store.',
    acceptanceCriteria: [
      {
        id: 'AC-1',
        kind: 'event',
        text: "When a poll for a repo's issues completes, the reconciler shall store the response ETag.",
      },
    ],
    outOfScope: ['The secondary-limit and Retry-After handling.'],
    filesLikelyTouched: ['apps/daemon/src/github-reconciler.ts', 'apps/daemon/src/ticket-store.ts'],
    estimate: { changedLines: 38, filesTouched: 2, layered: false },
    openQuestions: [],
  };
}

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    owner: 'jortega0033',
    repo: 'pipenzo',
    number: ISSUE_NUMBER,
    title: 'Persist poll ETags per repo and resource in the ticket store',
    body: '',
    state: 'open',
    labels: ['pipenzo:needs-human'],
    assignees: [],
    htmlUrl: `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    etag: undefined,
    ...overrides,
  };
}

async function realRepo(): Promise<{ repositoryPath: string; worktreeManager: OwnedWorktreeManager }> {
  const base = await mkdtemp(join(tmpdir(), 'pipenzo-plan-review-routes-git-'));
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
  const storeBase = await mkdtemp(join(tmpdir(), 'pipenzo-plan-review-routes-store-'));
  gitTempDirectories.push(storeBase);
  const registry = new ProviderRegistry();
  const tickets = new FileTicketStore(join(storeBase, 'tickets-v1'));
  tickets.create(makeTicket(options.ticket));
  const github = new FakeGitHubClient().seedIssue(makeIssue(options.issue));
  const machine = new PipenzoPhaseMachine({ tickets, github: () => github });
  const planReviewStore = new PlanReviewStore();
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
      planReviewStore,
    }),
  };
}

describe('POST /v2/pipenzo/tickets/risk/plan-review/capture', () => {
  it(
    'captures the cached plan when the ticket is genuinely awaiting a plan review',
    async () => {
      const { app } = await buildApp({ ticket: { spec: planSpec(), awaitingPlanReview: true } });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/plan-review/capture',
        headers: auth,
        payload: { ticketId: TICKET_ID },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { approvalId: string; spec: { summary: string } };
      expect(body.approvalId).toEqual(expect.any(String));
      expect(body.spec.summary).toBe('Persist poll ETags per repo and resource in the ticket store.');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses a ticket with no awaitingPlanReview marker, even with a spec attached',
    async () => {
      const { app } = await buildApp({ ticket: { spec: planSpec(), awaitingPlanReview: false } });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/plan-review/capture',
        headers: auth,
        payload: { ticketId: TICKET_ID },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'ticket_not_found' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses a ticket with the marker set but no cached spec',
    async () => {
      const { app } = await buildApp({ ticket: { awaitingPlanReview: true } });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/plan-review/capture',
        headers: auth,
        payload: { ticketId: TICKET_ID },
      });

      expect(response.statusCode).toBe(404);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it('rejects an unauthenticated request', async () => {
    const { app } = await buildApp({ ticket: { spec: planSpec(), awaitingPlanReview: true } });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/risk/plan-review/capture',
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /v2/pipenzo/tickets/risk/plan-review/decide', () => {
  async function captured(built: Awaited<ReturnType<typeof buildApp>>) {
    const captureResponse = await built.app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/risk/plan-review/capture',
      headers: auth,
      payload: { ticketId: TICKET_ID },
    });
    const { approvalId } = captureResponse.json() as { approvalId: string };
    return approvalId;
  }

  it(
    'approve: dispatches a real Implement session, clears the marker, and moves the ticket to pipenzo:working',
    async () => {
      const built = await buildApp({ ticket: { spec: planSpec(), awaitingPlanReview: true } });
      const approvalId = await captured(built);

      const response = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/plan-review/decide',
        headers: auth,
        payload: {
          ticketId: TICKET_ID,
          approvalId,
          decision: 'approve',
          implement: { repositoryPath: built.repositoryPath, provider: 'claude' },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { decision: string; worktreeId: string; branch: string };
      expect(body.decision).toBe('approve');
      expect(body.worktreeId).toEqual(expect.any(String));
      expect(body.branch).toEqual(expect.any(String));

      const ticket = built.tickets.get(TICKET_ID);
      expect(ticket?.awaitingPlanReview).toBe(false);
      expect(ticket?.labels).toEqual(['pipenzo:working', 'pipenzo:schema-v1']);

      const comments = built.github.issueComments({ owner: 'jortega0033', repo: 'pipenzo' }, ISSUE_NUMBER);
      expect(comments.some((comment) => comment.body.includes('Implement is starting'))).toBe(true);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'approve: refuses at the wire level with no implement inputs -- 400, nothing dispatched',
    async () => {
      const built = await buildApp({ ticket: { spec: planSpec(), awaitingPlanReview: true } });
      const approvalId = await captured(built);

      const response = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/plan-review/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, approvalId, decision: 'approve' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'invalid_request' });
      expect(built.tickets.get(TICKET_ID)?.awaitingPlanReview).toBe(true);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'request_changes: refuses with no feedback at the wire level, then moves the ticket to pipenzo:queued and caches feedback for the next refine',
    async () => {
      const built = await buildApp({ ticket: { spec: planSpec(), awaitingPlanReview: true } });
      const approvalId = await captured(built);

      const noFeedback = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/plan-review/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, approvalId, decision: 'request_changes' },
      });
      expect(noFeedback.statusCode).toBe(400);

      const withFeedback = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/plan-review/decide',
        headers: auth,
        payload: {
          ticketId: TICKET_ID,
          approvalId,
          decision: 'request_changes',
          feedback: 'please also cover the 304 path',
        },
      });
      expect(withFeedback.statusCode).toBe(200);
      expect(withFeedback.json()).toEqual({ decision: 'request_changes' });

      const ticket = built.tickets.get(TICKET_ID);
      expect(ticket?.awaitingPlanReview).toBe(false);
      expect(ticket?.labels).toEqual(['pipenzo:queued', 'pipenzo:schema-v1']);
      expect(ticket?.planReviewFeedback).toBe('please also cover the 304 path');

      const comments = built.github.issueComments({ owner: 'jortega0033', repo: 'pipenzo' }, ISSUE_NUMBER);
      expect(comments.some((comment) => comment.body.includes('please also cover the 304 path'))).toBe(
        true,
      );
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'reject: refuses with no reason at the wire level, then parks the ticket under the bare pipenzo:needs-human label',
    async () => {
      const built = await buildApp({ ticket: { spec: planSpec(), awaitingPlanReview: true } });
      const approvalId = await captured(built);

      const noReason = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/plan-review/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, approvalId, decision: 'reject' },
      });
      expect(noReason.statusCode).toBe(400);

      const withReason = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/plan-review/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, approvalId, decision: 'reject', reason: 'too broad' },
      });
      expect(withReason.statusCode).toBe(200);
      expect(withReason.json()).toEqual({ decision: 'reject' });

      const ticket = built.tickets.get(TICKET_ID);
      expect(ticket?.awaitingPlanReview).toBe(false);
      expect(ticket?.labels).toEqual(['pipenzo:needs-human']);

      const comments = built.github.issueComments({ owner: 'jortega0033', repo: 'pipenzo' }, ISSUE_NUMBER);
      expect(comments.some((comment) => comment.body.includes('too broad'))).toBe(true);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses a second decide on the same approval id -- a decision is never re-askable',
    async () => {
      const built = await buildApp({ ticket: { spec: planSpec(), awaitingPlanReview: true } });
      const approvalId = await captured(built);

      const first = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/plan-review/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, approvalId, decision: 'reject', reason: 'first' },
      });
      expect(first.statusCode).toBe(200);

      const second = await built.app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/plan-review/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, approvalId, decision: 'reject', reason: 'second' },
      });
      expect(second.statusCode).toBe(404);
      expect(second.json()).toMatchObject({ code: 'approval_not_found' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it('rejects an unauthenticated request', async () => {
    const built = await buildApp({ ticket: { spec: planSpec(), awaitingPlanReview: true } });
    const response = await built.app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/risk/plan-review/decide',
    });
    expect(response.statusCode).toBe(401);
  });
});
