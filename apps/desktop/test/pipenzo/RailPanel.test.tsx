import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewReportV1, SpecTestAdjudicationV1 } from '@agent-dock/shared';
import { RailPanel } from '../../src/pipenzo/RailPanel.js';

const BASE_REPORT: ReviewReportV1 = {
  schemaVersion: 1,
  outcome: 'approved',
  baseCommit: 'a'.repeat(40),
  headCommit: 'b'.repeat(40),
  implementerTier: 'mid',
  deterministic: [
    { id: 'build', status: 'passed', summary: 'Build and typecheck passed', durationMs: 9000 },
    { id: 'gitleaks', status: 'skipped', summary: 'gitleaks not installed on this machine', durationMs: 0 },
  ],
  diffScope: {
    implementation: { changedLines: 8, filesTouched: 1 },
    generatedTests: { changedLines: 44, filesTouched: 1 },
    estimate: { changedLines: 60, filesTouched: 2 },
    exceededEstimate: false,
    ratio: 8 / 60,
  },
  reviewer: {
    sessionId: 's1',
    tier: 'mid',
    model: 'sonnet',
    findings: [{ severity: 'medium', message: 'a warning finding', path: 'a.ts', line: 76 }],
  },
  verifier: {
    sessionId: 's2',
    tier: 'frontier',
    model: 'opus',
    verdict: 'approved',
    vendorDiversityUnavailable: false,
    findings: [],
  },
};

describe('RailPanel', () => {
  it('renders the sections in DiffReview.dc.html order: machine-verified, findings, review, commit', () => {
    render(<RailPanel report={BASE_REPORT} commit={{ message: 'fix: thing\n\nCloses #94.' }} />);
    const labels = screen.getAllByText(/Machine-verified|Findings|Review|Commit/, { selector: '.label' });
    expect(labels.map((el) => el.textContent)).toEqual([
      'Machine-verified',
      'Findings · by severity',
      'Review',
      'Commit',
    ]);
  });

  it('renders a passed gate with the ok tone and a skipped gate with warn, never the same icon', () => {
    const { container } = render(<RailPanel report={BASE_REPORT} />);
    const wells = container.querySelectorAll('.v-ic');
    expect(wells[0]?.className).toBe('v-ic');
    expect(wells[1]?.className).toBe('v-ic warn');
  });

  it('renders the diff-scope row reporting implementation and generated tests separately', () => {
    render(<RailPanel report={BASE_REPORT} />);
    expect(screen.getByText('Diff scope within the Refine estimate')).toBeInTheDocument();
    expect(screen.getByText(/Implementation: 8 lines across 1 file/)).toBeInTheDocument();
    expect(screen.getByText(/Generated tests: 44 lines across 1 file/)).toBeInTheDocument();
    expect(screen.getByText(/implementation half only/)).toBeInTheDocument();
  });

  /**
   * Issue #145: the split belongs inside the gate that judged it. It used to render as a second
   * row below the gate list, which read as a seventh deterministic gate and said the same thing
   * twice -- once in the `diff_scope` gate's own summary and once again underneath it.
   */
  it('hangs the split on the diff_scope gate rather than adding a row beside it', () => {
    const report: ReviewReportV1 = {
      ...BASE_REPORT,
      deterministic: [
        ...BASE_REPORT.deterministic,
        {
          id: 'diff_scope',
          status: 'passed',
          summary: 'implementation diff is 8 lines against a 60-line estimate',
          durationMs: 0,
        },
      ],
    };
    const { container } = render(<RailPanel report={report} />);
    const machineVerified = container.querySelector('.v-block');
    // Three gates, and no fourth row carrying the same numbers again.
    expect(machineVerified?.querySelectorAll('.v-row')).toHaveLength(3);
    expect(screen.getAllByText(/Implementation: 8 lines across 1 file/)).toHaveLength(1);
    expect(screen.queryByText('Diff scope within the Refine estimate')).not.toBeInTheDocument();
  });

  /** The numbers are the point; losing them because no gate row exists would be worse. */
  it('still shows the split when the report carries scope numbers but no diff_scope gate ran', () => {
    render(<RailPanel report={BASE_REPORT} />);
    expect(screen.getByText(/Generated tests: 44 lines/)).toBeInTheDocument();
  });

  it('omits the agent-captured zone entirely when there is nothing self-reported or captured', () => {
    render(<RailPanel report={BASE_REPORT} />);
    expect(screen.queryByText('Agent-captured')).not.toBeInTheDocument();
  });

  it('renders self-reported rows in the agent-captured zone with the grey check well', () => {
    const { container } = render(
      <RailPanel report={BASE_REPORT} agentCapturedRows={['3/3 acceptance criteria met, by its own reading']} />,
    );
    expect(screen.getByText('Agent-captured')).toBeInTheDocument();
    expect(screen.getByText('3/3 acceptance criteria met, by its own reading')).toBeInTheDocument();
    expect(container.querySelectorAll('.v-ic.self')).toHaveLength(1);
  });

  it('renders screenshots in the agent-captured zone and opens the lightbox from a thumbnail', () => {
    render(
      <RailPanel
        report={BASE_REPORT}
        screenshots={[
          { label: 'Before', refLabel: 'main · 287a4a6' },
          { label: 'After', refLabel: 'issue-94 · working tree' },
        ]}
      />,
    );
    fireEvent.click(screen.getByText('After').closest('.shot')!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('After', { selector: '.lb-title' })).toBeInTheDocument();
  });

  it('shows the finding count tally and renders findings sorted by severity', () => {
    render(<RailPanel report={BASE_REPORT} />);
    expect(screen.getByText('a warning finding')).toBeInTheDocument();
    expect(screen.getByText('a.ts:76')).toBeInTheDocument();
  });

  it('omits the findings block entirely when there are none', () => {
    const noFindings: ReviewReportV1 = { ...BASE_REPORT, reviewer: { ...BASE_REPORT.reviewer!, findings: [] } };
    render(<RailPanel report={noFindings} />);
    expect(screen.queryByText('Findings · by severity')).not.toBeInTheDocument();
  });

  it('marks the active finding and calls onSelectFinding with its index', () => {
    const onSelectFinding = vi.fn();
    render(<RailPanel report={BASE_REPORT} selectedFindingIndex={0} onSelectFinding={onSelectFinding} />);
    const finding = screen.getByText('a warning finding').closest('.finding');
    expect(finding).toHaveClass('active');
    fireEvent.click(finding!);
    expect(onSelectFinding).toHaveBeenCalledWith(undefined);
  });

  it('renders the reviewer and verifier summary lines from the report', () => {
    render(<RailPanel report={BASE_REPORT} />);
    expect(screen.getByText(/Reviewer \(sonnet\): 1 advisory finding, none blocking/)).toBeInTheDocument();
    expect(screen.getByText(/Verifier \(opus\): 0 critical · verdict approved/)).toBeInTheDocument();
  });

  it('renders the commit block only when a commit message is supplied', () => {
    const { rerender, container } = render(<RailPanel report={BASE_REPORT} />);
    expect(screen.queryByText('Commit')).not.toBeInTheDocument();

    rerender(
      <RailPanel
        report={BASE_REPORT}
        commit={{ message: 'fix: thing\n\nCloses #94.', confidence: 'High confidence' }}
      />,
    );
    expect(container.querySelector('.commit')?.textContent).toBe('fix: thing\n\nCloses #94.');
    expect(screen.getByText('High confidence')).toBeInTheDocument();
  });
});

/**
 * Issue #146. The rail is where a reviewer sees that a machine check was removed from this ticket,
 * so the rulings live in the machine-verified zone -- but attributed, because a ruling is a
 * model's judgement and must never read as a machine check that ran.
 */
describe('RailPanel spec-test rulings', () => {
  const ADJUDICATION: SpecTestAdjudicationV1 = {
    schemaVersion: 1,
    adjudicates: { baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40) },
    ruledBy: { sessionId: 's', tier: 'frontier', model: 'opus' },
    rulings: [
      { testId: 'a > one', verdict: 'test_wrong', rationale: 'asserts what the spec never said' },
      { testId: 'b > two', verdict: 'code_wrong', rationale: 'AC-1 genuinely does not hold' },
    ],
  };

  it('renders nothing at all when no generated test was adjudicated', () => {
    render(<RailPanel report={BASE_REPORT} />);
    expect(screen.queryByText(/Ruled once/)).not.toBeInTheDocument();
  });

  it('names the tier and model that ruled, and counts drops against sustained', () => {
    render(<RailPanel report={BASE_REPORT} adjudication={ADJUDICATION} />);
    expect(
      screen.getByText(
        'Ruled once by the frontier-tier verifier (opus): 1 dropped, 1 sustained against the code.',
      ),
    ).toBeInTheDocument();
  });

  /** A dropped test is never silently deleted: the row says "dropped" and carries the reason. */
  it('says a dropped test was dropped, and shows why', () => {
    render(<RailPanel report={BASE_REPORT} adjudication={ADJUDICATION} />);
    expect(screen.getByText(/Test wrong, dropped/)).toBeInTheDocument();
    expect(screen.getByText(/asserts what the spec never said/)).toBeInTheDocument();
  });

  it('shows the sustained rulings too, not only the drops', () => {
    render(<RailPanel report={BASE_REPORT} adjudication={ADJUDICATION} />);
    expect(screen.getByText(/Code wrong, test kept/)).toBeInTheDocument();
  });
});
