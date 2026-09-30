import { describe, expect, it } from 'vitest';
import type { ReviewReportV1 } from '@agent-dock/shared';
import { countLessonsForRepo, deriveLessonPrefill } from '../../src/pipenzo/lesson-prompt.js';

function report(overrides: Partial<ReviewReportV1> = {}): ReviewReportV1 {
  return {
    schemaVersion: 1,
    outcome: 'approved',
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    implementerTier: 'mid',
    risk: 'low',
    deterministic: [{ id: 'build', status: 'passed', summary: 'ok', durationMs: 10 }],
    verifier: {
      sessionId: 's1',
      tier: 'mid',
      model: 'verifier-model',
      verdict: 'approved',
      vendorDiversityUnavailable: false,
      findings: [],
    },
    ...overrides,
  };
}

describe('deriveLessonPrefill', () => {
  it('returns an empty string when there is no report yet', () => {
    expect(deriveLessonPrefill(undefined)).toBe('');
  });

  it('draws from the highest-severity real finding either LLM pass reported', () => {
    const withFindings = report({
      reviewer: {
        sessionId: 's0',
        tier: 'mid',
        model: 'reviewer-model',
        findings: [{ severity: 'info', message: 'a minor style nit' }],
      },
      verifier: {
        sessionId: 's1',
        tier: 'mid',
        model: 'verifier-model',
        verdict: 'approved',
        vendorDiversityUnavailable: false,
        findings: [
          { severity: 'medium', message: 'On Windows the host sets Path, not PATH.' },
        ],
      },
    });
    expect(deriveLessonPrefill(withFindings)).toBe('On Windows the host sets Path, not PATH.');
  });

  it('falls back to a blown diff-scope estimate when there are no findings', () => {
    const blownEstimate = report({
      diffScope: {
        implementation: { changedLines: 620, filesTouched: 5 },
        generatedTests: { changedLines: 80, filesTouched: 1 },
        estimate: { changedLines: 400, filesTouched: 4 },
        exceededEstimate: true,
        ratio: 1.55,
      },
    });
    expect(deriveLessonPrefill(blownEstimate)).toBe(
      "This run's diff came in at 620 lines against a 400-line Refine estimate.",
    );
  });

  it('never fabricates text when the run genuinely hit nothing notable', () => {
    const clean = report({
      diffScope: {
        implementation: { changedLines: 60, filesTouched: 2 },
        generatedTests: { changedLines: 20, filesTouched: 1 },
        estimate: { changedLines: 400, filesTouched: 4 },
        exceededEstimate: false,
        ratio: 0.15,
      },
    });
    expect(deriveLessonPrefill(clean)).toBe('');
    expect(deriveLessonPrefill(report())).toBe('');
  });

  it('truncates an overlong finding to the lesson text schema cap of 500 characters', () => {
    const longMessage = 'x'.repeat(600);
    const withLongFinding = report({
      verifier: {
        sessionId: 's1',
        tier: 'mid',
        model: 'verifier-model',
        verdict: 'approved',
        vendorDiversityUnavailable: false,
        findings: [{ severity: 'high', message: longMessage }],
      },
    });
    expect(deriveLessonPrefill(withLongFinding)).toHaveLength(500);
  });
});

describe('countLessonsForRepo', () => {
  it('counts only the lessons matching the given repo', () => {
    const lessons = [
      { repo: 'octocat/a' },
      { repo: 'octocat/b' },
      { repo: 'octocat/a' },
    ];
    expect(countLessonsForRepo(lessons, 'octocat/a')).toBe(2);
    expect(countLessonsForRepo(lessons, 'octocat/b')).toBe(1);
    expect(countLessonsForRepo(lessons, 'octocat/c')).toBe(0);
  });
});
