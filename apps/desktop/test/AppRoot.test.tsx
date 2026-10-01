import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoGitHubConnectionV1 } from '@agent-dock/shared';
import { AppRoot } from '../src/AppRoot.js';
import { getBridge } from '../src/bridge.js';
import { UI_MODE_STORAGE_KEY } from '../src/ui-mode.js';
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
    resolvePipenzoCheckout: vi.fn(),
    pipenzoLessons: vi.fn().mockResolvedValue({ lessons: [] }),
    pipenzoCreateLesson: vi.fn(),
    pipenzoDeleteLesson: vi.fn(),
    pipenzoConcurrencySettings: vi
      .fn()
      .mockResolvedValue({ schemaVersion: 1, executionLimit: 2, runBudget: 'unlimited' }),
    pipenzoUpdateConcurrencySettings: vi.fn(),
    pipenzoCaptureSettings: vi
      .fn()
      .mockResolvedValue({ schemaVersion: 1, screenshotEnabled: true, escapeHatchEnabled: false }),
    pipenzoUpdateCaptureSettings: vi.fn(),
    pipenzoNotificationSettings: vi
      .fn()
      .mockResolvedValue({ schemaVersion: 1, refusal: true, medium: true, badge: true, sound: false }),
    pipenzoUpdateNotificationSettings: vi.fn(),
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
    implementDiffPipenzo: vi.fn(),
    reviewPipenzo: vi.fn(),
    runStatusPipenzo: vi.fn().mockResolvedValue({ live: false }),
    steerPipenzo: vi.fn(),
    stopPipenzo: vi.fn(),
    claimPipenzoIssue: vi.fn(),
    createPipenzoIssue: vi.fn(),
    commentOnPipenzoIssue: vi.fn(),
    pipenzoCaptureCapabilities: vi.fn(),
    draftPipenzoIssue: vi.fn(),
    pipenzoTicketRead: vi.fn(),
    pipenzoTicketTransition: vi.fn(),
    pipenzoListTickets: vi.fn().mockResolvedValue({ tickets: [] }),
    pipenzoRecordRiskApprovalOutcome: vi.fn(),
    pipenzoRecordRiskActivityOpened: vi.fn(),
    captureMediumApproval: vi.fn(),
    decideMediumApproval: vi.fn(),
    mediumApprovalStatus: vi.fn(),
    undoMediumApproval: vi.fn(),
    captureHighApproval: vi.fn(),
    decideHighApproval: vi.fn(),
    captureStackApproval: vi.fn(),
    decideStackApproval: vi.fn(),
    capturePlanReview: vi.fn(),
    decidePlanReview: vi.fn(),
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
  /**
   * Since issue #274, "Try a demo" lives only in `ConnectScreen`'s pre-app (`<App>` -- the only
   * place it used to also live -- is now reachable exclusively through `demoMode` itself). A
   * token-less install is what reaches the button, so that is the bridge this exercises the
   * bridge-swap lifecycle against, even though the assertions here are about bridge identity, not
   * about which screen is showing.
   */
  it('swaps in the demo bridge and shows the banner on entry, then restores the exact real bridge instance and hides the banner on exit', async () => {
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = realBridge({
      state: 'disconnected',
      source: 'none',
    });
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

    // Since issue #274, past the gate means `PipenzoAppShell`'s own Board nav item, not `<App>`'s
    // "Try a demo" -- `<App>` no longer renders for a real, connected session.
    expect(await screen.findByRole('button', { name: 'Board' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1 · Device code' })).not.toBeInTheDocument();
    expect(screen.queryByText(/own local file, not a stored account/)).not.toBeInTheDocument();
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
      expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument(),
    );
  });

  /**
   * The case `pipenzo-credential-v1.ts` carries `source` on the wire for: an empty vault and a
   * daemon running on the development fallback (a file, issue #212 -- an inherited shell variable
   * before that). Routing this install to "Connect GitHub" would be both false (it can reach
   * GitHub right now) and unfixable from that screen (connecting writes to a vault this daemon is
   * not reading), so it goes to the app -- and says so.
   */
  it('lets a development build on the development fallback through, and names it', async () => {
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = realBridge({
      state: 'disconnected',
      source: 'environment',
    });
    render(<AppRoot />);

    expect(await screen.findByRole('button', { name: 'Board' })).toBeInTheDocument();
    expect(screen.getByText(/own local file, not a stored account/)).toBeInTheDocument();
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
      expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument(),
    );
  });

  /**
   * Issue #342, end to end through the real root: a Queued card opens the Implement dialog, the
   * dispatch reaches `implementPipenzo` with the daemon-resolved checkout, and -- because the dialog
   * closes itself on success -- the toast is what tells the person it actually started.
   */
  it('starts Implement from a Queued card and confirms it with a toast naming the branch', async () => {
    const bridge = realBridge();
    const checkout = '/state/repos/octocat/hello-world';
    const spec = {
      schemaVersion: 1 as const,
      issue: { repo: 'octocat/hello-world', number: 42, title: 'Fix the thing' },
      summary: 'Fix the thing.',
      acceptanceCriteria: [{ id: 'AC-1', kind: 'event' as const, text: 'When X, the system shall Y' }],
      outOfScope: [],
      filesLikelyTouched: [],
      estimate: { changedLines: 12, filesTouched: 1, layered: false },
      openQuestions: [],
    };
    bridge.pipenzoListTickets = vi.fn().mockResolvedValue({
      tickets: [
        {
          schemaVersion: 1,
          ticketId: '00000000-0000-4000-8000-000000000042',
          repo: 'octocat/hello-world',
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
        },
      ],
    });
    bridge.resolvePipenzoCheckout = vi
      .fn()
      .mockResolvedValue({ repo: 'octocat/hello-world', repositoryPath: checkout });
    bridge.inspectWorkspace = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      workspaceId: 'c'.repeat(64),
      incarnation: 'd'.repeat(64),
      displayName: 'hello-world',
      reusable: true,
      state: 'trusted',
    });
    bridge.refinePipenzo = vi
      .fn()
      .mockResolvedValue({ sessionId: 'r', spec, toolsUsed: [], gateVerdict: 'single' });
    bridge.claimPipenzoIssue = vi.fn().mockResolvedValue({
      repo: 'octocat/hello-world',
      issueNumber: 42,
      outcome: 'claimed',
      assignees: ['octocat'],
      title: 'Fix the thing',
      htmlUrl: 'https://github.com/octocat/hello-world/issues/42',
    });
    bridge.previewWorktree = vi.fn().mockResolvedValue({
      workspaceId: 'c'.repeat(64),
      name: 'issue-42',
      displayTarget: 'issue-42',
      includeFiles: [],
      ignoredFiles: [],
      secretRisk: false,
      requiresConfirmation: false,
    });
    bridge.implementPipenzo = vi.fn().mockResolvedValue({
      worktreeId: '123e4567-e89b-42d3-a456-426614174000',
      branch: 'issue-42',
      baseCommit: 'b'.repeat(40),
      sessionId: 'implement-1',
    });
    // Issue #341 PR 2: Start now lands on `DiffReviewScreen`, not back on the board -- its own
    // `useImplementPoll` calls this immediately on mount. `sessionState` omitted (== `'running'`,
    // per that hook) keeps it on the honest "Watching the implement session…" state, since this
    // test's own concern is the toast, not what a finished review renders (`DiffReviewScreen.
    // test.tsx` and `PipenzoAppShell.test.tsx`'s own "DiffReviewScreen" describe block own that).
    bridge.implementResultPipenzo = vi.fn().mockResolvedValue({
      worktreeId: '123e4567-e89b-42d3-a456-426614174000',
      branch: 'issue-42',
      baseCommit: 'b'.repeat(40),
      headCommit: 'b'.repeat(40),
      commits: [],
    });
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
    render(<AppRoot />);

    fireEvent.click(await screen.findByRole('button', { name: /Fix the thing/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Refine ticket' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));

    expect(await screen.findByText('Implement started on #42')).toBeInTheDocument();
    expect(screen.getByText('octocat/hello-world · issue-42')).toBeInTheDocument();
    // Issue #15: `ticketId` now rides along too -- see `BoardImplementDialog.tsx`'s own doc comment.
    expect(bridge.implementPipenzo).toHaveBeenCalledWith({
      spec,
      repositoryPath: checkout,
      provider: 'claude',
      ticketId: '00000000-0000-4000-8000-000000000042',
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The dialog closing is not "back to the board" any more -- it is the real DiffReviewScreen
    // this dispatch was always meant to lead to.
    expect(
      screen.getByRole('status', { name: /waiting for the implement session on #42/i }),
    ).toBeInTheDocument();
  });

  /**
   * Issue #341 PR 2, end to end through the real root: the dispatch above lands on
   * `DiffReviewScreen`, which has no header of its own to confirm a push in -- this is what proves
   * `onPushed` actually reaches `AppRoot`'s own toast, not just `PipenzoAppShell`'s internal state
   * (a code-review follow-up: the callback existed and was documented before this test did).
   */
  it('pushes from DiffReviewScreen and confirms it with a toast naming the branch', async () => {
    const bridge = realBridge();
    const checkout = '/state/repos/octocat/hello-world';
    const spec = {
      schemaVersion: 1 as const,
      issue: { repo: 'octocat/hello-world', number: 42, title: 'Fix the thing' },
      summary: 'Fix the thing.',
      acceptanceCriteria: [{ id: 'AC-1', kind: 'event' as const, text: 'When X, the system shall Y' }],
      outOfScope: [],
      filesLikelyTouched: [],
      estimate: { changedLines: 12, filesTouched: 1, layered: false },
      openQuestions: [],
    };
    bridge.pipenzoListTickets = vi.fn().mockResolvedValue({
      tickets: [
        {
          schemaVersion: 1,
          ticketId: '00000000-0000-4000-8000-000000000042',
          repo: 'octocat/hello-world',
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
        },
      ],
    });
    bridge.resolvePipenzoCheckout = vi
      .fn()
      .mockResolvedValue({ repo: 'octocat/hello-world', repositoryPath: checkout });
    bridge.inspectWorkspace = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      workspaceId: 'c'.repeat(64),
      incarnation: 'd'.repeat(64),
      displayName: 'hello-world',
      reusable: true,
      state: 'trusted',
    });
    bridge.refinePipenzo = vi
      .fn()
      .mockResolvedValue({ sessionId: 'r', spec, toolsUsed: [], gateVerdict: 'single' });
    bridge.claimPipenzoIssue = vi.fn().mockResolvedValue({
      repo: 'octocat/hello-world',
      issueNumber: 42,
      outcome: 'claimed',
      assignees: ['octocat'],
      title: 'Fix the thing',
      htmlUrl: 'https://github.com/octocat/hello-world/issues/42',
    });
    bridge.previewWorktree = vi.fn().mockResolvedValue({
      workspaceId: 'c'.repeat(64),
      name: 'issue-42',
      displayTarget: 'issue-42',
      includeFiles: [],
      ignoredFiles: [],
      secretRisk: false,
      requiresConfirmation: false,
    });
    const started = {
      worktreeId: '123e4567-e89b-42d3-a456-426614174000',
      branch: 'issue-42',
      baseCommit: 'b'.repeat(40),
      sessionId: 'implement-1',
    };
    bridge.implementPipenzo = vi.fn().mockResolvedValue(started);
    bridge.implementResultPipenzo = vi.fn().mockResolvedValue({
      worktreeId: started.worktreeId,
      branch: started.branch,
      baseCommit: started.baseCommit,
      headCommit: 'c'.repeat(40),
      commits: ['c'.repeat(40)],
      sessionState: 'completed',
    });
    bridge.implementDiffPipenzo = vi.fn().mockResolvedValue({
      worktreeId: started.worktreeId,
      baseCommit: started.baseCommit,
      headCommit: 'c'.repeat(40),
      diffText: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,3 @@\n context\n+added line\n context\n',
      truncated: false,
      additions: 8,
      deletions: 0,
      filesChanged: 1,
    });
    const publishResult = {
      worktreeId: started.worktreeId,
      remote: 'origin',
      branch: started.branch,
      headSha: 'c'.repeat(40),
      updatedRemote: true,
    };
    bridge.publishPipenzo = vi.fn().mockResolvedValue(publishResult);
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
    render(<AppRoot />);

    fireEvent.click(await screen.findByRole('button', { name: /Fix the thing/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Refine ticket' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await screen.findByText('added line');

    fireEvent.click(screen.getByRole('button', { name: /push branch/i }));

    // Scoped to the push toast itself -- the earlier "Implement started" toast (still visible,
    // toasts stack rather than replace) carries the identical description text.
    const pushToast = (await screen.findByText('Pushed #42')).closest('.toast');
    expect(pushToast).toHaveTextContent('octocat/hello-world · issue-42');
    expect(bridge.publishPipenzo).toHaveBeenCalledWith({
      worktreeId: started.worktreeId,
      branch: started.branch,
      remote: undefined,
      operation: 'push',
    });
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

  /**
   * Issue #286: an already-connected vault (`state: 'connected'`) whose daemon has not confirmed
   * anything yet (`source: 'none'`, honest as of #209) must wait rather than flash "Connect GitHub"
   * -- and once the daemon reports it never came up at all, it gets an honest failure message
   * instead of silently defaulting to the sign-in screen.
   */
  it('waits rather than flashing ConnectScreen for an already-connected vault, then reports an honest daemon failure', async () => {
    // Several hooks in the tree subscribe to `onDaemonStatus` independently (`useGitHubConnection`,
    // `useConnectedRepos`), so a push must reach every listener, not just the last one registered.
    const listeners: ((status: DaemonStatus) => void)[] = [];
    const deliverStatus = (status: DaemonStatus) => listeners.forEach((listener) => listener(status));
    const bridge = realBridge({ state: 'connected', login: 'octocat', source: 'none' });
    bridge.getDaemonStatus = vi.fn().mockResolvedValue({ state: 'connecting' } satisfies DaemonStatus);
    bridge.onDaemonStatus = vi.fn((callback) => {
      listeners.push(callback);
      return () => {};
    });
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
    render(<AppRoot />);

    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Checking your GitHub connection' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('heading', { name: 'Connect GitHub' })).not.toBeInTheDocument();

    deliverStatus({ state: 'unavailable', error: 'daemon failed to start: boom' });

    expect(await screen.findByRole('alert')).toHaveTextContent(/daemon could not start/i);
    expect(screen.queryByRole('heading', { name: 'Connect GitHub' })).not.toBeInTheDocument();
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

    // Since issue #274, this waits on `PipenzoAppShell`'s Board nav item -- the same "we are past
    // the gate" signal `Try a demo` used to serve before `<App>` became demo-only.
    await screen.findByRole('button', { name: 'Board' });
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
    await screen.findByRole('button', { name: 'Board' });

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
    await screen.findByRole('button', { name: 'Board' });

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
    await screen.findByRole('button', { name: 'Board' });

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
    await screen.findByRole('button', { name: 'Board' });

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

describe('AppRoot manual-refresh failure toast (issue #77)', () => {
  /**
   * `pollGitHubHealthNow`'s own promise settling is the only feedback a manual refresh ever gets --
   * the sync pill has no error state of its own. Before this, a rejection there vanished into a
   * swallowed `.catch(() => {})`; this asserts the danger toast Foundations.dc.html's "the smaller
   * failures" example describes fires instead, and that its one action retries the same call.
   */
  it('shows a non-auto-dismissing danger toast when a manual sync refresh fails, and retries on its action', async () => {
    const bridge = realBridge();
    bridge.pollGitHubHealthNow = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined);
    (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
    render(<AppRoot />);
    await screen.findByRole('button', { name: 'Board' });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

    expect(await screen.findByText("Couldn't refresh — GitHub is unreachable.")).toBeInTheDocument();
    expect(bridge.pollGitHubHealthNow).toHaveBeenCalledTimes(1);

    // Long enough that a 6s auto-dismiss (the no-action default) would have fired if this toast
    // carried one -- it must not, since it carries an action.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText("Couldn't refresh — GitHub is unreachable.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(bridge.pollGitHubHealthNow).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Couldn't refresh — GitHub is unreachable.")).not.toBeInTheDocument();
  });
});

describe('AppRoot Simple mode (issue #133)', () => {
  /**
   * `pipenzo:ui-mode` stored as `'simple'` is the one real way to reach `SimpleModeShell` through
   * this root today -- there is no tray-badge or notification click to drive it yet (#151, #129,
   * both still open), so this seeds the same persisted preference `UiModeProvider` reads on mount
   * rather than fabricating an in-app entry point the canvas never draws. `PipenzoAppShell`'s own
   * "Board" nav item is the proof the Expert switch genuinely lands back in Expert mode, not just
   * that the Simple shell disappeared.
   */
  it('renders the Simple-mode shell with no sidebar from the stored preference, and the Expert switch returns to the real board', async () => {
    window.localStorage.setItem(UI_MODE_STORAGE_KEY, 'simple');
    render(<AppRoot />);

    expect(await screen.findByText('Nothing to show in Simple mode yet')).toBeInTheDocument();
    expect(document.querySelector('.sidebar')).not.toBeInTheDocument();
    expect(document.querySelector('.simple-shell')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expert' }));

    expect(await screen.findByRole('button', { name: 'Board' })).toBeInTheDocument();
    expect(document.querySelector('.simple-shell')).not.toBeInTheDocument();
  });
});
