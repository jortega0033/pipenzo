import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  StackApprovalAccepted,
  StackApprovalPanel,
  StackApprovalRejected,
} from '../../src/pipenzo/StackApproval.js';

const ESTIMATE = { changedLines: 212, filesTouched: 9, layered: true };
const PARTS = [
  { summary: 'Extract the shared capability schema', changedLines: 80, filesTouched: 3 },
  { summary: 'Wire the HTTP transport to it', changedLines: 70, filesTouched: 3 },
  { summary: 'Wire the stdio transport to it', changedLines: 62, filesTouched: 3 },
];

describe('StackApprovalPanel', () => {
  it('renders the proposal title, sub, and every row in the proposed order', () => {
    render(<StackApprovalPanel estimate={ESTIMATE} parts={PARTS} onAccept={vi.fn()} onReject={vi.fn()} />);

    expect(screen.getByText('Stack approval — 3 PRs, dependency-ordered')).toBeInTheDocument();
    expect(screen.getByText(/pipenzo:awaiting-stack-approval/)).toBeInTheDocument();
    expect(screen.getByText('Extract the shared capability schema')).toBeInTheDocument();
    expect(screen.getByText('Wire the HTTP transport to it')).toBeInTheDocument();
    expect(screen.getByText('Wire the stdio transport to it')).toBeInTheDocument();
    expect(screen.getByText('1/3')).toBeInTheDocument();
    expect(screen.getByText('2/3')).toBeInTheDocument();
    expect(screen.getByText('3/3')).toBeInTheDocument();
  });

  it('disables the top row’s move-up and the bottom row’s move-down', () => {
    render(<StackApprovalPanel estimate={ESTIMATE} parts={PARTS} onAccept={vi.fn()} onReject={vi.fn()} />);
    const moveUpButtons = screen.getAllByRole('button', { name: 'Move up' });
    const moveDownButtons = screen.getAllByRole('button', { name: 'Move down' });
    expect(moveUpButtons[0]).toBeDisabled();
    expect(moveDownButtons[moveDownButtons.length - 1]).toBeDisabled();
    expect(moveUpButtons[1]).not.toBeDisabled();
    expect(moveDownButtons[0]).not.toBeDisabled();
  });

  it('reordering actually changes the order Accept submits', () => {
    const onAccept = vi.fn();
    render(<StackApprovalPanel estimate={ESTIMATE} parts={PARTS} onAccept={onAccept} onReject={vi.fn()} />);

    // Move the third row ("Wire the stdio transport to it") up twice, to the front.
    const moveUpButtons = () => screen.getAllByRole('button', { name: 'Move up' });
    fireEvent.click(moveUpButtons()[2]!);
    fireEvent.click(moveUpButtons()[1]!);

    fireEvent.click(screen.getByRole('button', { name: /Accept stack in this order/ }));

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith([PARTS[2], PARTS[0], PARTS[1]]);
  });

  it('a single move-down has the mirror effect of a single move-up', () => {
    const onAccept = vi.fn();
    render(<StackApprovalPanel estimate={ESTIMATE} parts={PARTS} onAccept={onAccept} onReject={vi.fn()} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Move down' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /Accept stack in this order/ }));

    expect(onAccept).toHaveBeenCalledWith([PARTS[1], PARTS[0], PARTS[2]]);
  });

  it('Reject stays disabled until a non-blank reason is entered, and trims it before calling back', () => {
    const onReject = vi.fn();
    render(<StackApprovalPanel estimate={ESTIMATE} parts={PARTS} onAccept={vi.fn()} onReject={onReject} />);

    const rejectButton = screen.getByRole('button', { name: 'Reject' });
    expect(rejectButton).toBeDisabled();

    const textarea = screen.getByPlaceholderText('Posted as a comment on the issue.');
    fireEvent.change(textarea, { target: { value: '   ' } });
    expect(rejectButton).toBeDisabled();

    fireEvent.change(textarea, { target: { value: '  too risky to split this way  ' } });
    expect(rejectButton).not.toBeDisabled();

    fireEvent.click(rejectButton);
    expect(onReject).toHaveBeenCalledWith('too risky to split this way');
  });

  it('never calls onReject while the reason is blank, even if the disabled button is force-clicked', () => {
    const onReject = vi.fn();
    render(<StackApprovalPanel estimate={ESTIMATE} parts={PARTS} onAccept={vi.fn()} onReject={onReject} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).not.toHaveBeenCalled();
  });

  it('renders the estimate and entry-count reference cells', () => {
    render(<StackApprovalPanel estimate={ESTIMATE} parts={PARTS} onAccept={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText('212 lines')).toBeInTheDocument();
    expect(screen.getByText('9 files · layered')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});

describe('StackApprovalAccepted', () => {
  it('renders one kid row per child, in order, and the container framing', () => {
    render(
      <StackApprovalAccepted
        repo="jortega0033/pipenzo"
        parentIssueNumber={108}
        children={[
          { ticketId: 'a', issueNumber: 201, title: 'Extract the shared schema' },
          { ticketId: 'b', issueNumber: 202, title: 'Wire the HTTP transport' },
        ]}
      />,
    );

    expect(screen.getByText('Stack accepted — 2 child tickets created')).toBeInTheDocument();
    expect(screen.getByText(/#108 is now a container card/)).toBeInTheDocument();
    expect(screen.getByText('Extract the shared schema')).toBeInTheDocument();
    expect(screen.getByText('#201')).toBeInTheDocument();
    expect(screen.getByText('Wire the HTTP transport')).toBeInTheDocument();
    expect(screen.getByText('#202')).toBeInTheDocument();
  });

  it('links the "Open stack on GitHub" action to the parent issue', () => {
    render(
      <StackApprovalAccepted
        repo="jortega0033/pipenzo"
        parentIssueNumber={108}
        children={[{ ticketId: 'a', issueNumber: 201, title: 'One part' }]}
      />,
    );
    const link = screen.getByRole('link', { name: /Open stack on GitHub/ });
    expect(link).toHaveAttribute('href', 'https://github.com/jortega0033/pipenzo/issues/108');
  });
});

describe('StackApprovalRejected', () => {
  it('renders the rejected title naming the parent issue', () => {
    render(<StackApprovalRejected parentIssueNumber={108} />);
    expect(screen.getByText('Stack rejected — reason posted to #108')).toBeInTheDocument();
    expect(screen.getByText(/no worktree was created/)).toBeInTheDocument();
  });

  it('renders no back-to-proposal link when no callback is given', () => {
    render(<StackApprovalRejected parentIssueNumber={108} />);
    expect(screen.queryByText('Back to the proposal')).not.toBeInTheDocument();
  });

  it('calls back when "Back to the proposal" is clicked', () => {
    const onBackToProposal = vi.fn();
    render(<StackApprovalRejected parentIssueNumber={108} onBackToProposal={onBackToProposal} />);
    fireEvent.click(screen.getByText('Back to the proposal'));
    expect(onBackToProposal).toHaveBeenCalledTimes(1);
  });
});
