import { describe, expect, it } from 'vitest';
import type { RefineEstimateV1 } from '@agent-dock/shared';
import {
  stackAcceptedCommentBody,
  stackProposedCommentBody,
  stackRejectedCommentBody,
} from '../src/pipenzo-phase-service.js';

describe('stackProposedCommentBody', () => {
  const estimate: RefineEstimateV1 = { changedLines: 212, filesTouched: 9, layered: true };

  it('names the estimate and the awaiting-stack-approval label', () => {
    const body = stackProposedCommentBody(estimate);
    expect(body).toContain('212');
    expect(body).toContain('9');
    expect(body).toContain('pipenzo:awaiting-stack-approval');
  });

  it('renders a numbered proposed split, in order, when one was given', () => {
    const body = stackProposedCommentBody(estimate, [
      { summary: 'Extract the shared schema', changedLines: 80, filesTouched: 3 },
      { summary: 'Wire the HTTP transport', changedLines: 70, filesTouched: 3 },
    ]);
    expect(body).toContain('Proposed split · 2 tickets, in this order');
    const first = body.indexOf('1. Extract the shared schema');
    const second = body.indexOf('2. Wire the HTTP transport');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  it('says no split was generated when none was given, rather than inventing one', () => {
    const body = stackProposedCommentBody(estimate);
    expect(body).not.toContain('Proposed split');
    expect(body).toContain('no proposed split was generated');
  });

  it('says the same for an explicitly empty split', () => {
    const body = stackProposedCommentBody(estimate, []);
    expect(body).not.toContain('Proposed split');
  });
});

describe('stackAcceptedCommentBody', () => {
  it('numbers every child in order and names the container framing', () => {
    const body = stackAcceptedCommentBody([
      { issueNumber: 201, title: 'Extract the shared schema' },
      { issueNumber: 202, title: 'Wire the HTTP transport' },
    ]);
    expect(body).toContain('Stack accepted -- 2 child tickets created');
    const first = body.indexOf('1. #201 -- Extract the shared schema');
    const second = body.indexOf('2. #202 -- Wire the HTTP transport');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(body).toContain('container');
    expect(body).toContain('gh stack');
  });

  it('uses singular "ticket" for exactly one child', () => {
    const body = stackAcceptedCommentBody([{ issueNumber: 201, title: 'One part' }]);
    expect(body).toContain('1 child ticket created');
  });
});

describe('stackRejectedCommentBody', () => {
  it('includes the reason verbatim and says the ticket stays parked', () => {
    const body = stackRejectedCommentBody('The schema extraction alone is bigger than it looks.');
    expect(body).toContain('Stack proposal rejected');
    expect(body).toContain('The schema extraction alone is bigger than it looks.');
    expect(body).toContain('pipenzo:awaiting-stack-approval');
    expect(body).toContain('no worktree was created');
  });
});
