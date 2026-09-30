import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/** Every method the shell's own hooks (`usePipenzoTickets`, `useConnectedRepoList`) and
 * `SettingsPage`'s panels reach for on mount, and nothing else -- the same shape
 * `SettingsPage.test.tsx`'s own `installBridge` uses, extended with the board's own ticket-list
 * methods. `connectedRepos` defaults to a single repo so every test written before #89 keeps seeing
 * exactly the workspace it always did.
 *
 * Issue #341 adds `pipenzoTicketRead` and `pipenzoRecordRiskActivityOpened` unconditionally, not
 * only for the tests that exercise Activity/TicketDetail: every test here renders the full shell,
 * and both routes are now real, reachable screens rather than something a caller opts into.
 * `pipenzoTicketRead` echoes back whichever `tickets` entry matches the requested id -- the same
 * reconciliation shape `PhaseStepperPanel.test.tsx`'s own `reconciliation()` helper builds -- so
 * `PhaseStepperPanel`/`ActivityStreamPanel`'s live per-ticket read agrees with the board's own list
 * instead of racing it. */
function installBridge(
  options: {
    tickets?: readonly PipenzoTicketViewV1[];
    connectedRepos?: readonly string[];
  } = {},
) {
  const { tickets = [], connectedRepos = ['octocat/hello-world'] } = options;
  const pipenzoListTickets = vi.fn().mockResolvedValue({ tickets });
  // More than one subscriber is real: `usePipenzoTickets` (this shell), and, once TicketDetail is
  // open, `useTicketPhaseStepper` for both `PhaseStepperPanel` and `ActivityStreamPanel`, each via
  // its own `onPipenzoPhaseEvent` call -- a single stored callback would drop every subscriber but
  // the last.
  const phaseListeners: Array<(event: { ticketId: string }) => void> = [];
  setBridgeOverride({
    pipenzoListTickets,
    onPipenzoPhaseEvent: (callback: (event: { ticketId: string }) => void) => {
      phaseListeners.push(callback);
      return () => {
        const index = phaseListeners.indexOf(callback);
        if (index >= 0) phaseListeners.splice(index, 1);
      };
    },
    getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
    onDaemonStatus: () => () => {},
    pipenzoConnectedRepos: vi.fn().mockResolvedValue({ repositories: connectedRepos }),
    pipenzoListRepos: vi.fn().mockResolvedValue({ repositories: [], truncated: false }),
    pipenzoConnectRepos: vi.fn().mockResolvedValue({ repositories: connectedRepos }),
    pipenzoLessons: vi.fn().mockResolvedValue({ lessons: [] }),
    pipenzoCreateLesson: vi.fn(),
    pipenzoDeleteLesson: vi.fn(),
    pipenzoGitHubConnection: vi
      .fn()
      .mockResolvedValue({ state: 'connected', login: 'octocat', source: 'vault' }),
    listProvidersV2: vi.fn().mockResolvedValue([]),
    disconnectGitHub: vi.fn(),
    pipenzoTicketRead: vi.fn(({ ticketId }: { ticketId: string }) => {
      const ticket = tickets.find((candidate) => candidate.ticketId === ticketId);
      return ticket
        ? Promise.resolve({
            ticket,
            divergence: 'none',
            previousLane: ticket.lane,
            observedLabels: [],
            changed: false,
          })
        : Promise.reject(new Error(`no such ticket: ${ticketId}`));
    }),
    pipenzoRecordRiskActivityOpened: vi.fn().mockResolvedValue({
      risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
    }),
  } as never);
  return {
    pipenzoListTickets,
    /** Fires the same live phase-change event `usePipenzoTickets` debounces into a refetch -- lets
     *  a test simulate the board's list changing under an open screen without waiting on a real
     *  poll interval (issue #341's "ticket no longer in the list" fallback). `usePipenzoTickets`'s
     *  own listener ignores the event's shape entirely and refetches regardless; the per-ticket
     *  `ticketId` here is deliberately one no open panel is subscribed to, so this triggers exactly
     *  the board-wide refetch and nothing else. */
    emitPhaseEvent: () =>
      phaseListeners.forEach((listener) => listener({ ticketId: '__test-board-refetch__' })),
  };
}

/** The sidebar's own "Board" nav item, scoped away from `.sidebar` -- since issue #341, TicketDetail's
 *  crumb trail also carries a "Board" link (`CrumbLink`), and both are real, accessibly-named
 *  buttons at once while on that screen, so an unscoped `getByRole('button', { name: 'Board' })`
 *  is ambiguous the moment TicketDetail is open. */
function sidebarBoardButton(): HTMLElement {
  return within(document.querySelector('.sidebar')!).getByRole('button', { name: 'Board' });
}

const SYNC = { status: 'synced' as const, label: 'Synced 12s ago' };

afterEach(() => {
  cleanup();
  clearBridgeOverride();
});

describe('PipenzoAppShell', () => {
  /**
   * Issue #67: a `pipenzoListTickets` read that has not settled yet used to render the same
   * empty-lane board a genuinely clean backlog would -- indistinguishable, same as the #276 error
   * case this mirrors. These assert the cold-start skeleton and load-line render instead, and that
   * the real board takes over once the read settles, with nothing left behind.
   */
  it('shows the SkeletonBoard and a load-line naming the one connected repo while the first read is in flight', async () => {
    let resolveTickets: ((value: { tickets: PipenzoTicketViewV1[] }) => void) | undefined;
    setBridgeOverride({
      pipenzoListTickets: vi.fn(
        () => new Promise((resolve) => { resolveTickets = resolve; }),
      ),
      onPipenzoPhaseEvent: () => () => {},
      getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
      onDaemonStatus: () => () => {},
      pipenzoConnectedRepos: vi.fn().mockResolvedValue({ repositories: ['octocat/hello-world'] }),
      pipenzoListRepos: vi.fn().mockResolvedValue({ repositories: [], truncated: false }),
      pipenzoConnectRepos: vi.fn(),
      pipenzoGitHubConnection: vi
        .fn()
        .mockResolvedValue({ state: 'connected', login: 'octocat', source: 'vault' }),
      listProvidersV2: vi.fn().mockResolvedValue([]),
      disconnectGitHub: vi.fn(),
    } as never);
    const { container } = render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    expect(
      await screen.findByText(/Reading open issues from/),
    ).toBeInTheDocument();
    // Scoped to the load-line itself: the workspace switcher's own trigger also names this repo
    // now that it renders from the same connected-repos read (issue #89).
    const loadLine = within(container.querySelector('.load-line')!);
    expect(loadLine.getByText('octocat/hello-world')).toBeInTheDocument();
    expect(loadLine.getByText(/first poll of this session/)).toBeInTheDocument();
    expect(container.querySelector('.sk-board')).toBeInTheDocument();
    expect(container.querySelector('.board')).not.toBeInTheDocument();
    // Real lane names and dots render immediately, same as the real board -- only counts and cards
    // are placeholders.
    expect(screen.getByText('Queued')).toBeInTheDocument();

    resolveTickets?.({ tickets: [] });

    await waitFor(() => expect(container.querySelector('.board')).toBeInTheDocument());
    expect(container.querySelector('.sk-board')).not.toBeInTheDocument();
    expect(container.querySelector('.load-line')).not.toBeInTheDocument();
  });

  it('falls back to naming "your connected repos" in the load-line when more than one repo is connected', async () => {
    let resolveTickets: ((value: { tickets: PipenzoTicketViewV1[] }) => void) | undefined;
    setBridgeOverride({
      pipenzoListTickets: vi.fn(
        () => new Promise((resolve) => { resolveTickets = resolve; }),
      ),
      onPipenzoPhaseEvent: () => () => {},
      getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
      onDaemonStatus: () => () => {},
      pipenzoConnectedRepos: vi
        .fn()
        .mockResolvedValue({ repositories: ['octocat/hello-world', 'octocat/spoon-knife'] }),
      pipenzoListRepos: vi.fn().mockResolvedValue({ repositories: [], truncated: false }),
      pipenzoConnectRepos: vi.fn(),
      pipenzoGitHubConnection: vi
        .fn()
        .mockResolvedValue({ state: 'connected', login: 'octocat', source: 'vault' }),
      listProvidersV2: vi.fn().mockResolvedValue([]),
      disconnectGitHub: vi.fn(),
    } as never);
    const { container } = render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    await waitFor(() => expect(container.querySelector('.load-line')).toBeInTheDocument());
    expect(container.querySelector('.load-line')).toHaveTextContent('your connected repos');
    expect(container.querySelector('.load-line .mono')).not.toBeInTheDocument();

    resolveTickets?.({ tickets: [] });
    await waitFor(() => expect(container.querySelector('.load-line')).not.toBeInTheDocument());
  });

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
    installBridge({
      tickets: [
        makeTicket({ ticketId: 'a', issueNumber: 42, lane: 'queued', title: 'Fix the thing' }),
        makeTicket({ ticketId: 'b', issueNumber: 43, lane: 'working' }),
      ],
    });
    const { container } = render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    expect(await screen.findByText('Fix the thing')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
    // No cached title on the second ticket -- falls back to a real, non-guessed label.
    expect(screen.getByText('Issue #43')).toBeInTheDocument();
    expect(container.querySelectorAll('.card')).toHaveLength(2);
  });

  it('gives a Working card a real phase chip, read off the ticket, not guessed', async () => {
    installBridge({
      tickets: [
        makeTicket({ ticketId: 'a', issueNumber: 42, lane: 'working', phase: 'implement' }),
        makeTicket({ ticketId: 'b', issueNumber: 43, lane: 'working', phase: 'review' }),
        makeTicket({ ticketId: 'c', issueNumber: 44, lane: 'working', phase: 'refine' }),
      ],
    });
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    expect(await screen.findByText('implementing')).toBeInTheDocument();
    expect(screen.getByText('reviewing')).toBeInTheDocument();
    expect(screen.getByText('refining')).toBeInTheDocument();
  });

  it("renders a held Working card's real overlap ticket and file, with a disabled ghost Run-anyway (issue #85)", async () => {
    installBridge({
      tickets: [
        makeTicket({
          ticketId: 'a',
          issueNumber: 97,
          lane: 'working',
          concurrency: {
            state: 'held',
            overlapTicketId: 'b',
            overlapIssueNumber: 94,
            overlapFile: 'stdio-mcp-connection.ts',
          },
        }),
      ],
    });
    const { container } = render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    expect(await screen.findByText(/Waiting — file overlap with #94\./)).toBeInTheDocument();
    expect(screen.getByText('stdio-mcp-connection.ts')).toBeInTheDocument();
    expect(container.querySelector('.card.held')).toBeInTheDocument();

    // Ghost per the design canvas, which gives this control no `onClick` at all -- `disabled`
    // both matches that (a native disabled button fires no click handler) and makes the
    // non-interactivity real for keyboard/screen-reader users, not just visual.
    const runAnyway = screen.getByRole('button', { name: 'Run anyway' });
    expect(runAnyway).toBeDisabled();
  });

  it('renders a Working card with no held state as a plain card -- no WaitNote, no Run-anyway', async () => {
    installBridge({
      tickets: [
        makeTicket({ ticketId: 'a', issueNumber: 94, lane: 'working', concurrency: { state: 'running' } }),
      ],
    });
    const { container } = render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    await screen.findByText('#94');
    expect(container.querySelector('.card.held')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run anyway' })).not.toBeInTheDocument();
  });

  it('gives a Ready-for-review card a real chip and its real branch, when one exists', async () => {
    installBridge({
      tickets: [
        makeTicket({
          ticketId: 'a',
          issueNumber: 42,
          lane: 'ready-for-review',
          worktree: { id: '00000000-0000-4000-8000-000000000002', branch: 'issue-42' },
        }),
      ],
    });
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    expect(await screen.findByText('ready for review')).toBeInTheDocument();
    expect(screen.getByText('issue-42')).toBeInTheDocument();
  });

  it('renders no chip and no branch for Queued or Needs-human -- neither is a guess this shell makes', async () => {
    installBridge({
      tickets: [
        makeTicket({ ticketId: 'a', issueNumber: 42, lane: 'queued' }),
        makeTicket({ ticketId: 'b', issueNumber: 43, lane: 'needs-human' }),
      ],
    });
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

  /** The board's own methods plus everything the Implement path reaches for -- plus, since issue
   * #341, everything a non-Queued card's own Ticket Detail destination reaches for too
   * (`pipenzoTicketRead` for `PhaseStepperPanel`/`ActivityStreamPanel`'s live per-ticket read,
   * `pipenzoRecordRiskActivityOpened`, which `ActivityScreen` fires on mount). */
  function installImplementBridge(tickets: readonly PipenzoTicketViewV1[]) {
    const bridge = {
      pipenzoListTickets: vi.fn().mockResolvedValue({ tickets }),
      onPipenzoPhaseEvent: () => () => {},
      getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
      onDaemonStatus: () => () => {},
      pipenzoConnectedRepos: vi.fn().mockResolvedValue({ repositories: [REPO] }),
      pipenzoTicketRead: vi.fn(({ ticketId }: { ticketId: string }) => {
        const ticket = tickets.find((candidate) => candidate.ticketId === ticketId);
        return ticket
          ? Promise.resolve({
              ticket,
              divergence: 'none',
              previousLane: ticket.lane,
              observedLabels: [],
              changed: false,
            })
          : Promise.reject(new Error(`no such ticket: ${ticketId}`));
      }),
      pipenzoRecordRiskActivityOpened: vi.fn().mockResolvedValue({
        risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
      }),
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

  it('opens Ticket Detail, not Implement, from every other lane (issue #341)', async () => {
    const bridge = installImplementBridge([
      makeTicket({ ticketId: 'b', issueNumber: 43, lane: 'working', title: 'Already running' }),
      makeTicket({ ticketId: 'c', issueNumber: 44, lane: 'needs-human', title: 'Parked' }),
      makeTicket({ ticketId: 'd', issueNumber: 45, lane: 'ready-for-review', title: 'Done' }),
    ]);
    render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

    fireEvent.click(await screen.findByText('Already running'));

    // Ticket Detail, not the Implement dialog -- its own crumb names the real issue number.
    expect(document.querySelector('.crumbs .cur')?.textContent).toBe('#43');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bridge.resolvePipenzoCheckout).not.toHaveBeenCalled();

    fireEvent.click(sidebarBoardButton());
    await screen.findByText('Parked');
    fireEvent.click(screen.getByText('Parked'));
    expect(document.querySelector('.crumbs .cur')?.textContent).toBe('#44');

    fireEvent.click(sidebarBoardButton());
    await screen.findByText('Done');
    fireEvent.click(screen.getByText('Done'));
    expect(document.querySelector('.crumbs .cur')?.textContent).toBe('#45');

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
      pipenzoCreateLesson: vi.fn(),
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

  /**
   * Issue #89: the workspace switcher, wired to the two reads this shell already makes -- the
   * connected-repos list and the board's own ticket list -- rather than a mocked or hardcoded count.
   */
  describe('the workspace switcher', () => {
    const AD = 'jortega0033/agentdock';
    const PZ = 'jortega0033/pipenzo';

    it('renders the first connected repo active, with real per-repo open/running/needs-you counts', async () => {
      installBridge({
        connectedRepos: [AD, PZ],
        tickets: [
          makeTicket({ ticketId: 'a', repo: AD, lane: 'working' }),
          makeTicket({ ticketId: 'b', repo: AD, lane: 'working' }),
          makeTicket({ ticketId: 'c', repo: PZ, lane: 'needs-human' }),
        ],
      });
      render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

      const trigger = await screen.findByRole('button', { name: new RegExp(AD) });
      expect(trigger).toHaveTextContent('2 open · 2 running');

      // The menu lists every connected repo, not only the active one.
      fireEvent.click(trigger);
      const menu = within(screen.getByRole('dialog'));
      expect(menu.getByText('1 open · 1 needs you')).toBeInTheDocument();
    });

    it('switches the active repo when a different one is picked from the menu', async () => {
      installBridge({
        connectedRepos: [AD, PZ],
        tickets: [makeTicket({ ticketId: 'a', repo: PZ, lane: 'queued' })],
      });
      render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

      fireEvent.click(await screen.findByRole('button', { name: new RegExp(AD) }));
      fireEvent.click(screen.getByRole('button', { name: new RegExp(PZ) }));

      expect(await screen.findByRole('button', { name: new RegExp(PZ) })).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('"Manage repos…" routes to Settings and opens the same picker as first-run', async () => {
      installBridge({ connectedRepos: [AD, PZ] });
      render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

      fireEvent.click(await screen.findByRole('button', { name: new RegExp(AD) }));
      fireEvent.click(screen.getByRole('button', { name: /Manage repos/ }));

      // Routed to Settings...
      expect(await screen.findByText('Connected repos')).toBeInTheDocument();
      // ...with the first-run picker already open, not one more click away.
      expect(await screen.findByText('Choose the repos Pipenzo manages')).toBeInTheDocument();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    /** A plain "Settings" nav click must never inherit an earlier "Manage repos…" click's open picker. */
    it('does not reopen the picker on an ordinary Settings nav click', async () => {
      installBridge({ connectedRepos: [AD, PZ] });
      render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

      fireEvent.click(await screen.findByRole('button', { name: new RegExp(AD) }));
      fireEvent.click(screen.getByRole('button', { name: /Manage repos/ }));
      await screen.findByRole('dialog');
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Board' }));
      await screen.findByText('Queued');
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

      await screen.findByText('Connected repos');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('does not render a switcher trigger while nothing is connected', async () => {
      installBridge({ connectedRepos: [] });
      render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);
      await screen.findByText('Queued');

      expect(screen.queryByRole('button', { name: /open ·/ })).not.toBeInTheDocument();
    });
  });

  /**
   * Issue #88: the command palette (`BoardCommandPalette`) is mounted for real in the header, wired
   * to this shell's own ticket-store state, connected-repos list and Settings navigation -- not a
   * standalone harness.
   */
  describe('the command palette', () => {
    const AD = 'jortega0033/agentdock';
    const PZ = 'jortega0033/pipenzo';

    it('opens on Ctrl+K, shows a real ticket, and "Open Settings" navigates there', async () => {
      installBridge({
        tickets: [makeTicket({ ticketId: 'a', issueNumber: 42, lane: 'queued', title: 'Fix the thing' })],
      });
      render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);
      await screen.findByText('Fix the thing');

      fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

      const palette = screen.getByRole('dialog', { name: 'Command palette' });
      expect(within(palette).getByText('#42')).toBeInTheDocument();

      fireEvent.click(within(palette).getByRole('button', { name: /Open Settings/ }));

      expect(await screen.findByText('Connected repos')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('lists the real connected repos, and selecting one switches the active repo and opens Board', async () => {
      installBridge({ connectedRepos: [AD, PZ] });
      render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);
      // Land on Settings first, so selecting the repo in the palette is a real change of view too.
      fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
      await screen.findByText('Connected repos');

      fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
      const palette = screen.getByRole('dialog', { name: 'Command palette' });
      fireEvent.click(within(palette).getByRole('button', { name: PZ }));

      // Same action the workspace switcher's own row performs -- the switcher trigger now names
      // the repo just picked from the palette, not whichever connected repo sorts first.
      expect(await screen.findByRole('button', { name: new RegExp(PZ) })).toBeInTheDocument();
      expect(screen.getByText('Queued')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  /**
   * Issue #341: `ActivityScreen` (#116-119) is real, tested, and previously unmounted anywhere in
   * the app -- these assert it is now a real nav destination, wired to the same `tickets` the board
   * already reads, not a standalone harness.
   */
  describe('the Activity screen (issue #341)', () => {
    it('navigates to Activity from the sidebar, rendering real tickets through ActivityRow and a working filter bar', async () => {
      installBridge({
        tickets: [
          makeTicket({ ticketId: 'a', issueNumber: 42, lane: 'queued', title: 'Fix the thing' }),
        ],
      });
      render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);
      await screen.findByText('Queued');

      const activity = screen.getByRole('button', { name: 'Activity' });
      fireEvent.click(activity);

      expect(await screen.findByText('Fix the thing')).toBeInTheDocument();
      expect(document.querySelector('.crumbs .cur')?.textContent).toBe('Activity');
      expect(activity.className).toBe('nav-item active');
      expect(screen.getByRole('button', { name: 'Board' }).className).toBe('nav-item');
      // The board itself is gone -- a different screen actually mounted, not just an overlay.
      expect(screen.queryByText('Queued')).not.toBeInTheDocument();
      // #117's filter tabs render for real, counting the one real ticket.
      expect(screen.getByRole('button', { name: /All 1\/1/ })).toBeInTheDocument();
    });

    it("opens Ticket Detail from an activity row's onOpenTicket", async () => {
      installBridge({
        tickets: [
          makeTicket({ ticketId: 'a', issueNumber: 42, lane: 'queued', title: 'Fix the thing' }),
        ],
      });
      render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
      await screen.findByText('Fix the thing');

      fireEvent.click(screen.getByText('Fix the thing'));

      expect(document.querySelector('.crumbs .cur')?.textContent).toBe('#42');
      // Neither the Board nor the Activity nav item claims this screen -- it is its own drill-down.
      expect(sidebarBoardButton().className).toBe('nav-item');
      expect(screen.getByRole('button', { name: 'Activity' }).className).toBe('nav-item');
    });
  });

  /**
   * Issue #341: `TicketDetailScreen`'s own doc comment named this shell as the composition and
   * routing it was missing -- `TicketDetailContainer` (#91/#92/#95/#96/#93's real panels) wired to
   * one real ticket, reached from a real board card.
   */
  describe('TicketDetail (issue #341)', () => {
    it('opens from a Working card with real rail blocks -- not mocked, not faked', async () => {
      installBridge({
        tickets: [
          makeTicket({
            ticketId: 'a',
            issueNumber: 94,
            lane: 'working',
            phase: 'implement',
            title: 'Wire the shell',
            risk: { score: 4, lastResetAt: '2026-01-01T00:00:00.000Z' },
          }),
        ],
      });
      render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);

      fireEvent.click(await screen.findByText('Wire the shell'));

      expect(document.querySelector('.crumbs .cur')?.textContent).toBe('#94');
      expect(document.querySelector('.h-id')?.textContent).toBe('#94');
      expect(screen.getByText('Wire the shell')).toBeInTheDocument();
      // The rail's real blocks (#95/#96), reading the ticket's own risk/attempts/budget fields.
      expect(screen.getByText('Cumulative risk')).toBeInTheDocument();
      expect(screen.getByText('Moderate')).toBeInTheDocument();
      expect(screen.getByText('Model routing')).toBeInTheDocument();
      expect(screen.getByText('No session has run against this ticket yet.')).toBeInTheDocument();
      expect(screen.getByText('Subscription headroom')).toBeInTheDocument();
      // The phase stepper (#91) resolves its own live read rather than staying on skeleton forever.
      await waitFor(() =>
        expect(screen.queryByTestId('phase-stepper-loading')).not.toBeInTheDocument(),
      );
      // The activity stream (#93) resolves too, off the same live read.
      await waitFor(() =>
        expect(screen.queryByTestId('activity-stream-loading')).not.toBeInTheDocument(),
      );
    });

    it('goes back to Board from the crumb trail\'s "Board" link', async () => {
      installBridge({
        tickets: [makeTicket({ ticketId: 'a', issueNumber: 94, lane: 'working' })],
      });
      render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);
      fireEvent.click(await screen.findByText('#94'));
      await screen.findByText('Cumulative risk');

      const crumbBoardLink = within(document.querySelector('.crumbs')!).getByRole('button', {
        name: 'Board',
      });
      fireEvent.click(crumbBoardLink);

      expect(await screen.findByText('Queued')).toBeInTheDocument();
      expect(document.querySelector('.crumbs .cur')?.textContent).toBe('Board');
    });

    it("switches which ticket is open via the ticket switcher's onSwitch, without leaving the screen", async () => {
      installBridge({
        tickets: [
          makeTicket({ ticketId: 'a', issueNumber: 50, lane: 'needs-human', title: 'First' }),
          makeTicket({ ticketId: 'b', issueNumber: 51, lane: 'needs-human', title: 'Second' }),
        ],
      });
      render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);
      fireEvent.click(await screen.findByText('First'));
      await screen.findByText('Cumulative risk');
      expect(document.querySelector('.crumbs .cur')?.textContent).toBe('#50');

      fireEvent.click(screen.getByRole('button', { name: '#51' }));

      expect(document.querySelector('.crumbs .cur')?.textContent).toBe('#51');
    });

    it('shows a real fallback, not a crash or fabricated data, for a ticket id no longer in the list', async () => {
      const tickets = [
        makeTicket({ ticketId: 'a', issueNumber: 60, lane: 'needs-human', title: 'Here now' }),
      ];
      const bridge = installBridge({ tickets });
      render(<PipenzoAppShell sync={SYNC} onRefreshSync={vi.fn()} />);
      fireEvent.click(await screen.findByText('Here now'));
      await screen.findByText('Cumulative risk');

      // The ticket the screen is open on merges and leaves the next poll -- the same live
      // phase-event-triggered refetch `use-pipenzo-tickets.ts` debounces in response to a real lane
      // move, not a manual re-render.
      bridge.pipenzoListTickets.mockResolvedValue({ tickets: [] });
      bridge.emitPhaseEvent();

      expect(
        await screen.findByText(/isn't in the board's current list anymore/),
      ).toBeInTheDocument();
      expect(screen.queryByText('Cumulative risk')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Back to Board' }));
      expect(await screen.findByText('Queued')).toBeInTheDocument();
      expect(document.querySelector('.crumbs .cur')?.textContent).toBe('Board');
    });
  });
});
