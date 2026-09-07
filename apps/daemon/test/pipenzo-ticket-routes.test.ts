import { mkdtempSync, rmSync } from 'node:fs';
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
} = {}) {
  const registry = new ProviderRegistry();
  const tickets = new FileTicketStore(storeDirectory());
  tickets.create(makeTicket(options.ticket));
  const github = new FakeGitHubClient().seedIssue(
    makeIssue(options.issueLabels ?? ['pipenzo:queued']),
  );
  const phaseMachine = new PipenzoPhaseMachine({
    tickets,
    ...(options.withGitHub === false ? {} : { github: () => github }),
  });
  return {
    github,
    tickets,
    app: buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
      phaseMachine,
    }),
  };
}

describe('POST /v2/pipenzo/tickets/read', () => {
  it('reconciles against the issue labels and reports agreement', async () => {
    const { app } = buildApp();

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
