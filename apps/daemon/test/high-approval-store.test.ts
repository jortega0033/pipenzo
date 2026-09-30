import { describe, expect, it } from 'vitest';
import { HighApprovalStore } from '../src/high-approval-store.js';

const TICKET_A = '00000000-0000-4000-8000-00000000000a';
const TICKET_B = '00000000-0000-4000-8000-00000000000b';

describe('HighApprovalStore.capture', () => {
  it('returns a fresh id per call and holds one pending entry per capture', () => {
    const store = new HighApprovalStore();
    const id1 = store.capture({ ticketId: TICKET_A, branch: 'issue-94' });
    const id2 = store.capture({ ticketId: TICKET_A, branch: 'issue-94' });

    expect(id1).not.toBe(id2);
    expect(store.size).toBe(2);
  });
});

describe('HighApprovalStore.decide -- never proceeds without a reason (CLAUDE.md hard rule 3)', () => {
  it('refuses a reject with no reason at all -- the entry stays pending, not consumed', () => {
    const store = new HighApprovalStore();
    const id = store.capture({ ticketId: TICKET_A, branch: 'issue-94' });

    expect(store.decide(TICKET_A, id, 'reject')).toBeUndefined();
    expect(store.size).toBe(1); // still pending -- the refused call did not consume it

    // The same id can still be decided correctly afterward -- a bad call never poisons a good one.
    expect(store.decide(TICKET_A, id, 'reject', 'touches the auth migration path')).toMatchObject({
      decision: 'reject',
      reason: 'touches the auth migration path',
    });
  });

  it('refuses a reject with a whitespace-only reason', () => {
    const store = new HighApprovalStore();
    const id = store.capture({ ticketId: TICKET_A, branch: 'issue-94' });
    expect(store.decide(TICKET_A, id, 'reject', '   ')).toBeUndefined();
    expect(store.size).toBe(1);
  });

  it('trims the reason it records', () => {
    const store = new HighApprovalStore();
    const id = store.capture({ ticketId: TICKET_A, branch: 'issue-94' });
    const decided = store.decide(TICKET_A, id, 'reject', '  no CI coverage yet  ');
    expect(decided).toMatchObject({ decision: 'reject', reason: 'no CI coverage yet' });
  });

  it('approves with no reason at all -- approving a HIGH action needs no justification, only the explicit click', () => {
    const store = new HighApprovalStore();
    const id = store.capture({ ticketId: TICKET_A, branch: 'issue-94' });
    expect(store.decide(TICKET_A, id, 'approve')).toMatchObject({ decision: 'approve', reason: undefined });
  });

  it('every decision deletes the entry -- approve and reject alike, since HIGH never offers Undo', () => {
    const store = new HighApprovalStore();
    const approvedId = store.capture({ ticketId: TICKET_A, branch: 'issue-94' });
    const rejectedId = store.capture({ ticketId: TICKET_A, branch: 'issue-94' });

    store.decide(TICKET_A, approvedId, 'approve');
    store.decide(TICKET_A, rejectedId, 'reject', 'not today');

    expect(store.size).toBe(0);
  });

  it('refuses a second decide() on the same id (CLAUDE.md hard rule #4: a decision is not re-askable)', () => {
    const store = new HighApprovalStore();
    const id = store.capture({ ticketId: TICKET_A, branch: 'issue-94' });

    expect(store.decide(TICKET_A, id, 'approve')).toBeDefined();
    expect(store.decide(TICKET_A, id, 'reject', 'changed my mind')).toBeUndefined();
  });

  it("refuses decide() for the right approval id under the wrong ticket (cross-ticket isolation)", () => {
    const store = new HighApprovalStore();
    const id = store.capture({ ticketId: TICKET_A, branch: 'issue-94' });

    expect(store.decide(TICKET_B, id, 'approve')).toBeUndefined();
    // Still pending under its real ticket -- the wrong-ticket call did not consume it.
    expect(store.decide(TICKET_A, id, 'approve')).toBeDefined();
  });

  it('returns undefined for an unknown approval id', () => {
    const store = new HighApprovalStore();
    expect(store.decide(TICKET_A, 'not-a-real-id', 'approve')).toBeUndefined();
  });

  it(
    'there is no default decision -- every branch of decide() requires an explicit approve/reject the caller supplied',
    () => {
      // This test exists specifically to document, and assert, the property CLAUDE.md hard rule 3
      // and the ticket's own invariant both require: nothing in this module can be reached with an
      // implicit "yes". A capture()'d entry that nobody ever calls decide() on simply stays pending
      // forever -- there is no timeout, no default-allow, and no code path that treats "never
      // decided" as "approved".
      const store = new HighApprovalStore();
      const id = store.capture({ ticketId: TICKET_A, branch: 'issue-94' });
      expect(store.size).toBe(1);
      // Passing an empty-string reason on approve must not be mistaken for a decision either --
      // approve is unconditionally allowed through (it needs no reason), so this asserts *that*
      // remains true rather than silently drifting toward requiring one.
      expect(store.decide(TICKET_A, id, 'approve', '')).toMatchObject({ decision: 'approve' });
    },
  );
});
