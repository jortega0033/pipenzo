import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffReviewHead, type DiffReviewStat } from '../../src/pipenzo/DiffReviewHead.js';
import type { AgentDockBridge } from '../../src/window.js';

const WORKTREE_ID = '123e4567-e89b-42d3-a456-426614174000';

const STAT: DiffReviewStat = {
  additions: 52,
  deletions: 6,
  filesChanged: 2,
  budgetLabel: 'within budget · ≤ 100 lines, ≤ 10 files',
  withinBudget: true,
  risk: 'high',
};

function installBridge() {
  (window as unknown as { agentDock: Partial<AgentDockBridge> }).agentDock = {
    publishPipenzo: vi.fn().mockResolvedValue({
      worktreeId: WORKTREE_ID,
      remote: 'origin',
      branch: 'issue-94',
      headSha: 'a'.repeat(40),
      updatedRemote: true,
    }),
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe('DiffReviewHead', () => {
  it('renders the id line, title and stat row exactly matching DiffReview.dc.html', () => {
    installBridge();
    render(
      <DiffReviewHead
        idLine="#94 · issue-94 → main · committed locally, nothing pushed"
        title="Sanitize environment for MCP stdio server subprocesses"
        stat={STAT}
        worktreeId={WORKTREE_ID}
        branch="issue-94"
      />,
    );
    expect(
      screen.getByText('#94 · issue-94 → main · committed locally, nothing pushed'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Sanitize environment for MCP stdio server subprocesses'),
    ).toBeInTheDocument();
    expect(screen.getByText('+52')).toBeInTheDocument();
    expect(screen.getByText('−6')).toBeInTheDocument();
    expect(screen.getByText('2 files changed')).toBeInTheDocument();
    expect(screen.getByText('within budget · ≤ 100 lines, ≤ 10 files')).toBeInTheDocument();
    expect(screen.getByText('HIGH · publish')).toBeInTheDocument();
  });

  it('renders the ready/waiting mascot decoratively, never pointing at or replacing the publish actions', () => {
    installBridge();
    render(
      <DiffReviewHead
        idLine="#94"
        title="t"
        stat={STAT}
        worktreeId={WORKTREE_ID}
        branch="issue-94"
      />,
    );
    const mascot = screen.getByRole('presentation', { hidden: true });
    expect(mascot).toHaveAttribute('alt', '');
    expect(mascot).toHaveClass('pipenzo-mascot-sm');
    // Real publish evidence is still driven by real buttons, not decoration.
    expect(screen.getByRole('button', { name: 'Push branch' })).toBeInTheDocument();
  });

  it('renders an over-budget chip with danger tone when the ticket exceeded its estimate', () => {
    installBridge();
    render(
      <DiffReviewHead
        idLine="#94"
        title="t"
        stat={{ ...STAT, withinBudget: false, budgetLabel: 'over budget · exceeded by 40%' }}
        worktreeId={WORKTREE_ID}
        branch="issue-94"
      />,
    );
    expect(screen.getByText('over budget · exceeded by 40%').className).toBe('chip chip-danger');
  });

  it('omits the risk chip entirely when no risk grade is available, rather than a false LOW', () => {
    installBridge();
    render(
      <DiffReviewHead
        idLine="#94"
        title="t"
        stat={{ ...STAT, risk: undefined }}
        worktreeId={WORKTREE_ID}
        branch="issue-94"
      />,
    );
    expect(screen.queryByText(/publish$/)).not.toBeInTheDocument();
  });

  it('wires Push branch through to the real publish call for this worktree and branch', async () => {
    // STAT is risk: 'low' here specifically to exercise the ungated path -- STAT's own HIGH grade
    // is what PublishActions.test.tsx's approval-card tests exercise instead (CLAUDE.md hard rule
    // #3: a HIGH-graded push must never auto-allow, so clicking Push branch there opens the full
    // HIGH approval card, issue #98's `HighApprovalStreamCard`, rather than calling the bridge
    // directly).
    installBridge();
    render(
      <DiffReviewHead
        idLine="#94"
        title="t"
        stat={{ ...STAT, risk: 'low' }}
        worktreeId={WORKTREE_ID}
        branch="issue-94"
        remote="origin"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Push branch' }));
    const bridge = window.agentDock as unknown as { publishPipenzo: ReturnType<typeof vi.fn> };
    expect(bridge.publishPipenzo).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      branch: 'issue-94',
      remote: 'origin',
      operation: 'push',
    });
  });

  it('gates a HIGH-graded push behind the full HIGH approval card instead of publishing on the first click', async () => {
    installBridge();
    render(
      <DiffReviewHead
        idLine="#94"
        title="t"
        stat={STAT}
        worktreeId={WORKTREE_ID}
        branch="issue-94"
        remote="origin"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Push branch' }));
    const bridge = window.agentDock as unknown as { publishPipenzo: ReturnType<typeof vi.fn> };
    expect(bridge.publishPipenzo).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(bridge.publishPipenzo).toHaveBeenCalledWith({
        worktreeId: WORKTREE_ID,
        branch: 'issue-94',
        remote: 'origin',
        operation: 'push',
      }),
    );
  });

  it('renders Discard branch only when a handler is supplied, matching the actions row', () => {
    installBridge();
    const onDiscardClick = vi.fn();
    render(
      <DiffReviewHead
        idLine="#94"
        title="t"
        stat={STAT}
        worktreeId={WORKTREE_ID}
        branch="issue-94"
        onDiscardClick={onDiscardClick}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard branch' }));
    expect(onDiscardClick).toHaveBeenCalledTimes(1);
  });
});
