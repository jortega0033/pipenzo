import { describe, expect, it } from 'vitest';
import type { RefineEstimateV1 } from '@agent-dock/shared';
import { refusalCommentBody } from '../src/pipenzo-phase-service.js';

describe('refusalCommentBody', () => {
  it('names the estimate and the ceiling reason when past 400 lines or 20 files', () => {
    const estimate: RefineEstimateV1 = { changedLines: 900, filesTouched: 40, layered: false };
    const body = refusalCommentBody(estimate);
    expect(body).toContain('900');
    expect(body).toContain('40');
    expect(body).toContain('400-line');
    expect(body).toContain('pipenzo:needs-pre-scoping');
  });

  it('names the layering reason for a refusal inside the 100-400/10-20 band', () => {
    const estimate: RefineEstimateV1 = { changedLines: 200, filesTouched: 12, layered: false };
    const body = refusalCommentBody(estimate);
    expect(body).toContain('200');
    expect(body).toContain('12');
    expect(body).toContain('no clean layering');
    expect(body).toContain('pipenzo:needs-pre-scoping');
  });

  it('says nothing was written and no runs were spent', () => {
    const body = refusalCommentBody({ changedLines: 900, filesTouched: 40, layered: false });
    expect(body).toContain('Nothing was written');
  });

  describe('proposedSplit (issue #271)', () => {
    const estimate: RefineEstimateV1 = { changedLines: 900, filesTouched: 40, layered: false };

    it('says nothing about a split when none was given', () => {
      const body = refusalCommentBody(estimate);
      expect(body).not.toContain('Proposed split');
    });

    it('says nothing about a split when given an empty one', () => {
      const body = refusalCommentBody(estimate, []);
      expect(body).not.toContain('Proposed split');
    });

    it('renders a numbered list, in order, when a real split is given', () => {
      const body = refusalCommentBody(estimate, [
        { summary: 'Extract the shared validation helper', changedLines: 80, filesTouched: 2 },
        { summary: 'Wire the new endpoint through it', changedLines: 140, filesTouched: 5 },
      ]);
      expect(body).toContain('Proposed split · 2 tickets, in this order');
      const first = body.indexOf('1. Extract the shared validation helper');
      const second = body.indexOf('2. Wire the new endpoint through it');
      expect(first).toBeGreaterThan(-1);
      expect(second).toBeGreaterThan(first);
      expect(body).toContain('(≈80 lines, 2 files)');
      expect(body).toContain('(≈140 lines, 5 files)');
    });

    it('still says nothing was written even with a split attached', () => {
      const body = refusalCommentBody(estimate, [
        { summary: 'One part', changedLines: 10, filesTouched: 1 },
      ]);
      expect(body).toContain('Nothing was written');
    });
  });
});
