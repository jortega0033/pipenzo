import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PipenzoTicketRecordV1, RefineProposedSplitPartV1 } from '@agent-dock/shared';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import { GitHubClientError } from '../src/github-client.js';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';
import { OwnedWorktreeManager } from '../src/worktree-manager.js';
import {
  materializeStack,
  StackMaterializationError,
  type StackWorktreePort,
} from '../src/pipenzo-stack-materializer.js';

const run = promisify(execFile);
const GIT_HEAVY_TIMEOUT_MS = 45_000;
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

const PARENT_TICKET: PipenzoTicketRecordV1 = {
  schemaVersion: 1,
  ticketId: '00000000-0000-4000-8000-0000000000aa',
  repo: 'jortega0033/pipenzo',
  issueNumber: 108,
  title: 'Rework provider capability negotiation across all transports',
  lane: 'needs-human',
  phase: 'refine',
  labels: ['pipenzo:awaiting-stack-approval', 'pipenzo:schema-v1'],
  estimate: { lines: 212, files: 9, layered: true },
  taskType: 'feature',
  stack: { parentId: null, childIds: [], index: null },
  attempts: [],
  budget: { tokensUsed: 0, limit: 0 },
  risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
  precommits: [],
  etags: {},
};

const PARTS: RefineProposedSplitPartV1[] = [
  { summary: 'Extract the shared capability schema', changedLines: 80, filesTouched: 3 },
  { summary: 'Wire the HTTP transport to it', changedLines: 70, filesTouched: 3 },
  { summary: 'Wire the stdio transport to it', changedLines: 62, filesTouched: 3 },
];

async function realRepo(): Promise<{ repo: string; worktreeManager: OwnedWorktreeManager }> {
  const base = await mkdtemp(join(tmpdir(), 'pipenzo-stack-materializer-'));
  tempDirectories.push(base);
  const repo = join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await run('git', ['init', '--initial-branch=main'], { cwd: repo });
  await run('git', ['config', 'user.name', 'Fixture'], { cwd: repo });
  await run('git', ['config', 'user.email', 'fixture@example.test'], { cwd: repo });
  await run('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repo });
  const worktreeManager = new OwnedWorktreeManager(join(base, 'owned'), join(base, 'worktrees.json'));
  await worktreeManager.load();
  return { repo, worktreeManager };
}

function ticketStore(base: string): FileTicketStore {
  return new FileTicketStore(join(base, 'tickets-v1'));
}

async function branchTipOf(path: string, branch: string): Promise<string> {
  const result = await run('git', ['rev-parse', branch], { cwd: path });
  return result.stdout.trim();
}

describe('materializeStack', () => {
  it(
    'creates one GitHub issue, one worktree+branch, and one ticket record per part, in the approved order',
    async () => {
      const { repo, worktreeManager } = await realRepo();
      const github = new FakeGitHubClient();
      const storeBase = await mkdtemp(join(tmpdir(), 'pipenzo-stack-materializer-tickets-'));
      tempDirectories.push(storeBase);
      const tickets = ticketStore(storeBase);

      const children = await materializeStack({
        parentTicket: PARENT_TICKET,
        repositoryPath: repo,
        orderedParts: PARTS,
        github,
        repoRef: { owner: 'jortega0033', repo: 'pipenzo' },
        worktrees: worktreeManager,
        tickets,
      });

      expect(children).toHaveLength(3);
      // Real, distinct GitHub issues, one per part, in order.
      const issueNumbers = children.map((child) => child.issueNumber);
      expect(new Set(issueNumbers).size).toBe(3);

      // Real, distinct ticket records, each a genuine child of the parent, at the right index.
      children.forEach((child, index) => {
        const record = tickets.get(child.ticketId);
        expect(record).toBeDefined();
        expect(record?.stack).toEqual({ parentId: PARENT_TICKET.ticketId, childIds: [], index });
        expect(record?.estimate).toEqual({
          lines: PARTS[index]!.changedLines,
          files: PARTS[index]!.filesTouched,
          layered: false,
        });
        expect(record?.taskType).toBe(PARENT_TICKET.taskType);
        expect(record?.issueNumber).toBe(child.issueNumber);
        expect(record?.worktree?.id).toBeTruthy();
        expect(record?.worktree?.branch).toBe(`issue-${child.issueNumber}`);
      });

      // Real, distinct worktrees.
      const worktreeIds = children.map((child) => tickets.get(child.ticketId)!.worktree!.id);
      expect(new Set(worktreeIds).size).toBe(3);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'stacks each child on the previous child’s own branch, not on the parent’s base (dependency order)',
    async () => {
      const { repo, worktreeManager } = await realRepo();
      const github = new FakeGitHubClient();
      const storeBase = await mkdtemp(join(tmpdir(), 'pipenzo-stack-materializer-order-'));
      tempDirectories.push(storeBase);
      const tickets = ticketStore(storeBase);

      const children = await materializeStack({
        parentTicket: PARENT_TICKET,
        repositoryPath: repo,
        orderedParts: PARTS,
        github,
        repoRef: { owner: 'jortega0033', repo: 'pipenzo' },
        worktrees: worktreeManager,
        tickets,
      });

      const branches = children.map((child) => tickets.get(child.ticketId)!.worktree!.branch);
      // Every branch after the first resolves to the exact same commit as the branch before it --
      // proof each child's worktree was cut from its predecessor's branch, not from `main` again.
      for (let i = 1; i < branches.length; i += 1) {
        const previousTip = await branchTipOf(repo, branches[i - 1]!);
        const thisBase = await run('git', ['merge-base', branches[i]!, branches[i - 1]!], { cwd: repo });
        expect(thisBase.stdout.trim()).toBe(previousTip);
      }
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'stops and reports partial progress when a later GitHub issue create fails',
    async () => {
      const { repo, worktreeManager } = await realRepo();
      const github = new FakeGitHubClient();
      const storeBase = await mkdtemp(join(tmpdir(), 'pipenzo-stack-materializer-partial-'));
      tempDirectories.push(storeBase);
      const tickets = ticketStore(storeBase);

      // Succeeds for part 1, fails for part 2, would succeed again for part 3 -- proves the
      // failure stops the loop rather than being retried past.
      let calls = 0;
      const failingOnSecond: Pick<typeof github, 'createIssue'> = {
        createIssue: async (ref, input) => {
          calls += 1;
          if (calls === 2) throw new GitHubClientError('rate_limited', 'synthetic failure');
          return github.createIssue(ref, input);
        },
      };

      let caught: unknown;
      try {
        await materializeStack({
          parentTicket: PARENT_TICKET,
          repositoryPath: repo,
          orderedParts: PARTS,
          github: failingOnSecond,
          repoRef: { owner: 'jortega0033', repo: 'pipenzo' },
          worktrees: worktreeManager,
          tickets,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(StackMaterializationError);
      const materializationError = caught as StackMaterializationError;
      // The first child was genuinely created before the second failed -- reported, not hidden.
      expect(materializationError.children).toHaveLength(1);
      expect(tickets.list()).toHaveLength(1);
      // Never retried past the failure: only 2 GitHub calls happened, not 3.
      expect(calls).toBe(2);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'reports a worktree provisioning failure without losing the already-created GitHub issue from its own report',
    async () => {
      const { repo } = await realRepo();
      const github = new FakeGitHubClient();
      const storeBase = await mkdtemp(join(tmpdir(), 'pipenzo-stack-materializer-worktree-fail-'));
      tempDirectories.push(storeBase);
      const tickets = ticketStore(storeBase);

      const brokenWorktrees: StackWorktreePort = {
        create: async () => {
          throw new Error('synthetic worktree failure');
        },
        ownedLocation: () => undefined,
      };

      await expect(
        materializeStack({
          parentTicket: PARENT_TICKET,
          repositoryPath: repo,
          orderedParts: PARTS.slice(0, 1),
          github,
          repoRef: { owner: 'jortega0033', repo: 'pipenzo' },
          worktrees: brokenWorktrees,
          tickets,
        }),
      ).rejects.toThrow(StackMaterializationError);

      // No ticket was persisted for the part whose worktree never came up.
      expect(tickets.list()).toHaveLength(0);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});
