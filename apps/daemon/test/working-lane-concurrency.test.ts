import { describe, expect, it } from 'vitest';
import {
  computeWorkingLaneConcurrency,
  PIPENZO_DEFAULT_WORKING_CAPACITY,
  type WorkingLaneTicketV1,
} from '../src/working-lane-concurrency.js';

function ticket(
  ticketId: string,
  issueNumber: number,
  filesLikelyTouched: readonly string[],
): WorkingLaneTicketV1 {
  return { ticketId, issueNumber, filesLikelyTouched };
}

describe('PIPENZO_DEFAULT_WORKING_CAPACITY', () => {
  it("is README's documented default (2 tickets at once)", () => {
    expect(PIPENZO_DEFAULT_WORKING_CAPACITY).toBe(2);
  });
});

describe('computeWorkingLaneConcurrency', () => {
  it('runs every ticket when none of their predicted files overlap', () => {
    const result = computeWorkingLaneConcurrency([
      ticket('t94', 94, ['a.ts']),
      ticket('t97', 97, ['b.ts']),
    ]);
    expect(result.get('t94')).toEqual({ state: 'running' });
    expect(result.get('t97')).toEqual({ state: 'running' });
  });

  it('holds the later-numbered ticket when it overlaps a running one, naming the file and ticket', () => {
    const result = computeWorkingLaneConcurrency([
      ticket('t94', 94, ['stdio-mcp-connection.ts']),
      ticket('t97', 97, ['stdio-mcp-connection.ts', 'other.ts']),
    ]);
    expect(result.get('t94')).toEqual({ state: 'running' });
    expect(result.get('t97')).toEqual({
      state: 'held',
      overlapTicketId: 't94',
      overlapIssueNumber: 94,
      overlapFile: 'stdio-mcp-connection.ts',
    });
  });

  it('orders by ascending issue number regardless of input order, since there is no real dispatch timestamp', () => {
    // #97 given first in the input array, but #94 is the lower issue number and should be the one
    // that "claims the slot" -- see the module's own doc comment on why issue number is the stand-in.
    const result = computeWorkingLaneConcurrency([
      ticket('t97', 97, ['shared.ts']),
      ticket('t94', 94, ['shared.ts']),
    ]);
    expect(result.get('t94')).toEqual({ state: 'running' });
    expect(result.get('t97')).toMatchObject({ state: 'held', overlapTicketId: 't94' });
  });

  it('chains holds transitively -- a third ticket overlapping only the held one is held against the running ticket it actually shares a file with', () => {
    const result = computeWorkingLaneConcurrency([
      ticket('t1', 1, ['a.ts']),
      ticket('t2', 2, ['a.ts', 'b.ts']),
      ticket('t3', 3, ['b.ts']),
    ]);
    expect(result.get('t1')).toEqual({ state: 'running' });
    expect(result.get('t2')).toMatchObject({ state: 'held', overlapTicketId: 't1' });
    // t3 shares nothing with t1 (the only ticket actually running) -- t2 never joins `running`
    // because it was held itself, so t3 is not serialised against it.
    expect(result.get('t3')).toEqual({ state: 'running' });
  });

  it('holds a ticket that overlaps two running tickets against the first one, in order', () => {
    const result = computeWorkingLaneConcurrency([
      ticket('t1', 1, ['a.ts']),
      ticket('t2', 2, ['b.ts']),
      ticket('t3', 3, ['a.ts', 'b.ts']),
    ]);
    expect(result.get('t1')).toEqual({ state: 'running' });
    expect(result.get('t2')).toEqual({ state: 'running' });
    expect(result.get('t3')).toMatchObject({ overlapTicketId: 't1', overlapFile: 'a.ts' });
  });

  it('runs every ticket with no predicted files at all', () => {
    const result = computeWorkingLaneConcurrency([ticket('t1', 1, []), ticket('t2', 2, [])]);
    expect(result.get('t1')).toEqual({ state: 'running' });
    expect(result.get('t2')).toEqual({ state: 'running' });
  });

  it('returns an empty map for an empty input', () => {
    expect(computeWorkingLaneConcurrency([]).size).toBe(0);
  });
});
