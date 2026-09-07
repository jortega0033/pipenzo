import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pipenzoPhaseEventV1Schema,
  type PipenzoPhaseEventV1,
  type PipenzoTicketRecordV1,
} from '@agent-dock/shared';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import type { GitHubIssue } from '../src/github-client.js';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';
import { PipenzoPhaseMachine } from '../src/pipenzo-phase-machine.js';
import {
  BoundedPipenzoPhaseSseWriter,
  PipenzoPhaseEventBus,
} from '../src/pipenzo-phase-events.js';
import type { SseOutput } from '../src/sse-writer.js';

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
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pipenzo-phase-events-'));
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

function harness(
  options: {
    ticket?: Partial<PipenzoTicketRecordV1>;
    issueLabels?: readonly string[];
    retain?: number;
  } = {},
) {
  const tickets = new FileTicketStore(storeDirectory());
  tickets.create(makeTicket(options.ticket));
  const github = new FakeGitHubClient().seedIssue(
    makeIssue(options.issueLabels ?? ['pipenzo:queued']),
  );
  const events = new PipenzoPhaseEventBus(options.retain);
  const machine = new PipenzoPhaseMachine({ tickets, github: () => github, events });
  return { tickets, github, events, machine };
}

const CHANGE = {
  ticketId: TICKET_ID,
  fromLane: 'queued',
  toLane: 'working',
  phase: 'implement',
  labels: ['pipenzo:working'],
} as const;

describe('PipenzoPhaseEventBus', () => {
  it('sequences from zero and reports a window a caught-up subscriber can resume from', () => {
    const bus = new PipenzoPhaseEventBus();

    expect(bus.replayWindow()).toEqual({ earliestSequence: 0, nextSequence: 0 });

    const first = bus.publish(CHANGE);
    const second = bus.publish(CHANGE);

    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(1);
    // A subscriber that has seen everything passes `nextSequence` and is replayed nothing.
    expect(bus.replayWindow()).toEqual({ earliestSequence: 0, nextSequence: 2 });
  });

  it('publishes an envelope the shared wire schema accepts', () => {
    const bus = new PipenzoPhaseEventBus();

    const event = bus.publish(CHANGE);

    expect(() => pipenzoPhaseEventV1Schema.parse(event)).not.toThrow();
    expect(event).toMatchObject({
      type: 'ticket.phase_changed',
      ticketId: TICKET_ID,
      fromLane: 'queued',
      toLane: 'working',
      phase: 'implement',
      labels: ['pipenzo:working'],
    });
  });

  it('replays only from the requested cursor, then delivers live events', () => {
    const bus = new PipenzoPhaseEventBus();
    bus.publish(CHANGE);
    bus.publish(CHANGE);

    const seen: number[] = [];
    const unsubscribe = bus.subscribe(1, (event) => seen.push(event.sequence));
    // Sequence 0 is before the cursor and must not be replayed.
    expect(seen).toEqual([1]);

    bus.publish(CHANGE);
    expect(seen).toEqual([1, 2]);

    unsubscribe();
    bus.publish(CHANGE);
    expect(seen).toEqual([1, 2]);
  });

  it('drops the oldest events past its bound and moves the window forward with them', () => {
    const bus = new PipenzoPhaseEventBus(3);
    for (let index = 0; index < 5; index += 1) bus.publish(CHANGE);

    // Five published, three retained: the window now starts at 2, and a cursor of 0 is a gap the
    // route refuses rather than answering with a silently truncated history.
    expect(bus.retained.map((event) => event.sequence)).toEqual([2, 3, 4]);
    expect(bus.replayWindow()).toEqual({ earliestSequence: 2, nextSequence: 5 });
  });

  it('isolates a throwing subscriber, because publishing runs inside a committed write', () => {
    const bus = new PipenzoPhaseEventBus();
    const delivered: number[] = [];
    bus.subscribe(0, () => {
      throw new Error('this subscriber is broken');
    });
    bus.subscribe(0, (event) => delivered.push(event.sequence));

    expect(() => bus.publish(CHANGE)).not.toThrow();
    // The healthy subscriber still got it.
    expect(delivered).toEqual([0]);
  });
});

/** Collects frames the way a socket would, with a switchable backpressure signal. */
function fakeOutput() {
  const chunks: string[] = [];
  const state = { ready: true, ended: false, drain: undefined as (() => void) | undefined };
  const output: SseOutput = {
    write(chunk: string) {
      chunks.push(chunk);
      return state.ready;
    },
    end(chunk?: string) {
      if (chunk !== undefined) chunks.push(chunk);
      state.ended = true;
    },
    once(_event: 'drain', listener: () => void) {
      state.drain = listener;
    },
  };
  return { chunks, state, output };
}

describe('BoundedPipenzoPhaseSseWriter', () => {
  it('frames an event with its sequence as the SSE id, so Last-Event-ID resumes from it', () => {
    const { chunks, output } = fakeOutput();
    const writer = new BoundedPipenzoPhaseSseWriter(output, () => {});
    const bus = new PipenzoPhaseEventBus();

    writer.start();
    writer.write(bus.publish(CHANGE));

    expect(chunks[0]).toBe(':ok\n\n');
    expect(chunks[1]).toContain('id: 0\n');
    expect(chunks[1]).toContain('event: ticket.phase_changed\n');
    const data = JSON.parse(chunks[1]!.split('data: ')[1]!) as PipenzoPhaseEventV1;
    expect(data.ticketId).toBe(TICKET_ID);
  });

  it('never treats an event as terminal: the board stream has no last event', () => {
    const { state, output } = fakeOutput();
    const writer = new BoundedPipenzoPhaseSseWriter(output, () => {});
    const bus = new PipenzoPhaseEventBus();

    writer.start();
    // A session stream would end on its terminal event. There is no phase event that ends a board.
    for (let index = 0; index < 3; index += 1) writer.write(bus.publish(CHANGE));

    expect(state.ended).toBe(false);
  });

  it('cuts a subscriber loose on overflow, naming the last sequence it actually received', () => {
    const { chunks, state, output } = fakeOutput();
    let closed = false;
    const writer = new BoundedPipenzoPhaseSseWriter(output, () => {
      closed = true;
    });
    const bus = new PipenzoPhaseEventBus(4096);

    writer.start();
    // The first write backpressures; everything after it queues until the bound is passed.
    state.ready = false;
    writer.write(bus.publish(CHANGE));
    for (let index = 0; index < 300; index += 1) writer.write(bus.publish(CHANGE));

    expect(state.ended).toBe(true);
    expect(closed).toBe(true);
    const overflow = JSON.parse(chunks.at(-1)!.split('data: ')[1]!) as {
      type: string;
      code: string;
      lastSequence: number;
    };
    expect(overflow).toMatchObject({ type: 'stream.error', code: 'stream_overflow' });
    // Sequence 0 was the one handed to the socket before it stopped accepting writes.
    expect(overflow.lastSequence).toBe(0);
  });
});

describe('PipenzoPhaseMachine publication', () => {
  it('announces a transition after both sides have committed', async () => {
    const { machine, events } = harness();

    await machine.transition(TICKET_ID, 'pipenzo:working');

    expect(events.retained).toHaveLength(1);
    expect(events.retained[0]).toMatchObject({
      ticketId: TICKET_ID,
      fromLane: 'queued',
      toLane: 'working',
      // Every `pipenzo:` label the ticket now carries, mirroring the record rather than a filtered
      // view of it -- the schema marker included, because that is what is on the issue.
      labels: ['pipenzo:working', 'pipenzo:schema-v1'],
    });
  });

  it('announces a label-only move, which keeps the lane but changes the card', async () => {
    const { machine, events } = harness({
      ticket: { lane: 'needs-human', labels: ['pipenzo:needs-human'] },
      issueLabels: ['pipenzo:needs-human'],
    });

    await machine.transition(TICKET_ID, 'pipenzo:interrupted');

    // Same lane both sides, and still an event: #80 draws `pipenzo:interrupted` differently from a
    // plain needs-human card, so a board that never heard about this renders the wrong one.
    expect(events.retained).toHaveLength(1);
    expect(events.retained[0]).toMatchObject({
      fromLane: 'needs-human',
      toLane: 'needs-human',
      labels: ['pipenzo:interrupted', 'pipenzo:schema-v1'],
    });
  });

  it('announces a read that reconciled, because that is a human editing the label on GitHub', async () => {
    const { machine, events } = harness({
      ticket: { lane: 'working', labels: ['pipenzo:working'] },
      issueLabels: ['pipenzo:needs-human'],
    });

    await machine.read(TICKET_ID);

    expect(events.retained).toHaveLength(1);
    expect(events.retained[0]).toMatchObject({ fromLane: 'working', toLane: 'needs-human' });
  });

  it('stays silent on a read that found both sides already in agreement', async () => {
    const { machine, events } = harness();

    await machine.read(TICKET_ID);

    // Nothing was rewritten, so there is nothing to announce.
    expect(events.retained).toHaveLength(0);
  });

  it('still transitions when no bus is wired at all', async () => {
    const tickets = new FileTicketStore(storeDirectory());
    tickets.create(makeTicket());
    const github = new FakeGitHubClient().seedIssue(makeIssue(['pipenzo:queued']));
    const machine = new PipenzoPhaseMachine({ tickets, github: () => github });

    const result = await machine.transition(TICKET_ID, 'pipenzo:working');

    expect(result.ticket.lane).toBe('working');
  });
});
