import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PipenzoImplementResultV1,
  PipenzoIssueClaimResultV1,
  PipenzoRefineResultV1,
  RefineSpecV1,
  WorktreePreviewV2,
} from '@agent-dock/shared';
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

/**
 * A real-shaped spec — this is what the daemon's Refine phase returns, and the only thing the
 * dialog is allowed to hand to Implement. Every assertion below that checks "the real spec" checks
 * object identity with this, so a fabricated stand-in could not pass by being shaped alike.
 */
const SPEC: RefineSpecV1 = {
  schemaVersion: 1,
  issue: { repo: 'jortega0033/agentdock', number: 94, title: TICKET.title },
  summary: 'Strip inherited secrets from the environment handed to MCP stdio subprocesses.',
  acceptanceCriteria: [
    {
      id: 'AC-1',
      kind: 'event',
      text: 'When an MCP stdio server is spawned, the daemon shall pass only an allowlisted environment',
    },
  ],
  outOfScope: ['HTTP transport MCP servers'],
  filesLikelyTouched: ['apps/daemon/src/providers.ts'],
  estimate: { changedLines: 38, filesTouched: 2, layered: false },
  openQuestions: [],
};

const REFINED: PipenzoRefineResultV1 = {
  sessionId: 'refine-session-1',
  spec: SPEC,
  toolsUsed: ['Grep'],
  gateVerdict: 'single',
};

const IMPLEMENTED: PipenzoImplementResultV1 = {
  worktreeId: '123e4567-e89b-42d3-a456-426614174000',
  branch: 'issue-94',
  baseCommit: 'b'.repeat(40),
  sessionId: 'implement-session-1',
};

const CLAIMED: PipenzoIssueClaimResultV1 = {
  repo: 'jortega0033/agentdock',
  issueNumber: 94,
  outcome: 'claimed',
  assignees: ['pipenzo-test-user'],
  title: 'Sanitize environment for MCP stdio subprocesses',
  htmlUrl: 'https://github.com/jortega0033/agentdock/issues/94',
};

function installBridge(overrides: Partial<AgentDockBridge> = {}) {
  const previewWorktree = vi.fn().mockResolvedValue(PREVIEW);
  const refinePipenzo = vi.fn().mockResolvedValue(REFINED);
  const implementPipenzo = vi.fn().mockResolvedValue(IMPLEMENTED);
  const claimPipenzoIssue = vi.fn().mockResolvedValue(CLAIMED);
  (window as unknown as { agentDock: Partial<AgentDockBridge> }).agentDock = {
    previewWorktree,
    refinePipenzo,
    implementPipenzo,
    claimPipenzoIssue,
    ...overrides,
  };
  return { previewWorktree, refinePipenzo, implementPipenzo, claimPipenzoIssue };
}

function renderDialog(props: Partial<Parameters<typeof ImplementDialog>[0]> = {}) {
  return render(
    <ImplementDialog
      open
      ticket={TICKET}
      cwd="/repo"
      provider="claude"
      onClose={() => {}}
      {...props}
    />,
  );
}

/** Refines, then waits for the spec to be on screen and Start to exist. */
async function refineAndWait() {
  fireEvent.click(screen.getByRole('button', { name: 'Refine ticket' }));
  await screen.findByRole('button', { name: 'Start' });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe('ImplementDialog', () => {
  it('renders the ticket number and title in the dialog head, matching Main.dc.html', () => {
    installBridge();
    renderDialog();
    expect(
      screen.getByText('Implement #94 — Sanitize environment for MCP stdio subprocesses'),
    ).toBeInTheDocument();
    expect(screen.getByText(/jortega0033\/agentdock/)).toBeInTheDocument();
  });

  /* ------------------------------------------------- refine before implement */

  /**
   * The gap issue #83's closing commit left open: a board card carries no spec, and Implement
   * takes one. The dialog's answer is to make Implement *unreachable* until Refine has produced a
   * real one — not to invent acceptance criteria to fill the field.
   */
  it('offers Refine and no Start at all when the ticket has no spec', () => {
    const { implementPipenzo } = installBridge();
    renderDialog();
    expect(screen.getByRole('button', { name: 'Refine ticket' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(implementPipenzo).not.toHaveBeenCalled();
  });

  it('runs the real refine route against the operator’s own checkout', async () => {
    const { refinePipenzo } = installBridge();
    renderDialog({ model: 'sonnet-x' });

    fireEvent.click(screen.getByRole('button', { name: 'Refine ticket' }));
    await screen.findByRole('button', { name: 'Refining…' });

    await waitFor(() =>
      expect(refinePipenzo).toHaveBeenCalledWith({
        repo: 'jortega0033/agentdock',
        issueNumber: 94,
        repositoryPath: '/repo',
        provider: 'claude',
        model: 'sonnet-x',
      }),
    );
  });

  /** Genuinely rendered, not silently carried: a human has to be able to read the spec. */
  it('renders the returned spec — summary, criteria, out of scope, estimate — before Start exists', async () => {
    installBridge();
    renderDialog();
    await refineAndWait();

    expect(screen.getByText(/Strip inherited secrets/)).toBeInTheDocument();
    expect(screen.getByText('AC-1')).toBeInTheDocument();
    expect(
      screen.getByText(/the daemon shall pass only an allowlisted environment/),
    ).toBeInTheDocument();
    expect(screen.getByText('HTTP transport MCP servers')).toBeInTheDocument();
    expect(screen.getByText(/38 changed lines across 2 files/)).toBeInTheDocument();
  });

  it('surfaces the spec’s open questions as a warning rather than a bullet', async () => {
    installBridge({
      refinePipenzo: vi.fn().mockResolvedValue({
        ...REFINED,
        spec: { ...SPEC, openQuestions: ['Does the allowlist include PATH?'] },
      }),
    });
    renderDialog();
    await refineAndWait();
    expect(screen.getByText(/could not answer 1 question/i)).toBeInTheDocument();
    expect(screen.getByText(/Does the allowlist include PATH\?/)).toBeInTheDocument();
  });

  it('skips Refine entirely when the caller already holds a real spec', () => {
    const { refinePipenzo } = installBridge();
    renderDialog({ spec: SPEC });
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refine ticket' })).not.toBeInTheDocument();
    expect(refinePipenzo).not.toHaveBeenCalled();
  });

  /* --------------------------------------------------------- implement start */

  it('holds Start pending across claim, preview and the real implement dispatch, then calls onStarted', async () => {
    const { previewWorktree, implementPipenzo, claimPipenzoIssue } = installBridge();
    const onStarted = vi.fn();
    renderDialog({ onStarted });
    await refineAndWait();

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByRole('button', { name: 'Starting…' });

    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith(IMPLEMENTED, {
        worktreeName: 'issue-94',
        extraInstructions: '',
        runBudget: 'unlimited',
      }),
    );
    expect(previewWorktree).toHaveBeenCalledWith({ cwd: '/repo', name: 'issue-94' });
    const [claimOrder = -1] = claimPipenzoIssue.mock.invocationCallOrder;
    const [previewOrder = -1] = previewWorktree.mock.invocationCallOrder;
    const [implementOrder = -1] = implementPipenzo.mock.invocationCallOrder;
    expect(claimOrder).toBeLessThan(previewOrder);
    expect(previewOrder).toBeLessThan(implementOrder);
  });

  /**
   * The whole point of the two-step flow: the object that reaches the route is the one the daemon
   * returned, by identity. Nothing here builds a spec.
   */
  it('sends the refine route’s own spec object to implement, never a constructed one', async () => {
    const { implementPipenzo } = installBridge();
    renderDialog();
    await refineAndWait();

    fireEvent.change(screen.getByLabelText('Extra instructions (optional)'), {
      target: { value: 'only touch the daemon side' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(implementPipenzo).toHaveBeenCalled());
    const [request] = implementPipenzo.mock.calls[0] as [
      { spec: RefineSpecV1; repositoryPath: string; provider: string; extraInstructions?: string },
    ];
    expect(request.spec).toBe(SPEC);
    expect(request).toEqual({
      spec: SPEC,
      repositoryPath: '/repo',
      provider: 'claude',
      extraInstructions: 'only touch the daemon side',
    });
  });

  it('passes the selected run budget through onStarted', async () => {
    installBridge();
    const onStarted = vi.fn();
    renderDialog({ onStarted });
    await refineAndWait();

    fireEvent.change(screen.getByLabelText('Run budget'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith(IMPLEMENTED, {
        worktreeName: 'issue-94',
        extraInstructions: '',
        runBudget: '3',
      }),
    );
  });

  /** Claiming one ticket and implementing another is the failure a mismatched spec would cause. */
  it('refuses a spec whose issue number is not this ticket’s, before claiming anything', async () => {
    const { implementPipenzo, claimPipenzoIssue } = installBridge();
    renderDialog({ spec: { ...SPEC, issue: { ...SPEC.issue, number: 95 } } });

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText(/This spec is for #95, not #94/);
    expect(claimPipenzoIssue).not.toHaveBeenCalled();
    expect(implementPipenzo).not.toHaveBeenCalled();
  });

  it('refuses to dispatch implement when the preview reports a secret-risk include, fail closed', async () => {
    const { implementPipenzo } = installBridge({
      previewWorktree: vi.fn().mockResolvedValue({ ...PREVIEW, secretRisk: true }),
    });
    const onStarted = vi.fn();
    renderDialog({ onStarted });
    await refineAndWait();

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText(/secret-shaped file/i);
    expect(implementPipenzo).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('Cancel closes the dialog without starting anything', () => {
    const { refinePipenzo, implementPipenzo } = installBridge();
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(refinePipenzo).not.toHaveBeenCalled();
    expect(implementPipenzo).not.toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    installBridge();
    renderDialog({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  /**
   * The branch is derived daemon-side (`ticketBranchName`), so the field reads it out rather than
   * pretending to choose it — `pipenzoImplementRequestV1Schema` has nowhere to put an override.
   */
  it('shows the derived branch as a read-only field', () => {
    installBridge();
    renderDialog();
    const branch = screen.getByLabelText('Branch') as HTMLInputElement;
    expect(branch.value).toBe('issue-94');
    expect(branch.readOnly).toBe(true);
  });

  /* ------------------------------------------------------- the claim pre-flight */

  /**
   * Issue #83's actual scope, now that #184 has made the route real: the pre-flight always runs,
   * and it runs *before* anything is created. There is no branch that skips it -- which is the
   * difference between a pre-flight and a warning.
   */
  it('claims the ticket through the daemon before touching a worktree', async () => {
    const { claimPipenzoIssue, previewWorktree } = installBridge();
    renderDialog();
    await refineAndWait();

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(claimPipenzoIssue).toHaveBeenCalled());
    // No login is sent: the daemon holds the token and resolves the authenticated user, so a
    // renderer cannot claim a ticket as somebody else.
    expect(claimPipenzoIssue).toHaveBeenCalledWith({
      repo: 'jortega0033/agentdock',
      issueNumber: 94,
    });
    await waitFor(() => expect(previewWorktree).toHaveBeenCalled());
    const [claimOrder = -1] = claimPipenzoIssue.mock.invocationCallOrder;
    const [previewOrder = -1] = previewWorktree.mock.invocationCallOrder;
    expect(claimOrder).toBeLessThan(previewOrder);
  });

  /** The daemon's `claimed_elsewhere` is a refusal, and the card has to name who holds it. */
  it('refuses on a lost claim race, naming the holder, with nothing created', async () => {
    const { previewWorktree, implementPipenzo } = installBridge({
      claimPipenzoIssue: vi.fn().mockResolvedValue({
        ...CLAIMED,
        outcome: 'claimed_elsewhere',
        assignees: ['someone-else', 'pipenzo-test-user'],
      }),
    });
    const onStarted = vi.fn();
    renderDialog({ onStarted });
    await refineAndWait();

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    // Twice, on purpose: the notice explains that nothing was started, and the field error is the
    // one an assistive technology announces.
    await waitFor(() =>
      expect(screen.getAllByText(/claimed by @someone-else/i).length).toBeGreaterThan(0),
    );
    expect(screen.getByRole('alert').textContent).toMatch(/claimed by @someone-else/i);
    expect(previewWorktree).not.toHaveBeenCalled();
    expect(implementPipenzo).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    // A claim conflict belongs to someone else — there is nothing to retry.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('refuses to dispatch implement when claimPreflight reports the ticket is already claimed', async () => {
    const { previewWorktree, implementPipenzo } = installBridge();
    const onStarted = vi.fn();
    renderDialog({
      onStarted,
      claimPreflight: () => Promise.resolve({ claimed: true, assignee: 'someone-else' }),
    });
    await refineAndWait();

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText(/already claimed by @someone-else/i);
    expect(previewWorktree).not.toHaveBeenCalled();
    expect(implementPipenzo).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    // A claim conflict belongs to someone else -- there is nothing to retry, matching
    // Main.dc.html's claimed-by-@someone-else card, which renders no action at all.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });
});
