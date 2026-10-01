import { describe, expect, it } from 'vitest';
import type { RefineSpecV1 } from '@agent-dock/shared';
import { PlanReviewStore } from '../src/plan-review-store.js';

const TICKET_ID = 'ticket-1';

function spec(overrides: Partial<RefineSpecV1> = {}): RefineSpecV1 {
  return {
    schemaVersion: 1,
    issue: { repo: 'jortega0033/pipenzo', number: 98, title: 'Persist poll ETags' },
    summary: 'Persist poll ETags per repo and resource in the ticket store.',
    acceptanceCriteria: [
      {
        id: 'AC-1',
        kind: 'event',
        text: "When a poll for a repo's issues completes, the reconciler shall store the response ETag.",
      },
    ],
    outOfScope: ['The secondary-limit and Retry-After handling.'],
    filesLikelyTouched: ['apps/daemon/src/github-reconciler.ts'],
    estimate: { changedLines: 38, filesTouched: 2, layered: false },
    openQuestions: [],
    ...overrides,
  };
}

describe('PlanReviewStore', () => {
  it('captures the whole spec and mints a fresh approval id each time', () => {
    const store = new PlanReviewStore();
    const plan = spec();
    const first = store.capture(TICKET_ID, plan);
    const second = store.capture(TICKET_ID, plan);
    expect(first).not.toBe(second);
    expect(store.size).toBe(2);
  });

  it('consume: returns the exact spec that was captured, by identity', () => {
    const store = new PlanReviewStore();
    const plan = spec();
    const approvalId = store.capture(TICKET_ID, plan);

    const entry = store.consume(TICKET_ID, approvalId);

    expect(entry).toBeDefined();
    expect(entry!.ticketId).toBe(TICKET_ID);
    expect(entry!.spec).toBe(plan);
  });

  it('consume: refuses (and does not remove) an entry for the wrong ticket', () => {
    const store = new PlanReviewStore();
    const approvalId = store.capture(TICKET_ID, spec());

    expect(store.consume('some-other-ticket', approvalId)).toBeUndefined();
    expect(store.size).toBe(1);

    // A real consume for the right ticket still works afterward -- the wrong-ticket attempt did
    // not spend it.
    expect(store.consume(TICKET_ID, approvalId)).toBeDefined();
  });

  it('refuses a second consume on the same approval id -- a decision is never re-askable', () => {
    const store = new PlanReviewStore();
    const approvalId = store.capture(TICKET_ID, spec());

    const first = store.consume(TICKET_ID, approvalId);
    const second = store.consume(TICKET_ID, approvalId);

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('refuses an unknown approval id', () => {
    const store = new PlanReviewStore();
    expect(store.consume(TICKET_ID, '00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });

  it('peek reads without consuming', () => {
    const store = new PlanReviewStore();
    const plan = spec();
    const approvalId = store.capture(TICKET_ID, plan);

    expect(store.peek(TICKET_ID, approvalId)?.spec).toBe(plan);
    expect(store.size).toBe(1);
    // Still consumable afterward -- peek never spends the entry.
    expect(store.consume(TICKET_ID, approvalId)).toBeDefined();
  });
});
