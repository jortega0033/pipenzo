import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PipenzoTicketRecordV1 } from '@agent-dock/shared';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import type { GitHubIssue } from '../src/github-client.js';
import { PipenzoPhaseEventBus } from '../src/pipenzo-phase-events.js';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';
import {
  PIPENZO_LEGAL_LANE_TRANSITIONS,
  PipenzoPhaseMachine,
  PipenzoPhaseMachineError,
  isBudgetExhausted,
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

function makeIssue(labels: readonly string[], title = 'First-run empty'): GitHubIssue {
  return {
    owner: REF.owner,
    repo: REF.repo,
    number: ISSUE_NUMBER,
    title,
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
  issueTitle?: string;
  events?: PipenzoPhaseEventBus;
} = {}) {
  const tickets = new FileTicketStore(storeDirectory());
  tickets.create(makeTicket(options.ticket));
  const github = new FakeGitHubClient().seedIssue(
    makeIssue(options.issueLabels ?? ['pipenzo:queued'], options.issueTitle),
  );
  const machine = new PipenzoPhaseMachine({
    tickets,
    github: () => github,
    ...(options.events ? { events: options.events } : {}),
  });
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
 * A transition reports divergence against *what it wrote*, not against the lane the ticket used to
 * hold -- a ticket moving lanes is the transition working. These cover the four outcomes, because
 * #149's audit trail keys off this field and a transition that reports drift on every ordinary move
 * (or stays silent when a racer overrode it) makes that trail worse than no trail.
 */
describe('PipenzoPhaseMachine.transition divergence', () => {
  it('reports no divergence for an ordinary lane move, which is the transition succeeding', async () => {
    const { machine } = harness();

    const result = await machine.transition(TICKET_ID, 'pipenzo:working');

    expect(result.ticket.lane).toBe('working');
    // The lane changed and the record was rewritten -- `changed` is what says so, not `divergence`.
    expect(result.changed).toBe(true);
    expect(result.divergence).toBe('none');
  });

  it("reports no divergence when ci-failed rides along into Ready-for-review, README's row", async () => {
    const { machine } = harness({
      ticket: { lane: 'needs-human', labels: ['pipenzo:ci-failed'] },
      issueLabels: ['pipenzo:ci-failed'],
    });

    const result = await machine.transition(TICKET_ID, 'pipenzo:ready-for-review');

    // Both labels were intended: the retained condition label is not an ambiguity.
    expect(result.observedLabels).toContain('pipenzo:ci-failed');
    expect(result.ticket.lane).toBe('ready-for-review');
    expect(result.divergence).toBe('none');
  });

  it('reports lane_reconciled when a concurrent writer pins the lane we tried to move off', async () => {
    const { machine, github } = harness({
      ticket: { lane: 'needs-human', labels: ['pipenzo:needs-human'] },
      issueLabels: ['pipenzo:needs-human'],
    });
    // The race the write path exists to reveal: our label goes in, someone else's answer comes back
    // holding the ticket exactly where it already was. Comparing against the *previous* lane calls
    // this `none` and loses the overridden write entirely.
    github.setIssueLabels = async () => ['pipenzo:needs-human', 'pipenzo:schema-v1'];

    const result = await machine.transition(TICKET_ID, 'pipenzo:ready-for-review');

    expect(result.ticket.lane).toBe('needs-human');
    expect(result.divergence).toBe('lane_reconciled');
  });

  it('reports ambiguous_labels when the lane held but a label we never wrote came back', async () => {
    const { machine, github } = harness({
      ticket: { lane: 'working', labels: ['pipenzo:working'] },
      issueLabels: ['pipenzo:working'],
    });
    // Same lane as the target, so the lane check passes -- but ci-failed was never ours to write.
    github.setIssueLabels = async () => [
      'pipenzo:needs-human',
      'pipenzo:ci-failed',
      'pipenzo:schema-v1',
    ];

    const result = await machine.transition(TICKET_ID, 'pipenzo:needs-human');

    expect(result.ticket.lane).toBe('needs-human');
    expect(result.divergence).toBe('ambiguous_labels');
  });

  it('reports unlabelled when a racer strips the namespace between the write and its response', async () => {
    const { machine, github } = harness();
    github.setIssueLabels = async () => [];

    const result = await machine.transition(TICKET_ID, 'pipenzo:working');

    expect(result.divergence).toBe('unlabelled');
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
    // Title held equal to the fake issue's default so this test isolates lane/label agreement --
    // title caching has its own describe block below.
    const { machine } = harness({
      ticket: { lane: 'queued', labels: ['pipenzo:queued'], title: 'First-run empty' },
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

  it('prefers queued over working, because working is the lane that dispatches', async () => {
    const { machine } = harness({
      ticket: { lane: 'working', labels: ['pipenzo:working'] },
      issueLabels: ['pipenzo:working', 'pipenzo:queued'],
    });

    // A teammate adding `queued` beside `working` on github.com is asking for a halt. Ordering
    // these by progress rather than by which one dispatches would override that request.
    expect((await machine.read(TICKET_ID)).ticket.lane).toBe('queued');
  });

  it('reports a local store failure as store_failed, not as a GitHub error', async () => {
    const { machine, tickets } = harness({
      ticket: { lane: 'working', labels: ['pipenzo:working'] },
      issueLabels: ['pipenzo:needs-human'],
    });
    tickets.update = () => {
      throw new Error('disk is full');
    };

    // The reconciliation itself succeeded; it is the local write that failed. Reporting that as
    // github_failed would send an operator to check their network and their token.
    await expect(machine.read(TICKET_ID)).rejects.toMatchObject({ code: 'store_failed' });
  });

  it('prefers ready-for-review over working for the same reason', async () => {
    const { machine } = harness({
      ticket: { lane: 'working', labels: ['pipenzo:working'] },
      issueLabels: ['pipenzo:working', 'pipenzo:ready-for-review'],
    });

    expect((await machine.read(TICKET_ID)).ticket.lane).toBe('ready-for-review');
  });

  it('keeps the local lane when the issue carries no lane-bearing label at all', async () => {
    // Title held equal to the fake issue's default for the same reason as the agreement test above
    // -- this isolates the "no lane-bearing label" case from title caching.
    const { machine, tickets } = harness({
      ticket: { lane: 'working', labels: ['pipenzo:working'], title: 'First-run empty' },
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

describe('PipenzoPhaseMachine issue state (issue #159)', () => {
  it('reports issueState from the same round trip read() already makes', async () => {
    const { machine } = harness();
    const result = await machine.read(TICKET_ID);
    expect(result.issueState).toBe('open');
  });

  it('reports closed once the issue closes, on every read() branch', async () => {
    const tickets = new FileTicketStore(storeDirectory());
    tickets.create(makeTicket());
    const github = new FakeGitHubClient().seedIssue({
      ...makeIssue(['pipenzo:queued']),
      state: 'closed',
    });
    const machine = new PipenzoPhaseMachine({ tickets, github: () => github });

    // Agreeing lane/labels: the "nothing changed" branch.
    expect((await machine.read(TICKET_ID)).issueState).toBe('closed');
  });

  it('reports closed on the reconciling branch too, not just the agreeing one', async () => {
    // A closed issue whose label disagrees with the local lane, so the reconciling branch (not the
    // "agrees" branch, already covered above) is the one under test.
    const tickets = new FileTicketStore(storeDirectory());
    tickets.create(makeTicket({ lane: 'working', labels: ['pipenzo:working'] }));
    const github = new FakeGitHubClient().seedIssue({
      ...makeIssue(['pipenzo:needs-human']),
      state: 'closed',
    });
    const machine = new PipenzoPhaseMachine({ tickets, github: () => github });

    const result = await machine.read(TICKET_ID);
    expect(result.divergence).toBe('lane_reconciled');
    expect(result.issueState).toBe('closed');
  });

  it('carries the issue state a transition’s own read() already observed', async () => {
    const tickets = new FileTicketStore(storeDirectory());
    tickets.create(makeTicket());
    const github = new FakeGitHubClient().seedIssue({
      ...makeIssue(['pipenzo:queued']),
      state: 'closed',
    });
    const machine = new PipenzoPhaseMachine({ tickets, github: () => github });

    const result = await machine.transition(TICKET_ID, 'pipenzo:working');
    expect(result.issueState).toBe('closed');
  });
});

describe('PipenzoPhaseMachine.read title caching (issue #255)', () => {
  it('caches the title on a ticket that has never had one', async () => {
    const { machine, tickets } = harness({ issueTitle: 'Fix the board list route' });

    const result = await machine.read(TICKET_ID);

    expect(result.ticket.title).toBe('Fix the board list route');
    expect(result.changed).toBe(true);
    expect(tickets.get(TICKET_ID)?.title).toBe('Fix the board list route');
  });

  it('refreshes a stale cached title on an otherwise-agreeing read', async () => {
    const { machine, tickets } = harness({
      ticket: { title: 'Old title' },
      issueLabels: ['pipenzo:queued'],
      issueTitle: 'Renamed on GitHub',
    });

    const result = await machine.read(TICKET_ID);

    // The lane/labels agreed, so this would otherwise have been an unchanged, unpersisted read --
    // the title still has to travel through, since nothing else will ever pick it up.
    expect(result.divergence).toBe('none');
    expect(result.ticket.title).toBe('Renamed on GitHub');
    expect(result.changed).toBe(true);
    expect(tickets.get(TICKET_ID)?.title).toBe('Renamed on GitHub');
  });

  it('does not rewrite the record when the title has not changed', async () => {
    const { machine, tickets } = harness({
      ticket: { title: 'Same title throughout' },
      issueTitle: 'Same title throughout',
    });
    const before = tickets.get(TICKET_ID);

    const result = await machine.read(TICKET_ID);

    expect(result.changed).toBe(false);
    expect(tickets.get(TICKET_ID)).toBe(before);
  });

  it('still caches the title when the issue carries no lane-bearing label', async () => {
    const { machine, tickets } = harness({
      ticket: { lane: 'working', labels: ['pipenzo:working'] },
      issueLabels: ['bug'],
      issueTitle: 'Not yet triaged',
    });

    const result = await machine.read(TICKET_ID);

    expect(result.divergence).toBe('unlabelled');
    expect(result.changed).toBe(true);
    // The lane itself is still untouched -- only the title travelled.
    expect(result.ticket.lane).toBe('working');
    expect(tickets.get(TICKET_ID)?.title).toBe('Not yet triaged');
  });

  it('folds a title change into a lane reconciliation, in the same write', async () => {
    const { machine, tickets, github } = harness({
      ticket: { lane: 'working', labels: ['pipenzo:working'], title: 'Old title' },
      issueLabels: ['pipenzo:needs-human'],
      issueTitle: 'New title',
    });

    const result = await machine.read(TICKET_ID);

    expect(result.divergence).toBe('lane_reconciled');
    expect(result.ticket.lane).toBe('needs-human');
    expect(result.ticket.title).toBe('New title');
    expect(tickets.get(TICKET_ID)?.title).toBe('New title');
    // Reconciliation is local-only, same as every other read() reconciliation.
    expect(github.calls.filter((call) => call.method === 'setIssueLabels')).toHaveLength(0);
  });

  it('does not announce a title-only change on an otherwise-agreeing read', async () => {
    const events = new PipenzoPhaseEventBus();
    const { machine } = harness({
      ticket: { lane: 'queued', labels: ['pipenzo:queued'], title: 'Old title' },
      issueLabels: ['pipenzo:queued'],
      issueTitle: 'Renamed on GitHub',
      events,
    });

    const result = await machine.read(TICKET_ID);

    // The write happened (this is the same case covered above), but the phase-event stream (#189)
    // carries lane transitions, not card content -- a title update with no lane change is not
    // something a subscriber reconnects to that stream to hear about, so #announce must stay silent.
    expect(result.changed).toBe(true);
    expect(result.ticket.title).toBe('Renamed on GitHub');
    expect(events.retained).toHaveLength(0);
  });
});

describe('PipenzoPhaseMachine.list', () => {
  it('returns every ticket the local store knows about, unreconciled', () => {
    const { machine, tickets } = harness({ ticket: { lane: 'needs-human' } });

    // No GitHub client wired for this assertion path -- list() must never need one.
    const machineWithoutGitHub = new PipenzoPhaseMachine({ tickets });
    expect(machineWithoutGitHub.list()).toEqual([tickets.get(TICKET_ID)]);
    expect(machine.list()).toEqual([tickets.get(TICKET_ID)]);
  });
});

/**
 * Issue #201's crash-recovery gap: nothing populated `attempts[]` at real dispatch time, so
 * `pipenzo-crash-recovery.ts`'s session-to-ticket index only ever had data in a test that hand-
 * seeded it. `recordAttempt()` is the fix's local write; `pipenzo-implement-attempts.test.ts`
 * proves the whole dispatch-to-crash-recovery path end to end, and this file covers the method's
 * own edges.
 */
describe('PipenzoPhaseMachine.recordAttempt', () => {
  it('appends an attempt to a ticket with none yet, without touching GitHub', () => {
    const { machine, tickets, github } = harness({ ticket: { attempts: [] } });

    machine.recordAttempt(TICKET_ID, {
      sessionId: 'session-1',
      tier: 'mid',
      model: 'claude-sonnet',
      outcome: 'dispatched',
    });

    expect(tickets.get(TICKET_ID)?.attempts).toEqual([
      { sessionId: 'session-1', tier: 'mid', model: 'claude-sonnet', outcome: 'dispatched' },
    ]);
    // Local-only: unlike `transition()` and `read()`, this must never cost a GitHub round trip.
    expect(github.calls).toEqual([]);
  });

  it('appends to an existing attempts[] rather than replacing it, preserving order', () => {
    const { machine, tickets } = harness({
      ticket: {
        attempts: [{ sessionId: 'session-1', tier: 'mid', model: 'claude-sonnet', outcome: 'dispatched' }],
      },
    });

    machine.recordAttempt(TICKET_ID, {
      sessionId: 'session-2',
      tier: 'frontier',
      model: 'claude-opus',
      outcome: 'dispatched',
    });

    expect(tickets.get(TICKET_ID)?.attempts.map((attempt) => attempt.sessionId)).toEqual([
      'session-1',
      'session-2',
    ]);
  });

  it('does not announce a phase-stream event -- appending an attempt never moves a lane', () => {
    const events = new PipenzoPhaseEventBus();
    const { machine } = harness({ ticket: { attempts: [] }, events });

    machine.recordAttempt(TICKET_ID, {
      sessionId: 'session-1',
      tier: 'mid',
      model: 'claude-sonnet',
      outcome: 'dispatched',
    });

    expect(events.retained).toHaveLength(0);
  });

  it('throws ticket_not_found rather than silently doing nothing for an unknown ticket', () => {
    const { machine } = harness();

    expect(() =>
      machine.recordAttempt('00000000-0000-4000-8000-00000000ffff', {
        sessionId: 'session-1',
        tier: 'mid',
        model: 'claude-sonnet',
        outcome: 'dispatched',
      }),
    ).toThrow(PipenzoPhaseMachineError);
  });

  it('drops the oldest attempt rather than growing past the schema’s 50-entry cap', () => {
    const existing = Array.from({ length: 50 }, (_, index) => ({
      sessionId: `session-${index}`,
      tier: 'mid' as const,
      model: 'claude-sonnet',
      outcome: 'dispatched',
    }));
    const { machine, tickets } = harness({ ticket: { attempts: existing } });

    machine.recordAttempt(TICKET_ID, {
      sessionId: 'session-newest',
      tier: 'frontier',
      model: 'claude-opus',
      outcome: 'dispatched',
    });

    const stored = tickets.get(TICKET_ID)?.attempts ?? [];
    expect(stored).toHaveLength(50);
    // The newest attempt -- the one a live interrupted session would need matched -- survives...
    expect(stored.at(-1)?.sessionId).toBe('session-newest');
    // ...and the oldest is what made room for it.
    expect(stored.some((attempt) => attempt.sessionId === 'session-0')).toBe(false);
    expect(stored[0]?.sessionId).toBe('session-1');
  });
});

/**
 * Issue #74, the split of #20 that guards the phase machine's write path: an issue carrying a
 * `pipenzo:schema-vN` marker newer than this build understands (`pipenzo:schema-v1`) must refuse
 * both reconciliation and transition rather than write v1 semantics over state a newer Pipenzo
 * already migrated. Named `schema_read_only` because README's own rule is per-repo ("other connected
 * repos keep polling/running") — these tests cover the one ticket/issue the guard actually sees.
 */
describe('PipenzoPhaseMachine schema read-only guard', () => {
  it('refuses to read a ticket whose issue carries a newer schema marker', async () => {
    const { machine, tickets } = harness({
      issueLabels: ['pipenzo:queued', 'pipenzo:schema-v2'],
    });
    const before = tickets.get(TICKET_ID);

    await expect(machine.read(TICKET_ID)).rejects.toMatchObject({ code: 'schema_read_only' });

    // Nothing about the local record moved -- a refusal, not a silent skip.
    expect(tickets.get(TICKET_ID)).toBe(before);
  });

  it('refuses a transition on the same ticket, and never calls setIssueLabels', async () => {
    const { machine, github, tickets } = harness({
      issueLabels: ['pipenzo:queued', 'pipenzo:schema-v2'],
    });

    await expect(machine.transition(TICKET_ID, 'pipenzo:working')).rejects.toMatchObject({
      code: 'schema_read_only',
    });

    // The write this guard exists to prevent never reached GitHub, and the local lane is untouched.
    expect(github.calls.filter((call) => call.method === 'setIssueLabels')).toHaveLength(0);
    expect(tickets.get(TICKET_ID)?.lane).toBe('queued');
  });

  it('names the offending marker in the error details', async () => {
    const { machine } = harness({ issueLabels: ['pipenzo:queued', 'pipenzo:schema-v3'] });

    await expect(machine.read(TICKET_ID)).rejects.toMatchObject({
      code: 'schema_read_only',
      details: ['pipenzo:schema-v3'],
    });
  });

  it('is unmoved by an ordinary unrecognised pipenzo label -- only a schema marker triggers it', async () => {
    // Same fixture as the "ignores an unknown pipenzo-prefixed label" test above: a future *state*
    // label is silently dropped, not a read-only trip. Only `pipenzo:schema-v<N>` is special-cased.
    const { machine } = harness({
      issueLabels: ['pipenzo:queued', 'pipenzo:some-future-state'],
    });

    await expect(machine.read(TICKET_ID)).resolves.toMatchObject({ ticket: { lane: 'queued' } });
  });

  it("does not trip on this build's own marker, pipenzo:schema-v1", async () => {
    const { machine, github } = harness({
      issueLabels: ['pipenzo:queued', 'pipenzo:schema-v1'],
    });

    const result = await machine.transition(TICKET_ID, 'pipenzo:working');

    expect(result.ticket.lane).toBe('working');
    expect(github.calls.filter((call) => call.method === 'setIssueLabels')).toHaveLength(1);
  });

  it('an ordinary transition with no schema marker at all still writes normally', async () => {
    // The harness's default fixture carries no `pipenzo:schema-v*` label at all -- this is the
    // "normal write still works" case the guard must not regress.
    const { machine, github, tickets } = harness();

    const result = await machine.transition(TICKET_ID, 'pipenzo:working');

    expect(result.ticket.lane).toBe('working');
    expect(tickets.get(TICKET_ID)?.lane).toBe('working');
    expect(github.calls.filter((call) => call.method === 'setIssueLabels')).toHaveLength(1);
  });
});

/**
 * Issue #143, slice 1: `budget.tokensUsed` had a field since build step 3, but nothing ever wrote
 * to it. `recordTokenUsage()` is that write; slice 2 is the separate enforcement consequence.
 */
describe('PipenzoPhaseMachine.recordTokenUsage', () => {
  it('adds to a ticket with no usage yet, without touching GitHub', () => {
    const { machine, tickets, github } = harness({ ticket: { budget: { tokensUsed: 0, limit: 0 } } });

    machine.recordTokenUsage(TICKET_ID, 1_500);

    expect(tickets.get(TICKET_ID)?.budget).toEqual({ tokensUsed: 1_500, limit: 0 });
    // Local-only: unlike `transition()` and `read()`, this must never cost a GitHub round trip.
    expect(github.calls).toEqual([]);
  });

  it('accumulates across calls rather than overwriting the previous total', () => {
    const { machine, tickets } = harness({ ticket: { budget: { tokensUsed: 1_000, limit: 0 } } });

    machine.recordTokenUsage(TICKET_ID, 250);

    expect(tickets.get(TICKET_ID)?.budget.tokensUsed).toBe(1_250);
  });

  it('returns the updated ticket record so a caller can decide whether to park it', () => {
    const { machine } = harness({ ticket: { budget: { tokensUsed: 100, limit: 0 } } });

    const updated = machine.recordTokenUsage(TICKET_ID, 50);

    expect(updated.budget.tokensUsed).toBe(150);
  });

  it('ignores a non-positive or non-finite report rather than corrupting the total', () => {
    const { machine, tickets } = harness({ ticket: { budget: { tokensUsed: 100, limit: 0 } } });

    machine.recordTokenUsage(TICKET_ID, 0);
    machine.recordTokenUsage(TICKET_ID, -5);
    machine.recordTokenUsage(TICKET_ID, Number.NaN);
    machine.recordTokenUsage(TICKET_ID, Number.POSITIVE_INFINITY);

    expect(tickets.get(TICKET_ID)?.budget.tokensUsed).toBe(100);
  });

  it('does not announce a phase-stream event -- adding usage never moves a lane', () => {
    const events = new PipenzoPhaseEventBus();
    const { machine } = harness({ ticket: { budget: { tokensUsed: 0, limit: 0 } }, events });

    machine.recordTokenUsage(TICKET_ID, 10);

    expect(events.retained).toHaveLength(0);
  });

  it('throws ticket_not_found rather than silently doing nothing for an unknown ticket', () => {
    const { machine } = harness();

    expect(() => machine.recordTokenUsage('00000000-0000-4000-8000-00000000ffff', 10)).toThrow(
      PipenzoPhaseMachineError,
    );
  });

  it('clamps to the schema’s int32 bound rather than overflowing it', () => {
    const { machine, tickets } = harness({
      ticket: { budget: { tokensUsed: 2_147_483_647 - 10, limit: 0 } },
    });

    machine.recordTokenUsage(TICKET_ID, 1_000);

    expect(tickets.get(TICKET_ID)?.budget.tokensUsed).toBe(2_147_483_647);
  });
});

describe('isBudgetExhausted', () => {
  it('is false when limit is 0, no matter how much has been spent -- 0 means unlimited', () => {
    expect(isBudgetExhausted({ tokensUsed: 1_000_000, limit: 0 })).toBe(false);
  });

  it('is false while spend is below a real limit', () => {
    expect(isBudgetExhausted({ tokensUsed: 99, limit: 100 })).toBe(false);
  });

  it('is true once spend reaches the limit exactly, not only once it passes it', () => {
    expect(isBudgetExhausted({ tokensUsed: 100, limit: 100 })).toBe(true);
  });

  it('is true once spend passes the limit', () => {
    expect(isBudgetExhausted({ tokensUsed: 101, limit: 100 })).toBe(true);
  });
});

describe('PipenzoPhaseMachine.peekBudget', () => {
  it('reads a ticket’s budget locally, without a GitHub round trip', () => {
    const { machine, github } = harness({ ticket: { budget: { tokensUsed: 42, limit: 100 } } });

    expect(machine.peekBudget(TICKET_ID)).toEqual({ tokensUsed: 42, limit: 100 });
    expect(github.calls).toEqual([]);
  });

  it('returns undefined for an unknown ticket rather than throwing', () => {
    const { machine } = harness();

    expect(machine.peekBudget('00000000-0000-4000-8000-00000000ffff')).toBeUndefined();
  });
});
