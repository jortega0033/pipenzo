import { describe, expect, it } from 'vitest';
import {
  evaluateFileOverlapGate,
  findOverlappingFiles,
  type FileOverlapCandidateV1,
} from '../src/file-overlap-gate.js';

function candidate(ticketId: string, filesLikelyTouched: readonly string[]): FileOverlapCandidateV1 {
  return { ticketId, filesLikelyTouched };
}

describe('findOverlappingFiles', () => {
  it('returns the shared paths in first-seen order from the first list', () => {
    expect(findOverlappingFiles(['a.ts', 'b.ts', 'c.ts'], ['c.ts', 'a.ts'])).toEqual(['a.ts', 'c.ts']);
  });

  it('returns an empty array for disjoint lists', () => {
    expect(findOverlappingFiles(['a.ts'], ['b.ts'])).toEqual([]);
  });

  it('returns an empty array when either list is empty', () => {
    expect(findOverlappingFiles([], ['a.ts'])).toEqual([]);
    expect(findOverlappingFiles(['a.ts'], [])).toEqual([]);
    expect(findOverlappingFiles([], [])).toEqual([]);
  });

  it('deduplicates a path repeated within the first list', () => {
    expect(findOverlappingFiles(['a.ts', 'a.ts'], ['a.ts'])).toEqual(['a.ts']);
  });

  it('treats paths as exact strings, not directory prefixes', () => {
    expect(findOverlappingFiles(['src/foo.ts'], ['src/foo/bar.ts'])).toEqual([]);
  });

  it('is case-sensitive, matching git’s own path comparison', () => {
    expect(findOverlappingFiles(['src/Foo.ts'], ['src/foo.ts'])).toEqual([]);
  });
});

describe('evaluateFileOverlapGate', () => {
  it('runs a candidate with no in-flight tickets', () => {
    const verdict = evaluateFileOverlapGate(candidate('t1', ['a.ts']), []);
    expect(verdict).toEqual({ decision: 'run', overlappingTicketIds: [], overlappingFiles: [] });
  });

  it('runs a candidate whose files share nothing with any in-flight ticket', () => {
    const verdict = evaluateFileOverlapGate(candidate('t1', ['a.ts']), [
      candidate('t2', ['b.ts']),
      candidate('t3', ['c.ts']),
    ]);
    expect(verdict.decision).toBe('run');
    expect(verdict.overlappingTicketIds).toEqual([]);
  });

  it('holds a candidate that shares a file with exactly one in-flight ticket', () => {
    const verdict = evaluateFileOverlapGate(candidate('t1', ['a.ts', 'b.ts']), [
      candidate('t2', ['b.ts', 'c.ts']),
    ]);
    expect(verdict.decision).toBe('hold');
    expect(verdict.overlappingTicketIds).toEqual(['t2']);
    expect(verdict.overlappingFiles).toEqual(['b.ts']);
  });

  it('reports every overlapping in-flight ticket, not just the first', () => {
    const verdict = evaluateFileOverlapGate(candidate('t1', ['a.ts', 'b.ts']), [
      candidate('t2', ['a.ts']),
      candidate('t3', ['x.ts']),
      candidate('t4', ['b.ts']),
    ]);
    expect(verdict.decision).toBe('hold');
    expect(verdict.overlappingTicketIds).toEqual(['t2', 't4']);
    expect(verdict.overlappingFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('deduplicates overlappingFiles across multiple in-flight tickets sharing the same path', () => {
    const verdict = evaluateFileOverlapGate(candidate('t1', ['a.ts']), [
      candidate('t2', ['a.ts']),
      candidate('t3', ['a.ts']),
    ]);
    expect(verdict.overlappingTicketIds).toEqual(['t2', 't3']);
    expect(verdict.overlappingFiles).toEqual(['a.ts']);
  });

  it('never serialises a ticket against itself, even if the snapshot includes the candidate', () => {
    const verdict = evaluateFileOverlapGate(candidate('t1', ['a.ts']), [
      candidate('t1', ['a.ts']),
      candidate('t2', ['x.ts']),
    ]);
    expect(verdict.decision).toBe('run');
    expect(verdict.overlappingTicketIds).toEqual([]);
  });

  it('runs when the candidate has no predicted files at all', () => {
    const verdict = evaluateFileOverlapGate(candidate('t1', []), [candidate('t2', ['a.ts'])]);
    expect(verdict.decision).toBe('run');
  });

  it('runs when an in-flight ticket has no predicted files at all', () => {
    const verdict = evaluateFileOverlapGate(candidate('t1', ['a.ts']), [candidate('t2', [])]);
    expect(verdict.decision).toBe('run');
  });
});
