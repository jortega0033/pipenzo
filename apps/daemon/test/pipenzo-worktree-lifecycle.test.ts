import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PipenzoTicketRecordV1 } from '@agent-dock/shared';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';
import { OwnedWorktreeManager } from '../src/worktree-manager.js';
import { runGitCommand } from '../src/pipenzo-git.js';
import {
  attachTicketWorktree,
  cleanupTerminalWorktree,
  isAbandonedToQueue,
} from '../src/pipenzo-worktree-lifecycle.js';

/**
 * Real `git` subprocess spawns dominate this file's wall-clock cost, matching
 * `subagent-worktree.test.ts`/`worktree-routes.test.ts`'s own measured budget for the same reason:
 * a process spawn on Windows costs 100-300 ms before the command runs, and every body here drives
 * `git init`, `git worktree add`, `git checkout -b` and (in the dirty case) a real cleanup refusal.
 */
const GIT_HEAVY_TIMEOUT_MS = 45_000;

const run = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'pipenzo-worktree-lifecycle-'));
  temporaryDirectories.push(path);
  return path;
}

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await run('git', ['init'], { cwd: path });
  await writeFile(join(path, 'README.md'), 'fixture');
  await run('git', ['add', 'README.md'], { cwd: path });
  await run(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'],
    { cwd: path },
  );
}

function makeTicket(overrides: Partial<PipenzoTicketRecordV1> = {}): PipenzoTicketRecordV1 {
  return {
    schemaVersion: 1,
    ticketId: randomUUID(),
    repo: 'jortega0033/pipenzo',
    issueNumber: 1,
    lane: 'working',
    phase: 'implement',
    labels: ['pipenzo:working'],
    estimate: { lines: 40, files: 3, layered: false },
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

/**
 * Builds one real repo, one real owned worktree checked out onto a real branch (matching
 * `ImplementOrchestrator.start()`'s own two-step shape: a detached `create()`, then a `git
 * checkout -b` inside the worktree) and one ticket record naming it.
 */
async function harness(): Promise<{
  base: string;
  repo: string;
  branch: string;
  worktrees: OwnedWorktreeManager;
  tickets: FileTicketStore;
  ticket: PipenzoTicketRecordV1;
}> {
  const base = await temporaryDirectory();
  const repo = join(base, 'repo');
  await initRepo(repo);
  const worktrees = new OwnedWorktreeManager(join(base, 'owned'), join(base, 'worktrees.json'));
  await worktrees.load();
  const created = await worktrees.create({ cwd: repo, name: 'ticket', confirmIncludeCopy: true });
  const location = worktrees.ownedLocation(created.id);
  if (!location) throw new Error('expected the freshly created worktree to resolve');
  const branch = 'issue-1';
  await run('git', ['checkout', '-b', branch], { cwd: location.path });

  const tickets = new FileTicketStore(join(base, 'tickets'));
  const ticket = makeTicket({ worktree: { id: created.id, path: location.path, branch } });
  tickets.create(ticket);

  return { base, repo, branch, worktrees, tickets, ticket };
}

describe('attachTicketWorktree', () => {
  it('records the worktree onto an existing ticket', async () => {
    const tickets = new FileTicketStore(await temporaryDirectory());
    const ticket = makeTicket();
    tickets.create(ticket);

    attachTicketWorktree(tickets, ticket.ticketId, {
      id: randomUUID(),
      path: 'C:\\owned\\ticket',
      branch: 'issue-1',
    });

    expect(tickets.get(ticket.ticketId)?.worktree).toEqual({
      id: expect.any(String),
      path: 'C:\\owned\\ticket',
      branch: 'issue-1',
    });
  });

  it('is a quiet no-op for a ticket id nothing knows about', async () => {
    const tickets = new FileTicketStore(await temporaryDirectory());
    // Must not throw: the caller (a successful implement() dispatch) has already returned its real
    // result to its own caller by the time this best-effort write runs.
    expect(() =>
      attachTicketWorktree(tickets, randomUUID(), {
        id: randomUUID(),
        path: 'C:\\owned\\ticket',
        branch: 'issue-1',
      }),
    ).not.toThrow();
  });
});

describe('isAbandonedToQueue', () => {
  it('is true for working/ready-for-review moving back to queued', () => {
    expect(isAbandonedToQueue('working', 'queued')).toBe(true);
    expect(isAbandonedToQueue('ready-for-review', 'queued')).toBe(true);
  });

  it('is false for every other pair, including queued self-transitions', () => {
    expect(isAbandonedToQueue('queued', 'queued')).toBe(false);
    expect(isAbandonedToQueue('needs-human', 'queued')).toBe(false);
    expect(isAbandonedToQueue('working', 'ready-for-review')).toBe(false);
    expect(isAbandonedToQueue('working', 'needs-human')).toBe(false);
  });
});

describe('cleanupTerminalWorktree', () => {
  it('is a no-op that changes nothing for a ticket with no recorded worktree', async () => {
    const tickets = new FileTicketStore(await temporaryDirectory());
    const ticket = makeTicket();
    tickets.create(ticket);
    let cleanupCalled = false;

    const result = await cleanupTerminalWorktree({
      tickets,
      worktrees: {
        cleanup: async () => {
          cleanupCalled = true;
          return {};
        },
        ownedLocation: () => undefined,
      },
      ticketId: ticket.ticketId,
      reason: 'abandoned',
    });

    expect(result).toEqual({ outcome: 'no_worktree' });
    expect(cleanupCalled).toBe(false);
  });

  it(
    'removes a clean worktree, sweeps its branch, and clears the ticket record',
    async () => {
      const { repo, branch, worktrees, tickets, ticket } = await harness();

      const result = await cleanupTerminalWorktree({
        tickets,
        worktrees,
        ticketId: ticket.ticketId,
        reason: 'issue_closed',
      });

      expect(result).toEqual({ outcome: 'cleaned' });
      expect(tickets.get(ticket.ticketId)?.worktree).toBeUndefined();

      const owned = await worktrees.list();
      expect(owned.find((entry) => entry.id === ticket.worktree?.id)?.status ?? 'missing').toBe(
        'missing',
      );

      const branches = await runGitCommand(['branch', '--list', branch], repo);
      expect(branches.stdout.trim()).toBe('');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'retains a dirty worktree, surfaces the refusal, and never touches the branch',
    async () => {
      const { repo, branch, worktrees, tickets, ticket } = await harness();
      const worktreePath = ticket.worktree?.path;
      if (!worktreePath) throw new Error('expected the harness ticket to carry a worktree');
      // A real uncommitted change to a tracked file -- the case `OwnedWorktreeManager.cleanup()`
      // always refuses regardless of any option, never overridden by this module.
      await writeFile(join(worktreePath, 'README.md'), 'agent edit, never committed');

      const warnings: unknown[] = [];
      const result = await cleanupTerminalWorktree({
        tickets,
        worktrees,
        ticketId: ticket.ticketId,
        reason: 'abandoned',
        logger: { info() {}, warn: (...args) => warnings.push(args), error() {}, debug() {} },
      });

      expect(result).toEqual({ outcome: 'retained_dirty' });
      // Not swallowed: something observable recorded the refusal.
      expect(warnings.length).toBeGreaterThan(0);
      // Nothing was deleted: the ticket still names the worktree, and it is still there on disk.
      expect(tickets.get(ticket.ticketId)?.worktree).toEqual(ticket.worktree);
      const owned = await worktrees.list();
      expect(owned.find((entry) => entry.id === ticket.worktree?.id)?.status).toBe('dirty');

      const branches = await runGitCommand(['branch', '--list', branch], repo);
      expect(branches.stdout.trim()).not.toBe('');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'leaves the ticket record untouched when the worktree is not found',
    async () => {
      const tickets = new FileTicketStore(await temporaryDirectory());
      const ticket = makeTicket({
        worktree: { id: randomUUID(), path: 'C:\\owned\\gone', branch: 'issue-1' },
      });
      tickets.create(ticket);

      const result = await cleanupTerminalWorktree({
        tickets,
        worktrees: {
          cleanup: async () => {
            const { WorktreeManagerError } = await import('../src/worktree-manager.js');
            throw new WorktreeManagerError('worktree_not_found', 'no such owned worktree');
          },
          ownedLocation: () => undefined,
        },
        ticketId: ticket.ticketId,
        reason: 'issue_closed',
      });

      expect(result).toEqual({ outcome: 'cleanup_failed', error: 'no such owned worktree' });
      expect(tickets.get(ticket.ticketId)?.worktree).toEqual(ticket.worktree);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});
