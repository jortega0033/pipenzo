import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedWorktreeV2 } from '@agent-dock/shared';
import { DiscardBranchDialog } from '../../src/pipenzo/DiscardBranchDialog.js';
import type { AgentDockBridge } from '../../src/window.js';

const WORKTREE_ID = '123e4567-e89b-42d3-a456-426614174000';

const CLEANED: OwnedWorktreeV2 = {
  id: WORKTREE_ID,
  workspaceId: 'a'.repeat(64),
  name: 'issue-94',
  displayPath: 'issue-94',
  status: 'missing',
  createdAt: '2026-09-06T00:00:00.000Z',
};

function daemonError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function installBridge(overrides: Partial<AgentDockBridge> = {}) {
  const cleanupWorktree = vi.fn().mockResolvedValue(CLEANED);
  (window as unknown as { agentDock: Partial<AgentDockBridge> }).agentDock = {
    cleanupWorktree,
    ...overrides,
  };
  return { cleanupWorktree };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe('DiscardBranchDialog', () => {
  it('renders the branch name and a plain confirm on first open', () => {
    installBridge();
    render(<DiscardBranchDialog open worktreeId={WORKTREE_ID} branch="issue-94" onClose={() => {}} />);
    expect(screen.getByText('issue-94', { selector: '.mono' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard branch' })).toBeInTheDocument();
  });

  it('discards a clean worktree in one call, deleting the branch too by default, then reports success', async () => {
    const { cleanupWorktree } = installBridge();
    const onDiscarded = vi.fn();
    render(
      <DiscardBranchDialog open worktreeId={WORKTREE_ID} branch="issue-94" onClose={() => {}} onDiscarded={onDiscarded} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard branch' }));
    await waitFor(() => expect(onDiscarded).toHaveBeenCalledTimes(1));
    expect(cleanupWorktree).toHaveBeenCalledWith(WORKTREE_ID, { deleteUntracked: false, deleteBranch: true });
  });

  it('offers "Also delete untracked files" after a first worktree_dirty failure, rather than a bare error', async () => {
    installBridge({ cleanupWorktree: vi.fn().mockRejectedValue(daemonError('worktree_dirty', 'Dirty worktrees are never removed automatically')) });
    render(<DiscardBranchDialog open worktreeId={WORKTREE_ID} branch="issue-94" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard branch' }));

    const retryButton = await screen.findByRole('button', { name: 'Also delete untracked files' });
    expect(screen.getByText(/untracked files/i, { selector: '.f-err' })).toBeInTheDocument();
    expect(retryButton).not.toBeDisabled();
  });

  it('retries with deleteUntracked on the second click, and succeeds if that was the whole problem', async () => {
    const cleanupWorktree = vi
      .fn()
      .mockRejectedValueOnce(daemonError('worktree_dirty', 'dirty'))
      .mockResolvedValueOnce(CLEANED);
    installBridge({ cleanupWorktree });
    const onDiscarded = vi.fn();
    render(
      <DiscardBranchDialog open worktreeId={WORKTREE_ID} branch="issue-94" onClose={() => {}} onDiscarded={onDiscarded} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard branch' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Also delete untracked files' }));

    await waitFor(() => expect(onDiscarded).toHaveBeenCalledTimes(1));
    expect(cleanupWorktree).toHaveBeenNthCalledWith(2, WORKTREE_ID, { deleteUntracked: true, deleteBranch: true });
  });

  it('refuses outright with no further action once the retry also comes back worktree_dirty (real tracked changes)', async () => {
    const cleanupWorktree = vi.fn().mockRejectedValue(daemonError('worktree_dirty', 'dirty'));
    installBridge({ cleanupWorktree });
    render(<DiscardBranchDialog open worktreeId={WORKTREE_ID} branch="issue-94" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard branch' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Also delete untracked files' }));

    await screen.findByText(/uncommitted changes to tracked files/i);
    const finalButton = screen.getByRole('button', { name: 'Discard branch' });
    expect(finalButton).toBeDisabled();
    expect(cleanupWorktree).toHaveBeenCalledTimes(2);
  });

  it('shows the plain error message for a failure that is not worktree_dirty, with no untracked offer', async () => {
    installBridge({ cleanupWorktree: vi.fn().mockRejectedValue(daemonError('worktree_locked', 'Locked worktrees are never removed automatically')) });
    render(<DiscardBranchDialog open worktreeId={WORKTREE_ID} branch="issue-94" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard branch' }));

    await screen.findByText('Locked worktrees are never removed automatically');
    expect(screen.queryByRole('button', { name: 'Also delete untracked files' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard branch' })).not.toBeDisabled();
  });

  it('resets all attempt state on Cancel, so reopening starts from a plain confirm again', async () => {
    installBridge({ cleanupWorktree: vi.fn().mockRejectedValue(daemonError('worktree_dirty', 'dirty')) });
    const onClose = vi.fn();
    const { rerender } = render(
      <DiscardBranchDialog open worktreeId={WORKTREE_ID} branch="issue-94" onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard branch' }));
    await screen.findByRole('button', { name: 'Also delete untracked files' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<DiscardBranchDialog open={false} worktreeId={WORKTREE_ID} branch="issue-94" onClose={onClose} />);
    rerender(<DiscardBranchDialog open worktreeId={WORKTREE_ID} branch="issue-94" onClose={onClose} />);
    expect(screen.getByRole('button', { name: 'Discard branch' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Also delete untracked files' })).not.toBeInTheDocument();
  });

  it('omits "and its branch" from the confirmation copy when deleteBranch is false', () => {
    installBridge();
    render(
      <DiscardBranchDialog open worktreeId={WORKTREE_ID} branch="issue-94" onClose={() => {}} deleteBranch={false} />,
    );
    expect(screen.getByText(/This deletes the worktree for/)).toBeInTheDocument();
  });
});
