import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  HighApprovalCard,
  HighApprovalResolved,
  HighApprovalStreamCard,
} from '../../src/components/primitives/HighApproval.js';
import { PreCommitment } from '../../src/components/primitives/PreCommitment.js';

function renderCard(onReject = vi.fn(), onApprove = vi.fn()) {
  const utils = render(
    <HighApprovalCard
      kindLine="external_side_effect · publish gate · issue-94"
      description="pipenzo wants to push the finished branch and open a pull request."
      command={'git push origin issue-94\ngh pr create --fill --base main'}
      precommit={
        <PreCommitment status="pending" headDetail={<b>· posted before this action</b>}>
          <PreCommitment.Row k="action">
            Push issue-94 to origin and open one PR against main
          </PreCommitment.Row>
        </PreCommitment>
      }
      onReject={onReject}
      onApprove={onApprove}
      footNote="OS notification sent 14:02 · no Undo at HIGH · no auto-allow, ever"
    />,
  );
  return { onReject, onApprove, ...utils };
}

describe('HighApprovalCard', () => {
  it('renders the HIGH risk chip, kind line, command and pre-commitment', () => {
    renderCard();
    expect(screen.getByText('Approval needed')).toBeInTheDocument();
    expect(screen.getByText('HIGH')).toBeInTheDocument();
    expect(
      screen.getByText('external_side_effect · publish gate · issue-94'),
    ).toBeInTheDocument();
    expect(screen.getByText(/git push origin issue-94/)).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('marks the reason field as required at HIGH', () => {
    renderCard();
    expect(screen.getByText('required at HIGH')).toBeInTheDocument();
  });

  it('calls onReject with the typed reason', () => {
    const { onReject } = renderCard();
    const textarea = screen.getByPlaceholderText(
      'Fed back into the next attempt. A rejected HIGH action is never retried on its own.',
    );
    fireEvent.change(textarea, { target: { value: 'Not ready to push yet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalledWith('Not ready to push yet');
  });

  it('calls onApprove on click', () => {
    const { onApprove } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('renders the hi-foot rules line', () => {
    renderCard();
    expect(
      screen.getByText('OS notification sent 14:02 · no Undo at HIGH · no auto-allow, ever'),
    ).toBeInTheDocument();
  });
});

/**
 * `TicketDetail.dc.html`'s own `.approval-card` shell (issue #98) -- the "full card at foot of
 * stream" this ticket adds, distinct from `HighApprovalCard`'s `.dialog` above. Mandatory-reason
 * enforcement is this component's own job, not a caller's: `onReject` cannot be reached at all
 * while the reason field is empty or whitespace-only.
 */
function renderStreamCard(onReject = vi.fn(), onApprove = vi.fn()) {
  const utils = render(
    <HighApprovalStreamCard
      sub="external_side_effect · publish gate · issue-94"
      description="pipenzo wants to push the finished branch and open a pull request."
      command={'git push origin issue-94\ngh pr create --fill --base main'}
      precommit={
        <PreCommitment status="pending">
          <PreCommitment.Row k="action">
            Push issue-94 to origin and open one PR against main
          </PreCommitment.Row>
        </PreCommitment>
      }
      onReject={onReject}
      onApprove={onApprove}
      footNote="OS notification sent 14:02 · no Undo at HIGH · no auto-allow, ever"
    />,
  );
  return { onReject, onApprove, ...utils };
}

describe('HighApprovalStreamCard', () => {
  it('renders the HIGH risk chip, sub line, command and pre-commitment', () => {
    renderStreamCard();
    expect(screen.getByText('Approval needed')).toBeInTheDocument();
    expect(screen.getByText('HIGH')).toBeInTheDocument();
    expect(screen.getByText('external_side_effect · publish gate · issue-94')).toBeInTheDocument();
    expect(screen.getByText(/git push origin issue-94/)).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('Reject starts disabled -- an empty reason can never reach onReject', () => {
    const { onReject } = renderStreamCard();
    const rejectButton = screen.getByRole('button', { name: 'Reject' });
    expect(rejectButton).toBeDisabled();

    fireEvent.click(rejectButton);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('Reject stays disabled for a whitespace-only reason', () => {
    const { onReject } = renderStreamCard();
    fireEvent.change(screen.getByPlaceholderText(/Fed back to the next attempt/), {
      target: { value: '   ' },
    });
    const rejectButton = screen.getByRole('button', { name: 'Reject' });
    expect(rejectButton).toBeDisabled();

    fireEvent.click(rejectButton);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('Reject enables once a non-empty reason is typed, and calls onReject with the trimmed text', () => {
    const { onReject } = renderStreamCard();
    fireEvent.change(screen.getByPlaceholderText(/Fed back to the next attempt/), {
      target: { value: '  touches the token vault  ' },
    });
    const rejectButton = screen.getByRole('button', { name: 'Reject' });
    expect(rejectButton).not.toBeDisabled();

    fireEvent.click(rejectButton);
    expect(onReject).toHaveBeenCalledWith('touches the token vault');
  });

  it('Approve needs no reason -- it is never disabled, regardless of the reason field', () => {
    const { onApprove } = renderStreamCard();
    const approveButton = screen.getByRole('button', { name: 'Approve' });
    expect(approveButton).not.toBeDisabled();

    fireEvent.click(approveButton);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('marks the reason field as required at HIGH', () => {
    renderStreamCard();
    expect(screen.getByText('required at HIGH')).toBeInTheDocument();
  });

  it('renders the approval-foot rules line', () => {
    renderStreamCard();
    expect(
      screen.getByText('OS notification sent 14:02 · no Undo at HIGH · no auto-allow, ever'),
    ).toBeInTheDocument();
  });
});

describe('HighApprovalResolved', () => {
  it('renders the approved outcome with a check icon and no Undo affordance anywhere', () => {
    render(
      <HighApprovalResolved outcome="approved" sub="external_side_effect · publish gate · issue-94">
        <b>Approved</b> — git push origin issue-94 runs now. There is no Undo at HIGH.
      </HighApprovalResolved>,
    );
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText(/runs now/)).toBeInTheDocument();
    expect(screen.getByText('HIGH')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Undo/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Undo/, { selector: 'button' })).not.toBeInTheDocument();
  });

  it('renders the rejected outcome with an X icon, distinct from the approved tone, and no Undo affordance', () => {
    render(
      <HighApprovalResolved outcome="rejected" sub="external_side_effect · publish gate · issue-94">
        <b>Rejected</b> — nothing pushed. A rejected HIGH action is never retried on its own.
      </HighApprovalResolved>,
    );
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText(/nothing pushed/)).toBeInTheDocument();
    expect(screen.getByText('HIGH')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Undo/ })).not.toBeInTheDocument();
  });
});
