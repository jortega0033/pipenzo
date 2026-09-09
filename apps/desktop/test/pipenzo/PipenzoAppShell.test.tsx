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
