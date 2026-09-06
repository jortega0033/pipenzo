import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HighApprovalCard } from '../../src/components/primitives/HighApproval.js';
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
