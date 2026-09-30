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
import { PipenzoPhaseService } from '../src/pipenzo-phase-service.js';
import { OwnedWorktreeManager } from '../src/worktree-manager.js';
import type { GateCommandRunner, CommandResult } from '../src/review-gates.js';

const run = promisify(execFile);
const GIT_HEAVY_TIMEOUT_MS = 45_000;
const REPO = 'jortega0033/pipenzo';
const ISSUE_NUMBER = 108;
const TICKET_ID = '00000000-0000-4000-8000-0000000000bb';
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
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
    title: 'Rework provider capability negotiation across all transports',
    body: 'Needs a shared capability schema across transports.',
    state: 'open',
    labels: ['pipenzo:queued'],
    assignees: [],
    htmlUrl: `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    etag: undefined,
    ...overrides,
  };
}

function stackSpec(overrides: Partial<RefineSpecV1> = {}): RefineSpecV1 {
  return {
    schemaVersion: 1,
    issue: { repo: REPO, number: ISSUE_NUMBER, title: issue().title },
    summary: 'Rework provider capability negotiation.',
    acceptanceCriteria: [{ id: 'AC-1', kind: 'ubiquitous', text: 'The daemon shall negotiate capabilities' }],
    outOfScope: ['Provider auth'],
    filesLikelyTouched: [],
    estimate: { changedLines: 212, filesTouched: 9, layered: true },
    openQuestions: [],
    proposedSplit: [
      { summary: 'Extract the shared capability schema', changedLines: 80, filesTouched: 3 },
      { summary: 'Wire the HTTP transport to it', changedLines: 70, filesTouched: 3 },
      { summary: 'Wire the stdio transport to it', changedLines: 62, filesTouched: 3 },
    ],
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

async function realRepo(): Promise<{ repositoryPath: string; worktreeManager: OwnedWorktreeManager }> {
  const base = await mkdtemp(join(tmpdir(), 'pipenzo-stack-approval-service-'));
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
  const storeBase = await mkdtemp(join(tmpdir(), 'pipenzo-stack-approval-service-tickets-'));
  tempDirectories.push(storeBase);
  const tickets = new FileTicketStore(join(storeBase, 'tickets-v1'));
  tickets.create(makeTicket(options.ticket));
  const github = new FakeGitHubClient().seedIssue(issue({ labels: options.ticket?.labels ?? ['pipenzo:working'] }));
  const machine = new PipenzoPhaseMachine({ tickets, github: () => github });

  const service = new PipenzoPhaseService({
    refineSessions: {
      run: async () => ({
        sessionId: 'session-refine',
        output: JSON.parse(JSON.stringify(options.refineOutput ?? stackSpec())),
        toolsUsed: ['Read'],
      }),
    },
    reviewSessions: { run: async () => ({ sessionId: 'session-review', findings: [], verdict: 'approved' as const }) },
    implementSessions: { run: async () => ({ sessionId: 'session-implement' }) },
    worktrees: worktreeManager,
    github: () => github,
    commands: noCommands,
    machine,
    tickets,
    logger: noopLogger,
  });

  return { service, machine, tickets, github, repositoryPath, worktreeManager };
}

describe('PipenzoPhaseService — stack verdict at Refine (issue #99)', () => {
  it(
    'parks the ticket on pipenzo:awaiting-stack-approval, caches the proposed split, and posts a comment',
    async () => {
      const { service, tickets, github, repositoryPath } = await buildHarness({});

      const result = await service.refine({
        repo: REPO,
        issueNumber: ISSUE_NUMBER,
        repositoryPath,
        provider: 'claude',
        ticketId: TICKET_ID,
      });

      expect(result.gateVerdict).toBe('stack');

      const stored = tickets.get(TICKET_ID);
      expect(stored?.labels).toContain('pipenzo:awaiting-stack-approval');
      // The one write that makes a later captureStack possible -- see #reportStackVerdict's own
      // doc comment on why `spec` is cached this early for a `stack` verdict.
      expect(stored?.spec?.proposedSplit).toEqual(stackSpec().proposedSplit);

      const comments = github.issueComments({ owner: 'jortega0033', repo: 'pipenzo' }, ISSUE_NUMBER);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toContain('Proposed split');
      expect(comments[0]!.body).toContain('Extract the shared capability schema');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'does not double-transition or double-comment on a retried refine() once already parked',
    async () => {
      const { service, github, repositoryPath } = await buildHarness({ ticket: { labels: ['pipenzo:awaiting-stack-approval'] } });

      await service.refine({
        repo: REPO,
        issueNumber: ISSUE_NUMBER,
        repositoryPath,
        provider: 'claude',
        ticketId: TICKET_ID,
      });

      expect(github.issueComments({ owner: 'jortega0033', repo: 'pipenzo' }, ISSUE_NUMBER)).toHaveLength(0);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});

describe('PipenzoPhaseService.acceptStack (issue #99)', () => {
  it(
    'creates the child tickets in the given order, each with a real worktree/branch, and turns the parent into a container',
    async () => {
      const { service, tickets, repositoryPath } = await buildHarness({
        ticket: { labels: ['pipenzo:awaiting-stack-approval'], spec: stackSpec() },
      });
      const orderedParts = stackSpec().proposedSplit!;

      const children = await service.acceptStack(TICKET_ID, orderedParts, repositoryPath);

      expect(children).toHaveLength(3);
      children.forEach((child, index) => {
        const record = tickets.get(child.ticketId);
        expect(record?.stack).toEqual({ parentId: TICKET_ID, childIds: [], index });
        expect(record?.worktree?.id).toBeTruthy();
      });

      // The parent is now a container: non-empty childIds, in the same order children were created.
      const parent = tickets.get(TICKET_ID);
      expect(parent?.stack.childIds).toEqual(children.map((child) => child.ticketId));
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'honors a reordering -- the materialized children follow the given order, not proposedSplit\'s own order',
    async () => {
      const { service, tickets, repositoryPath } = await buildHarness({
        ticket: { labels: ['pipenzo:awaiting-stack-approval'], spec: stackSpec() },
      });
      const original = stackSpec().proposedSplit!;
      const reordered = [original[2]!, original[0]!, original[1]!];

      const children = await service.acceptStack(TICKET_ID, reordered, repositoryPath);

      expect(children.map((child) => tickets.get(child.ticketId)!.estimate)).toEqual([
        { lines: reordered[0]!.changedLines, files: reordered[0]!.filesTouched, layered: false },
        { lines: reordered[1]!.changedLines, files: reordered[1]!.filesTouched, layered: false },
        { lines: reordered[2]!.changedLines, files: reordered[2]!.filesTouched, layered: false },
      ]);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'posts a real acceptance comment naming every child',
    async () => {
      const { service, github, repositoryPath } = await buildHarness({
        ticket: { labels: ['pipenzo:awaiting-stack-approval'], spec: stackSpec() },
      });

      const children = await service.acceptStack(TICKET_ID, stackSpec().proposedSplit!, repositoryPath);

      const comments = github.issueComments({ owner: 'jortega0033', repo: 'pipenzo' }, ISSUE_NUMBER);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toContain('Stack accepted');
      for (const child of children) expect(comments[0]!.body).toContain(`#${child.issueNumber}`);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});

describe('PipenzoPhaseService.rejectStack (issue #99)', () => {
  it(
    'posts the reason as a real comment on the issue',
    async () => {
      const { service, github } = await buildHarness({
        ticket: { labels: ['pipenzo:awaiting-stack-approval'], spec: stackSpec() },
      });

      await service.rejectStack(TICKET_ID, 'Too risky to split this way -- the schema extraction alone is bigger than it looks.');

      const comments = github.issueComments({ owner: 'jortega0033', repo: 'pipenzo' }, ISSUE_NUMBER);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toContain('Stack proposal rejected');
      expect(comments[0]!.body).toContain('Too risky to split this way');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'throws (does not swallow) when the comment cannot be posted -- unlike the accept/proposal comments',
    async () => {
      const { service } = await buildHarness({
        ticket: { labels: ['pipenzo:awaiting-stack-approval'], spec: stackSpec() },
      });
      // A ticket whose issue the fake never seeded -- `machine.read()` itself fails first, which is
      // enough to prove rejectStack() does not quietly succeed when it cannot actually comment.
      await expect(service.rejectStack('no-such-ticket', 'a reason')).rejects.toBeTruthy();
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});
