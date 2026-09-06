import { describe, expect, it } from 'vitest';
import type { RefineSpecV1, ReviewReportV1 } from '@agent-dock/shared';
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

  it('reports the diff-scope implementation and generated-test totals separately', () => {
    const body = buildPullRequestBody(SPEC, REPORT);
    expect(body).toContain('+8 of ≤ 60 implementation · +44 generated tests, reported separately');
  });

  it('reports "None." for dropped spec-test rulings when none are given', () => {
    const body = buildPullRequestBody(SPEC, REPORT);
    expect(body).toContain('## Dropped spec-test rulings\n\nNone.');
  });

  it('lists dropped spec-test rulings when the caller supplies them', () => {
    const body = buildPullRequestBody(SPEC, REPORT, {
      droppedSpecTests: ['env-probe-server fixture test: flaked twice, dropped per adjudication'],
    });
    expect(body).toContain('- env-probe-server fixture test: flaked twice, dropped per adjudication');
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
