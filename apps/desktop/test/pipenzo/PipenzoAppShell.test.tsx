import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { PipenzoAppShell } from '../../src/pipenzo/PipenzoAppShell.js';

const REPO = 'jortega0033/pipenzo';

function makeTicket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: '00000000-0000-4000-8000-000000000001',
    repo: REPO,
    issueNumber: 81,
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
    ...overrides,
  };
}

/** Every method the shell's own hook (`usePipenzoTickets`) and `SettingsPage`'s panels reach for
 * on mount, and nothing else -- the same shape `SettingsPage.test.tsx`'s own `installBridge` uses,
 * extended with the board's own ticket-list methods. */
function installBridge(tickets: readonly PipenzoTicketViewV1[] = []) {
  setBridgeOverride({
    pipenzoListTickets: vi.fn().mockResolvedValue({ tickets }),
    onPipenzoPhaseEvent: () => () => {},
    getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
    onDaemonStatus: () => () => {},
    pipenzoConnectedRepos: vi.fn().mockResolvedValue({ repositories: ['octocat/hello-world'] }),
    pipenzoListRepos: vi.fn().mockResolvedValue({ repositories: [], truncated: false }),
    pipenzoConnectRepos: vi.fn(),
    pipenzoLessons: vi.fn().mockResolvedValue({ lessons: [] }),
    pipenzoDeleteLesson: vi.fn(),
    pipenzoGitHubConnection: vi
      .fn()
      .mockResolvedValue({ state: 'connected', login: 'octocat', source: 'vault' }),
    listProvidersV2: vi.fn().mockResolvedValue([]),
    disconnectGitHub: vi.fn(),
  } as never);
}

const SYNC = { status: 'synced' as const, label: 'Synced 12s ago' };

afterEach(() => {
  cleanup();
  clearBridgeOverride();
});

describe('PipenzoAppShell', () => {
  it('renders the board by default, with Board active in the sidebar', async () => {
    installBridge();
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    const board = await screen.findByRole('button', { name: 'Board' });
    expect(board.className).toBe('nav-item active');
    expect(screen.getByRole('button', { name: 'Settings' }).className).toBe('nav-item');
    // The board's own four lanes, proving `BoardScreen` is what actually mounted.
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('navigates to Settings and back on nav-item clicks, mounting a different screen each time', async () => {
    installBridge();
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);
    await screen.findByText('Queued');

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(await screen.findByText('Connected repos')).toBeInTheDocument();
    expect(screen.queryByText('Queued')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' }).className).toBe('nav-item active');
    expect(screen.getByRole('button', { name: 'Board' }).className).toBe('nav-item');

    fireEvent.click(screen.getByRole('button', { name: 'Board' }));

    expect(await screen.findByText('Queued')).toBeInTheDocument();
    expect(screen.queryByText('Connected repos')).not.toBeInTheDocument();
  });

  it('renders real tickets into their lanes through the base Card primitive', async () => {
    installBridge([
      makeTicket({ ticketId: 'a', issueNumber: 42, lane: 'queued', title: 'Fix the thing' }),
      makeTicket({ ticketId: 'b', issueNumber: 43, lane: 'working' }),
    ]);
    const { container } = render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    expect(await screen.findByText('Fix the thing')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
    // No cached title on the second ticket -- falls back to a real, non-guessed label.
    expect(screen.getByText('Issue #43')).toBeInTheDocument();
    expect(container.querySelectorAll('.card')).toHaveLength(2);
  });

  it('gives a Working card a real phase chip, read off the ticket, not guessed', async () => {
    installBridge([
      makeTicket({ ticketId: 'a', issueNumber: 42, lane: 'working', phase: 'implement' }),
      makeTicket({ ticketId: 'b', issueNumber: 43, lane: 'working', phase: 'review' }),
      makeTicket({ ticketId: 'c', issueNumber: 44, lane: 'working', phase: 'refine' }),
    ]);
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    expect(await screen.findByText('implementing')).toBeInTheDocument();
    expect(screen.getByText('reviewing')).toBeInTheDocument();
    expect(screen.getByText('refining')).toBeInTheDocument();
  });

  it('gives a Ready-for-review card a real chip and its real branch, when one exists', async () => {
    installBridge([
      makeTicket({
        ticketId: 'a',
        issueNumber: 42,
        lane: 'ready-for-review',
        worktree: { id: '00000000-0000-4000-8000-000000000002', branch: 'issue-42' },
      }),
    ]);
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    expect(await screen.findByText('ready for review')).toBeInTheDocument();
    expect(screen.getByText('issue-42')).toBeInTheDocument();
  });

  it('renders no chip and no branch for Queued or Needs-human -- neither is a guess this shell makes', async () => {
    installBridge([
      makeTicket({ ticketId: 'a', issueNumber: 42, lane: 'queued' }),
      makeTicket({ ticketId: 'b', issueNumber: 43, lane: 'needs-human' }),
    ]);
    const { container } = render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    await screen.findByText('#42');
    expect(container.querySelectorAll('.chip')).toHaveLength(0);
    expect(container.querySelectorAll('.card-foot')).toHaveLength(0);
  });

  it('shows the current page as the crumb trail', async () => {
    installBridge();
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);
    await screen.findByText('Queued');

    expect(document.querySelector('.crumbs .cur')?.textContent).toBe('Board');

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByText('Connected repos');

    expect(document.querySelector('.crumbs .cur')?.textContent).toBe('Settings');
  });

  it('renders the sync pill in the header and wires its refresh to the caller', async () => {
    installBridge();
    const onRefreshSync = vi.fn();
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={onRefreshSync} />);
    await screen.findByText('Queued');

    expect(screen.getByText('Synced 12s ago')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    expect(onRefreshSync).toHaveBeenCalledTimes(1);
  });

  it('does not flash the demo AgentDock shell -- nothing here ever renders `<App>`', async () => {
    installBridge();
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument());

    expect(screen.queryByRole('heading', { name: 'AgentDock' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try a demo' })).not.toBeInTheDocument();
  });

  /* ------------------------------------------- issue #342: Queued card -> Implement dialog */

  const CHECKOUT = '/state/repos/jortega0033/pipenzo';
  const TRUSTED = {
    schemaVersion: 1,
    workspaceId: 'c'.repeat(64),
    incarnation: 'd'.repeat(64),
    displayName: 'pipenzo',
    reusable: true,
    state: 'trusted',
  };
  const SPEC = {
    schemaVersion: 1,
    issue: { repo: REPO, number: 42, title: 'Fix the thing' },
    summary: 'Fix the thing.',
    acceptanceCriteria: [{ id: 'AC-1', kind: 'event', text: 'When X, the system shall Y' }],
    outOfScope: [],
    filesLikelyTouched: [],
    estimate: { changedLines: 12, filesTouched: 1, layered: false },
    openQuestions: [],
  };
  const IMPLEMENTED = {
    worktreeId: '123e4567-e89b-42d3-a456-426614174000',
    branch: 'issue-42',
    baseCommit: 'b'.repeat(40),
    sessionId: 'implement-1',
  };

  /** The board's own methods plus everything the Implement path reaches for. */
  function installImplementBridge(tickets: readonly PipenzoTicketViewV1[]) {
    const bridge = {
      pipenzoListTickets: vi.fn().mockResolvedValue({ tickets }),
      onPipenzoPhaseEvent: () => () => {},
      getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
      onDaemonStatus: () => () => {},
      resolvePipenzoCheckout: vi.fn().mockResolvedValue({ repo: REPO, repositoryPath: CHECKOUT }),
      inspectWorkspace: vi.fn().mockResolvedValue(TRUSTED),
      setWorkspaceTrust: vi.fn(),
      refinePipenzo: vi
        .fn()
        .mockResolvedValue({ sessionId: 'r', spec: SPEC, toolsUsed: [], gateVerdict: 'single' }),
      claimPipenzoIssue: vi.fn().mockResolvedValue({
        repo: REPO,
        issueNumber: 42,
        outcome: 'claimed',
        assignees: ['me'],
        title: 'Fix the thing',
        htmlUrl: 'https://github.com/jortega0033/pipenzo/issues/42',
      }),
      previewWorktree: vi.fn().mockResolvedValue({
        workspaceId: 'c'.repeat(64),
        name: 'issue-42',
        displayTarget: 'issue-42',
        includeFiles: [],
        ignoredFiles: [],
        secretRisk: false,
        requiresConfirmation: false,
      }),
      implementPipenzo: vi.fn().mockResolvedValue(IMPLEMENTED),
    };
    setBridgeOverride(bridge as never);
    return bridge;
  }

  it('makes a Queued card a button that opens the Implement dialog for that ticket', async () => {
    const bridge = installImplementBridge([
      makeTicket({ ticketId: 'a', issueNumber: 42, lane: 'queued', title: 'Fix the thing' }),
    ]);
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Fix the thing/ }));

    // The "preparing checkout" dialog is replaced by `ImplementDialog`'s own once the checkout
    // resolves, so assert against the settled one rather than whichever rendered first.
    await screen.findByRole('button', { name: 'Refine ticket' });
    expect(screen.getByRole('dialog', { name: 'Implement #42 — Fix the thing' })).toBeInTheDocument();
    expect(bridge.resolvePipenzoCheckout).toHaveBeenCalledWith({ repo: REPO });
  });

  it('opens it from the keyboard too, since a Queued card is a real button', async () => {
    installImplementBridge([
      makeTicket({ ticketId: 'a', issueNumber: 42, lane: 'queued', title: 'Fix the thing' }),
    ]);
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    fireEvent.keyDown(await screen.findByRole('button', { name: /Fix the thing/ }), { key: 'Enter' });

    await screen.findByRole('button', { name: 'Refine ticket' });
    expect(screen.getByRole('dialog', { name: 'Implement #42 — Fix the thing' })).toBeInTheDocument();
  });

  it('leaves cards in every other lane inert -- their next action is not Implement', async () => {
    const bridge = installImplementBridge([
      makeTicket({ ticketId: 'b', issueNumber: 43, lane: 'working', title: 'Already running' }),
      makeTicket({ ticketId: 'c', issueNumber: 44, lane: 'needs-human', title: 'Parked' }),
      makeTicket({ ticketId: 'd', issueNumber: 45, lane: 'ready-for-review', title: 'Done' }),
    ]);
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    fireEvent.click(await screen.findByText('Already running'));
    fireEvent.click(screen.getByText('Parked'));
    fireEvent.click(screen.getByText('Done'));

    expect(screen.queryByRole('button', { name: /Already running|Parked|Done/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bridge.resolvePipenzoCheckout).not.toHaveBeenCalled();
  });

  it('closes the dialog on Cancel without starting anything', async () => {
    const bridge = installImplementBridge([
      makeTicket({ ticketId: 'a', issueNumber: 42, lane: 'queued', title: 'Fix the thing' }),
    ]);
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Fix the thing/ }));
    await screen.findByRole('button', { name: 'Refine ticket' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bridge.implementPipenzo).not.toHaveBeenCalled();
  });

  it('dispatches the real implement from the card, then closes the dialog, re-reads the board and reports it', async () => {
    const bridge = installImplementBridge([
      makeTicket({ ticketId: 'a', issueNumber: 42, lane: 'queued', title: 'Fix the thing' }),
    ]);
    const onImplementStarted = vi.fn();
    render(
      <PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} onImplementStarted={onImplementStarted} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Fix the thing/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Refine ticket' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));

    await waitFor(() => expect(onImplementStarted).toHaveBeenCalledTimes(1));
    expect(onImplementStarted).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 42, repo: REPO }),
      IMPLEMENTED,
    );
    expect(bridge.implementPipenzo).toHaveBeenCalledWith({
      spec: SPEC,
      repositoryPath: CHECKOUT,
      provider: 'claude',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(bridge.pipenzoListTickets).toHaveBeenCalledTimes(2));
  });

  /**
   * Issue #276: a failed `pipenzoListTickets` read used to render the same empty-lane board a
   * genuinely clean backlog would -- indistinguishable, and silent about the failure.
   */
  it('shows a distinct error banner rather than a silent empty board when the ticket list fails to load, and Retry re-reads it', async () => {
    const pipenzoListTickets = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({
        tickets: [makeTicket({ ticketId: 'a', issueNumber: 42, lane: 'queued', title: 'Recovered' })],
      });
    setBridgeOverride({
      pipenzoListTickets,
      onPipenzoPhaseEvent: () => () => {},
      getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
    onDaemonStatus: () => () => {},
      pipenzoConnectedRepos: vi.fn().mockResolvedValue({ repositories: ['octocat/hello-world'] }),
      pipenzoListRepos: vi.fn().mockResolvedValue({ repositories: [], truncated: false }),
      pipenzoConnectRepos: vi.fn(),
      pipenzoLessons: vi.fn().mockResolvedValue({ lessons: [] }),
      pipenzoDeleteLesson: vi.fn(),
      pipenzoGitHubConnection: vi
        .fn()
        .mockResolvedValue({ state: 'connected', login: 'octocat', source: 'vault' }),
      listProvidersV2: vi.fn().mockResolvedValue([]),
      disconnectGitHub: vi.fn(),
    } as never);
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    expect(
      await screen.findByText(/Couldn.t read the ticket list from the local daemon/),
    ).toBeInTheDocument();
    // The board itself still renders underneath -- empty, not replaced -- same as `'loading'`.
    expect(screen.getByText('Queued')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(pipenzoListTickets).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Recovered')).toBeInTheDocument();
    expect(
      screen.queryByText(/Couldn.t read the ticket list from the local daemon/),
    ).not.toBeInTheDocument();
  });
});
