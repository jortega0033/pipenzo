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

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(WORKTREE));
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
});
