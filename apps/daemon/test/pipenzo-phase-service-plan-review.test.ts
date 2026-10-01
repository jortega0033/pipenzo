import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@agent-dock/agent-runtime';
import type { PipenzoTicketRecordV1, RefineSpecV1 } from '@agent-dock/shared';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import type { GitHubIssue } from '../src/github-client.js';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';
import { PipenzoPhaseMachine } from '../src/pipenzo-phase-machine.js';
import { PipenzoPhaseError, PipenzoPhaseService } from '../src/pipenzo-phase-service.js';
import { OwnedWorktreeManager } from '../src/worktree-manager.js';
import type { GateCommandRunner, CommandResult } from '../src/review-gates.js';
import type { CreateSessionV2Request } from '@agent-dock/shared';

const run = promisify(execFile);
const GIT_HEAVY_TIMEOUT_MS = 45_000;
const REPO = 'jortega0033/pipenzo';
const ISSUE_NUMBER = 98;
const TICKET_ID = '00000000-0000-4000-8000-0000000000e1';
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

const noCommands: GateCommandRunner = {
  available: async () => false,
  run: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', code: 0 }),
};

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    owner: 'jortega0033',
    repo: 'pipenzo',
    number: ISSUE_NUMBER,
    title: 'Persist poll ETags per repo and resource in the ticket store',
    body: 'Cache ETags so a 304 skips re-fetching the issue list.',
    state: 'open',
    labels: ['pipenzo:working'],
    assignees: [],
    htmlUrl: `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    etag: undefined,
    ...overrides,
  };
}

/** A clean, one-PR estimate -- the `single` diff-size-gate verdict this whole test file is about. */
function cleanSpec(overrides: Partial<RefineSpecV1> = {}): RefineSpecV1 {
  return {
    schemaVersion: 1,
    issue: { repo: REPO, number: ISSUE_NUMBER, title: issue().title },
    summary: 'Persist poll ETags per repo and resource in the ticket store.',
    acceptanceCriteria: [
      {
        id: 'AC-1',
        kind: 'event',
        text: "When a poll for a repo's issues completes, the reconciler shall store the response ETag.",
      },
    ],
    outOfScope: ['The secondary-limit and Retry-After handling.'],
    filesLikelyTouched: ['apps/daemon/src/github-reconciler.ts'],
    estimate: { changedLines: 38, filesTouched: 2, layered: false },
    openQuestions: [],
    ...overrides,
  };
}

function makeTicket(overrides: Partial<PipenzoTicketRecordV1> = {}): PipenzoTicketRecordV1 {
  return {
    schemaVersion: 1,
    ticketId: TICKET_ID,
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    lane: 'working',
    phase: 'refine',
    labels: ['pipenzo:working'],
    estimate: { lines: 0, files: 0, layered: false },
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

async function realRepo(): Promise<{ repositoryPath: string; worktreeManager: OwnedWorktreeManager }> {
  const base = await mkdtemp(join(tmpdir(), 'pipenzo-plan-review-service-'));
  tempDirectories.push(base);
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

async function buildHarness(options: {
  ticket?: Partial<PipenzoTicketRecordV1>;
  refineOutput?: RefineSpecV1;
}) {
  const { repositoryPath, worktreeManager } = await realRepo();
  const storeBase = await mkdtemp(join(tmpdir(), 'pipenzo-plan-review-service-tickets-'));
  tempDirectories.push(storeBase);
  const tickets = new FileTicketStore(join(storeBase, 'tickets-v1'));
  tickets.create(makeTicket(options.ticket));
  const github = new FakeGitHubClient().seedIssue(
    issue({ labels: options.ticket?.labels ?? ['pipenzo:working'] }),
  );
  const machine = new PipenzoPhaseMachine({ tickets, github: () => github });

  const seenRefineRequests: CreateSessionV2Request[] = [];
  let implementDispatched = 0;

  const service = new PipenzoPhaseService({
    refineSessions: {
      run: async (request) => {
        seenRefineRequests.push(request);
        return {
          sessionId: 'session-refine',
          output: JSON.parse(JSON.stringify(options.refineOutput ?? cleanSpec())),
          toolsUsed: ['Read'],
        };
      },
    },
    reviewSessions: {
      run: async () => ({ sessionId: 'session-review', findings: [], verdict: 'approved' as const }),
    },
    implementSessions: {
      run: async () => {
        implementDispatched += 1;
        return { sessionId: 'session-implement' };
      },
    },
    worktrees: worktreeManager,
    github: () => github,
    commands: noCommands,
    machine,
    tickets,
    logger: noopLogger,
  });

  return {
    service,
    machine,
    tickets,
    github,
    repositoryPath,
    worktreeManager,
    seenRefineRequests,
    implementDispatched: () => implementDispatched,
  };
}

describe('PipenzoPhaseService — plan-review gate at Refine (issue #15)', () => {
  it(
    'a clean (single) verdict parks the ticket, caches the spec, sets the local marker, and posts a comment -- never the bare label alone',
    async () => {
      const { service, tickets, github, repositoryPath } = await buildHarness({});

      const result = await service.refine({
        repo: REPO,
        issueNumber: ISSUE_NUMBER,
        repositoryPath,
        provider: 'claude',
        ticketId: TICKET_ID,
      });

      expect(result.gateVerdict).toBe('single');

      const ticket = tickets.get(TICKET_ID);
      expect(ticket?.labels).toContain('pipenzo:needs-human');
      expect(ticket?.awaitingPlanReview).toBe(true);
      expect(ticket?.spec?.summary).toBe(cleanSpec().summary);

      const comments = github.issueComments({ owner: 'jortega0033', repo: 'pipenzo' }, ISSUE_NUMBER);
      expect(comments.some((comment) => comment.body.includes('pipenzo:needs-human'))).toBe(true);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'is idempotent: a retried refine() against an already-parked ticket does not re-park or double-post',
    async () => {
      const { service, tickets, github, repositoryPath } = await buildHarness({});

      await service.refine({
        repo: REPO,
        issueNumber: ISSUE_NUMBER,
        repositoryPath,
        provider: 'claude',
        ticketId: TICKET_ID,
      });
      await service.refine({
        repo: REPO,
        issueNumber: ISSUE_NUMBER,
        repositoryPath,
        provider: 'claude',
        ticketId: TICKET_ID,
      });

      const comments = github.issueComments({ owner: 'jortega0033', repo: 'pipenzo' }, ISSUE_NUMBER);
      expect(comments).toHaveLength(1);
      expect(tickets.get(TICKET_ID)?.awaitingPlanReview).toBe(true);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'a ticketless refine() (no ticketId) never gates anything -- every existing caller still refines exactly as before',
    async () => {
      const { service, repositoryPath } = await buildHarness({});
      const result = await service.refine({
        repo: REPO,
        issueNumber: ISSUE_NUMBER,
        repositoryPath,
        provider: 'claude',
      });
      expect(result.gateVerdict).toBe('single');
      // No ticketId means nothing to park -- this assertion is really just "it didn't throw."
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'a cached request-changes feedback reaches the next refine prompt, then is cleared so it is never reapplied',
    async () => {
      const { service, tickets, repositoryPath, seenRefineRequests } = await buildHarness({
        ticket: { planReviewFeedback: 'please also cover the 304 path' },
      });

      await service.refine({
        repo: REPO,
        issueNumber: ISSUE_NUMBER,
        repositoryPath,
        provider: 'claude',
        ticketId: TICKET_ID,
      });

      expect(seenRefineRequests).toHaveLength(1);
      expect(seenRefineRequests[0]!.prompt).toContain('please also cover the 304 path');
      expect(tickets.get(TICKET_ID)?.planReviewFeedback).toBeUndefined();

      // A second refine for the same ticket must not see stale feedback again.
      await service.refine({
        repo: REPO,
        issueNumber: ISSUE_NUMBER,
        repositoryPath,
        provider: 'claude',
        ticketId: TICKET_ID,
      });
      expect(seenRefineRequests[1]!.prompt).not.toContain('please also cover the 304 path');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});

describe('PipenzoPhaseService.implement() — the plan-review gate\'s real enforcement (issue #15)', () => {
  it(
    'refuses with plan_review_pending for a ticket whose local marker is still set -- no worktree, no dispatch',
    async () => {
      const { service, repositoryPath, implementDispatched } = await buildHarness({
        ticket: { spec: cleanSpec(), awaitingPlanReview: true, labels: ['pipenzo:needs-human'] },
      });

      await expect(
        service.implement({
          spec: cleanSpec(),
          repositoryPath,
          provider: 'claude',
          ticketId: TICKET_ID,
        }),
      ).rejects.toMatchObject({ code: 'plan_review_pending' });
      expect(implementDispatched()).toBe(0);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'dispatches normally for a ticket whose marker was never set',
    async () => {
      const { service, repositoryPath, implementDispatched } = await buildHarness({
        ticket: { labels: ['pipenzo:working'] },
      });

      const result = await service.implement({
        spec: cleanSpec(),
        repositoryPath,
        provider: 'claude',
        ticketId: TICKET_ID,
      });

      expect(result.sessionId).toBe('session-implement');
      expect(implementDispatched()).toBe(1);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'dispatches normally for a caller with no ticketId at all, regardless of what any ticket\'s marker says',
    async () => {
      const { service, repositoryPath, implementDispatched } = await buildHarness({
        ticket: { spec: cleanSpec(), awaitingPlanReview: true },
      });

      const result = await service.implement({ spec: cleanSpec(), repositoryPath, provider: 'claude' });
      expect(result.sessionId).toBe('session-implement');
      expect(implementDispatched()).toBe(1);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});

describe('PipenzoPhaseService — plan-review decisions (issue #15)', () => {
  it(
    'approvePlanReview: clears the marker, moves the label to pipenzo:working, and dispatches a real Implement session with the frozen spec',
    async () => {
      const { service, tickets, repositoryPath, implementDispatched } = await buildHarness({
        ticket: { spec: cleanSpec(), awaitingPlanReview: true, labels: ['pipenzo:needs-human'] },
      });

      const result = await service.approvePlanReview(TICKET_ID, cleanSpec(), {
        repositoryPath,
        provider: 'claude',
      });

      expect(result.sessionId).toBe('session-implement');
      expect(implementDispatched()).toBe(1);
      const ticket = tickets.get(TICKET_ID);
      expect(ticket?.awaitingPlanReview).toBe(false);
      expect(ticket?.labels).toContain('pipenzo:working');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'approvePlanReview: refuses a ticket whose marker is not set, and dispatches nothing',
    async () => {
      const { service, repositoryPath, implementDispatched } = await buildHarness({
        ticket: { labels: ['pipenzo:working'] },
      });

      await expect(
        service.approvePlanReview(TICKET_ID, cleanSpec(), { repositoryPath, provider: 'claude' }),
      ).rejects.toBeInstanceOf(PipenzoPhaseError);
      expect(implementDispatched()).toBe(0);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'requestPlanReviewChanges: clears the marker, moves the ticket to pipenzo:queued, and caches the feedback',
    async () => {
      const { service, tickets, github } = await buildHarness({
        ticket: { spec: cleanSpec(), awaitingPlanReview: true, labels: ['pipenzo:needs-human'] },
      });

      await service.requestPlanReviewChanges(TICKET_ID, 'please also cover the 304 path');

      const ticket = tickets.get(TICKET_ID);
      expect(ticket?.awaitingPlanReview).toBe(false);
      expect(ticket?.labels).toContain('pipenzo:queued');
      expect(ticket?.planReviewFeedback).toBe('please also cover the 304 path');

      const comments = github.issueComments({ owner: 'jortega0033', repo: 'pipenzo' }, ISSUE_NUMBER);
      expect(comments.some((c) => c.body.includes('please also cover the 304 path'))).toBe(true);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'rejectPlanReview: clears the marker and leaves the ticket on the bare pipenzo:needs-human label -- no new label, no transition',
    async () => {
      const { service, tickets, github } = await buildHarness({
        ticket: { spec: cleanSpec(), awaitingPlanReview: true, labels: ['pipenzo:needs-human'] },
      });

      await service.rejectPlanReview(TICKET_ID, 'too broad for one ticket');

      const ticket = tickets.get(TICKET_ID);
      expect(ticket?.awaitingPlanReview).toBe(false);
      expect(ticket?.labels).toEqual(['pipenzo:needs-human']);

      const comments = github.issueComments({ owner: 'jortega0033', repo: 'pipenzo' }, ISSUE_NUMBER);
      expect(comments.some((c) => c.body.includes('too broad for one ticket'))).toBe(true);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'rejectPlanReview: refuses a ticket whose marker is not set',
    async () => {
      const { service } = await buildHarness({ ticket: { labels: ['pipenzo:working'] } });
      await expect(service.rejectPlanReview(TICKET_ID, 'x')).rejects.toBeInstanceOf(PipenzoPhaseError);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});
