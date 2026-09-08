import { describe, expect, it } from 'vitest';
import type { ReviewReportV1 } from '@agent-dock/shared';
import { blownEstimateCommentBody } from '../src/pipenzo-phase-service.js';

const SHA = 'a'.repeat(40);

function report(overrides: Partial<ReviewReportV1> = {}): ReviewReportV1 {
  return {
    schemaVersion: 1,
    outcome: 'estimate_blown',
    baseCommit: SHA,
    headCommit: SHA,
    implementerTier: 'mid',
    deterministic: [],
    diffScope: {
      implementation: { changedLines: 900, filesTouched: 4 },
      generatedTests: { changedLines: 0, filesTouched: 0 },
      estimate: { changedLines: 200, filesTouched: 3 },
      exceededEstimate: true,
      ratio: 4.5,
    },
    ...overrides,
  };
}

describe('blownEstimateCommentBody', () => {
  it('names the ratio and the predicted/actual numbers', () => {
    const body = blownEstimateCommentBody(report());
    expect(body).toContain('4.50x');
    expect(body).toContain('200');
    expect(body).toContain('900');
    expect(body).toContain('3');
    expect(body).toContain('4');
    expect(body).toContain('pipenzo:awaiting-stack-approval');
  });

  it('falls back to a plain statement rather than asserting numbers it does not have, if diffScope is somehow absent', () => {
    const body = blownEstimateCommentBody(report({ diffScope: undefined }));
    expect(body).toContain('50%');
    expect(body).toContain('pipenzo:awaiting-stack-approval');
    expect(body).not.toMatch(/\d+x/);
  });
});
