import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewReportV1 } from '@agent-dock/shared';
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
    expect(
      screen.getByText('+8 of ≤ 60 implementation · +44 generated tests, reported separately'),
    ).toBeInTheDocument();
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

  it('renders screenshots in the agent-captured zone and wires onOpenScreenshot to the right index', () => {
    const onOpenScreenshot = vi.fn();
    render(
      <RailPanel
        report={BASE_REPORT}
        screenshots={[
          { label: 'Before', refLabel: 'main · 287a4a6' },
          { label: 'After', refLabel: 'issue-94 · working tree' },
        ]}
        onOpenScreenshot={onOpenScreenshot}
      />,
    );
    fireEvent.click(screen.getByText('After').closest('.shot')!);
    expect(onOpenScreenshot).toHaveBeenCalledWith(1);
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
