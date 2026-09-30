import { describe, expect, it } from 'vitest';
import { PIPENZO_LABEL_LANES, PIPENZO_LANES, type PipenzoLaneV1 } from '@agent-dock/shared';
import {
  BOARD_LANES,
  LANE_DRAG_LABEL,
  resolveBoardCardDrop,
  ticketsByLane,
} from '../../src/pipenzo/board-lanes.js';

describe('BOARD_LANES', () => {
  it('lists exactly the four lanes from the shared phase-machine contract, in its own order', () => {
    expect(BOARD_LANES.map((config) => config.lane)).toEqual([...PIPENZO_LANES]);
  });

  it('never lists a lane the shared label-lane map does not also point at', () => {
    // The single-source-of-truth property #81 asks for: every lane this board can show is one a
    // real `pipenzo:` label actually maps to, per `PIPENZO_LABEL_LANES` -- nothing here invents a
    // lane the phase machine could never produce.
    const lanesFromLabels = new Set(Object.values(PIPENZO_LABEL_LANES).filter(Boolean));
    for (const config of BOARD_LANES) {
      expect(lanesFromLabels.has(config.lane)).toBe(true);
    }
  });

  it('gives every lane a distinct title, dot color and empty-state copy', () => {
    const titles = BOARD_LANES.map((config) => config.title);
    const dotColors = BOARD_LANES.map((config) => config.dotColor);
    expect(new Set(titles).size).toBe(BOARD_LANES.length);
    expect(new Set(dotColors).size).toBe(BOARD_LANES.length);
    for (const config of BOARD_LANES) {
      expect(config.emptyTitle.length).toBeGreaterThan(0);
      expect(config.emptySub.length).toBeGreaterThan(0);
    }
  });

  it("labels the columns with Main.dc.html's own Board-screen text", () => {
    expect(BOARD_LANES.map((config) => config.title)).toEqual([
      'Queued',
      'Working',
      'Ready for review',
      'Needs human',
    ]);
  });
});

describe('ticketsByLane', () => {
  it('groups tickets by their own lane field, preserving arrival order within a lane', () => {
    const tickets = [
      { id: 'a', lane: 'queued' as PipenzoLaneV1 },
      { id: 'b', lane: 'working' as PipenzoLaneV1 },
      { id: 'c', lane: 'queued' as PipenzoLaneV1 },
      { id: 'd', lane: 'needs-human' as PipenzoLaneV1 },
    ];
    const grouped = ticketsByLane(tickets);
    expect(grouped.queued.map((t) => t.id)).toEqual(['a', 'c']);
    expect(grouped.working.map((t) => t.id)).toEqual(['b']);
    expect(grouped['ready-for-review']).toEqual([]);
    expect(grouped['needs-human'].map((t) => t.id)).toEqual(['d']);
  });

  it('returns every lane, even with no tickets at all', () => {
    const grouped = ticketsByLane([]);
    for (const lane of PIPENZO_LANES) {
      expect(grouped[lane]).toEqual([]);
    }
  });
});

describe('LANE_DRAG_LABEL (issue #82)', () => {
  it('names a real pipenzo: label for every lane, and only that lane maps to it', () => {
    for (const lane of PIPENZO_LANES) {
      const label = LANE_DRAG_LABEL[lane];
      expect(PIPENZO_LABEL_LANES[label]).toBe(lane);
    }
  });

  it('writes the one generic label for a manual drag onto Needs-human, not one of the five automation-specific ones', () => {
    // README's own five Needs-human labels (`needs-human`, `needs-pre-scoping`,
    // `awaiting-stack-approval`, `ci-failed`, `interrupted`) all render in that column, but only
    // one of them makes sense coming from a human's drag rather than automation reporting why it
    // stopped -- see this constant's own module comment.
    expect(LANE_DRAG_LABEL['needs-human']).toBe('pipenzo:needs-human');
  });

  it('is total over the four board lanes, same order as BOARD_LANES', () => {
    expect(Object.keys(LANE_DRAG_LABEL)).toEqual(BOARD_LANES.map((config) => config.lane));
  });
});

describe('resolveBoardCardDrop (issue #82)', () => {
  const tickets = [
    { ticketId: 'a', lane: 'queued' as PipenzoLaneV1 },
    { ticketId: 'b', lane: 'working' as PipenzoLaneV1 },
  ];

  it('resolves the dragged ticket and the lane it was dropped on', () => {
    expect(resolveBoardCardDrop(tickets, 'a', 'working')).toEqual({
      ticket: tickets[0],
      targetLane: 'working',
    });
  });

  it('is a no-op when the card was dropped back on its own lane', () => {
    expect(resolveBoardCardDrop(tickets, 'b', 'working')).toBeUndefined();
  });

  it('is a no-op when the drag ended outside any droppable lane', () => {
    expect(resolveBoardCardDrop(tickets, 'a', undefined)).toBeUndefined();
  });

  it('is a no-op for a ticket id the board no longer knows about', () => {
    expect(resolveBoardCardDrop(tickets, 'stale-id', 'working')).toBeUndefined();
  });
});
