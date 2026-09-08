import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoRepoV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { ConnectedReposPanel } from '../../src/pipenzo/ConnectedReposPanel.js';

const repo = (fullName: string, overrides: Partial<PipenzoRepoV1> = {}): PipenzoRepoV1 => ({
  fullName,
  archived: false,
  defaultBranch: 'main',
  openIssues: 0,
  ...overrides,
});

function installBridge(
  options: {
    connected?: readonly string[];
    connectedRejects?: boolean;
    listing?: readonly PipenzoRepoV1[];
    /** What `pipenzoConnectRepos` does. Defaults to echoing the request back, sorted. */
    connect?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const pipenzoConnectRepos =
    options.connect ??
    vi.fn(async (input: { repositories: string[] }) => ({
      repositories: [...input.repositories].sort(),
    }));
  const bridge = {
    pipenzoConnectedRepos: options.connectedRejects
      ? vi.fn().mockRejectedValue(new Error('daemon is not ready yet'))
      : vi.fn().mockResolvedValue({ repositories: options.connected ?? [] }),
    pipenzoListRepos: vi
      .fn()
      .mockResolvedValue({ repositories: options.listing ?? [], truncated: false }),
    pipenzoConnectRepos,
  };
  setBridgeOverride(bridge as never);
  return bridge;
}

afterEach(() => {
  cleanup();
  clearBridgeOverride();
});

const CONNECTED = ['jortega0033/agentdock', 'octocat/hello-world'];

/** Waits past the initial read, which every populated case starts from. */
const loaded = () => screen.findByText('jortega0033/agentdock');

describe('ConnectedReposPanel', () => {
  it('lists what the workspace has connected', async () => {
    installBridge({ connected: CONNECTED });
    render(<ConnectedReposPanel />);
    await loaded();

    const rows = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('jortega0033/agentdock');
    expect(rows[1]).toHaveTextContent('octocat/hello-world');
  });

  /**
   * The panel deliberately does not fetch the repository listing to decorate its rows. One listing
   * call fans out to as many as fifty GitHub requests, and this screen has to render when GitHub
   * is unreachable -- which is exactly when somebody opens it to find out why nothing is syncing.
   */
  it('renders without asking GitHub for anything', async () => {
    const bridge = installBridge({ connected: CONNECTED });
    render(<ConnectedReposPanel />);
    await loaded();

    expect(bridge.pipenzoListRepos).not.toHaveBeenCalled();
  });

  it('says nothing is being polled when nothing is connected', async () => {
    installBridge({ connected: [] });
    render(<ConnectedReposPanel />);

    expect(await screen.findByText(/nothing is being polled/i)).toBeInTheDocument();
    // The action stays: an empty list is the one state where "Add a repo…" is the whole point.
    expect(screen.getByRole('button', { name: /add a repo/i })).toBeInTheDocument();
  });

  /**
   * The distinction the whole load path exists for. A rejected read is the ordinary state while
   * the daemon starts, and reporting it as an empty list would tell a fully-configured user they
   * had connected nothing -- next to a button offering to fix it.
   */
  it('reports a failed read as unread, never as an empty list', async () => {
    installBridge({ connectedRejects: true });
    render(<ConnectedReposPanel />);

    expect(await screen.findByText(/could not read your connected repositories/i)).toBeVisible();
    expect(screen.queryByText(/nothing is being polled/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add a repo/i })).not.toBeInTheDocument();
  });

  it('retries the read', async () => {
    const bridge = installBridge({ connectedRejects: true });
    render(<ConnectedReposPanel />);
    await screen.findByText(/could not read your connected repositories/i);

    bridge.pipenzoConnectedRepos.mockResolvedValue({ repositories: CONNECTED });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await loaded();
    expect(bridge.pipenzoConnectedRepos).toHaveBeenCalledTimes(2);
  });

  /**
   * The rule the picker's save had to be corrected to follow, asserted here on the other writer:
   * `pipenzoConnectRepos` replaces the whole list, so a remove has to send everything that stays.
   * Sending only the removed name, or only what a filter happened to leave, deletes the rest.
   */
  it('removing one repo sends every repo that stays', async () => {
    const bridge = installBridge({ connected: CONNECTED });
    render(<ConnectedReposPanel />);
    await loaded();

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove jortega0033/agentdock from this workspace' }),
    );

    await waitFor(() => expect(bridge.pipenzoConnectRepos).toHaveBeenCalledTimes(1));
    expect(bridge.pipenzoConnectRepos).toHaveBeenCalledWith({
      repositories: ['octocat/hello-world'],
    });
    await waitFor(() =>
      expect(screen.queryByText('jortega0033/agentdock')).not.toBeInTheDocument(),
    );
  });

  /** The daemon de-duplicates and sorts, so what it answers is the list, not what was sent. */
  it('renders the saved list the daemon answers with, not the request', async () => {
    const connect = vi.fn().mockResolvedValue({ repositories: ['zzz/last', 'aaa/first'] });
    installBridge({ connected: CONNECTED, connect });
    render(<ConnectedReposPanel />);
    await loaded();

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove jortega0033/agentdock from this workspace' }),
    );

    await screen.findByText('zzz/last');
    expect(screen.getByText('aaa/first')).toBeInTheDocument();
    expect(screen.queryByText('octocat/hello-world')).not.toBeInTheDocument();
  });

  it('keeps the repo when the save fails, and says so', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('the daemon refused the write.'));
    installBridge({ connected: CONNECTED, connect });
    render(<ConnectedReposPanel />);
    await loaded();

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove jortega0033/agentdock from this workspace' }),
    );

    expect(await screen.findByText(/could not save that change/i)).toBeVisible();
    expect(screen.getByText('jortega0033/agentdock')).toBeInTheDocument();
  });

  /**
   * Two removals in flight at once would each compute their payload from the same pre-removal
   * list, so whichever landed second would put the other one's repository back.
   */
  it('will not start a second removal while one is in flight', async () => {
    let release: ((value: { repositories: string[] }) => void) | undefined;
    const connect = vi.fn(
      () =>
        new Promise<{ repositories: string[] }>((resolve) => {
          release = resolve;
        }),
    );
    const bridge = installBridge({ connected: CONNECTED, connect });
    render(<ConnectedReposPanel />);
    await loaded();

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove jortega0033/agentdock from this workspace' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove octocat/hello-world from this workspace' }),
    );

    expect(bridge.pipenzoConnectRepos).toHaveBeenCalledTimes(1);
    release?.({ repositories: ['octocat/hello-world'] });
    await waitFor(() =>
      expect(screen.queryByText('jortega0033/agentdock')).not.toBeInTheDocument(),
    );
  });

  it('opens the first-run picker from "Add a repo…", relabelled for saving', async () => {
    installBridge({
      connected: ['octocat/hello-world'],
      listing: [repo('octocat/hello-world'), repo('octocat/spoon-knife')],
    });
    render(<ConnectedReposPanel />);
    await screen.findByText('octocat/hello-world');

    fireEvent.click(screen.getByRole('button', { name: /add a repo/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // The picker's own row, and its CTA carrying #125's verb rather than first-run's.
    await screen.findByRole('checkbox', { name: /octocat\/spoon-knife/ });
    expect(screen.getByRole('button', { name: 'Save 1 repo' })).toBeInTheDocument();
  });

  it('closes the picker and shows what it saved', async () => {
    const connect = vi
      .fn()
      .mockResolvedValue({ repositories: ['octocat/hello-world', 'octocat/spoon-knife'] });
    installBridge({
      connected: ['octocat/hello-world'],
      listing: [repo('octocat/hello-world'), repo('octocat/spoon-knife')],
      connect,
    });
    render(<ConnectedReposPanel />);
    await screen.findByText('octocat/hello-world');

    fireEvent.click(screen.getByRole('button', { name: /add a repo/i }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /octocat\/spoon-knife/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 repos' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('octocat/spoon-knife')).toBeInTheDocument();
  });
});
