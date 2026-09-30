import { describe, expect, it } from 'vitest';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import {
  groupActivityEntriesByDay,
  toActivityFeed,
} from '../../src/pipenzo/activity-grouping.js';

// Day-bucketing reads the local calendar day off each `Date`, deliberately (a human reads "Today"
// against their own clock, not UTC's) -- which means a test built from fixed UTC timestamps needs a
// fixed local timezone to be deterministic across machines/CI. Pinned here rather than left to
// whatever timezone the runner happens to be in.
process.env.TZ = 'UTC';

const REPO = 'jortega0033/pipenzo';

function makeTicket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: '00000000-0000-4000-8000-000000000001',
    repo: REPO,
    issueNumber: 116,
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

describe('toActivityFeed', () => {
  it('sorts tickets reverse-chronologically by updatedAt', () => {
    const oldest = makeTicket({ ticketId: 'a', updatedAt: '2026-09-04T10:00:00.000Z' });
    const middle = makeTicket({ ticketId: 'b', updatedAt: '2026-09-06T09:00:00.000Z' });
    const newest = makeTicket({ ticketId: 'c', updatedAt: '2026-09-06T14:12:00.000Z' });

    const { entries } = toActivityFeed([oldest, newest, middle]);

    expect(entries.map((entry) => entry.ticket.ticketId)).toEqual(['c', 'b', 'a']);
  });

  it("breaks an exact timestamp tie by ticketId, so ordering never depends on input order", () => {
    const tied = '2026-09-06T14:12:00.000Z';
    const first = makeTicket({ ticketId: 'zzz', updatedAt: tied });
    const second = makeTicket({ ticketId: 'aaa', updatedAt: tied });

    const { entries } = toActivityFeed([first, second]);

    expect(entries.map((entry) => entry.ticket.ticketId)).toEqual(['aaa', 'zzz']);
  });

  it('routes a ticket with no updatedAt yet into undated rather than dropping or mis-sorting it', () => {
    const neverReconciled = makeTicket({ ticketId: 'fresh' });
    const dated = makeTicket({ ticketId: 'seen', updatedAt: '2026-09-06T14:12:00.000Z' });

    const { entries, undated } = toActivityFeed([neverReconciled, dated]);

    expect(entries.map((entry) => entry.ticket.ticketId)).toEqual(['seen']);
    expect(undated.map((ticket) => ticket.ticketId)).toEqual(['fresh']);
  });

  it('routes an unparseable updatedAt into undated instead of throwing or sorting it as "now"', () => {
    const corrupt = makeTicket({ ticketId: 'corrupt', updatedAt: 'not-a-date' });

    const { entries, undated } = toActivityFeed([corrupt]);

    expect(entries).toHaveLength(0);
    expect(undated.map((ticket) => ticket.ticketId)).toEqual(['corrupt']);
  });

  it('includes a merged/closed ticket exactly like any other -- the merged-ticket case (#116)', () => {
    // A merged ticket keeps whatever lane it last had reconciled to (the board simply stops
    // rendering it because it has no lane-bearing label GitHub still asserts) -- Activity has no
    // separate "is this merged" signal to filter on, and shouldn't need one: every real ticket in
    // the store belongs here, board-visible or not.
    const merged = makeTicket({
      ticketId: 'merged-ticket',
      lane: 'ready-for-review',
      labels: [],
      updatedAt: '2026-09-06T08:55:00.000Z',
    });
    const stillOnBoard = makeTicket({
      ticketId: 'on-board',
      lane: 'working',
      updatedAt: '2026-09-06T09:00:00.000Z',
    });

    const { entries } = toActivityFeed([merged, stillOnBoard]);

    expect(entries.map((entry) => entry.ticket.ticketId)).toEqual(['on-board', 'merged-ticket']);
  });
});

describe('groupActivityEntriesByDay', () => {
  const now = new Date('2026-09-06T18:00:00.000Z');

  it('clusters entries by real calendar day across a multi-day range, preserving reverse-chronological order', () => {
    const tickets = [
      makeTicket({ ticketId: 'today-2', updatedAt: '2026-09-06T14:12:00.000Z' }),
      makeTicket({ ticketId: 'today-1', updatedAt: '2026-09-06T09:12:00.000Z' }),
      makeTicket({ ticketId: 'yesterday', updatedAt: '2026-09-05T20:00:00.000Z' }),
      makeTicket({ ticketId: 'last-week', updatedAt: '2026-08-30T12:00:00.000Z' }),
    ];
    const { entries } = toActivityFeed(tickets);

    const groups = groupActivityEntriesByDay(entries, now);

    expect(groups).toHaveLength(3);
    expect(groups[0]?.entries.map((entry) => entry.ticket.ticketId)).toEqual([
      'today-2',
      'today-1',
    ]);
    expect(groups[1]?.entries.map((entry) => entry.ticket.ticketId)).toEqual(['yesterday']);
    expect(groups[2]?.entries.map((entry) => entry.ticket.ticketId)).toEqual(['last-week']);
  });

  it('labels the current day "Today · <weekday> <day> <month>"', () => {
    const tickets = [makeTicket({ updatedAt: '2026-09-06T14:12:00.000Z' })];
    const { entries } = toActivityFeed(tickets);

    const groups = groupActivityEntriesByDay(entries, now);

    expect(groups[0]?.label).toBe('Today · Sun 6 Sep');
  });

  it('labels the day before "Yesterday · ..." and anything older with just the date', () => {
    const tickets = [
      makeTicket({ ticketId: 'y', updatedAt: '2026-09-05T20:00:00.000Z' }),
      makeTicket({ ticketId: 'older', updatedAt: '2026-08-30T12:00:00.000Z' }),
    ];
    const { entries } = toActivityFeed(tickets);

    const groups = groupActivityEntriesByDay(entries, now);

    expect(groups[0]?.label).toBe('Yesterday · Sat 5 Sep');
    expect(groups[1]?.label).toBe('Sun 30 Aug');
  });

  it('produces no groups for an empty entry list', () => {
    expect(groupActivityEntriesByDay([], now)).toEqual([]);
  });
});
