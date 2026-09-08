import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoGitHubConnectionV1 } from '@agent-dock/shared';
import { AppRoot } from '../src/AppRoot.js';
import { getBridge } from '../src/bridge.js';
import type { AgentDockBridge, DaemonStatus } from '../src/window.js';

const CONNECTED: PipenzoGitHubConnectionV1 = {
  state: 'connected',
  login: 'octocat',
  storedAt: '2026-01-01T00:00:00.000Z',
  source: 'vault',
};

function realBridge(
  connection: PipenzoGitHubConnectionV1 = CONNECTED,
  connectedRepos: readonly string[] = ['octocat/hello-world'],
): AgentDockBridge {
  return {
    pipenzoGitHubConnection: vi.fn().mockResolvedValue(connection),
    disconnectGitHub: vi.fn().mockResolvedValue(connection),
    pipenzoListRepos: vi.fn().mockResolvedValue({ repositories: [], truncated: false }),
    // Non-empty by default: as of #115 a credentialed install with *no* repositories chosen is
    // routed to the picker rather than the app, so "connected" alone no longer means "past the
    // gate". The cases below that care about the difference set this explicitly.
    pipenzoConnectedRepos: vi.fn().mockResolvedValue({ repositories: connectedRepos }),
    pipenzoConnectRepos: vi.fn(),
    startGitHubDeviceFlow: vi.fn(),
    openGitHubDeviceVerification: vi.fn().mockResolvedValue(undefined),
    cancelGitHubDeviceFlow: vi.fn().mockResolvedValue(undefined),
    onGitHubDeviceOutcome: vi.fn(() => () => {}),
    getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' } satisfies DaemonStatus),
    onDaemonStatus: vi.fn().mockReturnValue(() => {}),
    listProviders: vi.fn().mockResolvedValue([]),
    listProvidersV2: vi.fn().mockResolvedValue([]),
    openProviderInstallDocs: vi.fn().mockResolvedValue(undefined),
    listMcpServers: vi.fn().mockResolvedValue({ servers: [], revision: 'real-1' }),
    configureMcpServer: vi.fn().mockResolvedValue({ servers: [], revision: 'real-1' }),
    actionMcpServer: vi.fn().mockResolvedValue({ servers: [], revision: 'real-1' }),
    getMcpCatalog: vi.fn().mockResolvedValue({ serverId: 'x', items: [], revision: 'real-1' }),
    startMcpOAuth: vi.fn().mockResolvedValue({ serverId: 'x', status: 'unsupported' }),
    invokeMcpTool: vi.fn().mockResolvedValue({ serverId: 'x', toolId: 'x', status: 'failed' }),
    listProviderComponents: vi.fn().mockResolvedValue({ items: [], revision: 'real-1' }),
    manageProviderComponent: vi.fn().mockResolvedValue({ componentId: 'x', status: 'unsupported' }),
    invokeProviderComponent: vi.fn().mockResolvedValue({ componentId: 'x', status: 'unsupported' }),
    getSubagentGraph: vi.fn().mockResolvedValue({ sessionId: 'x', nodes: [] }),
    controlSubagent: vi.fn().mockResolvedValue({ sessionId: 'x', agentId: 'x', status: 'unsupported' }),
    previewWorktree: vi.fn(),
    createWorktree: vi.fn(),
    listWorktrees: vi.fn().mockResolvedValue([]),
    cleanupWorktree: vi.fn(),
    publishPipenzo: vi.fn(),
    refinePipenzo: vi.fn(),
    implementPipenzo: vi.fn(),
    implementResultPipenzo: vi.fn(),
    reviewPipenzo: vi.fn(),
    claimPipenzoIssue: vi.fn(),
    createPipenzoIssue: vi.fn(),
    commentOnPipenzoIssue: vi.fn(),
    pipenzoCaptureCapabilities: vi.fn(),
    draftPipenzoIssue: vi.fn(),
    pipenzoTicketRead: vi.fn(),
    pipenzoTicketTransition: vi.fn(),
    pipenzoListTickets: vi.fn().mockResolvedValue({ tickets: [] }),
    onPipenzoPhaseEvent: vi.fn(() => () => {}),
    onPipenzoGitHubHealth: vi.fn(() => () => {}),
    pollGitHubHealthNow: vi.fn(async () => {}),
    selectAndUploadAttachments: vi.fn().mockResolvedValue([]),
    validateStructuredOutput: vi.fn(),
    createSession: vi.fn(),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    onSessionEvent: vi.fn().mockReturnValue(() => {}),
    createInteractiveSession: vi.fn(),
    listInteractiveSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    readInteractiveSessionHistory: vi.fn().mockResolvedValue({ events: [] }),
    reconnectInteractiveSession: vi.fn(),
    resumeInteractiveSession: vi.fn(),
    forkInteractiveSession: vi.fn(),
    deleteInteractiveSession: vi.fn().mockResolvedValue(undefined),
    sendSessionCommand: vi.fn(),
    respondApproval: vi.fn().mockResolvedValue({ status: 'accepted' }),
    answerQuestions: vi.fn().mockResolvedValue({ status: 'accepted' }),
    cancelInteractiveSession: vi.fn(),
    onInteractiveSessionEvent: vi.fn().mockReturnValue(() => {}),
    onInteractiveSessionStreamNotice: vi.fn().mockReturnValue(() => {}),
    onInteractionRequested: vi.fn().mockReturnValue(() => {}),
    onInteractionResolved: vi.fn().mockReturnValue(() => {}),
    inspectWorkspace: vi.fn(),
    setWorkspaceTrust: vi.fn(),
    readAudit: vi.fn().mockResolvedValue({ schemaVersion: 1, entries: [] }),
    selectDirectory: vi.fn().mockResolvedValue('/real/path'),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  (window as unknown as { agentDock: AgentDockBridge }).agentDock = realBridge();
});

describe('AppRoot demo-mode lifecycle', () => {
  it('swaps in the demo bridge and shows the banner on entry, then restores the exact real bridge instance and hides the banner on exit', async () => {
    const original = window.agentDock;
    render(<AppRoot />);

    // window.agentDock itself must never be reassigned -- Electron's contextBridge.exposeInMainWorld
    // makes it non-writable in the real app, so demo mode swaps through bridge.ts's override instead.
    await screen.findByRole('button', { name: 'Try a demo' });
    expect(screen.queryByText(/demo mode/i)).not.toBeInTheDocument();
    expect(getBridge()).toBe(original);
    expect(
      (getBridge() as unknown as { __agentDockDemo?: boolean }).__agentDockDemo,
    ).toBeUndefined();

    fireEvent.click(await screen.findByRole('button', { name: 'Try a demo' }));

    expect(await screen.findByText(/demo mode/i)).toBeInTheDocument();
    expect(getBridge()).not.toBe(original);
    expect((getBridge() as unknown as { __agentDockDemo?: boolean }).__agentDockDemo).toBe(true);
    expect(window.agentDock).toBe(original);

    fireEvent.click(screen.getByRole('button', { name: 'Exit demo' }));

    expect(getBridge()).toBe(original);
    expect(window.agentDock).toBe(original);
    expect(screen.queryByText(/demo mode/i)).not.toBeInTheDocument();
  });

  /**
   * Demo mode must never be gated behind a real GitHub account -- nothing about a fixture needs a
   * credential, and a token-less install is the entire audience for a demo. Two things have to hold
   * for that, and both are asserted here against the real path rather than assumed:
   *
   * 1. The pre-app offers the demo at all. "Try a demo" otherwise lives only inside `App`, which
   *    the gate replaces, making a token-less install the one install that cannot reach it.
   * 2. The gate re-runs against the *demo* bridge after the swap and honours its `connected`
   *    answer. If it read through to the real install's state, entering the demo would bounce
   *    straight back to "Connect GitHub" -- which is why `demo-bridge.ts` answers this method
   *    rather than throwing like the rest of its Pipenzo block.
   */
  it('reaches demo mode from a token-less install, and stays there', async () => {
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = realBridge({
      state: 'disconnected',
      source: 'none',
    });
    render(<AppRoot />);

    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try a demo' }));

    // Past the gate on the demo bridge's own answer, not the real install's.
    expect(await screen.findByText(/demo mode/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Connect GitHub' })).not.toBeInTheDocument();

    // And back to the pre-app on exit, because the real install is still token-less.
    fireEvent.click(screen.getByRole('button', { name: 'Exit demo' }));
    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();
  });
});

describe('AppRoot pre-app gate (issue #113)', () => {
  it('routes a token-less install to the pre-app, at step 1, with step 2 unreachable', async () => {
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = realBridge({
      state: 'disconnected',
      source: 'none',
    });
    render(<AppRoot />);

    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();
    // The app behind the gate is genuinely not rendered -- not merely hidden.
    expect(screen.queryByRole('heading', { name: 'AgentDock' })).not.toBeInTheDocument();

    const step1 = screen.getByRole('button', { name: '1 · Device code' });
    const step2 = screen.getByRole('button', { name: '2 · Choose repos' });
    expect(step1).toHaveAttribute('aria-current', 'step');
    // A repo picker with no credential behind it has nothing to list.
    expect(step2).toBeDisabled();

    fireEvent.click(step2);
    expect(screen.getByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();
  });

  it('lets a connected install past the gate, with no banner', async () => {
    render(<AppRoot />);

    expect(await screen.findByRole('button', { name: 'Try a demo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1 · Device code' })).not.toBeInTheDocument();
    expect(screen.queryByText(/PIPENZO_GITHUB_TOKEN/)).not.toBeInTheDocument();
  });

  /**
   * The headline behaviour of #115, through the real gate: a credential is no longer enough on its
   * own. An install that has connected GitHub and chosen nothing belongs in the repo picker.
   */
  it('sends a credentialed install with no repositories chosen to the picker', async () => {
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = realBridge(CONNECTED, []);
    render(<AppRoot />);

    expect(
      await screen.findByRole('heading', { name: 'Choose the repos Pipenzo manages' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try a demo' })).not.toBeInTheDocument();
  });

  /**
   * And it must not flash the board on the way there. The count is unknown for one IPC round trip,
   * and rendering the app during it would put the board on screen and then replace it -- the exact
   * flash `#113`'s loading screen exists to prevent, reintroduced for the second gate condition.
   */
  it('shows neither screen while the repository count is still unknown', async () => {
    let resolveRepos: ((value: { repositories: string[] }) => void) | undefined;
    const bridge = realBridge();
    bridge.pipenzoConnectedRepos = vi.fn(
      () =>
        new Promise<{ repositories: string[] }>((resolve) => {
          resolveRepos = resolve;
        }),
    );
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
    render(<AppRoot />);

    // Long enough for the connection read to have resolved, which is the state that used to be
    // enough on its own to render the app.
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Checking your GitHub connection' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Try a demo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Choose the repos/ })).not.toBeInTheDocument();

    resolveRepos?.({ repositories: ['octocat/hello-world'] });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Try a demo' })).toBeInTheDocument(),
    );
  });

  /**
   * The case `pipenzo-credential-v1.ts` carries `source` on the wire for: an empty vault and a
   * daemon running on an inherited shell variable. Routing this install to "Connect GitHub" would
   * be both false (it can reach GitHub right now) and unfixable from that screen (connecting writes
   * to a vault this daemon is not reading), so it goes to the app -- and says so.
   */
  it('lets a development build on an inherited token through, and names it', async () => {
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = realBridge({
      state: 'disconnected',
      source: 'environment',
    });
    render(<AppRoot />);

    expect(await screen.findByRole('button', { name: 'Try a demo' })).toBeInTheDocument();
    expect(screen.getByText(/PIPENZO_GITHUB_TOKEN/)).toBeInTheDocument();
  });

  /**
   * Neither real screen may be rendered before the answer arrives. Both flashes are wrong and
   * neither is a security failure -- this gate is presentation, and the enforcement is one process
   * down, where a daemon with no credential answers `token_missing` to every GitHub call whatever
   * the renderer painted. Flashing the board at a token-less install shows a surface that cannot
   * do anything; flashing "Connect GitHub" at a correctly-connected user on every launch reads as
   * the app having lost their account.
   */
  it('renders neither screen until the connection has actually been read', async () => {
    let resolveConnection: ((value: PipenzoGitHubConnectionV1) => void) | undefined;
    const bridge = realBridge();
    bridge.pipenzoGitHubConnection = vi.fn(
      () =>
        new Promise<PipenzoGitHubConnectionV1>((resolve) => {
          resolveConnection = resolve;
        }),
    );
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
    render(<AppRoot />);

    expect(screen.queryByRole('heading', { name: 'Connect GitHub' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try a demo' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Checking your GitHub connection' })).toBeInTheDocument();

    resolveConnection?.(CONNECTED);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Try a demo' })).toBeInTheDocument(),
    );
  });

  /**
   * A machine that cannot store a credential must be told *before* it authorizes, not after: the
   * device flow would otherwise complete on github.com and then fail to save, which looks like
   * Pipenzo losing the token rather than refusing to keep it badly.
   */
  it('explains a machine that cannot hold a credential at all', async () => {
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = realBridge({
      state: 'unavailable',
      reason: 'plaintext_backend',
      source: 'none',
    });
    render(<AppRoot />);

    expect(await screen.findByText(/published constant key/i)).toBeInTheDocument();
  });
});

describe('AppRoot connection-health banner (issue #257 -> #70)', () => {
  it('renders the retrying banner from a real onPipenzoGitHubHealth push, and wires "Retry now" to pollGitHubHealthNow', async () => {
    let deliverHealth: ((health: import('@agent-dock/shared').PipenzoGitHubHealthV1) => void) | undefined;
    const bridge = realBridge();
    bridge.onPipenzoGitHubHealth = vi.fn((callback) => {
      deliverHealth = callback;
      return () => {};
    });
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
    render(<AppRoot />);

    await screen.findByRole('button', { name: 'Try a demo' });
    // No banner until the daemon actually pushes a value -- `undefined` is silence, not a guess.
    expect(screen.queryByText(/attempt \d+ of \d+/)).not.toBeInTheDocument();

    deliverHealth?.({
      state: 'retrying',
      attempt: 2,
      maxAttempts: 5,
      nextAttemptAt: Date.now() + 18_000,
      consecutiveFailures: 2,
      firstFailureAt: Date.now() - 40_000,
    });

    expect(await screen.findByText('attempt 2 of 5')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(bridge.pollGitHubHealthNow).toHaveBeenCalledTimes(1);
  });

  it('renders the blocking unreachable banner (#71) from a real push, in the same slot', async () => {
    let deliverHealth: ((health: import('@agent-dock/shared').PipenzoGitHubHealthV1) => void) | undefined;
    const bridge = realBridge();
    bridge.onPipenzoGitHubHealth = vi.fn((callback) => {
      deliverHealth = callback;
      return () => {};
    });
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
    render(<AppRoot />);
    await screen.findByRole('button', { name: 'Try a demo' });

    deliverHealth?.({
      state: 'unreachable',
      consecutiveFailures: 5,
      firstFailureAt: Date.now() - 60_000,
      maxAttempts: 5,
    });

    expect(await screen.findByText('GitHub is unreachable.')).toBeInTheDocument();
  });

  it('renders the credential-rejected banner (#72) and wires "Re-authenticate" to disconnectGitHub', async () => {
    let deliverHealth: ((health: import('@agent-dock/shared').PipenzoGitHubHealthV1) => void) | undefined;
    const bridge = realBridge();
    bridge.onPipenzoGitHubHealth = vi.fn((callback) => {
      deliverHealth = callback;
      return () => {};
    });
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
    render(<AppRoot />);
    await screen.findByRole('button', { name: 'Try a demo' });

    deliverHealth?.({ state: 'credential_rejected', rejectedAt: Date.now() - 30_000 });

    expect(await screen.findByText('Your GitHub sign-in expired.')).toBeInTheDocument();
    // "Re-authenticate" opens a confirm dialog before touching the credential -- see
    // ConnectionHealthBanner.tsx's CredentialRejectedBanner doc comment for why a disconnect
    // reachable mid-run (which this is) needs one, the same way AccountPanel.tsx's identical
    // "Disconnect GitHub" does.
    fireEvent.click(screen.getByRole('button', { name: 'Re-authenticate' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Re-authenticate' }));
    await waitFor(() => expect(bridge.disconnectGitHub).toHaveBeenCalledTimes(1));
  });

  it('renders the recovery banner (#73) with the real login and repo count once healthy follows a real failure', async () => {
    let deliverHealth: ((health: import('@agent-dock/shared').PipenzoGitHubHealthV1) => void) | undefined;
    const bridge = realBridge(CONNECTED, ['octocat/hello-world', 'octocat/other']);
    bridge.onPipenzoGitHubHealth = vi.fn((callback) => {
      deliverHealth = callback;
      return () => {};
    });
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
    render(<AppRoot />);
    await screen.findByRole('button', { name: 'Try a demo' });

    deliverHealth?.({
      state: 'unreachable',
      consecutiveFailures: 5,
      firstFailureAt: Date.now() - 60_000,
      maxAttempts: 5,
    });
    await screen.findByText('GitHub is unreachable.');

    deliverHealth?.({ state: 'healthy', lastCleanPollAt: Date.now() });

    expect(await screen.findByText(/Signed in again/)).toBeInTheDocument();
    expect(screen.getByText('octocat')).toBeInTheDocument();
    expect(screen.getByText(/2 repos reconnected/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Signed in again/)).not.toBeInTheDocument();
  });

  it('wires the sync pill and the degraded-quota banner (#75) to real health pushes', async () => {
    let deliverHealth: ((health: import('@agent-dock/shared').PipenzoGitHubHealthV1) => void) | undefined;
    const bridge = realBridge();
    bridge.onPipenzoGitHubHealth = vi.fn((callback) => {
      deliverHealth = callback;
      return () => {};
    });
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
    render(<AppRoot />);
    await screen.findByRole('button', { name: 'Try a demo' });

    // Before any push: the pill reads "not synced yet" rather than guessing.
    expect(screen.getByText('Not synced yet')).toBeInTheDocument();

    deliverHealth?.({
      state: 'healthy',
      lastCleanPollAt: Date.now(),
      quota: { remainingFraction: 0.05, resetAt: Date.now() + 60_000, degraded: true },
    });

    expect(await screen.findByText('Syncing slowly')).toBeInTheDocument();
    expect(screen.getByText(/degraded, not failed/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Poll now' }));
    await waitFor(() => expect(bridge.pollGitHubHealthNow).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => expect(bridge.pollGitHubHealthNow).toHaveBeenCalledTimes(2));
  });
});
