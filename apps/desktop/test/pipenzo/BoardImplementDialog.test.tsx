import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PipenzoImplementResultV1,
  PipenzoIssueClaimResultV1,
  PipenzoRefineResultV1,
  PipenzoTicketViewV1,
  RefineSpecV1,
  WorkspaceTrustViewV2,
  WorktreePreviewV2,
} from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import {
  BOARD_IMPLEMENT_PROVIDER,
  BoardImplementDialog,
} from '../../src/pipenzo/BoardImplementDialog.js';

/**
 * Issue #342's click-to-start path, from a board ticket (which has only `owner/name`) to a real
 * implement dispatch against a real checkout path. `ImplementDialog.test.tsx` owns the dialog's own
 * refine/claim/preview/implement rules; this file owns what has to happen *before* that dialog can
 * exist, and that the path it is handed is the one the daemon resolved.
 */

const REPO = 'jortega0033/pipenzo';
const CHECKOUT = 'C:\\pipenzo-state\\repos\\jortega0033\\pipenzo';

const TICKET: PipenzoTicketViewV1 = {
  schemaVersion: 1,
  ticketId: '00000000-0000-4000-8000-000000000042',
  repo: REPO,
  issueNumber: 42,
  title: 'Fix the thing',
  lane: 'queued',
  phase: 'refine',
  labels: ['pipenzo:queued'],
  estimate: { lines: 0, files: 0, layered: false },
  taskType: 'chore',
  stack: { parentId: null, childIds: [], index: null },
  attempts: [],
  budget: { tokensUsed: 0, limit: 0 },
  risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
  precommits: [],
  etags: {},
};

const TRUST_BASE = {
  schemaVersion: 1 as const,
  workspaceId: 'c'.repeat(64),
  incarnation: 'd'.repeat(64),
  displayName: 'pipenzo',
  reusable: true,
};
const TRUSTED: WorkspaceTrustViewV2 = { ...TRUST_BASE, state: 'trusted' };
const UNTRUSTED: WorkspaceTrustViewV2 = { ...TRUST_BASE, state: 'untrusted' };

const SPEC: RefineSpecV1 = {
  schemaVersion: 1,
  issue: { repo: REPO, number: 42, title: 'Fix the thing' },
  summary: 'Fix the thing, and only the thing.',
  acceptanceCriteria: [{ id: 'AC-1', kind: 'event', text: 'When X, the system shall Y' }],
  outOfScope: ['Everything else'],
  filesLikelyTouched: ['src/thing.ts'],
  estimate: { changedLines: 12, filesTouched: 1, layered: false },
  openQuestions: [],
};
const REFINED: PipenzoRefineResultV1 = {
  sessionId: 'refine-1',
  spec: SPEC,
  toolsUsed: ['Grep'],
  gateVerdict: 'single',
};
const PREVIEW: WorktreePreviewV2 = {
  workspaceId: 'c'.repeat(64),
  name: 'issue-42',
  displayTarget: 'issue-42',
  includeFiles: [],
  ignoredFiles: [],
  secretRisk: false,
  requiresConfirmation: false,
};
const CLAIMED: PipenzoIssueClaimResultV1 = {
  repo: REPO,
  issueNumber: 42,
  outcome: 'claimed',
  assignees: ['me'],
  title: 'Fix the thing',
  htmlUrl: 'https://github.com/jortega0033/pipenzo/issues/42',
};
const IMPLEMENTED: PipenzoImplementResultV1 = {
  worktreeId: '123e4567-e89b-42d3-a456-426614174000',
  branch: 'issue-42',
  baseCommit: 'b'.repeat(40),
  sessionId: 'implement-1',
};

function installBridge(overrides: Record<string, unknown> = {}) {
  const bridge = {
    resolvePipenzoCheckout: vi.fn().mockResolvedValue({ repo: REPO, repositoryPath: CHECKOUT }),
    inspectWorkspace: vi.fn().mockResolvedValue(TRUSTED),
    setWorkspaceTrust: vi.fn().mockResolvedValue(TRUSTED),
    refinePipenzo: vi.fn().mockResolvedValue(REFINED),
    claimPipenzoIssue: vi.fn().mockResolvedValue(CLAIMED),
    previewWorktree: vi.fn().mockResolvedValue(PREVIEW),
    implementPipenzo: vi.fn().mockResolvedValue(IMPLEMENTED),
    ...overrides,
  };
  setBridgeOverride(bridge as never);
  return bridge;
}

afterEach(() => {
  cleanup();
  clearBridgeOverride();
});

describe('BoardImplementDialog', () => {
  it('resolves the ticket’s repo to a checkout, then runs the real refine and implement against that path', async () => {
    const bridge = installBridge();
    const onStarted = vi.fn();
    render(<BoardImplementDialog ticket={TICKET} onClose={vi.fn()} onStarted={onStarted} />);

    // Step 1 is visible while it runs -- a first clone is not instant.
    expect(screen.getByRole('status')).toHaveTextContent(/Preparing a local checkout of/);
    expect(bridge.resolvePipenzoCheckout).toHaveBeenCalledWith({ repo: REPO });

    fireEvent.click(await screen.findByRole('button', { name: 'Refine ticket' }));
    await waitFor(() =>
      expect(bridge.refinePipenzo).toHaveBeenCalledWith({
        repo: REPO,
        issueNumber: 42,
        repositoryPath: CHECKOUT,
        provider: BOARD_IMPLEMENT_PROVIDER,
      }),
    );
    expect(bridge.inspectWorkspace).toHaveBeenCalledWith(CHECKOUT);

    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(IMPLEMENTED));
    expect(bridge.previewWorktree).toHaveBeenCalledWith({ cwd: CHECKOUT, name: 'issue-42' });
    expect(bridge.implementPipenzo).toHaveBeenCalledWith({
      spec: SPEC,
      repositoryPath: CHECKOUT,
      provider: BOARD_IMPLEMENT_PROVIDER,
    });
  });

  it('reads out the default provider in the dialog rather than choosing it silently', async () => {
    installBridge();
    render(<BoardImplementDialog ticket={TICKET} onClose={vi.fn()} />);

    await screen.findByRole('button', { name: 'Refine ticket' });
    expect(BOARD_IMPLEMENT_PROVIDER).toBe('claude');
    expect(screen.getByText(/with its default model/)).toHaveTextContent(
      'Runs on claude, with its default model.',
    );
  });

  it('never trusts a fresh checkout on the person’s behalf: refine is unreachable until they click Trust', async () => {
    const bridge = installBridge({ inspectWorkspace: vi.fn().mockResolvedValue(UNTRUSTED) });
    render(<BoardImplementDialog ticket={TICKET} onClose={vi.fn()} />);

    const trust = await screen.findByRole('button', { name: 'Trust this checkout' });
    expect(screen.getByText(CHECKOUT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refine ticket' })).not.toBeInTheDocument();
    expect(bridge.setWorkspaceTrust).not.toHaveBeenCalled();

    fireEvent.click(trust);

    await screen.findByRole('button', { name: 'Refine ticket' });
    expect(bridge.setWorkspaceTrust).toHaveBeenCalledWith(TRUST_BASE.workspaceId, {
      cwd: CHECKOUT,
      incarnation: TRUST_BASE.incarnation,
      state: 'trusted',
    });
    expect(bridge.refinePipenzo).not.toHaveBeenCalled();
  });

  it('keeps the trust prompt, with the reason, when trusting fails', async () => {
    installBridge({
      inspectWorkspace: vi.fn().mockResolvedValue(UNTRUSTED),
      setWorkspaceTrust: vi.fn().mockRejectedValue(new Error('workspace identity changed')),
    });
    render(<BoardImplementDialog ticket={TICKET} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Trust this checkout' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('workspace identity changed');
    expect(screen.queryByRole('button', { name: 'Refine ticket' })).not.toBeInTheDocument();
  });

  it('surfaces a failed checkout with the daemon’s reason and a Retry that asks again', async () => {
    const resolvePipenzoCheckout = vi
      .fn()
      .mockRejectedValueOnce(new Error('git clone https://github.com/jortega0033/pipenzo.git failed'))
      .mockResolvedValue({ repo: REPO, repositoryPath: CHECKOUT });
    installBridge({ resolvePipenzoCheckout });
    render(<BoardImplementDialog ticket={TICKET} onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Couldn.t prepare a local checkout of jortega0033\/pipenzo: git clone .* failed/,
    );
    expect(screen.queryByRole('button', { name: 'Refine ticket' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByRole('button', { name: 'Refine ticket' });
    expect(resolvePipenzoCheckout).toHaveBeenCalledTimes(2);
  });

  it('lets the person cancel while the checkout is still being prepared', async () => {
    installBridge({ resolvePipenzoCheckout: vi.fn(() => new Promise(() => {})) });
    const onClose = vi.fn();
    render(<BoardImplementDialog ticket={TICKET} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
