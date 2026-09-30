import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { PipenzoPhaseEventBus } from '../src/pipenzo-phase-events.js';
import { OwnedWorktreeManager } from '../src/worktree-manager.js';
import { runGitCommand } from '../src/pipenzo-git.js';

const TOKEN = 'test-token-pipenzo-tickets';
const TICKET_ID = '00000000-0000-4000-8000-000000000001';
const WORKTREE_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const REPO = 'jortega0033/pipenzo';
const REF = { owner: 'jortega0033', repo: 'pipenzo' };
const ISSUE_NUMBER = 78;
const WORKTREE_PATH = process.platform === 'win32' ? 'C:\\owned\\issue-78' : '/owned/issue-78';
const auth = { authorization: `Bearer ${TOKEN}` };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function storeDirectory(): string {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pipenzo-ticket-routes-'));
  temporaryDirectories.push(temporaryDirectory);
  return join(temporaryDirectory, 'tickets-v1');
}

function makeTicket(overrides: Partial<PipenzoTicketRecordV1> = {}): PipenzoTicketRecordV1 {
  return {
    schemaVersion: 1,
    ticketId: TICKET_ID,
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    lane: 'queued',
    phase: 'refine',
    labels: ['pipenzo:queued'],
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

/** A minimal, schema-valid Refine spec, for tickets that need a real `filesLikelyTouched` to
 * exercise the Working-lane concurrency report (issue #85). */
function spec(overrides: Partial<RefineSpecV1> = {}): RefineSpecV1 {
  return {
    schemaVersion: 1,
    issue: { repo: REPO, number: ISSUE_NUMBER, title: 'A ticket' },
    summary: 'A minimal spec for a route test.',
    acceptanceCriteria: [{ id: 'AC-1', kind: 'ubiquitous', text: 'The daemon shall do the thing' }],
    outOfScope: ['Everything else'],
    filesLikelyTouched: [],
    estimate: { changedLines: 10, filesTouched: 1, layered: false },
    openQuestions: [],
    ...overrides,
  };
}

function makeIssue(labels: readonly string[]): GitHubIssue {
  return {
    owner: REF.owner,
    repo: REF.repo,
    number: ISSUE_NUMBER,
    title: 'First-run empty',
    body: '',
    state: 'open',
    labels: [...labels],
    assignees: [],
    htmlUrl: `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    etag: undefined,
  };
}

function buildApp(options: {
  ticket?: Partial<PipenzoTicketRecordV1>;
  issueLabels?: readonly string[];
  withGitHub?: boolean;
  withEvents?: boolean;
  /** Issue #159: real when a test wants the abandonment-cleanup wiring exercised. */
  worktreeManager?: OwnedWorktreeManager;
} = {}) {
  const registry = new ProviderRegistry();
  const tickets = new FileTicketStore(storeDirectory());
  tickets.create(makeTicket(options.ticket));
  const github = new FakeGitHubClient().seedIssue(
    makeIssue(options.issueLabels ?? ['pipenzo:queued']),
  );
  const phaseEvents = options.withEvents === false ? undefined : new PipenzoPhaseEventBus();
  const phaseMachine = new PipenzoPhaseMachine({
    tickets,
    ...(options.withGitHub === false ? {} : { github: () => github }),
    ...(phaseEvents ? { events: phaseEvents } : {}),
  });
  return {
    github,
    tickets,
    phaseEvents,
    app: buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
      phaseMachine,
      ...(phaseEvents ? { phaseEvents } : {}),
      ...(options.worktreeManager
        ? { ticketStore: tickets, worktreeManager: options.worktreeManager }
        : {}),
    }),
  };
}

describe('GET /v2/pipenzo/tickets', () => {
  it('lists the local store state, with no GitHub call at all', async () => {
    const { app, github } = buildApp({ ticket: { title: 'Fix the board list route' } });

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/tickets', headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tickets: [{ ticketId: TICKET_ID, lane: 'queued', title: 'Fix the board list route' }],
    });
    expect(github.calls).toHaveLength(0);
  });

  it('omits the title field entirely when the record has never cached one', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/tickets', headers: auth });

    const body = response.json() as { tickets: Array<Record<string, unknown>> };
    expect(body.tickets[0]).not.toHaveProperty('title');
  });

  it('lists every ticket the store holds, not just one', async () => {
    const { app, tickets } = buildApp();
    tickets.create(
      makeTicket({
        ticketId: '00000000-0000-4000-8000-000000000002',
        issueNumber: 79,
        title: 'A second ticket',
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/tickets', headers: auth });

    const body = response.json() as { tickets: Array<{ ticketId: string }> };
    expect(body.tickets.map((ticket) => ticket.ticketId).sort()).toEqual(
      ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'].sort(),
    );
  });

  it('never puts a worktree filesystem path on the wire', async () => {
    const { app } = buildApp({
      ticket: { worktree: { id: WORKTREE_ID, path: WORKTREE_PATH, branch: 'issue-78' } },
    });

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/tickets', headers: auth });

    expect(response.body).not.toContain('issue-78\\');
    expect(response.body).not.toContain('/owned/');
    expect(response.body).not.toContain('owned');
  });

  it('rejects an unauthenticated request', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/tickets' });

    expect(response.statusCode).toBe(401);
  });
});

describe('GET /v2/pipenzo/tickets — Working lane concurrency (issue #85)', () => {
  it('reports the fixed capacity default alongside the ticket list', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/tickets', headers: auth });

    expect(response.json()).toMatchObject({ workingLaneCapacity: 2 });
  });

  it('marks a solitary Working ticket running, with no concurrency conflict', async () => {
    const { app } = buildApp({
      ticket: { lane: 'working', labels: ['pipenzo:working'], spec: spec({ filesLikelyTouched: ['a.ts'] }) },
    });

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/tickets', headers: auth });

    const body = response.json() as { tickets: Array<{ ticketId: string; concurrency?: unknown }> };
    expect(body.tickets[0]?.concurrency).toEqual({ state: 'running' });
  });

  it('holds the later-numbered ticket that overlaps a running one, naming the real ticket and file', async () => {
    const { app, tickets } = buildApp({
      ticket: {
        ticketId: '00000000-0000-4000-8000-000000000001',
        issueNumber: 94,
        lane: 'working',
        labels: ['pipenzo:working'],
        spec: spec({ issue: { repo: REPO, number: 94, title: 'A ticket' }, filesLikelyTouched: ['stdio-mcp-connection.ts'] }),
      },
    });
    tickets.create(
      makeTicket({
        ticketId: '00000000-0000-4000-8000-000000000002',
        issueNumber: 97,
        lane: 'working',
        labels: ['pipenzo:working'],
        spec: spec({
          issue: { repo: REPO, number: 97, title: 'Another ticket' },
          filesLikelyTouched: ['stdio-mcp-connection.ts', 'other.ts'],
        }),
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/tickets', headers: auth });

    const body = response.json() as {
      tickets: Array<{ issueNumber: number; concurrency?: Record<string, unknown> }>;
    };
    const held = body.tickets.find((ticket) => ticket.issueNumber === 97);
    expect(held?.concurrency).toEqual({
      state: 'held',
      overlapTicketId: '00000000-0000-4000-8000-000000000001',
      overlapIssueNumber: 94,
      overlapFile: 'stdio-mcp-connection.ts',
    });
  });

  it('never evaluates a ticket outside the Working lane, even one with an overlapping spec', async () => {
    const { app } = buildApp({
      ticket: { lane: 'queued', labels: ['pipenzo:queued'], spec: spec({ filesLikelyTouched: ['a.ts'] }) },
    });

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/tickets', headers: auth });

    const body = response.json() as { tickets: Array<{ concurrency?: unknown }> };
    expect(body.tickets[0]).not.toHaveProperty('concurrency');
  });
});

describe('POST /v2/pipenzo/tickets/read', () => {
  it('reconciles against the issue labels and reports agreement', async () => {
    // Title held equal to the fake issue's default (see makeIssue) so this test isolates label
    // agreement from the title-caching path a first read also exercises (issue #255).
    const { app } = buildApp({ ticket: { title: 'First-run empty' } });

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/read',
      headers: auth,
      payload: { ticketId: TICKET_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      divergence: 'none',
      changed: false,
      ticket: { ticketId: TICKET_ID, lane: 'queued' },
    });
  });

  it('lets the label win over a stale local lane', async () => {
    const { app } = buildApp({
      ticket: { lane: 'working', labels: ['pipenzo:working'] },
      issueLabels: ['pipenzo:needs-human'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/read',
      headers: auth,
      payload: { ticketId: TICKET_ID },
    });

    expect(response.json()).toMatchObject({
      divergence: 'lane_reconciled',
      previousLane: 'working',
      changed: true,
      ticket: { lane: 'needs-human' },
    });
  });

  it('never puts a worktree filesystem path on the wire', async () => {
    const { app } = buildApp({
      ticket: {
        worktree: { id: WORKTREE_ID, path: WORKTREE_PATH, branch: 'issue-78' },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/read',
      headers: auth,
      payload: { ticketId: TICKET_ID },
    });

    const body = response.json() as { ticket: { worktree?: Record<string, unknown> } };
    expect(body.ticket.worktree).toEqual({ id: WORKTREE_ID, branch: 'issue-78' });
    // The whole payload, not just the worktree object -- a path must not appear anywhere on it.
    expect(response.body).not.toContain('issue-78\\');
    expect(response.body).not.toContain('/owned/');
    expect(response.body).not.toContain('owned');
  });

  it('answers 404 for an unknown ticket', async () => {
    const { app } = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/read',
      headers: auth,
      payload: { ticketId: '00000000-0000-4000-8000-00000000dead' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'ticket_not_found' });
  });

  it('answers 412 when no GitHub credential is configured', async () => {
    const { app } = buildApp({ withGitHub: false });

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/read',
      headers: auth,
      payload: { ticketId: TICKET_ID },
    });

    expect(response.statusCode).toBe(412);
    expect(response.json()).toMatchObject({ code: 'token_missing' });
  });

  it('rejects an unauthenticated request', async () => {
    const { app } = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/read',
      payload: { ticketId: TICKET_ID },
    });

    expect(response.statusCode).toBe(401);
  });

  it('never echoes a rejected body', async () => {
    const { app } = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/read',
      headers: auth,
      payload: { ticketId: 'not-a-uuid', smuggled: 'echo-me-back' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('echo-me-back');
    expect(response.body).not.toContain('not-a-uuid');
  });
});

describe('POST /v2/pipenzo/tickets/transition', () => {
  it('writes the label and reports the resulting lane', async () => {
    const { app, github, tickets } = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/transition',
      headers: auth,
      payload: { ticketId: TICKET_ID, label: 'pipenzo:working' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ticket: { lane: 'working' }, changed: true });
    expect(tickets.get(TICKET_ID)?.lane).toBe('working');
    const issue = await github.getIssue(REF, ISSUE_NUMBER);
    expect(issue.labels).toContain('pipenzo:working');
    // The schema marker survives a namespace-replacing write.
    expect(issue.labels).toContain('pipenzo:schema-v1');
  });

  it('answers 409 for an illegal transition', async () => {
    const { app, github } = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/transition',
      headers: auth,
      payload: { ticketId: TICKET_ID, label: 'pipenzo:ready-for-review' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'illegal_transition' });
    expect(github.calls.filter((call) => call.method === 'setIssueLabels')).toHaveLength(0);
  });

  it('rejects the schema marker as a transition target', async () => {
    const { app, github } = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/transition',
      headers: auth,
      payload: { ticketId: TICKET_ID, label: 'pipenzo:schema-v1' },
    });

    expect(response.statusCode).toBe(400);
    expect(github.calls.filter((call) => call.method === 'setIssueLabels')).toHaveLength(0);
  });

  it('rejects a label outside the vocabulary', async () => {
    const { app } = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/transition',
      headers: auth,
      payload: { ticketId: TICKET_ID, label: 'bug' },
    });

    expect(response.statusCode).toBe(400);
  });
});

/**
 * Real `git` subprocess spawns dominate this block's cost, matching `worktree-routes.test.ts`'s own
 * measured budget for the same reason: a process spawn on Windows costs 100-300 ms before the
 * command runs, and each body here drives a real `git init`, `git worktree add` and `git checkout`.
 */
const GIT_HEAVY_TIMEOUT_MS = 45_000;
const run = promisify(execFile);

describe('POST /v2/pipenzo/tickets/transition worktree cleanup (issue #159)', () => {
  const gitTempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      gitTempDirectories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
    );
  });

  /** One real repo, one real owned worktree checked out onto a real branch. */
  async function realWorktree(): Promise<{
    repo: string;
    branch: string;
    worktreeManager: OwnedWorktreeManager;
    worktreeId: string;
    worktreePath: string;
  }> {
    const base = await mkdtemp(join(tmpdir(), 'pipenzo-ticket-routes-git-'));
    gitTempDirectories.push(base);
    const repo = join(base, 'repo');
    await mkdir(repo, { recursive: true });
    await run('git', ['init'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), 'fixture');
    await run('git', ['add', 'README.md'], { cwd: repo });
    await run(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'],
      { cwd: repo },
    );
    const worktreeManager = new OwnedWorktreeManager(join(base, 'owned'), join(base, 'worktrees.json'));
    await worktreeManager.load();
    const created = await worktreeManager.create({
      cwd: repo,
      name: 'ticket',
      confirmIncludeCopy: true,
    });
    const location = worktreeManager.ownedLocation(created.id);
    if (!location) throw new Error('expected the freshly created worktree to resolve');
    const branch = `issue-${ISSUE_NUMBER}`;
    await run('git', ['checkout', '-b', branch], { cwd: location.path });
    return { repo, branch, worktreeManager, worktreeId: created.id, worktreePath: location.path };
  }

  it(
    'cleans up the worktree and sweeps its branch on an abandonment (working -> queued)',
    async () => {
      const { repo, branch, worktreeManager, worktreeId, worktreePath } = await realWorktree();
      const { app, tickets } = buildApp({
        ticket: {
          lane: 'working',
          labels: ['pipenzo:working'],
          worktree: { id: worktreeId, path: worktreePath, branch },
        },
        issueLabels: ['pipenzo:working'],
        worktreeManager,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/transition',
        headers: auth,
        payload: { ticketId: TICKET_ID, label: 'pipenzo:queued' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ticket: { lane: 'queued' } });
      expect(tickets.get(TICKET_ID)?.worktree).toBeUndefined();

      const owned = await worktreeManager.list();
      expect(owned.find((entry) => entry.id === worktreeId)?.status ?? 'missing').toBe('missing');
      const branches = await runGitCommand(['branch', '--list', branch], repo);
      expect(branches.stdout.trim()).toBe('');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'retains a dirty worktree instead of deleting it, and keeps the ticket’s record of it',
    async () => {
      const { repo, branch, worktreeManager, worktreeId, worktreePath } = await realWorktree();
      await writeFile(join(worktreePath, 'README.md'), 'agent edit, never committed');
      const { app, tickets } = buildApp({
        ticket: {
          lane: 'ready-for-review',
          labels: ['pipenzo:ready-for-review'],
          worktree: { id: worktreeId, path: worktreePath, branch },
        },
        issueLabels: ['pipenzo:ready-for-review'],
        worktreeManager,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/transition',
        headers: auth,
        payload: { ticketId: TICKET_ID, label: 'pipenzo:queued' },
      });

      expect(response.statusCode).toBe(200);
      expect(tickets.get(TICKET_ID)?.worktree).toEqual({ id: worktreeId, path: worktreePath, branch });
      const owned = await worktreeManager.list();
      expect(owned.find((entry) => entry.id === worktreeId)?.status).toBe('dirty');
      const branches = await runGitCommand(['branch', '--list', branch], repo);
      expect(branches.stdout.trim()).not.toBe('');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'does not clean up on a transition that is not an abandonment',
    async () => {
      const { worktreeManager, worktreeId, worktreePath } = await realWorktree();
      const { app, tickets } = buildApp({
        ticket: {
          lane: 'working',
          labels: ['pipenzo:working'],
          worktree: { id: worktreeId, path: worktreePath, branch: `issue-${ISSUE_NUMBER}` },
        },
        issueLabels: ['pipenzo:working'],
        worktreeManager,
      });

      // working -> ready-for-review is a real, legal transition, but not the abandonment pattern
      // (`working`/`ready-for-review` landing on `queued`) this cleanup is scoped to.
      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/transition',
        headers: auth,
        payload: { ticketId: TICKET_ID, label: 'pipenzo:ready-for-review' },
      });

      expect(response.statusCode).toBe(200);
      expect(tickets.get(TICKET_ID)?.worktree).toEqual({
        id: worktreeId,
        path: worktreePath,
        branch: `issue-${ISSUE_NUMBER}`,
      });
      const owned = await worktreeManager.list();
      expect(owned.find((entry) => entry.id === worktreeId)?.status).toBe('ready');
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});

/**
 * The phase stream (#189).
 *
 * The rejection paths reply normally and are tested with `inject` like every other route here. The
 * streaming path cannot be: `inject` resolves when the response ends, and this stream deliberately
 * has no terminal event -- a board stream ends when the subscriber disconnects, not when some event
 * arrives. So the happy path runs against a real listening socket and closes the read itself.
 */
describe('GET /v2/pipenzo/tickets/events', () => {
  it('refuses a Last-Event-ID that is not a plain sequence, rather than coercing it', async () => {
    const { app } = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/v2/pipenzo/tickets/events',
      headers: { ...auth, 'last-event-id': 'not-a-number' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_last_event_id' });
  });

  it('refuses a cursor the bounded window no longer holds, and reports the window', async () => {
    const { app, phaseEvents } = buildApp();

    // Nothing has been published, so "everything after sequence 9" is a gap, not an empty tail.
    const response = await app.inject({
      method: 'GET',
      url: '/v2/pipenzo/tickets/events',
      headers: { ...auth, 'last-event-id': '9' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'replay_gap',
      details: phaseEvents!.replayWindow(),
    });
  });

  it('is not registered at all when the daemon was built without a bus', async () => {
    const { app } = buildApp({ withEvents: false });

    const response = await app.inject({
      method: 'GET',
      url: '/v2/pipenzo/tickets/events',
      headers: auth,
    });

    expect(response.statusCode).toBe(404);
  });

  it('requires the bearer token like every other route on this surface', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/v2/pipenzo/tickets/events' });

    expect(response.statusCode).toBe(401);
  });

  it('replays the retained window and then streams a live transition', async () => {
    const { app, phaseEvents } = buildApp();
    // Published before anyone subscribes, so one connection covers both replay and live delivery.
    phaseEvents!.publish({
      ticketId: TICKET_ID,
      fromLane: 'queued',
      toLane: 'working',
      phase: 'implement',
      labels: ['pipenzo:working'],
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const controller = new AbortController();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/v2/pipenzo/tickets/events`, {
        headers: auth,
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      const readUntil = async (predicate: (text: string) => boolean): Promise<void> => {
        while (!predicate(buffered)) {
          const { value, done } = await reader.read();
          if (done) return;
          buffered += decoder.decode(value, { stream: true });
        }
      };

      await readUntil((text) => text.includes('id: 0'));
      expect(buffered).toContain('event: ticket.phase_changed');

      await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/transition',
        headers: auth,
        payload: { ticketId: TICKET_ID, label: 'pipenzo:needs-human' },
      });
      await readUntil((text) => text.includes('id: 1'));

      const frames = buffered
        .split('\n\n')
        .filter((frame) => frame.includes('data: '))
        .map(
          (frame) => JSON.parse(frame.split('data: ')[1]!) as { sequence: number; toLane: string },
        );
      expect(frames.map((frame) => frame.sequence)).toEqual([0, 1]);
      expect(frames[1]!.toLane).toBe('needs-human');

      await reader.cancel().catch(() => undefined);
    } finally {
      controller.abort();
      await app.close();
    }
  }, 15_000);
});
