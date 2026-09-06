import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedWorktreeV2, WorktreePreviewV2 } from '@agent-dock/shared';
import { ImplementDialog } from '../../src/pipenzo/ImplementDialog.js';
import type { AgentDockBridge } from '../../src/window.js';

const TICKET = { num: 94, title: 'Sanitize environment for MCP stdio subprocesses', repo: 'jortega0033/agentdock' };

const PREVIEW: WorktreePreviewV2 = {
  workspaceId: 'a'.repeat(64),
  name: 'issue-94',
  displayTarget: 'issue-94',
  includeFiles: [],
  ignoredFiles: [],
  secretRisk: false,
  requiresConfirmation: false,
};

const WORKTREE: OwnedWorktreeV2 = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  workspaceId: 'a'.repeat(64),
  name: 'issue-94',
  displayPath: 'issue-94',
  status: 'ready',
  createdAt: '2026-09-06T00:00:00.000Z',
};

function installBridge(overrides: Partial<AgentDockBridge> = {}) {
  const previewWorktree = vi.fn().mockResolvedValue(PREVIEW);
  const createWorktree = vi.fn().mockResolvedValue(WORKTREE);
  (window as unknown as { agentDock: Partial<AgentDockBridge> }).agentDock = {
    previewWorktree,
    createWorktree,
    ...overrides,
  };
  return { previewWorktree, createWorktree };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe('ImplementDialog', () => {
  it('renders the ticket number and title in the dialog head, matching Main.dc.html', () => {
    installBridge();
    render(<ImplementDialog open ticket={TICKET} cwd="/repo" onClose={() => {}} />);
    expect(
      screen.getByText('Implement #94 — Sanitize environment for MCP stdio subprocesses'),
    ).toBeInTheDocument();
    expect(screen.getByText(/jortega0033\/agentdock/)).toBeInTheDocument();
  });

  it('holds Start pending across the real preview-then-create worktree chain, then calls onStarted', async () => {
    const { previewWorktree, createWorktree } = installBridge();
    const onStarted = vi.fn();
    render(<ImplementDialog open ticket={TICKET} cwd="/repo" onClose={() => {}} onStarted={onStarted} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByRole('button', { name: 'Starting…' });

    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith(WORKTREE, {
        worktreeName: 'issue-94',
        extraInstructions: '',
        runBudget: 'unlimited',
      }),
    );
    expect(previewWorktree).toHaveBeenCalledWith({ cwd: '/repo', name: 'issue-94' });
    expect(createWorktree).toHaveBeenCalledWith({ cwd: '/repo', name: 'issue-94', confirmIncludeCopy: true });
    // preview must resolve before create is even attempted -- two real round trips, not one.
    const [previewOrder = -1] = previewWorktree.mock.invocationCallOrder;
    const [createOrder = -1] = createWorktree.mock.invocationCallOrder;
    expect(previewOrder).toBeLessThan(createOrder);
    expect(createOrder).toBeGreaterThanOrEqual(0);
  });

  it('refuses to create the worktree when the preview reports a secret-risk include, fail closed', async () => {
    const { createWorktree } = installBridge({
      previewWorktree: vi.fn().mockResolvedValue({ ...PREVIEW, secretRisk: true }),
    });
    const onStarted = vi.fn();
    render(<ImplementDialog open ticket={TICKET} cwd="/repo" onClose={() => {}} onStarted={onStarted} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText(/secret-shaped file/i);
    expect(createWorktree).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('Cancel closes the dialog without starting anything', () => {
    const { previewWorktree } = installBridge();
    const onClose = vi.fn();
    render(<ImplementDialog open ticket={TICKET} cwd="/repo" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(previewWorktree).not.toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    installBridge();
    render(<ImplementDialog open={false} ticket={TICKET} cwd="/repo" onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('uses a valid branch-name override as the worktree name instead of the default', async () => {
    const { previewWorktree } = installBridge();
    render(<ImplementDialog open ticket={TICKET} cwd="/repo" onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('Branch name override'), {
      target: { value: 'issue-94-retry' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() =>
      expect(previewWorktree).toHaveBeenCalledWith({ cwd: '/repo', name: 'issue-94-retry' }),
    );
  });

  it('rejects an invalid branch-name override inline and refuses to start', () => {
    const { previewWorktree } = installBridge();
    render(<ImplementDialog open ticket={TICKET} cwd="/repo" onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('Branch name override'), {
      target: { value: 'issue 94/oops' },
    });
    expect(screen.getByText(/only letters, numbers/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(previewWorktree).not.toHaveBeenCalled();
  });

  it('passes extra instructions and the selected run budget through onStarted', async () => {
    installBridge();
    const onStarted = vi.fn();
    render(<ImplementDialog open ticket={TICKET} cwd="/repo" onClose={() => {}} onStarted={onStarted} />);

    fireEvent.change(screen.getByLabelText('Extra instructions (optional)'), {
      target: { value: 'only touch the daemon side' },
    });
    fireEvent.change(screen.getByLabelText('Run budget'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith(WORKTREE, {
        worktreeName: 'issue-94',
        extraInstructions: 'only touch the daemon side',
        runBudget: '3',
      }),
    );
  });

  it('shows an explicit notice instead of silently skipping the claim check when none is wired', () => {
    installBridge();
    render(<ImplementDialog open ticket={TICKET} cwd="/repo" onClose={() => {}} />);
    expect(screen.getByText(/claim verification isn't wired up yet/i)).toBeInTheDocument();
  });

  it('does not show the claim-check notice once a claimPreflight is supplied', () => {
    installBridge();
    render(
      <ImplementDialog
        open
        ticket={TICKET}
        cwd="/repo"
        onClose={() => {}}
        claimPreflight={() => Promise.resolve({ claimed: false })}
      />,
    );
    expect(screen.queryByText(/claim verification isn't wired up yet/i)).not.toBeInTheDocument();
  });

  it('refuses to create a worktree when claimPreflight reports the ticket is already claimed', async () => {
    const { previewWorktree } = installBridge();
    const onStarted = vi.fn();
    render(
      <ImplementDialog
        open
        ticket={TICKET}
        cwd="/repo"
        onClose={() => {}}
        onStarted={onStarted}
        claimPreflight={() => Promise.resolve({ claimed: true, assignee: 'someone-else' })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText(/already claimed by @someone-else/i);
    expect(previewWorktree).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    // A claim conflict belongs to someone else -- there is nothing to retry, matching
    // Main.dc.html's claimed-by-@someone-else card, which renders no action at all.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });
});
