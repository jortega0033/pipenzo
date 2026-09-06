import { describe, expect, it } from 'vitest';
import type { DiffScopeV1, LlmReviewPassV1, VerifierPassV1 } from '@agent-dock/shared';
import {
  combineFindings,
  findingLocation,
  formatDiffScopeSummary,
  gateTone,
  mapFindingSeverity,
  tallyFindings,
  verifierStandingText,
} from '../../src/pipenzo/rail.js';

describe('gateTone', () => {
  it('maps passed to ok, skipped to warn, and failed/errored to danger', () => {
    expect(gateTone('passed')).toBe('ok');
    expect(gateTone('skipped')).toBe('warn');
    expect(gateTone('failed')).toBe('danger');
    expect(gateTone('errored')).toBe('danger');
  });
});

describe('mapFindingSeverity', () => {
  it('maps high to critical and medium to warning', () => {
    expect(mapFindingSeverity('high')).toBe('critical');
    expect(mapFindingSeverity('medium')).toBe('warning');
  });

  it('collapses low and info into the info UI tone', () => {
    expect(mapFindingSeverity('low')).toBe('info');
    expect(mapFindingSeverity('info')).toBe('info');
  });
});

const REVIEWER: LlmReviewPassV1 = {
  sessionId: 'reviewer-session',
  tier: 'mid',
  model: 'sonnet',
  findings: [
    { severity: 'medium', message: 'a warning from the reviewer', path: 'a.ts', line: 5 },
    { severity: 'info', message: 'an info note from the reviewer' },
  ],
};

const VERIFIER: VerifierPassV1 = {
  sessionId: 'verifier-session',
  tier: 'frontier',
  model: 'opus',
  verdict: 'approved',
  vendorDiversityUnavailable: false,
  findings: [{ severity: 'high', message: 'a critical from the verifier', path: 'b.ts', line: 10 }],
};

describe('combineFindings', () => {
  it('merges reviewer and verifier findings into one list', () => {
    expect(combineFindings(REVIEWER, VERIFIER)).toHaveLength(3);
  });

  it('sorts critical first, then warning, then info, preserving arrival order within a tier', () => {
    const combined = combineFindings(REVIEWER, VERIFIER);
    expect(combined.map((finding) => finding.severity)).toEqual(['critical', 'warning', 'info']);
    expect(combined[0]?.message).toBe('a critical from the verifier');
  });

  it('tags each finding with which pass produced it', () => {
    const combined = combineFindings(REVIEWER, VERIFIER);
    expect(combined.find((finding) => finding.message.includes('critical'))?.source).toBe('verifier');
    expect(combined.find((finding) => finding.message.includes('warning'))?.source).toBe('reviewer');
  });

  it('returns an empty list when neither pass ran', () => {
    expect(combineFindings(undefined, undefined)).toEqual([]);
  });
});

describe('tallyFindings', () => {
  it('counts each UI severity tier', () => {
    const combined = combineFindings(REVIEWER, VERIFIER);
    expect(tallyFindings(combined)).toEqual({ critical: 1, warning: 1, info: 1 });
  });
});

describe('findingLocation', () => {
  it('renders path:line when both are present', () => {
    expect(findingLocation({ severity: 'critical', source: 'verifier', message: 'm', path: 'a.ts', line: 76 })).toBe(
      'a.ts:76',
    );
  });

  it('renders just the path when there is no line', () => {
    expect(findingLocation({ severity: 'info', source: 'reviewer', message: 'm', path: 'a.ts' })).toBe('a.ts');
  });

  it('returns undefined when the finding is not about a specific file', () => {
    expect(findingLocation({ severity: 'info', source: 'reviewer', message: 'm' })).toBeUndefined();
  });
});

const DIFF_SCOPE: DiffScopeV1 = {
  implementation: { changedLines: 8, filesTouched: 1 },
  generatedTests: { changedLines: 44, filesTouched: 1 },
  estimate: { changedLines: 60, filesTouched: 2 },
  exceededEstimate: false,
  ratio: 8 / 60,
};

describe('formatDiffScopeSummary', () => {
  it('reports the implementation total against the estimate and the test total separately', () => {
    expect(formatDiffScopeSummary(DIFF_SCOPE)).toMatchObject({
      statusText: 'Diff scope within the Refine estimate',
      detailText: '+8 of ≤ 60 implementation · +44 generated tests, reported separately',
    });
  });

  /**
   * Issue #145. `DiffScopeV1` carries `filesTouched` on both halves and on the estimate, and a
   * summary that reported only line counts threw away half of what was measured.
   */
  it('reports lines and files for each half, never merged into one count', () => {
    const summary = formatDiffScopeSummary(DIFF_SCOPE);
    expect(summary.implementationText).toBe('Implementation: 8 lines across 1 file');
    expect(summary.generatedTestsText).toBe('Generated tests: 44 lines across 1 file');
  });

  /**
   * The point of the split, said out loud. Two numbers beside a 60-line estimate do not on their
   * own tell a reader which one the gate judged -- and a reader who guesses wrong concludes the
   * ticket blew its estimate because its generated tests were large, which is exactly the
   * misreading the split exists to prevent.
   */
  it('states which half the estimate was measured against', () => {
    const summary = formatDiffScopeSummary(DIFF_SCOPE);
    expect(summary.measuredAgainstText).toContain('60-line / 2-file estimate');
    expect(summary.measuredAgainstText).toContain('implementation half only');
    expect(summary.measuredAgainstText).toContain('never charged to the estimate');
  });

  it('pluralises a single changed line and a single file correctly', () => {
    const single = formatDiffScopeSummary({
      ...DIFF_SCOPE,
      implementation: { changedLines: 1, filesTouched: 1 },
      generatedTests: { changedLines: 0, filesTouched: 0 },
    });
    expect(single.implementationText).toBe('Implementation: 1 line across 1 file');
    expect(single.generatedTestsText).toBe('Generated tests: 0 lines across 0 files');
  });

  it('reports an exceeded estimate distinctly from within-budget', () => {
    const exceeded = { ...DIFF_SCOPE, exceededEstimate: true };
    expect(formatDiffScopeSummary(exceeded).statusText).toBe('Diff scope exceeded the Refine estimate');
  });
});

/**
 * Issue #147. README requires that a run whose cross-vendor tiebreak had nothing to work with be
 * *recorded on the run* -- a verifier that could not be cross-vendor is a weaker check, and the
 * evidence block must not imply otherwise.
 */
describe('verifierStandingText', () => {
  const verifier = (overrides: Partial<VerifierPassV1> = {}): VerifierPassV1 => ({
    sessionId: 's',
    tier: 'frontier',
    model: 'opus',
    verdict: 'approved',
    vendorDiversityUnavailable: false,
    findings: [],
    ...overrides,
  });

  it('states the tier relationship rather than leaving a reader to work it out', () => {
    expect(verifierStandingText(verifier(), 'mid')).toContain(
      "above the implementer's mid tier",
    );
    expect(verifierStandingText(verifier({ tier: 'mid' }), 'mid')).toContain(
      "at the implementer's mid tier",
    );
  });

  it('says a same-vendor verifier is a weaker check, in words', () => {
    const text = verifierStandingText(verifier({ vendorDiversityUnavailable: true }), 'mid');
    expect(text).toContain('cross-vendor diversity was unavailable');
    expect(text).toContain('weaker check');
  });

  it('says nothing about weakness when the tiebreak was honoured', () => {
    const text = verifierStandingText(verifier(), 'mid');
    expect(text).toContain('a different vendor from the implementer');
    expect(text).not.toContain('weaker check');
  });
});
