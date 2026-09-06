import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MediumApprovalDone, MediumApprovalInline } from '../../src/components/primitives/MediumApproval.js';
import { PreCommitment } from '../../src/components/primitives/PreCommitment.js';

describe('MediumApprovalInline', () => {
  it('renders head, command and precommit', () => {
    render(
      <MediumApprovalInline
        command="git rm packages/agent-runtime/test/fixtures/legacy-env-server.js"
        precommit={
          <PreCommitment status="pending">
            <PreCommitment.Row k="action">Delete the legacy fixture</PreCommitment.Row>
          </PreCommitment>
        }
        notificationNote="OS pinged after 60 s without an answer (38 s)"
        onReject={vi.fn()}
        onAllow={vi.fn()}
      />,
    );
    expect(screen.getByText('MEDIUM')).toBeInTheDocument();
    expect(screen.getByText('Allow this step?')).toBeInTheDocument();
    expect(screen.getByText('blocks the run')).toBeInTheDocument();
    expect(
      screen.getByText('git rm packages/agent-runtime/test/fixtures/legacy-env-server.js'),
    ).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('omits the reason field unless onReasonChange is given', () => {
    const { container, rerender } = render(
      <MediumApprovalInline
        command="cmd"
        precommit={<div />}
        notificationNote="note"
        onReject={vi.fn()}
        onAllow={vi.fn()}
      />,
    );
    expect(container.querySelector('input.field')).not.toBeInTheDocument();

    rerender(
      <MediumApprovalInline
        command="cmd"
        precommit={<div />}
        notificationNote="note"
        reason=""
        onReasonChange={vi.fn()}
        onReject={vi.fn()}
        onAllow={vi.fn()}
      />,
    );
    expect(container.querySelector('input.field')).toBeInTheDocument();
  });

  it('calls onReject and onAllow from the foot actions', () => {
    const onReject = vi.fn();
    const onAllow = vi.fn();
    render(
      <MediumApprovalInline
        command="cmd"
        precommit={<div />}
        notificationNote="note"
        onReject={onReject}
        onAllow={onAllow}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.click(screen.getByRole('button', { name: /Allow/ }));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it('calls onReasonChange with the new value', () => {
    const onReasonChange = vi.fn();
    render(
      <MediumApprovalInline
        command="cmd"
        precommit={<div />}
        notificationNote="note"
        reason=""
        onReasonChange={onReasonChange}
        onReject={vi.fn()}
        onAllow={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Reason, if rejecting/), {
      target: { value: 'not needed' },
    });
    expect(onReasonChange).toHaveBeenCalledWith('not needed');
  });
});

describe('MediumApprovalDone', () => {
  it('renders the resolved sentence and the undo countdown', () => {
    const onUndo = vi.fn();
    render(
      <MediumApprovalDone undoSeconds={57} onUndo={onUndo}>
        <b>Allowed</b> — removing the fixture and re-running vitest.
      </MediumApprovalDone>,
    );
    expect(screen.getByText('Allowed')).toBeInTheDocument();
    expect(screen.getByText('57 s')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
