import { describe, expect, it } from 'vitest';
import type { RefineEstimateV1 } from '@agent-dock/shared';
import { evaluateDiffSizeGate } from '../src/refine-gate.js';

function estimate(overrides: Partial<RefineEstimateV1> = {}): RefineEstimateV1 {
  return { changedLines: 0, filesTouched: 0, layered: false, ...overrides };
}

describe('evaluateDiffSizeGate', () => {
  it('accepts a one-PR-sized change: at or under 100 lines and 10 files', () => {
    expect(evaluateDiffSizeGate(estimate({ changedLines: 100, filesTouched: 10 }))).toBe('single');
    expect(evaluateDiffSizeGate(estimate({ changedLines: 0, filesTouched: 0 }))).toBe('single');
  });

  it('requires a stack, not a refusal, once past 100 lines or 10 files while layered and within 400/20', () => {
    expect(
      evaluateDiffSizeGate(estimate({ changedLines: 101, filesTouched: 5, layered: true })),
    ).toBe('stack');
    expect(
      evaluateDiffSizeGate(estimate({ changedLines: 50, filesTouched: 11, layered: true })),
    ).toBe('stack');
    expect(
      evaluateDiffSizeGate(estimate({ changedLines: 400, filesTouched: 20, layered: true })),
    ).toBe('stack');
  });

  it('refuses the 100-400/10-20 band when there is no clean layering', () => {
    expect(
      evaluateDiffSizeGate(estimate({ changedLines: 200, filesTouched: 12, layered: false })),
    ).toBe('refuse');
  });

  it('refuses anything past the 400-line/20-file ceiling regardless of layering', () => {
    expect(
      evaluateDiffSizeGate(estimate({ changedLines: 401, filesTouched: 5, layered: true })),
    ).toBe('refuse');
    expect(
      evaluateDiffSizeGate(estimate({ changedLines: 50, filesTouched: 21, layered: true })),
    ).toBe('refuse');
  });

  it('is a pure total order: never anything outside single/stack/refuse for any real estimate shape', () => {
    const samples = [
      estimate({ changedLines: 100, filesTouched: 11 }),
      estimate({ changedLines: 101, filesTouched: 10 }),
      estimate({ changedLines: 0, filesTouched: 0, layered: true }),
    ];
    for (const sample of samples) {
      expect(['single', 'stack', 'refuse']).toContain(evaluateDiffSizeGate(sample));
    }
  });
});
