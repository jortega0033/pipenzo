import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PreCommitment } from '../../src/components/primitives/PreCommitment.js';

describe('PreCommitment', () => {
  it('renders pending with no toggle and always-visible rows', () => {
    const { container } = render(
      <PreCommitment status="pending" headDetail={<b>· pnpm vitest run mcp-stdio-client</b>}>
        <PreCommitment.Row k="action">Re-run the whole suite</PreCommitment.Row>
        <PreCommitment.Row k="expect">21 passed, 0 failed, 1 new</PreCommitment.Row>
        <PreCommitment.Row k="if_wrong">Revert and park the ticket</PreCommitment.Row>
      </PreCommitment>,
    );
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(container.querySelector('.pc-toggle')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.pc-row')).toHaveLength(3);
  });

  it('renders match collapsed by default, toggling rows on click', () => {
    render(
      <PreCommitment status="match" headDetail={<b>· pnpm vitest run mcp-stdio-client</b>}>
        <PreCommitment.Row k="action">Re-run the whole suite</PreCommitment.Row>
        <PreCommitment.Outcome tone="ok" k="outcome">
          21 passed, 0 failed, 1 new · 4.1s
        </PreCommitment.Outcome>
      </PreCommitment>,
    );
    expect(screen.getByText('match')).toBeInTheDocument();
    expect(screen.queryByText('outcome')).not.toBeInTheDocument();
    const toggle = screen.getByText('show');
    fireEvent.click(toggle);
    expect(screen.getByText('hide')).toBeInTheDocument();
    expect(screen.getByText('outcome')).toBeInTheDocument();
    fireEvent.click(screen.getByText('hide'));
    expect(screen.queryByText('outcome')).not.toBeInTheDocument();
  });

  it('starts expanded when defaultCollapsed is false', () => {
    render(
      <PreCommitment status="match" defaultCollapsed={false}>
        <PreCommitment.Outcome tone="ok" k="outcome">
          21 passed
        </PreCommitment.Outcome>
      </PreCommitment>,
    );
    expect(screen.getByText('hide')).toBeInTheDocument();
    expect(screen.getByText('outcome')).toBeInTheDocument();
  });

  it('pins mismatch open with a static "stays open" indicator, no interactive toggle', () => {
    render(
      <PreCommitment status="mismatch">
        <PreCommitment.Outcome tone="mismatch" k="mismatch">
          Test failed — child env had no PATH on Windows
        </PreCommitment.Outcome>
      </PreCommitment>,
    );
    expect(screen.getByText('mismatch', { selector: '.chip' })).toBeInTheDocument();
    const stays = screen.getByText('stays open');
    expect(stays).toHaveStyle({ cursor: 'default' });
    expect(screen.getByText('Test failed — child env had no PATH on Windows')).toBeInTheDocument();
  });

  it('pins partial open showing only the outcome row, no plan rows required', () => {
    const { container } = render(
      <PreCommitment status="partial">
        <PreCommitment.Outcome tone="partial" k="partial">
          Pushed; 4 of 5 checks green, typecheck still running at the 10 min mark
        </PreCommitment.Outcome>
      </PreCommitment>,
    );
    expect(screen.getByText('partial', { selector: '.chip' })).toBeInTheDocument();
    expect(container.querySelectorAll('.pc-row')).toHaveLength(1);
    expect(container.querySelector('.pc-row.got.part')).toBeInTheDocument();
  });
});
