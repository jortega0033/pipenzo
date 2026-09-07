import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import type {
  AgentSession,
  AgentSessionV2,
  CapabilitySelection,
  PipenzoTicketRecordV1,
} from '@agent-dock/shared';
import { GitHubClientError } from '../src/github-client.js';
import type { GitHubIssue } from '../src/github-client.js';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import type { DurableExecutionRecord } from '../src/execution-graph-store.js';
import type { ProviderContinuationScope } from '../src/provider-v2.js';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';
import { PipenzoPhaseMachine } from '../src/pipenzo-phase-machine.js';
import { PipenzoPhaseEventBus } from '../src/pipenzo-phase-events.js';
import {
  PipenzoCrashRecovery,
  type RecoveryCompatSessionLookup,
  type RecoveryExecutionLookup,
} from '../src/pipenzo-crash-recovery.js';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';

const TOKEN = 'test-token-pipenzo-recovery';
const TICKET_ID = '00000000-0000-4000-8000-0000000001aa';
const OTHER_TICKET_ID = '00000000-0000-4000-8000-0000000001bb';
const WORKTREE_ID = '11111111-2222-4333-8444-555555555555';
const REPO = 'jortega0033/pipenzo';
const REF = { owner: 'jortega0033', repo: 'pipenzo' };
const ISSUE_NUMBER = 190;
const SESSION_ID = 'session-crashed-mid-implement';
const WORKTREE_PATH = process.platform === 'win32' ? 'C:\\owned\\issue-190' : '/owned/issue-190';
const auth = { authorization: `Bearer ${TOKEN}` };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function storeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pipenzo-crash-recovery-'));
  temporaryDirectories.push(root);
  return join(root, 'tickets-v1');
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
    worktree: { id: WORKTREE_ID, path: WORKTREE_PATH, branch: 'issue-190' },
    attempts: [
      { sessionId: SESSION_ID, tier: 'mid', model: 'claude-sonnet', outcome: 'dispatched' },
    ],
    budget: { tokensUsed: 1_200, limit: 0 },
    risk: { score: 3, lastResetAt: '2026-01-01T00:00:00.000Z' },
    precommits: [],
    etags: {},
    ...overrides,
  };
}

function makeIssue(labels: readonly string[]): GitHubIssue {
  return {
    owner: REF.owner,
    repo: REF.repo,
    number: ISSUE_NUMBER,
    title: 'Crash recovery',
    body: '',
    state: 'open',
    labels: [...labels],
    assignees: [],
    htmlUrl: `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    etag: undefined,
  };
}

const selection: CapabilitySelection = {
  transport: 'fake-v2',
  enabled: [],
  unavailableOptional: [],
  possibleEffects: [],
  effectsComplete: true,
};

const continuationScope: ProviderContinuationScope = {
  provider: 'claude',
  cwd: '/workspace',
  executablePath: '/usr/bin/claude',
  providerVersion: '1.0.0',
  authenticated: 'authenticated',
  authSource: 'claude_subscription',
  accountFingerprint: 'fingerprint',
  selectedModel: 'claude-sonnet',
  workspaceTrust: {
    state: 'trusted',
    workspaceId: 'workspace',
    incarnation: 'incarnation',
    trustEpoch: 1,
  },
};

function interruptedSession(overrides: Partial<AgentSessionV2> = {}): AgentSessionV2 {
  const executionId = randomUUID();
  return {
    id: SESSION_ID,
    provider: 'claude',
    transport: 'fake-v2',
    cwd: '/workspace',
    status: 'interrupted',
    selection,
    executionId,
    rootExecutionId: executionId,
    continuationKind: 'fresh',
    acceptedWork: 'not_accepted',
    startedAt: '2026-09-01T07:59:00.000Z',
    completedAt: '2026-09-01T08:00:00.000Z',
    terminalReason: 'daemon_restart',
    earliestSequence: 0,
    ...overrides,
  };
}

/**
 * The execution-graph half of the lookup, plus a spy for every method that could start or continue
 * a session. Recovery is not given a `SessionManager` at all, and these are here so the "never
 * auto-resumes" test asserts on something concrete rather than on the absence of an import.
 */
interface SpyingExecutionLookup extends RecoveryExecutionLookup {
  readonly dispatches: string[];
  reserve(): void;
  update(): void;
  acquireContinuation(): void;
}

function executions(records: Record<string, DurableExecutionRecord>): SpyingExecutionLookup {
  const dispatches: string[] = [];
  return {
    dispatches,
    get: (sessionId: string) => records[sessionId],
    // Present only to be caught being called. `PipenzoCrashRecovery`'s dependency type is
    // `Pick<ExecutionGraphStore, 'get'>`, so nothing it holds can legally reach these -- which is
    // the point: a future edit that reached for one would have to widen the type first.
    reserve: () => void dispatches.push('reserve'),
    update: () => void dispatches.push('update'),
    acquireContinuation: () => void dispatches.push('acquireContinuation'),
  };
}

function compatSessions(records: Record<string, AgentSession>): RecoveryCompatSessionLookup {
  return { get: (sessionId: string) => records[sessionId] };
}

interface HarnessOptions {
  ticket?: Partial<PipenzoTicketRecordV1> | null;
  extraTickets?: PipenzoTicketRecordV1[];
  issueLabels?: readonly string[];
  execution?: DurableExecutionRecord | null;
  compat?: AgentSession | null;
  withMachine?: boolean;
  /** A corrupt file dropped into `records/` before the store loads, to force a quarantine. */
  corruptRecord?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const directory = storeRoot();
  if (options.corruptRecord) {
    mkdirSync(join(directory, 'records'), { recursive: true });
    writeFileSync(join(directory, 'records', `${OTHER_TICKET_ID}.json`), '{ not json');
  }
  const tickets = new FileTicketStore(directory);
  if (options.ticket !== null) tickets.create(makeTicket(options.ticket ?? {}));
  for (const extra of options.extraTickets ?? []) tickets.create(extra);

  const github = new FakeGitHubClient().seedIssue(
    makeIssue(options.issueLabels ?? ['pipenzo:working']),
  );
  const events = new PipenzoPhaseEventBus();
  const machine = new PipenzoPhaseMachine({ tickets, github: () => github, events });
  const graph = executions(
    options.execution === null || options.execution === undefined
      ? {}
      : { [SESSION_ID]: options.execution },
  );
  const recovery = new PipenzoCrashRecovery({
    tickets,
    executions: graph,
    sessions: compatSessions(
      options.compat === null || options.compat === undefined ? {} : { [SESSION_ID]: options.compat },
    ),
    logger: noopLogger,
    ...(options.withMachine === false ? {} : { machine }),
    events,
  });
  return {
    tickets,
    github,
    events,
    graph,
    recovery,
    quarantined: tickets.getRecoveryReport().quarantinedFiles.length,
  };
}

describe('PipenzoCrashRecovery.park', () => {
  it('resolves an interrupted session to its ticket and parks it in needs-human', () => {
    const { tickets, recovery } = harness();

    const report = recovery.park({
      interruptedSessionIds: [SESSION_ID],
      quarantinedTicketRecordCount: 0,
    });

    expect(report.interruptedSessionCount).toBe(1);
    expect(report.unmatchedSessionCount).toBe(0);
    expect(report.parked).toHaveLength(1);
    expect(report.parked[0]).toMatchObject({
      ticketId: TICKET_ID,
      sessionId: SESSION_ID,
      lane: 'needs-human',
      phase: 'implement',
      labelWrite: 'pending',
    });
    expect(report.parked[0]?.labels).toContain('pipenzo:interrupted');
    expect(report.parked[0]?.labels).not.toContain('pipenzo:working');

    const stored = tickets.get(TICKET_ID);
    expect(stored?.lane).toBe('needs-human');
    expect(stored?.labels).toContain('pipenzo:interrupted');
  });

  it('keeps the last completed phase and the worktree, without putting the path on the report', () => {
    const { tickets, recovery } = harness();

    const report = recovery.park({
      interruptedSessionIds: [SESSION_ID],
      quarantinedTicketRecordCount: 0,
    });

    // The daemon still needs the real path to find the worktree it owns...
    expect(tickets.get(TICKET_ID)?.worktree?.path).toBe(WORKTREE_PATH);
    // ...and the surface the desktop reads addresses it by id, exactly like the ticket routes.
    expect(report.parked[0]?.worktree).toEqual({ id: WORKTREE_ID, branch: 'issue-190' });
    expect(JSON.stringify(report)).not.toContain(WORKTREE_PATH);
    expect(report.parked[0]?.phase).toBe('implement');
  });

  it('deduplicates a session id reported by both stores', () => {
    const { recovery } = harness();

    const report = recovery.park({
      interruptedSessionIds: [SESSION_ID, SESSION_ID],
      quarantinedTicketRecordCount: 0,
    });

    expect(report.interruptedSessionCount).toBe(1);
    expect(report.parked).toHaveLength(1);
  });

  it('counts an interrupted session with no matching ticket instead of failing on it', () => {
    const { tickets, recovery } = harness();

    const report = recovery.park({
      interruptedSessionIds: ['a-plain-agentdock-session', SESSION_ID],
      quarantinedTicketRecordCount: 0,
    });

    expect(report.unmatchedSessionCount).toBe(1);
    expect(report.parked.map((entry) => entry.ticketId)).toEqual([TICKET_ID]);
    expect(tickets.get(TICKET_ID)?.lane).toBe('needs-human');
  });

  it('retains a condition label and the schema marker across the park', () => {
    const { recovery } = harness({
      ticket: { labels: ['pipenzo:working', 'pipenzo:ci-failed', 'pipenzo:schema-v1'] },
    });

    const report = recovery.park({
      interruptedSessionIds: [SESSION_ID],
      quarantinedTicketRecordCount: 0,
    });

    expect(report.parked[0]?.labels).toEqual(
      expect.arrayContaining(['pipenzo:interrupted', 'pipenzo:ci-failed', 'pipenzo:schema-v1']),
    );
    expect(report.parked[0]?.labels).not.toContain('pipenzo:working');
  });

  it('announces the lane move on the phase stream', () => {
    const { events, recovery } = harness();

    recovery.park({ interruptedSessionIds: [SESSION_ID], quarantinedTicketRecordCount: 0 });

    expect(events.retained).toHaveLength(1);
    expect(events.retained[0]).toMatchObject({
      type: 'ticket.phase_changed',
      ticketId: TICKET_ID,
      fromLane: 'working',
      toLane: 'needs-human',
      phase: 'implement',
    });
    expect(events.retained[0]?.labels).toContain('pipenzo:interrupted');
  });

  it('parks a ticket whose store also had to quarantine a torn record on the same start', () => {
    const { tickets, recovery, quarantined } = harness({ corruptRecord: true });

    // The store's own recovery ran and repaired something; the two reports have to compose.
    expect(quarantined).toBe(1);

    const report = recovery.park({
      interruptedSessionIds: [SESSION_ID],
      quarantinedTicketRecordCount: quarantined,
    });

    expect(report.quarantinedTicketRecordCount).toBe(1);
    expect(report.parked).toHaveLength(1);
    expect(tickets.get(TICKET_ID)?.lane).toBe('needs-human');
  });

  it('never resumes or retries the interrupted session', async () => {
    const { graph, github, recovery } = harness({
      execution: { session: interruptedSession({ providerSessionId: 'thread-1' }), interactive: true, continuationScope },
    });

    recovery.park({ interruptedSessionIds: [SESSION_ID], quarantinedTicketRecordCount: 0 });
    await recovery.writeLabels();

    // Nothing dispatched, continued, or re-reserved -- the only GitHub traffic is the label write
    // and the read the phase machine does to reconcile before it.
    expect(graph.dispatches).toEqual([]);
    expect(github.calls.map((call) => call.method).sort()).toEqual(['getIssue', 'setIssueLabels']);
  });
});

describe('PipenzoCrashRecovery resumability', () => {
  it('offers resume only when a providerSessionId and a continuationScope both exist', () => {
    const { recovery } = harness({
      execution: {
        session: interruptedSession({ providerSessionId: 'thread-1' }),
        interactive: true,
        continuationScope,
      },
    });

    const report = recovery.park({
      interruptedSessionIds: [SESSION_ID],
      quarantinedTicketRecordCount: 0,
    });

    expect(report.parked[0]?.resumable).toBe(true);
  });

  it('refuses resume when the continuation scope is missing', () => {
    const { recovery } = harness({
      execution: { session: interruptedSession({ providerSessionId: 'thread-1' }), interactive: true },
    });

    const report = recovery.park({
      interruptedSessionIds: [SESSION_ID],
      quarantinedTicketRecordCount: 0,
    });

    expect(report.parked[0]?.resumable).toBe(false);
  });

  it('refuses resume when no provider session id was ever reported', () => {
    const { recovery } = harness({
      execution: { session: interruptedSession(), interactive: true, continuationScope },
    });

    const report = recovery.park({
      interruptedSessionIds: [SESSION_ID],
      quarantinedTicketRecordCount: 0,
    });

    expect(report.parked[0]?.resumable).toBe(false);
  });

  it('falls back to the v1 compatibility record for the provider session id', () => {
    const { recovery } = harness({
      execution: { session: interruptedSession(), interactive: true, continuationScope },
      compat: {
        id: SESSION_ID,
        provider: 'claude',
        cwd: '/workspace',
        prompt: 'implement',
        status: 'failed',
        providerSessionId: 'thread-1',
        startedAt: '2026-09-01T07:59:00.000Z',
      },
    });

    const report = recovery.park({
      interruptedSessionIds: [SESSION_ID],
      quarantinedTicketRecordCount: 0,
    });

    expect(report.parked[0]?.resumable).toBe(true);
  });

  it('refuses resume when the execution record itself was quarantined', () => {
    const { recovery } = harness({ execution: null });

    const report = recovery.park({
      interruptedSessionIds: [SESSION_ID],
      quarantinedTicketRecordCount: 0,
    });

    // The ticket still parks: a session whose record did not survive is the case a human most needs
    // told about, not the case to drop.
    expect(report.parked).toHaveLength(1);
    expect(report.parked[0]?.resumable).toBe(false);
  });
});

describe('PipenzoCrashRecovery.writeLabels', () => {
  it('writes pipenzo:interrupted to the issue and reports the write', async () => {
    const { github, recovery } = harness();

    recovery.park({ interruptedSessionIds: [SESSION_ID], quarantinedTicketRecordCount: 0 });
    const report = await recovery.writeLabels();

    expect(report.parked[0]?.labelWrite).toBe('written');
    const write = github.calls.find((call) => call.method === 'setIssueLabels');
    expect(write?.key).toContain('pipenzo:interrupted');
  });

  it('does not throw, and does not undo the local park, when GitHub refuses the write', async () => {
    const { github, tickets, recovery } = harness();
    github.failNext('setIssueLabels', new GitHubClientError('rate_limited', 'rate limited'));

    recovery.park({ interruptedSessionIds: [SESSION_ID], quarantinedTicketRecordCount: 0 });
    const report = await recovery.writeLabels();

    expect(report.parked[0]?.labelWrite).toBe('failed');
    expect(tickets.get(TICKET_ID)?.lane).toBe('needs-human');
    expect(tickets.get(TICKET_ID)?.labels).toContain('pipenzo:interrupted');
  });

  it('does not throw when GitHub is unreachable before the write is even attempted', async () => {
    const { github, tickets, recovery } = harness();
    github.failNext('getIssue', new GitHubClientError('network', 'network unreachable'));

    recovery.park({ interruptedSessionIds: [SESSION_ID], quarantinedTicketRecordCount: 0 });
    const report = await recovery.writeLabels();

    expect(report.parked[0]?.labelWrite).toBe('failed');
    expect(tickets.get(TICKET_ID)?.lane).toBe('needs-human');
  });

  it('leaves every parked ticket pending when no GitHub client is configured', async () => {
    const { tickets, recovery } = harness({ withMachine: false });

    recovery.park({ interruptedSessionIds: [SESSION_ID], quarantinedTicketRecordCount: 0 });
    const report = await recovery.writeLabels();

    expect(report.parked[0]?.labelWrite).toBe('pending');
    expect(tickets.get(TICKET_ID)?.lane).toBe('needs-human');
  });

  it('keeps going after one ticket fails, so one bad issue cannot strand the rest', async () => {
    const other: PipenzoTicketRecordV1 = makeTicket({
      ticketId: OTHER_TICKET_ID,
      // No issue is seeded for this number, so the phase machine's read fails on it.
      issueNumber: 4_242,
      attempts: [
        { sessionId: 'session-two', tier: 'mid', model: 'claude-sonnet', outcome: 'dispatched' },
      ],
    });
    const { recovery } = harness({ extraTickets: [other] });

    recovery.park({
      interruptedSessionIds: ['session-two', SESSION_ID],
      quarantinedTicketRecordCount: 0,
    });
    const report = await recovery.writeLabels();

    const byTicket = new Map(report.parked.map((entry) => [entry.ticketId, entry.labelWrite]));
    expect(byTicket.get(OTHER_TICKET_ID)).toBe('failed');
    expect(byTicket.get(TICKET_ID)).toBe('written');
  });
});

describe('GET /v2/pipenzo/recovery', () => {
  function buildApp(options: HarnessOptions = {}) {
    const built = harness(options);
    const registry = new ProviderRegistry();
    return {
      ...built,
      app: buildServer({
        registry,
        sessionManager: new SessionManager(registry, noopLogger),
        token: TOKEN,
        logger: noopLogger,
        crashRecovery: built.recovery,
      }),
    };
  }

  it('serves the parked set', async () => {
    const { app, recovery } = buildApp();
    recovery.park({ interruptedSessionIds: [SESSION_ID], quarantinedTicketRecordCount: 0 });

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/recovery', headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: 1,
      interruptedSessionCount: 1,
      unmatchedSessionCount: 0,
      parked: [{ ticketId: TICKET_ID, lane: 'needs-human', labelWrite: 'pending' }],
    });
  });

  it('answers an empty report when nothing was interrupted', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/recovery', headers: auth });

    expect(response.json()).toMatchObject({ interruptedSessionCount: 0, parked: [] });
  });

  it('requires the bearer token', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/recovery' });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a request carrying an Origin header', async () => {
    const { app } = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/v2/pipenzo/recovery',
      headers: { ...auth, origin: 'https://example.com' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('never puts a worktree filesystem path on the wire', async () => {
    const { app, recovery } = buildApp();
    recovery.park({ interruptedSessionIds: [SESSION_ID], quarantinedTicketRecordCount: 0 });

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/recovery', headers: auth });

    expect(response.body).not.toContain(WORKTREE_PATH);
    expect(response.json().parked[0].worktree).toEqual({ id: WORKTREE_ID, branch: 'issue-190' });
  });
});
