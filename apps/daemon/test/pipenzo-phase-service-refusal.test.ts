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
});
