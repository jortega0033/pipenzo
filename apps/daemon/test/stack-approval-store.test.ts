import { describe, expect, it } from 'vitest';
import type { RefineProposedSplitPartV1 } from '@agent-dock/shared';
import { StackApprovalStore, isIndexPermutation } from '../src/stack-approval-store.js';

const TICKET_ID = 'ticket-1';
const PARTS: RefineProposedSplitPartV1[] = [
  { summary: 'Part A', changedLines: 100, filesTouched: 3 },
  { summary: 'Part B', changedLines: 120, filesTouched: 4 },
  { summary: 'Part C', changedLines: 90, filesTouched: 2 },
];

describe('isIndexPermutation', () => {
  it('accepts an exact-length permutation', () => {
    expect(isIndexPermutation([2, 0, 1], 3)).toBe(true);
    expect(isIndexPermutation([0, 1, 2], 3)).toBe(true);
  });

  it('rejects a wrong length', () => {
    expect(isIndexPermutation([0, 1], 3)).toBe(false);
    expect(isIndexPermutation([0, 1, 2, 0], 3)).toBe(false);
  });

  it('rejects a repeated index', () => {
    expect(isIndexPermutation([0, 0, 1], 3)).toBe(false);
  });

  it('rejects an out-of-range index', () => {
    expect(isIndexPermutation([0, 1, 3], 3)).toBe(false);
    expect(isIndexPermutation([-1, 1, 2], 3)).toBe(false);
  });

  it('rejects a non-integer', () => {
    expect(isIndexPermutation([0.5, 1, 2], 3)).toBe(false);
  });
});

describe('StackApprovalStore', () => {
  it('captures the parts and mints a fresh approval id each time', () => {
    const store = new StackApprovalStore();
    const first = store.capture(TICKET_ID, PARTS);
    const second = store.capture(TICKET_ID, PARTS);
    expect(first).not.toBe(second);
    expect(store.size).toBe(2);
  });

  it('accept: reorders the captured parts exactly as the permutation says, and never a different set', () => {
    const store = new StackApprovalStore();
    const approvalId = store.capture(TICKET_ID, PARTS);

    const decision = store.decide(TICKET_ID, approvalId, 'accept', { order: [2, 0, 1] });

    expect(decision).toEqual({
      kind: 'accept',
      ticketId: TICKET_ID,
      orderedParts: [PARTS[2], PARTS[0], PARTS[1]],
    });
  });

  it('accept: refuses an order that is not an exact permutation of the captured parts (bounded fan-out)', () => {
    const store = new StackApprovalStore();
    const approvalId = store.capture(TICKET_ID, PARTS);

    // Fewer entries than captured.
    expect(store.decide(TICKET_ID, approvalId, 'accept', { order: [0, 1] })).toBeUndefined();
    // A repeated index -- would create fewer real tickets than the count implies, silently.
    expect(store.decide(TICKET_ID, approvalId, 'accept', { order: [0, 0, 1] })).toBeUndefined();
    // An out-of-range index -- cannot reference a part that was never captured.
    expect(store.decide(TICKET_ID, approvalId, 'accept', { order: [0, 1, 9] })).toBeUndefined();
    // Missing order entirely.
    expect(store.decide(TICKET_ID, approvalId, 'accept', {})).toBeUndefined();

    // None of the above consumed the entry -- a real accept still works afterward.
    expect(store.decide(TICKET_ID, approvalId, 'accept', { order: [0, 1, 2] })).toEqual({
      kind: 'accept',
      ticketId: TICKET_ID,
      orderedParts: PARTS,
    });
  });

  it('reject: requires a non-blank reason, and is refused (not consumed) without one', () => {
    const store = new StackApprovalStore();
    const approvalId = store.capture(TICKET_ID, PARTS);

    expect(store.decide(TICKET_ID, approvalId, 'reject', {})).toBeUndefined();
    expect(store.decide(TICKET_ID, approvalId, 'reject', { reason: '   ' })).toBeUndefined();

    const decision = store.decide(TICKET_ID, approvalId, 'reject', { reason: '  too risky  ' });
    expect(decision).toEqual({ kind: 'reject', ticketId: TICKET_ID, reason: 'too risky' });
  });

  it('refuses to decide for a wrong ticket id', () => {
    const store = new StackApprovalStore();
    const approvalId = store.capture(TICKET_ID, PARTS);
    expect(store.decide('some-other-ticket', approvalId, 'accept', { order: [0, 1, 2] })).toBeUndefined();
  });

  it('refuses a second decide on the same approval id -- a decision is never re-askable', () => {
    const store = new StackApprovalStore();
    const approvalId = store.capture(TICKET_ID, PARTS);

    const first = store.decide(TICKET_ID, approvalId, 'accept', { order: [0, 1, 2] });
    const second = store.decide(TICKET_ID, approvalId, 'reject', { reason: 'too late' });

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('refuses an unknown approval id', () => {
    const store = new StackApprovalStore();
    expect(
      store.decide(TICKET_ID, '00000000-0000-4000-8000-000000000000', 'accept', { order: [0] }),
    ).toBeUndefined();
  });
});
