import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  PlanReviewApproved,
  PlanReviewChangesRequested,
  PlanReviewPanel,
  PlanReviewRejected,
} from '../../src/pipenzo/PlanReview.js';

const SPEC = {
  summary: 'Persist poll ETags per repo and resource in the ticket store.',
  acceptanceCriteria: [
    {
      id: 'AC-1',
      kind: 'event' as const,
      text: "When a poll for a repo's issues completes, the reconciler shall store the response ETag.",
    },
    {
      id: 'AC-2',
      kind: 'event' as const,
      text: 'When a poll is issued for a resource that has a stored ETag, the client shall send it as If-None-Match.',
    },
  ],
  outOfScope: [
    'The secondary-limit and Retry-After handling.',
    'Changing the poll interval or the degradation behaviour.',
  ],
  filesLikelyTouched: ['apps/daemon/src/github-reconciler.ts', 'apps/daemon/src/ticket-store.ts'],
  estimate: { changedLines: 44, filesTouched: 2, layered: false },
  openQuestions: [],
};

describe('PlanReviewPanel', () => {
  it('renders the title, acceptance criteria, out-of-scope entries, and files', () => {
    render(
      <PlanReviewPanel spec={SPEC} onApprove={vi.fn()} onRequestChanges={vi.fn()} onReject={vi.fn()} />,
    );

    expect(
      screen.getByText('Plan review — approve the spec before Implement starts'),
    ).toBeInTheDocument();
    expect(screen.getByText(/AC-1/)).toBeInTheDocument();
    expect(screen.getByText(/AC-2/)).toBeInTheDocument();
    expect(screen.getByText('The secondary-limit and Retry-After handling.')).toBeInTheDocument();
    expect(screen.getByText('apps/daemon/src/github-reconciler.ts')).toBeInTheDocument();
    expect(screen.getByText('apps/daemon/src/ticket-store.ts')).toBeInTheDocument();
  });

  it('Approve needs no reason and calls back with no arguments', () => {
    const onApprove = vi.fn();
    render(
      <PlanReviewPanel spec={SPEC} onApprove={onApprove} onRequestChanges={vi.fn()} onReject={vi.fn()} />,
    );

    const approveButton = screen.getByRole('button', { name: /Approve & start Implement/ });
    expect(approveButton).not.toBeDisabled();
    fireEvent.click(approveButton);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('Reject and Request changes both stay disabled until a non-blank reason is entered', () => {
    render(
      <PlanReviewPanel spec={SPEC} onApprove={vi.fn()} onRequestChanges={vi.fn()} onReject={vi.fn()} />,
    );

    const rejectButton = screen.getByRole('button', { name: 'Reject' });
    const requestChangesButton = screen.getByRole('button', { name: 'Request changes' });
    expect(rejectButton).toBeDisabled();
    expect(requestChangesButton).toBeDisabled();

    const textarea = screen.getByLabelText(/Reason, if rejecting or asking for changes/);
    fireEvent.change(textarea, { target: { value: '   ' } });
    expect(rejectButton).toBeDisabled();
    expect(requestChangesButton).toBeDisabled();

    fireEvent.change(textarea, { target: { value: '  needs a different approach  ' } });
    expect(rejectButton).not.toBeDisabled();
    expect(requestChangesButton).not.toBeDisabled();
  });

  it('trims the shared reason before calling onReject', () => {
    const onReject = vi.fn();
    render(
      <PlanReviewPanel spec={SPEC} onApprove={vi.fn()} onRequestChanges={vi.fn()} onReject={onReject} />,
    );
    const textarea = screen.getByLabelText(/Reason, if rejecting or asking for changes/);
    fireEvent.change(textarea, { target: { value: '  too broad for one ticket  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalledWith('too broad for one ticket');
  });

  it('trims the shared reason before calling onRequestChanges', () => {
    const onRequestChanges = vi.fn();
    render(
      <PlanReviewPanel
        spec={SPEC}
        onApprove={vi.fn()}
        onRequestChanges={onRequestChanges}
        onReject={vi.fn()}
      />,
    );
    const textarea = screen.getByLabelText(/Reason, if rejecting or asking for changes/);
    fireEvent.change(textarea, { target: { value: '  please also cover the 304 path  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(onRequestChanges).toHaveBeenCalledWith('please also cover the 304 path');
  });

  it('never calls onReject or onRequestChanges while the reason is blank, even if force-clicked', () => {
    const onReject = vi.fn();
    const onRequestChanges = vi.fn();
    render(
      <PlanReviewPanel
        spec={SPEC}
        onApprove={vi.fn()}
        onRequestChanges={onRequestChanges}
        onReject={onReject}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(onReject).not.toHaveBeenCalled();
    expect(onRequestChanges).not.toHaveBeenCalled();
  });

  it('renders an open-questions block only when the spec actually carries one', () => {
    const { rerender } = render(
      <PlanReviewPanel spec={SPEC} onApprove={vi.fn()} onRequestChanges={vi.fn()} onReject={vi.fn()} />,
    );
    expect(screen.queryByText(/open question/)).not.toBeInTheDocument();

    rerender(
      <PlanReviewPanel
        spec={{ ...SPEC, openQuestions: ['Should the ETag survive a repo rename?'] }}
        onApprove={vi.fn()}
        onRequestChanges={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 open question/)).toBeInTheDocument();
    expect(screen.getByText('Should the ETag survive a repo rename?')).toBeInTheDocument();
  });
});

describe('PlanReviewApproved', () => {
  it('names the real branch Implement started with', () => {
    render(<PlanReviewApproved branch="issue-98" />);
    expect(
      screen.getByText('Spec approved — Implement starts on the next free slot'),
    ).toBeInTheDocument();
    expect(screen.getByText(/issue-98/)).toBeInTheDocument();
  });
});

describe('PlanReviewChangesRequested', () => {
  it('renders the changes-requested title', () => {
    render(<PlanReviewChangesRequested />);
    expect(
      screen.getByText('Changes requested — Refine runs again with your note'),
    ).toBeInTheDocument();
  });

  it('calls back when "Back to the spec" is clicked', () => {
    const onBackToProposal = vi.fn();
    render(<PlanReviewChangesRequested onBackToProposal={onBackToProposal} />);
    fireEvent.click(screen.getByText('Back to the spec'));
    expect(onBackToProposal).toHaveBeenCalledTimes(1);
  });
});

describe('PlanReviewRejected', () => {
  it('renders the rejected title naming the issue', () => {
    render(<PlanReviewRejected issueNumber={98} />);
    expect(screen.getByText('Plan rejected — reason posted to #98')).toBeInTheDocument();
    expect(screen.getByText(/no worktree was created/)).toBeInTheDocument();
  });

  it('renders no back-to-proposal link when no callback is given', () => {
    render(<PlanReviewRejected issueNumber={98} />);
    expect(screen.queryByText('Back to the spec')).not.toBeInTheDocument();
  });
});
