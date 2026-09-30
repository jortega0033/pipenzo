import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@agent-dock/agent-runtime';
import type { PipenzoTicketRecordV1, RefineEstimateV1, RefineSpecV1 } from '@agent-dock/shared';
import { PipenzoPhaseService, refusalCommentBody } from '../src/pipenzo-phase-service.js';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import type { GitHubIssue } from '../src/github-client.js';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';
import { PipenzoPhaseMachine } from '../src/pipenzo-phase-machine.js';
import { OwnedWorktreeManager } from '../src/worktree-manager.js';
import type { GateCommandRunner, CommandResult } from '../src/review-gates.js';

describe('refusalCommentBody', () => {
  it('names the estimate and the ceiling reason when past 400 lines or 20 files', () => {
    const estimate: RefineEstimateV1 = { changedLines: 900, filesTouched: 40, layered: false };
    const body = refusalCommentBody(estimate);
    expect(body).toContain('900');
    expect(body).toContain('40');
    expect(body).toContain('400-line');
    expect(body).toContain('pipenzo:needs-pre-scoping');
  });

  it('names the layering reason for a refusal inside the 100-400/10-20 band', () => {
    const estimate: RefineEstimateV1 = { changedLines: 200, filesTouched: 12, layered: false };
    const body = refusalCommentBody(estimate);
    expect(body).toContain('200');
    expect(body).toContain('12');
    expect(body).toContain('no clean layering');
    expect(body).toContain('pipenzo:needs-pre-scoping');
  });

  it('says nothing was written and no runs were spent', () => {
    const body = refusalCommentBody({ changedLines: 900, filesTouched: 40, layered: false });
    expect(body).toContain('Nothing was written');
  });

  describe('proposedSplit (issue #271)', () => {
    const estimate: RefineEstimateV1 = { changedLines: 900, filesTouched: 40, layered: false };

    it('says nothing about a split when none was given', () => {
      const body = refusalCommentBody(estimate);
      expect(body).not.toContain('Proposed split');
    });

    it('says nothing about a split when given an empty one', () => {
      const body = refusalCommentBody(estimate, []);
      expect(body).not.toContain('Proposed split');
    });

    it('renders a numbered list, in order, when a real split is given', () => {
      const body = refusalCommentBody(estimate, [
        { summary: 'Extract the shared validation helper', changedLines: 80, filesTouched: 2 },
        { summary: 'Wire the new endpoint through it', changedLines: 140, filesTouched: 5 },
      ]);
      expect(body).toContain('Proposed split · 2 tickets, in this order');
      const first = body.indexOf('1. Extract the shared validation helper');
      const second = body.indexOf('2. Wire the new endpoint through it');
      expect(first).toBeGreaterThan(-1);
      expect(second).toBeGreaterThan(first);
      expect(body).toContain('(≈80 lines, 2 files)');
      expect(body).toContain('(≈140 lines, 5 files)');
    });

    it('still says nothing was written even with a split attached', () => {
      const body = refusalCommentBody(estimate, [
        { summary: 'One part', changedLines: 10, filesTouched: 1 },
      ]);
      expect(body).toContain('Nothing was written');
    });
  });
});

/**
 * Issue #469's own investigation question, answered by a real `PipenzoPhaseService.refine()` call
 * against a real `FileTicketStore`: before this suite, nothing cached a refusal's `spec` onto the
 * ticket record the way `#reportStackVerdict` already caches one for a `stack` verdict -- a
 * refusal's estimate/tripped-threshold/proposedSplit lived only in the original `refine()`
 * response. `#reportRefusal` now makes the same early write `#reportStackVerdict` does; this suite
 * is what proves it, using the exact harness shape
 * `pipenzo-phase-service-stack-approval.test.ts` already established for the sibling case.
 */
const run = promisify(execFile);
const GIT_HEAVY_TIMEOUT_MS = 45_000;
const REFUSAL_REPO = 'jortega0033/pipenzo';
const REFUSAL_ISSUE_NUMBER = 113;
const REFUSAL_TICKET_ID = '00000000-0000-4000-8000-0000000000cc';
const refusalTempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    refusalTempDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

const refusalNoCommands: GateCommandRunner = {
  available: async () => false,
  run: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', code: 0 }),
};

function refusalIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    owner: 'jortega0033',
    repo: 'pipenzo',
    number: REFUSAL_ISSUE_NUMBER,
    title: 'Replace the JSON file store with SQLite across daemon and desktop',
    body: 'Needs a storage-engine swap across both packages.',
    state: 'open',
    labels: ['pipenzo:queued'],
    assignees: [],
    htmlUrl: `https://github.com/${REFUSAL_REPO}/issues/${REFUSAL_ISSUE_NUMBER}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    etag: undefined,
    ...overrides,
  };
}

/** Past README's ceiling either way -- refuses regardless of `layered`. */
function refusedSpec(overrides: Partial<RefineSpecV1> = {}): RefineSpecV1 {
  return {
    schemaVersion: 1,
    issue: { repo: REFUSAL_REPO, number: REFUSAL_ISSUE_NUMBER, title: refusalIssue().title },
    summary: 'Swap the JSON file store for SQLite everywhere it is read or written.',
    acceptanceCriteria: [
      { id: 'AC-1', kind: 'ubiquitous', text: 'The daemon shall persist tickets in SQLite' },
    ],
    outOfScope: ['A schema migration tool for existing JSON stores'],
    filesLikelyTouched: [],
    estimate: { changedLines: 1750, filesTouched: 31, layered: false },
    openQuestions: [],
    proposedSplit: [
      { summary: 'Introduce a storage interface behind the current store', changedLines: 90, filesTouched: 4 },
      { summary: 'SQLite adapter behind that interface', changedLines: 620, filesTouched: 9 },
      { summary: 'Migrate every caller off the JSON store', changedLines: 1040, filesTouched: 18 },
    ],
    ...overrides,
  };
}

function makeRefusalTicket(overrides: Partial<PipenzoTicketRecordV1> = {}): PipenzoTicketRecordV1 {
  return {
    schemaVersion: 1,
    ticketId: REFUSAL_TICKET_ID,
    repo: REFUSAL_REPO,
    issueNumber: REFUSAL_ISSUE_NUMBER,
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

async function refusalRealRepo(): Promise<{
  repositoryPath: string;
  worktreeManager: OwnedWorktreeManager;
}> {
  const base = await mkdtemp(join(tmpdir(), 'pipenzo-refusal-cache-service-'));
  refusalTempDirectories.push(base);
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

async function buildRefusalHarness(options: { ticket?: Partial<PipenzoTicketRecordV1> }) {
  const { repositoryPath, worktreeManager } = await refusalRealRepo();
  const storeBase = await mkdtemp(join(tmpdir(), 'pipenzo-refusal-cache-service-tickets-'));
  refusalTempDirectories.push(storeBase);
  const tickets = new FileTicketStore(join(storeBase, 'tickets-v1'));
  tickets.create(makeRefusalTicket(options.ticket));
  const github = new FakeGitHubClient().seedIssue(
    refusalIssue({ labels: options.ticket?.labels ?? ['pipenzo:working'] }),
  );
  const machine = new PipenzoPhaseMachine({ tickets, github: () => github });

  const service = new PipenzoPhaseService({
    refineSessions: {
      run: async () => ({
        sessionId: 'session-refine',
        output: JSON.parse(JSON.stringify(refusedSpec())),
        toolsUsed: ['Read'],
      }),
    },
    reviewSessions: {
      run: async () => ({ sessionId: 'session-review', findings: [], verdict: 'approved' as const }),
    },
    implementSessions: { run: async () => ({ sessionId: 'session-implement' }) },
    worktrees: worktreeManager,
    github: () => github,
    commands: refusalNoCommands,
    machine,
    tickets,
    logger: noopLogger,
  });

  return { service, tickets, github, repositoryPath };
}

describe('PipenzoPhaseService — refusal at Refine caches the spec (issue #469)', () => {
  it(
    'parks the ticket on pipenzo:needs-pre-scoping and caches the estimate and proposed split onto the record',
    async () => {
      const { service, tickets, github, repositoryPath } = await buildRefusalHarness({});

      const result = await service.refine({
        repo: REFUSAL_REPO,
        issueNumber: REFUSAL_ISSUE_NUMBER,
        repositoryPath,
        provider: 'claude',
        ticketId: REFUSAL_TICKET_ID,
      });

      expect(result.gateVerdict).toBe('refuse');

      const stored = tickets.get(REFUSAL_TICKET_ID);
      expect(stored?.labels).toContain('pipenzo:needs-pre-scoping');
      // The write that makes RefusalPanel's data survive past the original response -- see
      // `#reportRefusal`'s own doc comment for why `spec` is cached this early.
      expect(stored?.spec?.estimate).toEqual(refusedSpec().estimate);
      expect(stored?.spec?.proposedSplit).toEqual(refusedSpec().proposedSplit);

      const comments = github.issueComments({ owner: 'jortega0033', repo: 'pipenzo' }, REFUSAL_ISSUE_NUMBER);
      expect(comments).toHaveLength(1);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'does not double-transition, double-comment, or re-cache on a retried refine() once already parked',
    async () => {
      const { service, tickets, github, repositoryPath } = await buildRefusalHarness({
        ticket: { labels: ['pipenzo:needs-pre-scoping'] },
      });

      await service.refine({
        repo: REFUSAL_REPO,
        issueNumber: REFUSAL_ISSUE_NUMBER,
        repositoryPath,
        provider: 'claude',
        ticketId: REFUSAL_TICKET_ID,
      });

      expect(github.issueComments({ owner: 'jortega0033', repo: 'pipenzo' }, REFUSAL_ISSUE_NUMBER)).toHaveLength(0);
      // Guarded by the same `read()`-then-skip the comment/transition are -- a retry must not cache
      // a second time either, even though re-caching the same value would be harmless here.
      expect(tickets.get(REFUSAL_TICKET_ID)?.spec).toBeUndefined();
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});
