import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PipenzoTicketRecordV1 } from '@agent-dock/shared';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import type { GitHubIssue } from '../src/github-client.js';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';
import {
  PIPENZO_LEGAL_LANE_TRANSITIONS,
  PipenzoPhaseMachine,
  PipenzoPhaseMachineError,
  isLegalLaneTransition,
} from '../src/pipenzo-phase-machine.js';

const TICKET_ID = '00000000-0000-4000-8000-000000000001';
const REPO = 'jortega0033/pipenzo';
const REF = { owner: 'jortega0033', repo: 'pipenzo' };
const ISSUE_NUMBER = 78;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function storeDirectory(): string {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pipenzo-phase-machine-'));
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

/** A store + fake GitHub + machine, wired the way `index.ts` wires the real ones. */
function harness(options: {
  ticket?: Partial<PipenzoTicketRecordV1>;
  issueLabels?: readonly string[];
} = {}) {
  const tickets = new FileTicketStore(storeDirectory());
  tickets.create(makeTicket(options.ticket));
  const github = new FakeGitHubClient().seedIssue(
    makeIssue(options.issueLabels ?? ['pipenzo:queued']),
  );
  const machine = new PipenzoPhaseMachine({ tickets, github: () => github });
  return { tickets, github, machine };
}

describe('PipenzoPhaseMachine transition table', () => {
  it('permits every lane pair except queued to ready-for-review', () => {
    const lanes = ['queued', 'working', 'ready-for-review', 'needs-human'] as const;
    const illegal: string[] = [];
    for (const from of lanes) {
      for (const to of lanes) {
        if (!isLegalLaneTransition(from, to)) illegal.push(`${from}->${to}`);
      }
    }
    expect(illegal).toEqual(['queued->ready-for-review']);
  });

  it('permits every self-transition, so the five Needs-human labels can move between themselves', () => {
    for (const lane of ['queued', 'working', 'ready-for-review', 'needs-human'] as const) {
      expect(PIPENZO_LEGAL_LANE_TRANSITIONS[lane]).toContain(lane);
    }
  });

  it("permits needs-human to ready-for-review, README's ci-failed row", () => {
    expect(isLegalLaneTransition('needs-human', 'ready-for-review')).toBe(true);
  });
});

describe('PipenzoPhaseMachine.transition', () => {
  it('writes the GitHub label before the local record', async () => {
    const { github, machine, tickets } = harness();

    const result = await machine.transition(TICKET_ID, 'pipenzo:working');

    // The label write happened, and the local record followed it.
    const writes = github.calls.filter((call) => call.method === 'setIssueLabels');
    expect(writes).toHaveLength(1);
    expect(result.ticket.lane).toBe('working');
    expect(tickets.get(TICKET_ID)?.lane).toBe('working');
  });

  it('re-asserts the schema marker on every write, because setIssueLabels replaces the namespace', async () => {
    const { github, machine } = harness();

    await machine.transition(TICKET_ID, 'pipenzo:working');

    const issue = await github.getIssue(REF, ISSUE_NUMBER);
    // Without the marker in the write, replacing the namespace would have deleted it.
    expect(issue.labels).toContain('pipenzo:schema-v1');
    expect(issue.labels).toContain('pipenzo:working');
    expect(issue.labels).not.toContain('pipenzo:queued');
  });

  it('preserves foreign labels across a lane write', async () => {
    const { github, machine } = harness({
      issueLabels: ['pipenzo:queued', 'bug', 'good first issue'],
    });

    await machine.transition(TICKET_ID, 'pipenzo:working');

    const issue = await github.getIssue(REF, ISSUE_NUMBER);
    expect(issue.labels).toContain('bug');
    expect(issue.labels).toContain('good first issue');
  });

  it('refuses an illegal transition without writing anything to GitHub', async () => {
    const { github, machine, tickets } = harness();

    await expect(machine.transition(TICKET_ID, 'pipenzo:ready-for-review')).rejects.toMatchObject({
      code: 'illegal_transition',
    });
    expect(github.calls.filter((call) => call.method === 'setIssueLabels')).toHaveLength(0);
    expect(tickets.get(TICKET_ID)?.lane).toBe('queued');
  });

  it('judges legality against the reconciled lane, not the stale local one', async () => {
    // Local says queued (so queued->ready-for-review would be illegal), but the issue's label says
    // the ticket is really working -- from which ready-for-review is legal.
    const { machine } = harness({
      ticket: { lane: 'queued', labels: ['pipenzo:queued'] },
      issueLabels: ['pipenzo:working'],
    });

    const result = await machine.transition(TICKET_ID, 'pipenzo:ready-for-review');

    expect(result.ticket.lane).toBe('ready-for-review');
  });

  it('rejects a label that carries no lane', async () => {
    const { machine } = harness();

    await expect(
      // The schema marker is a marker, never a state to transition into.
      machine.transition(TICKET_ID, 'pipenzo:schema-v1' as never),
    ).rejects.toBeInstanceOf(PipenzoPhaseMachineError);
  });
});

/**
 * README's `pipenzo:ci-failed` row, which is the one label whose lane is written as a transition
 * rather than a value: "The label stays on the ticket, but a ticket carrying it moves to Ready for
 * review the moment the forked fix attempt commits".
 */
describe('PipenzoPhaseMachine and the CI-failure lifecycle', () => {
  it('puts a ticket carrying ci-failed alone in the Needs-human lane', async () => {
    const { machine } = harness({
      ticket: { lane: 'ready-for-review', labels: ['pipenzo:ready-for-review'] },
      issueLabels: ['pipenzo:ci-failed'],
    });

    // Nobody has looked at it yet, so the condition label supplies the lane on its own.
    expect((await machine.read(TICKET_ID)).ticket.lane).toBe('needs-human');
  });

  it('keeps ci-failed on the ticket when the fix commits and it moves to ready-for-review', async () => {
    const { machine, github } = harness({
      ticket: { lane: 'needs-human', labels: ['pipenzo:ci-failed'] },
      issueLabels: ['pipenzo:ci-failed'],
    });

    const result = await machine.transition(TICKET_ID, 'pipenzo:ready-for-review');

    expect(result.ticket.lane).toBe('ready-for-review');
    const issue = await github.getIssue(REF, ISSUE_NUMBER);
    // The label stays on the ticket -- stripping it here would lose the CI-failure lifecycle's own
    // marker at the exact moment README says it must survive.
    expect(issue.labels).toContain('pipenzo:ci-failed');
    expect(issue.labels).toContain('pipenzo:ready-for-review');
  });

  it('reads a ticket carrying both ci-failed and ready-for-review as ready-for-review', async () => {
    const { machine } = harness({
      ticket: { lane: 'needs-human', labels: ['pipenzo:ci-failed'] },
      issueLabels: ['pipenzo:ci-failed', 'pipenzo:ready-for-review'],
    });

    // A rule that simply took the most-halting lane would answer needs-human here, which is
    // backwards from README's table.
    expect((await machine.read(TICKET_ID)).ticket.lane).toBe('ready-for-review');
  });

  it('does not drag a stale state label along when entering the CI-failure lifecycle', async () => {
    const { machine, github } = harness({
      ticket: { lane: 'ready-for-review', labels: ['pipenzo:ready-for-review'] },
      issueLabels: ['pipenzo:ready-for-review'],
    });

    await machine.transition(TICKET_ID, 'pipenzo:ci-failed');

    const issue = await github.getIssue(REF, ISSUE_NUMBER);
    expect(issue.labels).toContain('pipenzo:ci-failed');
    expect(issue.labels).not.toContain('pipenzo:ready-for-review');
  });

  it('does not re-add a condition label a human has deleted from the issue', async () => {
    // The local record still remembers ci-failed; the issue no longer carries any pipenzo label, so
    // `read()` reports `unlabelled` and leaves the stale record alone. Retaining from the record
    // rather than from what GitHub actually has would put the deleted label straight back.
    const { machine, github } = harness({
      ticket: { lane: 'needs-human', labels: ['pipenzo:ci-failed'] },
      issueLabels: ['bug'],
    });

    await machine.transition(TICKET_ID, 'pipenzo:working');

    const issue = await github.getIssue(REF, ISSUE_NUMBER);
    expect(issue.labels).not.toContain('pipenzo:ci-failed');
    expect(issue.labels).toContain('pipenzo:working');
    expect(issue.labels).toContain('bug');
  });

  it('does not retain merge-conflict across a transition, which has no such lifecycle', async () => {
    const { machine, github } = harness({
      ticket: { lane: 'needs-human', labels: ['pipenzo:merge-conflict'] },
      issueLabels: ['pipenzo:merge-conflict'],
    });

    await machine.transition(TICKET_ID, 'pipenzo:working');

    const issue = await github.getIssue(REF, ISSUE_NUMBER);
    expect(issue.labels).not.toContain('pipenzo:merge-conflict');
  });
});

describe('PipenzoPhaseMachine.read reconciliation', () => {
  it('reports no divergence when the two stores agree', async () => {
    const { machine } = harness({
      ticket: { lane: 'queued', labels: ['pipenzo:queued'] },
      issueLabels: ['pipenzo:queued'],
    });

    const result = await machine.read(TICKET_ID);

    expect(result.divergence).toBe('none');
    expect(result.changed).toBe(false);
  });

  it('lets the label win and rewrites the local record, never the other way around', async () => {
    const { machine, github, tickets } = harness({
      ticket: { lane: 'working', labels: ['pipenzo:working'] },
      issueLabels: ['pipenzo:needs-human'],
    });

    const result = await machine.read(TICKET_ID);

    expect(result.divergence).toBe('lane_reconciled');
    expect(result.previousLane).toBe('working');
    expect(result.ticket.lane).toBe('needs-human');
    expect(tickets.get(TICKET_ID)?.lane).toBe('needs-human');
    // The authoritative side was not touched: reconciliation is a local rewrite only.
    expect(github.calls.filter((call) => call.method === 'setIssueLabels')).toHaveLength(0);
  });

  it('resolves multiple lane labels toward the lane that halts automation', async () => {
    const { machine } = harness({
      ticket: { lane: 'working', labels: ['pipenzo:working'] },
      issueLabels: ['pipenzo:working', 'pipenzo:needs-human'],
    });

    const result = await machine.read(TICKET_ID);

    expect(result.divergence).toBe('ambiguous_labels');
    // needs-human outranks working: a human flagged a running ticket, so it must not keep dispatching.
    expect(result.ticket.lane).toBe('needs-human');
    expect(result.observedLabels).toHaveLength(2);
  });

  it('prefers ready-for-review over working for the same reason', async () => {
    const { machine } = harness({
      ticket: { lane: 'working', labels: ['pipenzo:working'] },
      issueLabels: ['pipenzo:working', 'pipenzo:ready-for-review'],
    });

    expect((await machine.read(TICKET_ID)).ticket.lane).toBe('ready-for-review');
  });

  it('keeps the local lane when the issue carries no lane-bearing label at all', async () => {
    const { machine, tickets } = harness({
      ticket: { lane: 'working', labels: ['pipenzo:working'] },
      issueLabels: ['bug', 'pipenzo:schema-v1'],
    });

    const result = await machine.read(TICKET_ID);

    // An absent label states nothing, so there is nothing to reconcile *to*. Clearing the local
    // record here would turn a deleted label into data loss on the side holding the worktree.
    expect(result.divergence).toBe('unlabelled');
    expect(result.changed).toBe(false);
    expect(result.ticket.lane).toBe('working');
    expect(tickets.get(TICKET_ID)?.lane).toBe('working');
  });

  it('ignores an unknown pipenzo-prefixed label rather than persisting it', async () => {
    const { machine } = harness({
      ticket: { lane: 'queued', labels: ['pipenzo:queued'] },
      issueLabels: ['pipenzo:queued', 'pipenzo:some-future-state'],
    });

    const result = await machine.read(TICKET_ID);

    expect(result.ticket.labels).toEqual(['pipenzo:queued']);
    expect(result.ticket.lane).toBe('queued');
  });

  it('fails with ticket_not_found for an unknown ticket', async () => {
    const { machine } = harness();

    await expect(machine.read('00000000-0000-4000-8000-00000000dead')).rejects.toMatchObject({
      code: 'ticket_not_found',
    });
  });

  it('reports token_missing when no GitHub client is configured', async () => {
    const tickets = new FileTicketStore(storeDirectory());
    tickets.create(makeTicket());
    const machine = new PipenzoPhaseMachine({ tickets });

    await expect(machine.read(TICKET_ID)).rejects.toMatchObject({ code: 'token_missing' });
  });

  it('maps a GitHub not_found onto issue_not_found', async () => {
    const tickets = new FileTicketStore(storeDirectory());
    tickets.create(makeTicket());
    // Seeded with no issue at all, so getIssue throws not_found.
    const github = new FakeGitHubClient();
    const machine = new PipenzoPhaseMachine({ tickets, github: () => github });

    await expect(machine.read(TICKET_ID)).rejects.toMatchObject({ code: 'issue_not_found' });
  });
});
