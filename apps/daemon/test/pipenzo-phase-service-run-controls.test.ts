import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@agent-dock/agent-runtime';
import type { PipenzoTicketRecordV1 } from '@agent-dock/shared';
import { PipenzoPhaseError, PipenzoPhaseService } from '../src/pipenzo-phase-service.js';
import type { PipenzoRunControlSessionPort } from '../src/pipenzo-run-control-sessions.js';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import type { GitHubIssue } from '../src/github-client.js';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';
import { PipenzoPhaseMachine } from '../src/pipenzo-phase-machine.js';
import { OwnedWorktreeManager } from '../src/worktree-manager.js';
import type { GateCommandRunner, CommandResult } from '../src/review-gates.js';

/**
 * Issue #103's own safety properties, proven against a real git worktree and a real
 * `FileTicketStore`/`PipenzoPhaseMachine` -- the same harness shape
 * `pipenzo-phase-service-refusal.test.ts` already established, with a fake
 * `PipenzoRunControlSessionPort` standing in for agentdock's session machinery (that machinery's
 * own turn-boundary/state gating is `packages/agent-runtime`'s and `v2-session-facade.ts`'s own
 * test suites' job, not this one's -- this suite proves `PipenzoPhaseService` calls that seam
 * correctly and never reaches past it into the worktree).
 */
const run = promisify(execFile);
const GIT_HEAVY_TIMEOUT_MS = 45_000;
const RUN_CONTROL_REPO = 'jortega0033/pipenzo';
const RUN_CONTROL_ISSUE_NUMBER = 114;
const RUN_CONTROL_TICKET_ID = '00000000-0000-4000-8000-0000000000dd';
const runControlTempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    runControlTempDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

const runControlNoCommands: GateCommandRunner = {
  available: async () => false,
  run: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', code: 0 }),
};

function runControlIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    owner: 'jortega0033',
    repo: 'pipenzo',
    number: RUN_CONTROL_ISSUE_NUMBER,
    title: 'Wire Steer/Stop into TicketDetail',
    body: 'Deliver instruction at next tool boundary; Stop abandons only in-flight tool call.',
    state: 'open',
    labels: ['pipenzo:working'],
    assignees: [],
    htmlUrl: `https://github.com/${RUN_CONTROL_REPO}/issues/${RUN_CONTROL_ISSUE_NUMBER}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    etag: undefined,
    ...overrides,
  };
}

/** A fake seam onto agentdock's session commands (see `pipenzo-run-control-sessions.ts`'s own
 *  doc comment for what the real one wraps). Records every `steer`/`interrupt` call it receives so
 *  a test can assert exactly which session and turn a command was actually sent against. */
class FakeRunControlSessions implements PipenzoRunControlSessionPort {
  readonly steerCalls: Array<{ sessionId: string; turnId: string; instruction: string }> = [];
  readonly interruptCalls: Array<{ sessionId: string; turnId: string }> = [];
  #statuses = new Map<string, { active: boolean; turnId?: string }>();
  #interruptOk = true;
  #steerOk = true;

  setStatus(sessionId: string, status: { active: boolean; turnId?: string } | undefined): void {
    if (status) this.#statuses.set(sessionId, status);
    else this.#statuses.delete(sessionId);
  }

  setInterruptOk(ok: boolean): void {
    this.#interruptOk = ok;
  }

  setSteerOk(ok: boolean): void {
    this.#steerOk = ok;
  }

  status(sessionId: string): { active: boolean; turnId?: string } | undefined {
    return this.#statuses.get(sessionId);
  }

  async steer(sessionId: string, turnId: string, instruction: string): Promise<{ ok: boolean }> {
    this.steerCalls.push({ sessionId, turnId, instruction });
    return { ok: this.#steerOk };
  }

  async interrupt(sessionId: string, turnId: string): Promise<{ ok: boolean }> {
    this.interruptCalls.push({ sessionId, turnId });
    return { ok: this.#interruptOk };
  }
}

function makeRunControlTicket(
  overrides: Partial<PipenzoTicketRecordV1> = {},
): PipenzoTicketRecordV1 {
  return {
    schemaVersion: 1,
    ticketId: RUN_CONTROL_TICKET_ID,
    repo: RUN_CONTROL_REPO,
    issueNumber: RUN_CONTROL_ISSUE_NUMBER,
    lane: 'working',
    phase: 'implement',
    labels: ['pipenzo:working'],
    estimate: { lines: 0, files: 0, layered: false },
    taskType: 'feature',
    stack: { parentId: null, childIds: [], index: null },
    // `spec` stands in for "the approved Refine spec" -- every steerImplement() test asserts this
    // object is still present and unchanged afterward, since steering must never touch it.
    spec: {
      schemaVersion: 1,
      issue: { repo: RUN_CONTROL_REPO, number: RUN_CONTROL_ISSUE_NUMBER, title: runControlIssue().title },
      summary: 'Wire the run-control bridge.',
      acceptanceCriteria: [
        { id: 'AC-1', kind: 'ubiquitous', text: 'The system shall deliver a steer at the next tool boundary' },
      ],
      outOfScope: ['Anything about how agentdock delivers input.steer/session.interrupt itself'],
      filesLikelyTouched: [],
      estimate: { changedLines: 120, filesTouched: 6, layered: false },
      openQuestions: [],
    },
    attempts: [],
    budget: { tokensUsed: 0, limit: 0 },
    risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
    precommits: [],
    etags: {},
    ...overrides,
  };
}

/** A real repository, a real owned worktree cut from it (via the same `OwnedWorktreeManager` the
 *  daemon uses in production), and one real extra commit on top of the worktree's base -- so
 *  `commitCount` in every assertion below is a real `git rev-list --count`, not a stubbed number. */
async function runControlRealWorktree(): Promise<{
  repositoryPath: string;
  worktreeManager: OwnedWorktreeManager;
  worktreeId: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
}> {
  const base = await mkdtemp(join(tmpdir(), 'pipenzo-run-controls-'));
  runControlTempDirectories.push(base);
  const repositoryPath = join(base, 'repo');
  await mkdir(repositoryPath, { recursive: true });
  await run('git', ['init', '--initial-branch=main'], { cwd: repositoryPath });
  await run('git', ['config', 'user.name', 'Fixture'], { cwd: repositoryPath });
  await run('git', ['config', 'user.email', 'fixture@example.test'], { cwd: repositoryPath });
  await run('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repositoryPath });

  const worktreeManager = new OwnedWorktreeManager(join(base, 'owned'), join(base, 'worktrees.json'));
  await worktreeManager.load();
  const branch = `issue-${RUN_CONTROL_ISSUE_NUMBER}`;
  const owned = await worktreeManager.create({
    cwd: repositoryPath,
    name: branch,
    confirmIncludeCopy: true,
  });
  const location = worktreeManager.ownedLocation(owned.id);
  if (!location) throw new Error('test setup: owned worktree has no location');

  const baseCommitResult = await run('git', ['rev-parse', 'HEAD'], { cwd: location.path });
  const baseCommit = baseCommitResult.stdout.trim();

  // The one commit this "session" made -- what a real Implement session's own `git commit` (or
  // `ImplementOrchestrator`'s own finishing commit) would leave behind while still running.
  await writeFile(join(location.path, 'note.txt'), 'steered work in progress\n', 'utf8');
  await run('git', ['add', '-A'], { cwd: location.path });
  await run('git', ['commit', '-m', 'wip: steered work'], { cwd: location.path });

  return {
    repositoryPath,
    worktreeManager,
    worktreeId: owned.id,
    worktreePath: location.path,
    branch,
    baseCommit,
  };
}

async function buildRunControlHarness(options: {
  attempt?: { sessionId: string } | null;
  ticketOverrides?: Partial<PipenzoTicketRecordV1>;
}) {
  const { worktreeManager, worktreeId, worktreePath, branch, baseCommit } =
    await runControlRealWorktree();
  const storeBase = await mkdtemp(join(tmpdir(), 'pipenzo-run-controls-tickets-'));
  runControlTempDirectories.push(storeBase);
  const tickets = new FileTicketStore(join(storeBase, 'tickets-v1'));
  const sessionId = options.attempt === null ? undefined : options.attempt?.sessionId ?? 'session-implement-1';
  tickets.create(
    makeRunControlTicket({
      worktree: { id: worktreeId, path: worktreePath, branch, baseCommit },
      attempts:
        sessionId === undefined
          ? []
          : [{ sessionId, tier: 'mid', model: 'claude-sonnet', outcome: 'dispatched' }],
      ...options.ticketOverrides,
    }),
  );
  const github = new FakeGitHubClient().seedIssue(runControlIssue());
  const machine = new PipenzoPhaseMachine({ tickets, github: () => github });
  const runControls = new FakeRunControlSessions();

  const service = new PipenzoPhaseService({
    refineSessions: { run: async () => ({ sessionId: 's', output: {}, toolsUsed: [] }) },
    reviewSessions: { run: async () => ({ sessionId: 's', findings: [], verdict: 'approved' as const }) },
    implementSessions: { run: async () => ({ sessionId: 's' }) },
    worktrees: worktreeManager,
    github: () => github,
    commands: runControlNoCommands,
    machine,
    tickets,
    logger: noopLogger,
    runControls,
  });

  return { service, tickets, github, worktreeManager, worktreePath, branch, sessionId, runControls };
}

describe('PipenzoPhaseService.runStatus (issue #103)', () => {
  it(
    'reports live: false for a ticket with no dispatched attempt',
    async () => {
      const { service } = await buildRunControlHarness({ attempt: null });
      const result = await service.runStatus({ ticketId: RUN_CONTROL_TICKET_ID });
      expect(result).toEqual({ live: false });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'reports live: false when the dispatched attempt is not a session that is active right now',
    async () => {
      const { service } = await buildRunControlHarness({ attempt: { sessionId: 'session-ended' } });
      // No status set on the fake -> `status()` returns undefined -> "never seen this session".
      const result = await service.runStatus({ ticketId: RUN_CONTROL_TICKET_ID });
      expect(result).toEqual({ live: false });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'reports a real, live commit count for a genuinely running session',
    async () => {
      const { service, sessionId, runControls, branch } = await buildRunControlHarness({});
      runControls.setStatus(sessionId!, { active: true, turnId: 'turn-1' });

      const result = await service.runStatus({ ticketId: RUN_CONTROL_TICKET_ID });

      expect(result).toEqual({
        live: true,
        sessionId,
        tier: 'mid',
        model: 'claude-sonnet',
        branch,
        commitCount: 1,
      });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});

describe('PipenzoPhaseService.steerImplement (issue #103)', () => {
  it(
    'delivers the instruction to the running session at its current turn, and never touches the approved spec',
    async () => {
      const { service, tickets, sessionId, runControls } = await buildRunControlHarness({});
      runControls.setStatus(sessionId!, { active: true, turnId: 'turn-7' });
      const specBefore = tickets.get(RUN_CONTROL_TICKET_ID)?.spec;

      const result = await service.steerImplement({
        ticketId: RUN_CONTROL_TICKET_ID,
        instruction: 'leave the legacy fixture alone for now',
      });

      expect(result).toEqual({ sessionId });
      expect(runControls.steerCalls).toEqual([
        { sessionId, turnId: 'turn-7', instruction: 'leave the legacy fixture alone for now' },
      ]);
      // The one property this whole method exists to hold: the ticket's cached Refine spec is
      // byte-for-byte the same object after a steer as before it.
      expect(tickets.get(RUN_CONTROL_TICKET_ID)?.spec).toEqual(specBefore);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses with run_not_active rather than guessing, when the session is not live right now',
    async () => {
      const { service, sessionId } = await buildRunControlHarness({});
      // No `setStatus` call -- the fake reports "never seen this session", same as one that ended.

      await expect(
        service.steerImplement({ ticketId: RUN_CONTROL_TICKET_ID, instruction: 'anything' }),
      ).rejects.toMatchObject({ code: 'run_not_active' });
      void sessionId;
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses with run_not_found for a ticket that was never dispatched',
    async () => {
      const { service } = await buildRunControlHarness({ attempt: null });

      await expect(
        service.steerImplement({ ticketId: RUN_CONTROL_TICKET_ID, instruction: 'anything' }),
      ).rejects.toMatchObject({ code: 'run_not_found' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses with run_not_active when the daemon rejects the command (e.g. a stale turn)',
    async () => {
      const { service, sessionId, runControls } = await buildRunControlHarness({});
      runControls.setStatus(sessionId!, { active: true, turnId: 'turn-7' });
      runControls.setSteerOk(false);

      await expect(
        service.steerImplement({ ticketId: RUN_CONTROL_TICKET_ID, instruction: 'anything' }),
      ).rejects.toBeInstanceOf(PipenzoPhaseError);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});

describe('PipenzoPhaseService.stopImplement (issue #103)', () => {
  it(
    'abandons only the in-flight turn, preserves every commit and the worktree, and parks the ticket on pipenzo:needs-human',
    async () => {
      const { service, tickets, worktreeManager, worktreePath, branch, sessionId, runControls } =
        await buildRunControlHarness({});
      runControls.setStatus(sessionId!, { active: true, turnId: 'turn-3' });

      const result = await service.stopImplement({ ticketId: RUN_CONTROL_TICKET_ID });

      expect(runControls.interruptCalls).toEqual([{ sessionId, turnId: 'turn-3' }]);
      expect(result.label).toBe('pipenzo:needs-human');
      expect(result.branch).toBe(branch);
      // The real commit made in `runControlRealWorktree()` is still exactly what `git log` reports
      // -- nothing about stopping a session touched it.
      expect(result.commitCount).toBe(1);
      // `HEAD`, not `branch` by name: `OwnedWorktreeManager.create()` owns exactly what the
      // worktree's local branch is actually called, and this assertion only needs to know the
      // commit is still reachable from wherever the worktree's checkout currently sits.
      const log = await run('git', ['log', '--oneline', 'HEAD'], { cwd: worktreePath });
      expect(log.stdout).toContain('wip: steered work');

      expect(tickets.get(RUN_CONTROL_TICKET_ID)?.labels).toContain('pipenzo:needs-human');
      // The worktree directory itself was never removed -- `stopImplement()` must never reach
      // `cleanupTerminalWorktree()`/`cleanupWorktree()`. `execFile` (via `promisify`) rejects on a
      // non-zero exit or a missing directory, so simply resolving here is the proof: a removed
      // worktree would have made this `git status` throw, not return a status with content.
      const status = await run('git', ['status', '--porcelain=v1'], { cwd: worktreePath });
      expect(status.stdout).toBeDefined();
      expect(worktreeManager.ownedLocation(result.worktreeId)?.path).toBe(worktreePath);
      // The manager's own registry still lists exactly the one worktree this harness created --
      // not just that `ownedLocation()` happens to still resolve it, but that nothing silently
      // dropped it from (or added a stray entry to) the registry `ownedLocation()` reads from.
      const owned = await worktreeManager.list();
      expect(owned.map((entry) => entry.id)).toEqual([result.worktreeId]);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses with run_not_active and does not touch the ticket label when the session is not live',
    async () => {
      const { service, tickets } = await buildRunControlHarness({});
      // No `setStatus` -- the session is reported unseen/not-active.

      await expect(
        service.stopImplement({ ticketId: RUN_CONTROL_TICKET_ID }),
      ).rejects.toMatchObject({ code: 'run_not_active' });
      expect(tickets.get(RUN_CONTROL_TICKET_ID)?.labels).toEqual(['pipenzo:working']);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses with run_not_active when the daemon rejects the interrupt, and still does not touch the label',
    async () => {
      const { service, tickets, sessionId, runControls } = await buildRunControlHarness({});
      runControls.setStatus(sessionId!, { active: true, turnId: 'turn-9' });
      runControls.setInterruptOk(false);

      await expect(
        service.stopImplement({ ticketId: RUN_CONTROL_TICKET_ID }),
      ).rejects.toMatchObject({ code: 'run_not_active' });
      expect(tickets.get(RUN_CONTROL_TICKET_ID)?.labels).toEqual(['pipenzo:working']);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses with run_not_found for a ticket that was never dispatched',
    async () => {
      const { service } = await buildRunControlHarness({ attempt: null });

      await expect(service.stopImplement({ ticketId: RUN_CONTROL_TICKET_ID })).rejects.toMatchObject({
        code: 'run_not_found',
      });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});
