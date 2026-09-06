import { describe, expect, it } from 'vitest';
import type {
  RefineSpecV1,
  ReviewReportV1,
  SpecTestAdjudicationV1,
} from '@agent-dock/shared';
import {
  buildCommitMessage,
  buildConfidenceLine,
  buildPullRequestBody,
  buildPullRequestInput,
} from '../../src/pipenzo/pr-assembly.js';

const SPEC: RefineSpecV1 = {
  schemaVersion: 1,
  issue: { repo: 'jortega0033/agentdock', number: 94, title: 'Sanitize environment for MCP stdio server subprocesses' },
  summary: 'Spawned servers no longer inherit the full host env.',
  acceptanceCriteria: [{ id: 'AC-1', kind: 'ubiquitous', text: 'The system shall sanitize the environment.' }],
  outOfScope: ['Renderer-side environment handling'],
  filesLikelyTouched: ['packages/agent-runtime/src/mcp/stdio-mcp-connection.ts'],
  estimate: { changedLines: 60, filesTouched: 2, layered: false },
  openQuestions: [],
};

const REPORT: ReviewReportV1 = {
  schemaVersion: 1,
  outcome: 'approved',
  baseCommit: 'a'.repeat(40),
  headCommit: 'b'.repeat(40),
  implementerTier: 'mid',
  deterministic: [
    { id: 'build', status: 'passed', summary: 'Build and typecheck passed', durationMs: 9000 },
    { id: 'gitleaks', status: 'skipped', summary: 'gitleaks not installed', durationMs: 0 },
  ],
  diffScope: {
    implementation: { changedLines: 8, filesTouched: 1 },
    generatedTests: { changedLines: 44, filesTouched: 1 },
    estimate: { changedLines: 60, filesTouched: 2 },
    exceededEstimate: false,
    ratio: 8 / 60,
  },
  reviewer: { sessionId: 's1', tier: 'mid', model: 'sonnet', findings: [{ severity: 'medium', message: 'a note' }] },
  verifier: {
    sessionId: 's2',
    tier: 'frontier',
    model: 'opus',
    verdict: 'approved',
    vendorDiversityUnavailable: false,
    findings: [],
  },
};

const ADJUDICATION: SpecTestAdjudicationV1 = {
  schemaVersion: 1,
  adjudicates: { baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40) },
  ruledBy: { sessionId: 's', tier: 'frontier', model: 'verifier-model' },
  rulings: [
    {
      testId: 'a > one',
      verdict: 'test_wrong',
      rationale: 'asserts what the spec never said',
      criterionId: 'AC-1',
    },
    { testId: 'b > two', verdict: 'code_wrong', rationale: 'AC-1 genuinely does not hold' },
  ],
};

describe('buildCommitMessage', () => {
  it('uses the issue title as the subject with no prefix when no commit type is given', () => {
    const message = buildCommitMessage(SPEC);
    expect(message.split('\n')[0]).toBe('Sanitize environment for MCP stdio server subprocesses');
  });

  it('prefixes type(scope) and lowercases the subject when both are given', () => {
    const message = buildCommitMessage(SPEC, { commitType: 'fix', commitScope: 'mcp' });
    expect(message.split('\n')[0]).toBe('fix(mcp): sanitize environment for MCP stdio server subprocesses');
  });

  it('prefixes with just the type when no scope is given', () => {
    const message = buildCommitMessage(SPEC, { commitType: 'fix' });
    expect(message.split('\n')[0]).toBe('fix: sanitize environment for MCP stdio server subprocesses');
  });

  it('carries the Refine summary as the body and closes the issue', () => {
    const message = buildCommitMessage(SPEC, { commitType: 'fix', commitScope: 'mcp' });
    expect(message).toBe(
      'fix(mcp): sanitize environment for MCP stdio server subprocesses\n\n' +
        'Spawned servers no longer inherit the full host env. Closes #94.',
    );
  });
});

describe('buildConfidenceLine', () => {
  it('reports the verifier verdict and critical-finding count actually in the report', () => {
    expect(buildConfidenceLine(REPORT)).toContain('The verifier approved this diff with 0 critical findings sustained.');
  });

  it('reports whether the diff stayed within its Refine estimate as a percentage', () => {
    expect(buildConfidenceLine(REPORT)).toContain('The diff stayed within its Refine estimate (13% of predicted lines).');
  });

  it('reports an exceeded estimate distinctly', () => {
    const exceeded: ReviewReportV1 = { ...REPORT, diffScope: { ...REPORT.diffScope!, exceededEstimate: true, ratio: 1.4 } };
    expect(buildConfidenceLine(exceeded)).toContain('The diff exceeded its Refine estimate (140% of predicted lines).');
  });

  it('returns an empty string when the report has neither a verifier pass nor a diff scope', () => {
    const bare: ReviewReportV1 = { ...REPORT, verifier: undefined, diffScope: undefined, reviewer: undefined };
    expect(buildConfidenceLine(bare)).toBe('');
  });
});

describe('buildPullRequestBody', () => {
  it('renders the two-zone evidence split into separate Machine-verified and Agent-captured sections', () => {
    const body = buildPullRequestBody(SPEC, REPORT);
    expect(body).toContain('## Machine-verified');
    expect(body).toContain('## Agent-captured (self-reported — not verified by a human)');
    // The two zones must stay genuinely separate -- a gate result must never appear under the
    // self-reported heading, matching README's requirement the rail already enforces visually.
    const machineSection = body.split('## Agent-captured')[0]!;
    expect(machineSection).toContain('Build and typecheck passed');
    expect(machineSection).not.toContain('Reviewer (sonnet)');
  });

  it('marks a skipped gate distinctly from a passed one', () => {
    const body = buildPullRequestBody(SPEC, REPORT);
    expect(body).toContain('✅ Build and typecheck passed');
    expect(body).toContain('⚠️ gitleaks not installed');
  });

  /**
   * Issue #145. A PR body reader has no rail to look at, so the split has to carry its own
   * explanation -- otherwise it is two numbers next to an estimate and the reader picks one.
   */
  it('reports the diff-scope implementation and generated-test totals separately', () => {
    const body = buildPullRequestBody(SPEC, REPORT);
    expect(body).toContain('- Implementation: 8 lines across 1 file');
    expect(body).toContain('- Generated tests: 44 lines across 1 file');
  });

  it('says which half the estimate was measured against, in the body itself', () => {
    const body = buildPullRequestBody(SPEC, REPORT);
    expect(body).toContain('implementation half only');
    expect(body).toContain('never charged to the estimate');
  });

  it('says nothing was adjudicated, rather than omitting the section', () => {
    const body = buildPullRequestBody(SPEC, REPORT);
    expect(body).toContain('## Spec-test rulings');
    expect(body).toContain('No spec-generated test failed, so none was adjudicated.');
  });

  it('lists dropped spec-test rulings when the caller supplies a bare list', () => {
    const body = buildPullRequestBody(SPEC, REPORT, {
      droppedSpecTests: ['env-probe-server fixture test: flaked twice, dropped per adjudication'],
    });
    expect(body).toContain(
      '- **Test wrong, dropped** env-probe-server fixture test: flaked twice, dropped per adjudication',
    );
  });

  /**
   * Issue #146. README: an invalid test is dropped **with the ruling recorded and visible in the
   * PR body -- never silently deleted**. So the rationale is in the body, not only the verdict,
   * and the sustained rulings are there too: a reader shown only the drops learns that the
   * adjudicator removed a check and nothing else, which is a false impression of the run.
   */
  it('renders every ruling from an adjudication record, with its rationale and who ruled', () => {
    const body = buildPullRequestBody(SPEC, REPORT, { adjudication: ADJUDICATION });
    expect(body).toContain('Ruled once by the frontier-tier verifier (verifier-model).');
    expect(body).toContain(
      '**Test wrong, dropped** `a > one` (AC-1) — asserts what the spec never said',
    );
    expect(body).toContain('**Code wrong, test kept** `b > two` — AC-1 genuinely does not hold');
  });

  it('prefers the adjudication record over a caller-supplied bare list', () => {
    const body = buildPullRequestBody(SPEC, REPORT, {
      adjudication: ADJUDICATION,
      droppedSpecTests: ['this stale list should not appear'],
    });
    expect(body).not.toContain('this stale list should not appear');
  });

  it('closes the originating issue', () => {
    expect(buildPullRequestBody(SPEC, REPORT)).toContain('Closes #94.');
  });
});

describe('buildPullRequestInput', () => {
  it('produces a title/body pair matching pipenzoPullRequestInputV1Schema', () => {
    const input = buildPullRequestInput(SPEC, REPORT, { commitType: 'fix', commitScope: 'mcp' });
    expect(input.title).toBe('fix(mcp): sanitize environment for MCP stdio server subprocesses');
    expect(input.body).toContain('## Summary');
    expect(input.body.length).toBeLessThanOrEqual(65_536);
  });
});
