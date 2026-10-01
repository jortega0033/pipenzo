import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoIssueDraftV1, WorkspaceTrustViewV2 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { BOARD_IMPLEMENT_PROVIDER } from '../../src/pipenzo/BoardImplementDialog.js';
import { BoardNewFromIdeaDialog } from '../../src/pipenzo/BoardNewFromIdeaDialog.js';

/**
 * The palette's "New from idea" row (issue #88's own follow-up), from an active repo (which is
 * only ever `owner/name`) to a real drafting session against a real checkout path.
 * `NewFromIdeaDialog.test.tsx` owns the dialog's own draft/create rules; this file owns what has to
 * happen *before* that dialog can exist, and that the checkout it is handed is the one the daemon
 * resolved -- the same split `BoardImplementDialog.test.tsx` already draws for Implement.
 */

const REPO = 'jortega0033/pipenzo';
const CHECKOUT = 'C:\\pipenzo-state\\repos\\jortega0033\\pipenzo';

const TRUST_BASE = {
  schemaVersion: 1 as const,
  workspaceId: 'c'.repeat(64),
  incarnation: 'd'.repeat(64),
  displayName: 'pipenzo',
  reusable: true,
};
const TRUSTED: WorkspaceTrustViewV2 = { ...TRUST_BASE, state: 'trusted' };
const UNTRUSTED: WorkspaceTrustViewV2 = { ...TRUST_BASE, state: 'untrusted' };

const DRAFT: PipenzoIssueDraftV1 = {
  schemaVersion: 1,
  title: 'Show an unread badge when a ticket reaches ready-for-review',
  acceptanceCriteria: [
    { id: 'AC-1', kind: 'event', text: 'When a ticket reaches ready-for-review, X shall Y' },
  ],
  outOfScope: ['sounds'],
  estimate: { changedLines: 40, filesTouched: 1, layered: false },
  openQuestions: [],
};

function installBridge(overrides: Record<string, unknown> = {}) {
  const bridge = {
    resolvePipenzoCheckout: vi.fn().mockResolvedValue({ repo: REPO, repositoryPath: CHECKOUT }),
    inspectWorkspace: vi.fn().mockResolvedValue(TRUSTED),
    setWorkspaceTrust: vi.fn().mockResolvedValue(TRUSTED),
    draftPipenzoIssue: vi.fn().mockResolvedValue({ sessionId: 's1', draft: DRAFT }),
    createPipenzoIssue: vi.fn().mockResolvedValue({
      repo: REPO,
      issueNumber: 901,
      title: DRAFT.title,
      htmlUrl: 'https://github.com/jortega0033/pipenzo/issues/901',
    }),
    ...overrides,
  };
  setBridgeOverride(bridge as never);
  return bridge;
}

afterEach(() => {
  cleanup();
  clearBridgeOverride();
});

describe('BoardNewFromIdeaDialog', () => {
  it('resolves the active repo to a checkout, then runs the real draft and create against that path', async () => {
    const bridge = installBridge();
    const onCreated = vi.fn();
    render(<BoardNewFromIdeaDialog repo={REPO} onClose={vi.fn()} onCreated={onCreated} />);

    // Step 1 is visible while it runs -- a first clone is not instant.
    expect(screen.getByRole('status')).toHaveTextContent(/Preparing a local checkout of/);
    expect(bridge.resolvePipenzoCheckout).toHaveBeenCalledWith({ repo: REPO });

    fireEvent.change(await screen.findByLabelText('What’s the problem?'), {
      target: { value: 'tickets get lost' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Draft issue' }));

    await waitFor(() =>
      expect(bridge.draftPipenzoIssue).toHaveBeenCalledWith({
        idea: 'tickets get lost',
        repositoryPath: CHECKOUT,
        provider: BOARD_IMPLEMENT_PROVIDER,
      }),
    );
    expect(bridge.inspectWorkspace).toHaveBeenCalledWith(CHECKOUT);

    fireEvent.click(await screen.findByRole('button', { name: 'Create issue' }));
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({
        issueNumber: 901,
        htmlUrl: 'https://github.com/jortega0033/pipenzo/issues/901',
      }),
    );
    expect(bridge.createPipenzoIssue).toHaveBeenCalledWith(
      expect.objectContaining({ repo: REPO, title: DRAFT.title }),
    );
  });

  it('never trusts a fresh checkout on the person’s behalf: drafting is unreachable until they click Trust', async () => {
    const bridge = installBridge({ inspectWorkspace: vi.fn().mockResolvedValue(UNTRUSTED) });
    render(<BoardNewFromIdeaDialog repo={REPO} onClose={vi.fn()} />);

    const trust = await screen.findByRole('button', { name: 'Trust this checkout' });
    expect(screen.getByText(CHECKOUT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Draft issue' })).not.toBeInTheDocument();
    expect(bridge.setWorkspaceTrust).not.toHaveBeenCalled();

    fireEvent.click(trust);

    await screen.findByRole('button', { name: 'Draft issue' });
    expect(bridge.setWorkspaceTrust).toHaveBeenCalledWith(TRUST_BASE.workspaceId, {
      cwd: CHECKOUT,
      incarnation: TRUST_BASE.incarnation,
      state: 'trusted',
    });
    expect(bridge.draftPipenzoIssue).not.toHaveBeenCalled();
  });

  it('keeps the trust prompt, with the reason, when trusting fails', async () => {
    installBridge({
      inspectWorkspace: vi.fn().mockResolvedValue(UNTRUSTED),
      setWorkspaceTrust: vi.fn().mockRejectedValue(new Error('workspace identity changed')),
    });
    render(<BoardNewFromIdeaDialog repo={REPO} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Trust this checkout' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('workspace identity changed');
    expect(screen.queryByRole('button', { name: 'Draft issue' })).not.toBeInTheDocument();
  });

  it('surfaces a failed checkout with the daemon’s reason and a Retry that asks again', async () => {
    const resolvePipenzoCheckout = vi
      .fn()
      .mockRejectedValueOnce(new Error('git clone https://github.com/jortega0033/pipenzo.git failed'))
      .mockResolvedValue({ repo: REPO, repositoryPath: CHECKOUT });
    installBridge({ resolvePipenzoCheckout });
    render(<BoardNewFromIdeaDialog repo={REPO} onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Couldn.t prepare a local checkout of jortega0033\/pipenzo: git clone .* failed/,
    );
    expect(screen.queryByRole('button', { name: 'Draft issue' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByRole('button', { name: 'Draft issue' });
    expect(resolvePipenzoCheckout).toHaveBeenCalledTimes(2);
  });

  it('lets the person cancel while the checkout is still being prepared', async () => {
    installBridge({ resolvePipenzoCheckout: vi.fn(() => new Promise(() => {})) });
    const onClose = vi.fn();
    render(<BoardNewFromIdeaDialog repo={REPO} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
