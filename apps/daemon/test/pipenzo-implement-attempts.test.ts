import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@agent-dock/agent-runtime';
import type { RefineSpecV1 } from '@agent-dock/shared';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';
import { PipenzoPhaseMachine } from '../src/pipenzo-phase-machine.js';
import { PipenzoPhaseService } from '../src/pipenzo-phase-service.js';
import type { ImplementWorktreeManager } from '../src/implement-orchestrator.js';
import type { CommandResult, GateCommandRunner } from '../src/review-gates.js';
import type { GitCommandResult, PipenzoGitRunner } from '../src/pipenzo-git.js';
import { PipenzoCrashRecovery } from '../src/pipenzo-crash-recovery.js';
import type { PipenzoTicketRecordV1 } from '@agent-dock/shared';

/**
 * The end-to-end proof for issue #201's own gap, quoted from that ticket's final report:
 *
 * > Nothing in `apps/daemon/src` currently writes to `PipenzoTicketRecordV1.attempts[]` at real
 * > session-dispatch time ... Crash recovery's session -> ticket matching depends entirely on that
 * > array, so today it only works in tests that hand-seed it.
 *
 * This test dispatches a real implement session through `PipenzoPhaseService.implement()` -- the
 * same call `POST /v2/pipenzo/implement` makes -- against a ticket created with an *empty*
 * `attempts[]`, exactly as a fresh ticket looks before anything runs. It then builds a
 * `PipenzoCrashRecovery` over that same ticket store, reports the dispatched session id as
 * interrupted (as a daemon restart mid-Implement would), and asserts recovery finds and parks the
 * ticket -- proving the session-to-ticket index has real data to match against, not only what a
 * test hand-seeds.
 */

const TICKET_ID = '00000000-0000-4000-8000-0000000002aa';
const WORKTREE_ID = '22222222-3333-4444-8555-666666666666';
const SESSION_ID = 'session-implement-dispatch';
const REPO = 'jortega0033/pipenzo';
const ISSUE_NUMBER = 201;
const BASE_SHA = 'a'.repeat(40);
const REPO_PATH = process.platform === 'win32' ? 'C:\\repos\\pipenzo' : '/repos/pipenzo';
const WORKTREE_PATH = process.platform === 'win32' ? 'C:\\owned\\issue-201' : '/owned/issue-201';

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function storeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pipenzo-implement-attempts-'));
  scratch.push(root);
  return join(root, 'tickets-v1');
}

function spec(): RefineSpecV1 {
  return {
    schemaVersion: 1,
    issue: { repo: REPO, number: ISSUE_NUMBER, title: 'Wire Implement dispatch to populate attempts[]' },
    summary: 'Record a real attempt at implement-dispatch time.',
    acceptanceCriteria: [
      { id: 'AC-1', kind: 'ubiquitous', text: 'The daemon shall record an attempt on dispatch' },
    ],
    outOfScope: ['Model routing'],
    filesLikelyTouched: ['apps/daemon/src/pipenzo-phase-service.ts'],
    estimate: { changedLines: 40, filesTouched: 3, layered: false },
    openQuestions: [],
  };
}

function makeTicket(overrides: Partial<PipenzoTicketRecordV1> = {}): PipenzoTicketRecordV1 {
  return {
    schemaVersion: 1,
    ticketId: TICKET_ID,
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    lane: 'working',
    phase: 'implement',
    labels: ['pipenzo:working'],
    estimate: { lines: 40, files: 3, layered: false },
    taskType: 'feature',
    stack: { parentId: null, childIds: [], index: null },
    // Deliberately empty -- nothing hand-seeds this. If the dispatch path below did not populate
    // it, crash recovery's session-to-ticket index would have nothing to match against.
    attempts: [],
    budget: { tokensUsed: 0, limit: 0 },
    risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
    precommits: [],
    etags: {},
    ...overrides,
  };
}

const ok = (stdout = ''): GitCommandResult => ({ stdout, stderr: '', code: 0 });

/** Just enough for `ImplementOrchestrator.start()` to cut a branch; nothing here is asserted on. */
const runGit: PipenzoGitRunner = async (args) => {
  if (args[0] === 'rev-parse') return ok(`${BASE_SHA}\n`);
  if (args[0] === 'switch') return ok('');
  return ok();
};

const worktrees: ImplementWorktreeManager & { ownedLocation: (id: string) => unknown } = {
  preview: async () => ({ secretRisk: false, includeFiles: [] }),
  create: async () => ({
    id: WORKTREE_ID,
    workspaceId: 'a'.repeat(64),
    name: 'issue-201',
    displayPath: 'issue-201',
    status: 'ready' as const,
    createdAt: '2026-09-01T00:00:00.000Z',
  }),
  ownedLocation: (id: string) =>
    id === WORKTREE_ID ? { id, path: WORKTREE_PATH, sourcePath: REPO_PATH } : undefined,
};

const noCommands: GateCommandRunner = {
  available: async () => false,
  run: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', code: 0 }),
};

function buildService(machine: PipenzoPhaseMachine): PipenzoPhaseService {
  return new PipenzoPhaseService({
    refineSessions: {
      run: () => {
        throw new Error('not exercised by this test');
      },
    },
    reviewSessions: {
      run: () => {
        throw new Error('not exercised by this test');
      },
    },
    implementSessions: {
      // Dispatch-only, exactly like `DispatchOnlyPhaseSessions` -- returns a real session id and
      // nothing else, which is all `PipenzoPhaseService.implement()` has to work with at the point
      // it decides whether to record an attempt.
      run: async () => ({ sessionId: SESSION_ID }),
    },
    worktrees: worktrees as never,
    commands: noCommands,
    runGit,
    env: { PIPENZO_GITHUB_REPO: REPO },
    machine,
    logger: noopLogger,
  });
}

describe('Implement dispatch populating attempts[] (issue #201)', () => {
  it('appends a real attempt at dispatch time, which crash recovery then matches without hand-seeding', async () => {
    const directory = storeRoot();
    const tickets = new FileTicketStore(directory);
    tickets.create(makeTicket());

    const machine = new PipenzoPhaseMachine({ tickets });
    const service = buildService(machine);

    const result = await service.implement({
      spec: spec(),
      repositoryPath: REPO_PATH,
      provider: 'claude',
      ticketId: TICKET_ID,
    });
    expect(result.sessionId).toBe(SESSION_ID);

    // The property #201's own report named: a real entry, in the shape the schema and the
    // crash-recovery matching logic both expect -- not hand-seeded, not a stub.
    const stored = tickets.get(TICKET_ID);
    expect(stored?.attempts).toEqual([
      { sessionId: SESSION_ID, tier: 'mid', model: 'default', outcome: 'dispatched' },
    ]);

    // Now simulate the daemon dying mid-Implement: the session this dispatch just started is
    // reported interrupted, the same way `FileExecutionGraphStore`'s own recovery would report it.
    const recovery = new PipenzoCrashRecovery({
      tickets,
      executions: { get: () => undefined },
      sessions: { get: () => undefined },
      logger: noopLogger,
    });
    const report = recovery.park({
      interruptedSessionIds: [SESSION_ID],
      quarantinedTicketRecordCount: 0,
    });

    // Matched via `attempts[].sessionId` alone -- the index this test never seeded by hand.
    expect(report.unmatchedSessionCount).toBe(0);
    expect(report.parked).toHaveLength(1);
    expect(report.parked[0]).toMatchObject({
      ticketId: TICKET_ID,
      sessionId: SESSION_ID,
      lane: 'needs-human',
    });
    expect(tickets.get(TICKET_ID)?.lane).toBe('needs-human');
  });

  it('does not record an attempt, and crash recovery reports the session unmatched, when the dispatch carried no ticketId', async () => {
    const directory = storeRoot();
    const tickets = new FileTicketStore(directory);
    tickets.create(makeTicket());

    const machine = new PipenzoPhaseMachine({ tickets });
    const service = buildService(machine);

    await service.implement({ spec: spec(), repositoryPath: REPO_PATH, provider: 'claude' });

    expect(tickets.get(TICKET_ID)?.attempts).toEqual([]);

    const recovery = new PipenzoCrashRecovery({
      tickets,
      executions: { get: () => undefined },
      sessions: { get: () => undefined },
      logger: noopLogger,
    });
    const report = recovery.park({
      interruptedSessionIds: [SESSION_ID],
      quarantinedTicketRecordCount: 0,
    });

    expect(report.unmatchedSessionCount).toBe(1);
    expect(report.parked).toHaveLength(0);
    expect(tickets.get(TICKET_ID)?.lane).toBe('working');
  });

  it('records the caller-given tier and model instead of the walking-skeleton defaults', async () => {
    const directory = storeRoot();
    const tickets = new FileTicketStore(directory);
    tickets.create(makeTicket());

    const machine = new PipenzoPhaseMachine({ tickets });
    const service = buildService(machine);

    await service.implement({
      spec: spec(),
      repositoryPath: REPO_PATH,
      provider: 'claude',
      ticketId: TICKET_ID,
      model: 'claude-opus-4',
      tier: 'frontier',
    });

    expect(tickets.get(TICKET_ID)?.attempts).toEqual([
      { sessionId: SESSION_ID, tier: 'frontier', model: 'claude-opus-4', outcome: 'dispatched' },
    ]);
  });
});
