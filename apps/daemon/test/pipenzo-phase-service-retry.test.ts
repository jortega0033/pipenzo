import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@agent-dock/agent-runtime';
import type { CreateSessionV2Request, PipenzoTicketRecordV1 } from '@agent-dock/shared';
import { PipenzoPhaseService } from '../src/pipenzo-phase-service.js';
import type { ImplementSessionPort, ImplementSessionOutcome } from '../src/implement-orchestrator.js';
import type { PipenzoRetrySessionPort } from '../src/pipenzo-retry-sessions.js';
import type { PipenzoRunControlSessionPort } from '../src/pipenzo-run-control-sessions.js';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import type { GitHubIssue } from '../src/github-client.js';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';
import { PipenzoPhaseMachine } from '../src/pipenzo-phase-machine.js';
import { OwnedWorktreeManager } from '../src/worktree-manager.js';
import type { GateCommandRunner, CommandResult } from '../src/review-gates.js';

/**
 * Issue #105, CLAUDE.md hard rule 4's own effectful half, proven against a real git worktree and a
 * real `FileTicketStore`/`PipenzoPhaseMachine` -- the same harness shape
 * `pipenzo-phase-service-run-controls.test.ts` already established for issue #103's Steer/Stop, with
 * a fake `ImplementSessionPort` standing in for agentdock's own session dispatch so this suite can
 * assert exactly which request (`continuation` set or not, `model` set or not) retryImplement() ever
 * builds -- never a real provider subprocess.
 */
const run = promisify(execFile);
const GIT_HEAVY_TIMEOUT_MS = 45_000;
const RETRY_REPO = 'jortega0033/pipenzo';
const RETRY_ISSUE_NUMBER = 115;
const RETRY_TICKET_ID = '00000000-0000-4000-8000-0000000000ee';
const retryTempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    retryTempDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

const retryNoCommands: GateCommandRunner = {
  available: async () => false,
  run: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', code: 0 }),
};

function retryIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    owner: 'jortega0033',
    repo: 'pipenzo',
    number: RETRY_ISSUE_NUMBER,
    title: 'Retry phase + classified retry',
    body: 'Header action + retry classification.',
    state: 'open',
    labels: ['pipenzo:needs-human'],
    assignees: [],
    htmlUrl: `https://github.com/${RETRY_REPO}/issues/${RETRY_ISSUE_NUMBER}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    etag: undefined,
    ...overrides,
  };
}

/** Records every `run()` call it receives, so a test can assert exactly what `retryImplement()`
 *  dispatched -- in particular, whether `continuation` and `model` were set. */
class FakeImplementSessions implements ImplementSessionPort {
  readonly runCalls: CreateSessionV2Request[] = [];
  #nextSessionId = 'retry-session-1';
  #shouldFail = false;

  setNextSessionId(id: string): void {
    this.#nextSessionId = id;
  }

  setShouldFail(fail: boolean): void {
    this.#shouldFail = fail;
  }

  async run(request: CreateSessionV2Request): Promise<ImplementSessionOutcome> {
    this.runCalls.push(request);
    if (this.#shouldFail) throw new Error('the fake implement session refused to start');
    return { sessionId: this.#nextSessionId };
  }
}

class FakeRetrySessions implements PipenzoRetrySessionPort {
  #ids = new Map<string, string>();

  setProviderSessionId(sessionId: string, providerSessionId: string | undefined): void {
    if (providerSessionId === undefined) this.#ids.delete(sessionId);
    else this.#ids.set(sessionId, providerSessionId);
  }

  providerSessionId(sessionId: string): string | undefined {
    return this.#ids.get(sessionId);
  }
}

class FakeRunControlSessions implements PipenzoRunControlSessionPort {
  #statuses = new Map<string, { active: boolean; turnId?: string }>();

  setStatus(sessionId: string, status: { active: boolean; turnId?: string } | undefined): void {
    if (status) this.#statuses.set(sessionId, status);
    else this.#statuses.delete(sessionId);
  }

  status(sessionId: string): { active: boolean; turnId?: string } | undefined {
    return this.#statuses.get(sessionId);
  }

  async steer(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async interrupt(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

function makeRetryTicket(overrides: Partial<PipenzoTicketRecordV1> = {}): PipenzoTicketRecordV1 {
  return {
    schemaVersion: 1,
    ticketId: RETRY_TICKET_ID,
    repo: RETRY_REPO,
    issueNumber: RETRY_ISSUE_NUMBER,
    lane: 'needs-human',
    phase: 'implement',
    labels: ['pipenzo:needs-human'],
    estimate: { lines: 0, files: 0, layered: false },
    taskType: 'feature',
    stack: { parentId: null, childIds: [], index: null },
    spec: {
      schemaVersion: 1,
      issue: { repo: RETRY_REPO, number: RETRY_ISSUE_NUMBER, title: retryIssue().title },
      summary: 'Classify and dispatch a retry.',
      acceptanceCriteria: [
        { id: 'AC-1', kind: 'ubiquitous', text: 'The system shall never auto-retry a denied approval' },
      ],
      outOfScope: ['How agentdock itself resumes/forks a provider session'],
      filesLikelyTouched: [],
      estimate: { changedLines: 80, filesTouched: 4, layered: false },
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

async function retryRealWorktree(): Promise<{
  repositoryPath: string;
  worktreeManager: OwnedWorktreeManager;
  worktreeId: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
}> {
  const base = await mkdtemp(join(tmpdir(), 'pipenzo-retry-'));
  retryTempDirectories.push(base);
  const repositoryPath = join(base, 'repo');
  await mkdir(repositoryPath, { recursive: true });
  await run('git', ['init', '--initial-branch=main'], { cwd: repositoryPath });
  await run('git', ['config', 'user.name', 'Fixture'], { cwd: repositoryPath });
  await run('git', ['config', 'user.email', 'fixture@example.test'], { cwd: repositoryPath });
  await run('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repositoryPath });

  const worktreeManager = new OwnedWorktreeManager(join(base, 'owned'), join(base, 'worktrees.json'));
  await worktreeManager.load();
  const branch = `issue-${RETRY_ISSUE_NUMBER}`;
  const owned = await worktreeManager.create({
    cwd: repositoryPath,
    name: branch,
    confirmIncludeCopy: true,
  });
  const location = worktreeManager.ownedLocation(owned.id);
  if (!location) throw new Error('test setup: owned worktree has no location');
  const baseCommitResult = await run('git', ['rev-parse', 'HEAD'], { cwd: location.path });

  return {
    repositoryPath,
    worktreeManager,
    worktreeId: owned.id,
    worktreePath: location.path,
    branch,
    baseCommit: baseCommitResult.stdout.trim(),
  };
}

async function buildRetryHarness(options: {
  ticketOverrides?: Partial<PipenzoTicketRecordV1>;
  issueOverrides?: Partial<GitHubIssue>;
} = {}) {
  const { worktreeManager, worktreeId, worktreePath, branch, baseCommit } = await retryRealWorktree();
  const storeBase = await mkdtemp(join(tmpdir(), 'pipenzo-retry-tickets-'));
  retryTempDirectories.push(storeBase);
  const tickets = new FileTicketStore(join(storeBase, 'tickets-v1'));
  tickets.create(
    makeRetryTicket({
      worktree: { id: worktreeId, path: worktreePath, branch, baseCommit },
      ...options.ticketOverrides,
    }),
  );
  // `machine.read()` treats the issue's own labels as authoritative (README's precedence rule) --
  // a test that wants the ticket to read as something other than `pipenzo:needs-human` has to say so
  // on the seeded issue too, not just on the local ticket fixture above (the same reasoning
  // `pipenzo-stack-approval-routes.test.ts`'s own `buildApp()` already states for the same reason).
  const github = new FakeGitHubClient().seedIssue(retryIssue(options.issueOverrides));
  const machine = new PipenzoPhaseMachine({ tickets, github: () => github });
  const implementSessions = new FakeImplementSessions();
  const retrySessions = new FakeRetrySessions();
  const runControls = new FakeRunControlSessions();

  const service = new PipenzoPhaseService({
    refineSessions: { run: async () => ({ sessionId: 's', output: {}, toolsUsed: [] }) },
    reviewSessions: { run: async () => ({ sessionId: 's', findings: [], verdict: 'approved' as const }) },
    implementSessions,
    worktrees: worktreeManager,
    github: () => github,
    commands: retryNoCommands,
    machine,
    tickets,
    logger: noopLogger,
    runControls,
    retrySessions,
  });

  return { service, tickets, worktreeManager, worktreePath, branch, implementSessions, retrySessions, runControls };
}

describe('PipenzoPhaseService.retryImplement (issue #105, CLAUDE.md hard rule 4)', () => {
  it(
    'refuses structurally when the ticket’s last approval was rejected, even with only one attempt made',
    async () => {
      const { service, implementSessions } = await buildRetryHarness({
        ticketOverrides: {
          attempts: [{ sessionId: 's-1', tier: 'mid', model: 'claude-sonnet', outcome: 'dispatched' }],
          lastApprovalRejection: { kind: 'high', reason: 'not ready', decidedAt: '2026-01-01T00:00:00.000Z' },
        },
      });

      await expect(service.retryImplement({ ticketId: RETRY_TICKET_ID })).rejects.toMatchObject({
        code: 'approval_denied',
      });
      // The structural refusal happens before any dispatch is ever attempted.
      expect(implementSessions.runCalls).toEqual([]);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses with not_parked for a ticket that is not on pipenzo:needs-human',
    async () => {
      const { service, implementSessions } = await buildRetryHarness({
        ticketOverrides: {
          lane: 'working',
          labels: ['pipenzo:working'],
          attempts: [{ sessionId: 's-1', tier: 'mid', model: 'claude-sonnet', outcome: 'dispatched' }],
        },
        issueOverrides: { labels: ['pipenzo:working'] },
      });

      await expect(service.retryImplement({ ticketId: RETRY_TICKET_ID })).rejects.toMatchObject({
        code: 'not_parked',
      });
      expect(implementSessions.runCalls).toEqual([]);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses with run_not_found for a ticket with no dispatched attempt',
    async () => {
      const { service } = await buildRetryHarness({ ticketOverrides: { attempts: [] } });

      await expect(service.retryImplement({ ticketId: RETRY_TICKET_ID })).rejects.toMatchObject({
        code: 'run_not_found',
      });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses with run_still_active when the prior session is genuinely live right now',
    async () => {
      const { service, runControls, implementSessions } = await buildRetryHarness({
        ticketOverrides: {
          attempts: [{ sessionId: 's-1', tier: 'mid', model: 'claude-sonnet', outcome: 'dispatched' }],
        },
      });
      runControls.setStatus('s-1', { active: true, turnId: 'turn-1' });

      await expect(service.retryImplement({ ticketId: RETRY_TICKET_ID })).rejects.toMatchObject({
        code: 'run_still_active',
      });
      expect(implementSessions.runCalls).toEqual([]);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses with max_retries_reached once the ticket has made 3 attempts, and parks it on pipenzo:needs-human',
    async () => {
      const { service, tickets, implementSessions } = await buildRetryHarness({
        ticketOverrides: {
          attempts: [
            { sessionId: 's-1', tier: 'cheap', model: 'default', outcome: 'dispatched' },
            { sessionId: 's-2', tier: 'mid', model: 'default', outcome: 'dispatched' },
            { sessionId: 's-3', tier: 'frontier', model: 'default', outcome: 'dispatched' },
          ],
        },
      });

      await expect(service.retryImplement({ ticketId: RETRY_TICKET_ID })).rejects.toMatchObject({
        code: 'max_retries_reached',
      });
      expect(implementSessions.runCalls).toEqual([]);
      expect(tickets.get(RETRY_TICKET_ID)?.labels).toContain('pipenzo:needs-human');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'dispatches a same-tier fork -- continuing the prior provider session, never selecting a model -- when the last attempt already reached frontier',
    async () => {
      const { service, tickets, implementSessions, retrySessions, worktreePath } = await buildRetryHarness({
        ticketOverrides: {
          attempts: [{ sessionId: 's-1', tier: 'frontier', model: 'claude-opus', outcome: 'dispatched' }],
        },
      });
      retrySessions.setProviderSessionId('s-1', 'provider-native-session-xyz');
      implementSessions.setNextSessionId('retry-fork-session');

      const result = await service.retryImplement({ ticketId: RETRY_TICKET_ID });

      expect(result).toEqual({ sessionId: 'retry-fork-session', mode: 'fork', tier: 'frontier' });
      expect(implementSessions.runCalls).toHaveLength(1);
      const dispatched = implementSessions.runCalls[0]!;
      // The one property CLAUDE.md hard rule 4 exists to hold: a fork never carries a model.
      expect(dispatched.model).toBeUndefined();
      expect(dispatched.continuation).toEqual({
        kind: 'fork',
        providerSessionId: 'provider-native-session-xyz',
      });
      expect(dispatched.cwd).toBe(worktreePath);

      const ticket = tickets.get(RETRY_TICKET_ID)!;
      expect(ticket.attempts.at(-1)).toMatchObject({ sessionId: 'retry-fork-session', tier: 'frontier' });
      expect(ticket.labels).toContain('pipenzo:working');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'dispatches a genuinely fresh session at the next tier -- never a continuation -- for a tier-escalation retry',
    async () => {
      const { service, tickets, implementSessions, retrySessions } = await buildRetryHarness({
        ticketOverrides: {
          attempts: [{ sessionId: 's-1', tier: 'mid', model: 'claude-sonnet', outcome: 'dispatched' }],
        },
      });
      // Even when a provider-native session id *is* available, a tier escalation must never fork --
      // this is the test the issue explicitly asks for.
      retrySessions.setProviderSessionId('s-1', 'provider-native-session-should-be-ignored');
      implementSessions.setNextSessionId('retry-fresh-session');

      const result = await service.retryImplement({ ticketId: RETRY_TICKET_ID });

      expect(result).toEqual({ sessionId: 'retry-fresh-session', mode: 'fresh', tier: 'frontier' });
      expect(implementSessions.runCalls).toHaveLength(1);
      const dispatched = implementSessions.runCalls[0]!;
      // The exact property this test exists to prove: a tier-escalation retry never carries a
      // `continuation` -- it is a genuinely fresh session, not a fork wearing a different tier.
      expect(dispatched.continuation).toBeUndefined();

      const ticket = tickets.get(RETRY_TICKET_ID)!;
      expect(ticket.attempts.at(-1)).toMatchObject({ sessionId: 'retry-fresh-session', tier: 'frontier' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses with fork_unavailable rather than silently dispatching fresh, when the prior session has no provider-native id to fork',
    async () => {
      const { service, implementSessions } = await buildRetryHarness({
        ticketOverrides: {
          attempts: [{ sessionId: 's-1', tier: 'frontier', model: 'claude-opus', outcome: 'dispatched' }],
        },
      });
      // No `setProviderSessionId` call -- the fake reports "never observed one".

      await expect(service.retryImplement({ ticketId: RETRY_TICKET_ID })).rejects.toMatchObject({
        code: 'fork_unavailable',
      });
      expect(implementSessions.runCalls).toEqual([]);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'never calls fork for a tier-escalation classification across every tier, proven directly against the dispatch call',
    async () => {
      // The issue's own explicit ask: a test proving a tier-escalation retry never calls fork.
      // Exercised at both tiers that escalate (cheap and mid); frontier has nowhere to escalate to
      // and is covered by the fork test above.
      for (const tier of ['cheap', 'mid'] as const) {
        const { service, implementSessions, retrySessions } = await buildRetryHarness({
          ticketOverrides: {
            attempts: [{ sessionId: 's-1', tier, model: 'default', outcome: 'dispatched' }],
          },
        });
        retrySessions.setProviderSessionId('s-1', 'provider-native-session-always-available');

        const result = await service.retryImplement({ ticketId: RETRY_TICKET_ID });

        expect(result.mode).toBe('fresh');
        expect(implementSessions.runCalls).toHaveLength(1);
        expect(implementSessions.runCalls[0]!.continuation).toBeUndefined();
      }
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});
