import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import type { PipenzoTicketRecordV1 } from '@agent-dock/shared';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import type { GitHubIssue } from '../src/github-client.js';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';
import { PipenzoPhaseMachine } from '../src/pipenzo-phase-machine.js';
import { OwnedWorktreeManager } from '../src/worktree-manager.js';
import { MediumApprovalStore } from '../src/medium-approval-store.js';

const TOKEN = 'test-token-medium-approval';
const TICKET_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_TICKET_ID = '00000000-0000-4000-8000-000000000002';
const REPO = 'jortega0033/pipenzo';
const ISSUE_NUMBER = 97;
const auth = { authorization: `Bearer ${TOKEN}` };

const GIT_HEAVY_TIMEOUT_MS = 45_000;
const run = promisify(execFile);
const gitTempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    gitTempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

function makeTicket(overrides: Partial<PipenzoTicketRecordV1> = {}): PipenzoTicketRecordV1 {
  return {
    schemaVersion: 1,
    ticketId: TICKET_ID,
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    lane: 'working',
    phase: 'implement',
    labels: ['pipenzo:working'],
    estimate: { lines: 0, files: 0, layered: false },
    taskType: 'chore',
    stack: { parentId: null, childIds: [], index: null },
    attempts: [],
    budget: { tokensUsed: 0, limit: 0 },
    risk: { score: 8, lastResetAt: '2026-01-01T00:00:00.000Z', pendingPromotion: false },
    precommits: [],
    etags: {},
    ...overrides,
  };
}

function makeIssue(): GitHubIssue {
  return {
    owner: 'jortega0033',
    repo: 'pipenzo',
    number: ISSUE_NUMBER,
    title: 'MEDIUM inline approval flow',
    body: '',
    state: 'open',
    labels: ['pipenzo:working'],
    assignees: [],
    htmlUrl: `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    etag: undefined,
  };
}

/** One real repo, one real owned worktree on a real branch -- same shape
 * `pipenzo-ticket-routes.test.ts`'s own `realWorktree()` uses, for the same reason: `capture`
 * genuinely spawns `git rev-parse HEAD` and reads real files under `location.path`. */
async function realWorktree(): Promise<{
  worktreeManager: OwnedWorktreeManager;
  worktreeId: string;
  worktreePath: string;
  branch: string;
}> {
  const base = await mkdtemp(join(tmpdir(), 'pipenzo-medium-approval-git-'));
  gitTempDirectories.push(base);
  const repo = join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await run('git', ['init'], { cwd: repo });
  await writeFile(join(repo, 'a.txt'), 'before\n');
  await run('git', ['add', 'a.txt'], { cwd: repo });
  await run(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'],
    { cwd: repo },
  );
  const worktreeManager = new OwnedWorktreeManager(join(base, 'owned'), join(base, 'worktrees.json'));
  await worktreeManager.load();
  const created = await worktreeManager.create({ cwd: repo, name: 'ticket', confirmIncludeCopy: true });
  const location = worktreeManager.ownedLocation(created.id);
  if (!location) throw new Error('expected the freshly created worktree to resolve');
  const branch = `issue-${ISSUE_NUMBER}`;
  await run('git', ['checkout', '-b', branch], { cwd: location.path });
  return { worktreeManager, worktreeId: created.id, worktreePath: location.path, branch };
}

function storeDirectory(base: string): string {
  return join(base, 'tickets-v1');
}

async function buildApp(options: {
  ticket?: Partial<PipenzoTicketRecordV1>;
  worktreeManager?: OwnedWorktreeManager;
} = {}) {
  const base = await mkdtemp(join(tmpdir(), 'pipenzo-medium-approval-store-'));
  gitTempDirectories.push(base);
  const registry = new ProviderRegistry();
  const tickets = new FileTicketStore(storeDirectory(base));
  tickets.create(makeTicket(options.ticket));
  const github = new FakeGitHubClient().seedIssue(makeIssue());
  const phaseMachine = new PipenzoPhaseMachine({ tickets, github: () => github });
  const mediumApprovalStore = new MediumApprovalStore();
  const worktreeManager = options.worktreeManager ?? new OwnedWorktreeManager(join(base, 'owned'), join(base, 'worktrees.json'));
  await worktreeManager.load();
  return {
    tickets,
    mediumApprovalStore,
    app: buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
      phaseMachine,
      worktreeManager,
      mediumApprovalStore,
    }),
  };
}

describe('POST /v2/pipenzo/tickets/risk/medium-approval/capture', () => {
  it(
    'captures a real snapshot when worktreeId matches the ticket\'s recorded worktree',
    async () => {
      const { worktreeManager, worktreeId, branch } = await realWorktree();
      const { app } = await buildApp({
        ticket: { worktree: { id: worktreeId, path: 'ignored', branch } },
        worktreeManager,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/medium-approval/capture',
        headers: auth,
        payload: { ticketId: TICKET_ID, worktreeId, branch, touchedPaths: ['a.txt'] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ snapshotId: expect.any(String) });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses when worktreeId is not the one recorded against this ticket',
    async () => {
      const { worktreeManager, worktreeId, branch } = await realWorktree();
      const { app } = await buildApp({
        ticket: { worktree: { id: '99999999-0000-4000-8000-000000000000', path: 'ignored', branch } },
        worktreeManager,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/medium-approval/capture',
        headers: auth,
        payload: { ticketId: TICKET_ID, worktreeId, branch, touchedPaths: [] },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'ticket_not_found' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it('refuses for a ticket with no worktree recorded at all', async () => {
    const { app } = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/risk/medium-approval/capture',
      headers: auth,
      payload: {
        ticketId: TICKET_ID,
        worktreeId: '99999999-0000-4000-8000-000000000000',
        branch: 'main',
        touchedPaths: [],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'ticket_not_found' });
  });

  it('answers worktree_not_found when the ticket agrees but the worktree manager does not know it', async () => {
    const worktreeId = '11111111-0000-4000-8000-000000000000';
    const emptyBase = await mkdtemp(join(tmpdir(), 'pipenzo-medium-approval-empty-'));
    gitTempDirectories.push(emptyBase);
    const worktreeManager = new OwnedWorktreeManager(join(emptyBase, 'owned'), join(emptyBase, 'worktrees.json'));
    await worktreeManager.load();
    const { app } = await buildApp({
      ticket: { worktree: { id: worktreeId, path: 'ignored', branch: 'main' } },
      worktreeManager,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/risk/medium-approval/capture',
      headers: auth,
      payload: { ticketId: TICKET_ID, worktreeId, branch: 'main', touchedPaths: [] },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'worktree_not_found' });
  });

  it('rejects a malformed body rather than echoing it back', async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/risk/medium-approval/capture',
      headers: auth,
      payload: { ticketId: 'not-a-uuid' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('not-a-uuid');
  });

  it('rejects an unauthenticated request', async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/v2/pipenzo/tickets/risk/medium-approval/capture' });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /v2/pipenzo/tickets/risk/medium-approval/decide', () => {
  async function captured(worktreeManager: OwnedWorktreeManager, worktreeId: string, branch: string, ticket: Partial<PipenzoTicketRecordV1> = {}) {
    const built = await buildApp({
      ticket: { worktree: { id: worktreeId, path: 'ignored', branch }, ...ticket },
      worktreeManager,
    });
    const captureResponse = await built.app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/risk/medium-approval/capture',
      headers: auth,
      payload: { ticketId: TICKET_ID, worktreeId, branch, touchedPaths: ['a.txt'] },
    });
    const { snapshotId } = captureResponse.json() as { snapshotId: string };
    return { ...built, snapshotId };
  }

  it(
    'allow records the risk-approval outcome, deliberately not resetting a MEDIUM score',
    async () => {
      const { worktreeManager, worktreeId, branch } = await realWorktree();
      const { app, tickets, snapshotId } = await captured(worktreeManager, worktreeId, branch, {
        risk: { score: 8, lastResetAt: '2026-01-01T00:00:00.000Z', pendingPromotion: false },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/medium-approval/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, snapshotId, decision: 'allow', reason: 'looks fine' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ decision: 'allow', risk: { score: 8 } });
      expect(tickets.get(TICKET_ID)?.risk.score).toBe(8);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'reject never touches the risk score, and the reason field is genuinely optional',
    async () => {
      const { worktreeManager, worktreeId, branch } = await realWorktree();
      const { app, tickets, snapshotId } = await captured(worktreeManager, worktreeId, branch, {
        risk: { score: 8, lastResetAt: '2026-01-01T00:00:00.000Z', pendingPromotion: false },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/medium-approval/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, snapshotId, decision: 'reject' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ decision: 'reject' });
      expect(tickets.get(TICKET_ID)?.risk.score).toBe(8);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses a second decide on the same snapshot -- a decision is never re-askable',
    async () => {
      const { worktreeManager, worktreeId, branch } = await realWorktree();
      const { app, snapshotId } = await captured(worktreeManager, worktreeId, branch);

      const first = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/medium-approval/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, snapshotId, decision: 'allow' },
      });
      const second = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/medium-approval/decide',
        headers: auth,
        payload: { ticketId: TICKET_ID, snapshotId, decision: 'reject' },
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(404);
      expect(second.json()).toMatchObject({ code: 'snapshot_not_found' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    "refuses to decide a real snapshot under a different ticket id (cannot forge which ticket's action this was)",
    async () => {
      const { worktreeManager, worktreeId, branch } = await realWorktree();
      const { app, snapshotId } = await captured(worktreeManager, worktreeId, branch);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/medium-approval/decide',
        headers: auth,
        payload: { ticketId: OTHER_TICKET_ID, snapshotId, decision: 'allow' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'snapshot_not_found' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});

describe('POST /v2/pipenzo/tickets/risk/medium-approval/status and /undo', () => {
  async function allowed(worktreeManager: OwnedWorktreeManager, worktreeId: string, worktreePath: string, branch: string) {
    const built = await buildApp({ ticket: { worktree: { id: worktreeId, path: 'ignored', branch } }, worktreeManager });
    const captureResponse = await built.app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/risk/medium-approval/capture',
      headers: auth,
      payload: { ticketId: TICKET_ID, worktreeId, branch, touchedPaths: ['a.txt'] },
    });
    const { snapshotId } = captureResponse.json() as { snapshotId: string };
    await built.app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/risk/medium-approval/decide',
      headers: auth,
      payload: { ticketId: TICKET_ID, snapshotId, decision: 'allow' },
    });
    return { ...built, snapshotId, worktreePath };
  }

  it(
    'reports undo available right after allow, then unavailable once another commit lands',
    async () => {
      const { worktreeManager, worktreeId, worktreePath, branch } = await realWorktree();
      const { app, snapshotId } = await allowed(worktreeManager, worktreeId, worktreePath, branch);

      const before = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/medium-approval/status',
        headers: auth,
        payload: { ticketId: TICKET_ID, snapshotId },
      });
      expect(before.json()).toEqual({ available: true });

      await writeFile(join(worktreePath, 'a.txt'), 'changed\n');
      await run('git', ['add', 'a.txt'], { cwd: worktreePath });
      await run(
        'git',
        ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'a real commit'],
        { cwd: worktreePath },
      );

      const after = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/medium-approval/status',
        headers: auth,
        payload: { ticketId: TICKET_ID, snapshotId },
      });
      expect(after.json()).toEqual({ available: false, reason: 'expired' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it('answers snapshot_not_found for status/undo under the wrong ticket', async () => {
    const { worktreeManager, worktreeId, worktreePath, branch } = await realWorktree();
    const { app, snapshotId } = await allowed(worktreeManager, worktreeId, worktreePath, branch);

    const status = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/risk/medium-approval/status',
      headers: auth,
      payload: { ticketId: OTHER_TICKET_ID, snapshotId },
    });
    const undo = await app.inject({
      method: 'POST',
      url: '/v2/pipenzo/tickets/risk/medium-approval/undo',
      headers: auth,
      payload: { ticketId: OTHER_TICKET_ID, snapshotId },
    });

    expect(status.statusCode).toBe(404);
    expect(undo.statusCode).toBe(404);
  }, GIT_HEAVY_TIMEOUT_MS);

  it(
    'undo genuinely restores the touched file, and a second undo is refused',
    async () => {
      const { worktreeManager, worktreeId, worktreePath, branch } = await realWorktree();
      const { app, snapshotId } = await allowed(worktreeManager, worktreeId, worktreePath, branch);
      await writeFile(join(worktreePath, 'a.txt'), 'the agent changed it\n');

      const first = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/medium-approval/undo',
        headers: auth,
        payload: { ticketId: TICKET_ID, snapshotId },
      });
      const second = await app.inject({
        method: 'POST',
        url: '/v2/pipenzo/tickets/risk/medium-approval/undo',
        headers: auth,
        payload: { ticketId: TICKET_ID, snapshotId },
      });

      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ restored: true });
      expect(second.statusCode).toBe(404);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );
});
