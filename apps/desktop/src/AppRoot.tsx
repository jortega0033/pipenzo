import { useCallback, useState } from 'react';
import { App } from './App.js';
import { createDemoBridge } from './demo-bridge.js';
import { clearBridgeOverride, getBridge, setBridgeOverride } from './bridge.js';
import { SyncStatusPill } from './components/primitives/SyncStatusPill.js';
import { ToastStack, useToastStack } from './components/primitives/Toast.js';
import { ThemeProvider } from './theme.js';
import { ConnectionHealthBanner } from './pipenzo/ConnectionHealthBanner.js';
import { ConnectScreen } from './pipenzo/ConnectScreen.js';
import { EnvironmentCredentialBanner } from './pipenzo/EnvironmentCredentialBanner.js';
import { PipenzoAppShell } from './pipenzo/PipenzoAppShell.js';
import { SimpleModeShell } from './pipenzo/SimpleModeShell.js';
import { deriveSyncStatus } from './pipenzo/sync-status.js';
import { routePipenzoStartup } from './pipenzo/startup-route.js';
import { useConnectedRepos } from './pipenzo/use-connected-repos.js';
import { useGitHubConnection } from './pipenzo/use-github-connection.js';
import { usePipenzoGitHubHealth } from './pipenzo/use-pipenzo-github-health.js';
import { UiModeProvider, useUiMode } from './ui-mode.js';

/** Owns the demo-mode lifecycle so it stays isolated from `App`'s own logic: swaps the active
 * bridge (via bridge.ts's override -- `window.agentDock` itself is frozen by Electron's
 * `contextBridge.exposeInMainWorld` and cannot be reassigned) between the real preload-assigned
 * bridge and the demo bridge, and fully remounts `<App>` (via `key`) on every transition so no
 * demo session state can bleed into a real session or vice versa.
 *
 * It is also where the pre-app gate lives (issue #113). That is deliberate: the gate has to sit
 * *above* the thing it gates, and it has to sit above the bridge swap too, so that entering demo
 * mode re-runs the routing decision against the demo bridge instead of inheriting the real
 * install's answer. The `key` remount already gives that for free.
 */
export function AppRoot() {
  const [demoMode, setDemoMode] = useState(false);
  const [instanceKey, setInstanceKey] = useState(0);

  const enterDemoMode = useCallback(() => {
    setBridgeOverride(createDemoBridge());
    setDemoMode(true);
    setInstanceKey((key) => key + 1);
  }, []);

  const exitDemoMode = useCallback(() => {
    clearBridgeOverride();
    setDemoMode(false);
    setInstanceKey((key) => key + 1);
  }, []);

  // Outside the `key`-remounted subtree so a demo-mode toggle can't reset or flicker the applied
  // theme -- ThemeProvider reads its persisted preference once, at this outer mount, not once per
  // bridge swap. UiModeProvider (issue #133) sits alongside it for the identical reason.
  return (
    <ThemeProvider>
      <UiModeProvider>
        <PipenzoStartup key={instanceKey} {...{ demoMode, enterDemoMode, exitDemoMode }} />
      </UiModeProvider>
    </ThemeProvider>
  );
}

/**
 * Remounted whole on every bridge swap, which is what lets `useGitHubConnection` simply read from
 * `getBridge()` without needing to notice that the bridge underneath it changed.
 */
function PipenzoStartup({
  demoMode,
  enterDemoMode,
  exitDemoMode,
}: {
  demoMode: boolean;
  enterDemoMode: () => void;
  exitDemoMode: () => void;
}) {
  // `daemonState` lets the router tell "no credential" apart from "credential exists, daemon
  // hasn't confirmed it yet" (issue #286) -- see `startup-route.ts` for why `connection.source`
  // alone can't, and `use-github-connection.ts` for why it comes from the same hook as `connection`
  // rather than a separately-subscribed one.
  const { connection, daemonState } = useGitHubConnection();
  const { connectedRepos, refresh: refreshConnectedRepos } = useConnectedRepos();
  // Subscribed unconditionally (rules of hooks), rendered only past the pre-app gate below: there
  // is nothing connected to poll, and so nothing this could report differently, before that point.
  const health = usePipenzoGitHubHealth();
  // Same rule: called here rather than after the early returns below so a screen transition never
  // changes this render's hook count.
  const toast = useToastStack();
  // Issue #133: which top-level shell to mount past the gate -- see "Simple mode (issue #133)"
  // below, next to where `mode` is actually read.
  const { mode, setMode } = useUiMode();
  // The ticket "See the technical details" (SimpleModeShell.tsx) asked to open in Expert mode, and
  // a token that forces PipenzoAppShell to remount even if the same ticket is opened twice in a
  // row -- the same "identity changes, so state resets" rule this shell's own `key={implementing.
  // ticketId}`/`key={reviewing.ticket.ticketId}` already apply one level down.
  const [expertEntryTicketId, setExpertEntryTicketId] = useState<string>();
  const [expertEntryToken, setExpertEntryToken] = useState(0);
  // #113 shipped this router with `connectedRepos` defaulting to `'not-tracked'`, because nothing
  // recorded a list. #115 is what makes it real -- and the hook keeps answering `'not-tracked'`
  // whenever the count is genuinely unknown, so a daemon that has not finished starting never gets
  // read as "no repositories chosen".
  const route = routePipenzoStartup({ connection, connectedRepos, daemonState });

  // Nothing at all until the credential state is known. A spinner here would be worse than blank:
  // this resolves in one IPC round trip, and a spinner that appears and vanishes inside a frame is
  // a flicker, not a progress report. `role="status"` with an accessible name keeps the moment
  // announced for a screen reader, which is the one audience for whom it is not instantaneous.
  if (route.screen === 'loading') {
    return <div className="preapp" role="status" aria-label="Checking your GitHub connection" />;
  }

  // The daemon never came up at all, for an install that already has a stored credential (issue
  // #286). `role="alert"` rather than `role="status"`: unlike `loading` above, this is not going to
  // resolve on its own, so it is worth a screen reader interrupting for.
  if (route.screen === 'daemon-unavailable') {
    return (
      <div className="preapp" role="alert">
        The local AgentDock daemon could not start, so your connected GitHub account can&rsquo;t be
        reached right now. Restart AgentDock to try again.
      </div>
    );
  }

  // `onEnterDemo` is passed only when not already in demo mode, for the same reason `App` hides
  // its own "Try a demo": a demo bridge that answered `disconnected` would otherwise offer to
  // enter a demo it is already inside.
  if (route.screen === 'pre-app') {
    return (
      <ConnectScreen
        route={route}
        {...(demoMode ? {} : { onEnterDemo: enterDemoMode })}
        // Handed the saved count directly rather than left to the next `ready`: the picker's save
        // is the moment first-run finishes, and waiting for a poll to notice would leave the user
        // looking at a screen they have already completed.
        onReposConnected={(repositories) => refreshConnectedRepos(repositories.length)}
      />
    );
  }

  const sync = deriveSyncStatus(health);
  // A manual refresh that fails silently is worse than one that fails loudly (Foundations.dc.html's
  // own toast example is exactly this shape): the pill itself has no room for an error state, so a
  // failed poll surfaces here instead of vanishing into a swallowed rejection.
  const onRefreshSync = function refreshSyncNow() {
    void getBridge()
      .pollGitHubHealthNow()
      .catch(() => {
        toast.push({
          tone: 'danger',
          icon: 'warning',
          title: "Couldn't refresh — GitHub is unreachable.",
          action: { label: 'Retry', onClick: refreshSyncNow },
        });
      });
  };

  return (
    <>
      {route.environmentCredential && <EnvironmentCredentialBanner />}
      {/*
       * The board header's sync pill (#75) lives in `PipenzoAppShell`'s own `MainHead`/
       * `MainHeadRight` now (issue #274) -- exactly the reflow this comment used to say was
       * shell-wiring's job once that ticket existed. Demo mode still renders `<App>`, which has no
       * `MainHead` to reflow into, so the pill keeps its own standalone row there, unchanged from
       * before #274.
       */}
      {demoMode && (
        <div className="sync-status-row" style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 16px 0' }}>
          <SyncStatusPill status={sync.status} label={sync.label} onRefresh={onRefreshSync} />
        </div>
      )}
      <ConnectionHealthBanner
        health={health}
        loginName={connection?.state === 'connected' ? connection.login : undefined}
        connectedRepoCount={typeof connectedRepos === 'number' ? connectedRepos : undefined}
        onRetryNow={() => void getBridge().pollGitHubHealthNow().catch(() => {})}
        // Forgets the now-useless stored credential rather than opening a second sign-in surface;
        // `useGitHubConnection` re-reads on the daemon's next `ready` and `routePipenzoStartup`
        // sends a disconnected install straight back to `ConnectScreen` -- see
        // `ConnectionHealthBanner.tsx`'s `CredentialRejectedBanner` doc comment for why reusing
        // that flow beats a parallel one, and for why this stays a real promise rather than
        // fire-and-forget: the banner's own confirm dialog awaits it to drive its pending/error
        // state, the same way `AccountPanel.tsx`'s identical "Disconnect GitHub" does.
        onReauthenticate={() => getBridge().disconnectGitHub().then(() => {})}
      />
      {/*
       * `<App>` -- the AgentDock demo shell this product inherited -- is now reachable only through
       * `demoMode` (issue #274). A real, connected session gets `PipenzoAppShell` instead: `<App>`'s
       * own "Try a demo" affordance goes with it, since `demo-bridge.ts`'s Pipenzo methods answer
       * enough to run `<App>` in demo mode but not enough to run the real board -- entering demo
       * from a real session would land on a board that cannot list tickets. `ConnectScreen`'s own
       * "Try a demo" (reachable from the pre-app, token-less) is unaffected and remains the way in.
       */}
      {demoMode ? (
        <App demoMode={demoMode} onEnterDemo={enterDemoMode} onExitDemo={exitDemoMode} />
      ) : mode === 'simple' ? (
        // Issue #133: no ticket is ever routed into `activeTicket` today -- #151 (tray badge) and
        // #129 (notifications), the two real entry points, are both still open, unscoped tickets.
        // Rather than guess that wiring, this renders `SimpleModeShell`'s own honest empty state
        // until one of them exists to call `onOpenTechnicalDetails`'s counterpart with a real
        // ticket. `onOpenTechnicalDetails` itself is real: it is what a future call *would* reach.
        <SimpleModeShell
          activeTicket={undefined}
          onOpenTechnicalDetails={(ticketId) => {
            setExpertEntryTicketId(ticketId);
            setExpertEntryToken((token) => token + 1);
            setMode('expert');
          }}
        />
      ) : (
        <PipenzoAppShell
          key={expertEntryToken}
          initialTicketId={expertEntryTicketId}
          sync={sync}
          onRefreshSync={onRefreshSync}
          // Issue #342: the dialog closes itself once Implement has dispatched, so this toast is
          // what tells the person it actually started -- and which branch it is working on.
          onImplementStarted={(ticket, started) =>
            toast.push({
              tone: 'ok',
              icon: 'implement',
              title: `Implement started on #${ticket.issueNumber}`,
              description: `${ticket.repo} · ${started.branch}`,
            })
          }
          // Issue #77: the dialog stays open on its own error (Foundations.dc.html's inline
          // notice/field-error pair), but a person who closes it anyway should not lose the fact
          // that nothing started -- danger tone, one action, no auto-dismiss, matching the
          // "Couldn't start #88 -- GitHub is unreachable" example exactly.
          onImplementFailed={(ticket, message, retry) =>
            toast.push({
              tone: 'danger',
              icon: 'warning',
              title: `Couldn't start #${ticket.issueNumber}`,
              description: message,
              action: { label: 'Retry', onClick: retry },
            })
          }
          // Issue #341 PR 2: `DiffReviewScreen` itself has no header of its own to show a success
          // state in -- pushing or opening a PR returns straight to the board (see
          // `PipenzoAppShell.tsx`'s own "Reaching DiffReviewScreen" doc section), so this toast is
          // what confirms the real result actually happened, the same "the screen that did it isn't
          // there to say so any more" reasoning `onImplementStarted` above already uses.
          onPushed={(ticket, result) =>
            toast.push({
              tone: 'ok',
              icon: 'git-branch',
              title: `Pushed #${ticket.issueNumber}`,
              description: `${ticket.repo} · ${result.branch}`,
            })
          }
          onPullRequestOpened={(ticket, result) =>
            toast.push({
              tone: 'ok',
              icon: 'git-pull-request',
              title: `Opened a pull request for #${ticket.issueNumber}`,
              description: result.pullRequest ? `#${result.pullRequest.number} · ${ticket.repo}` : ticket.repo,
              // Real per-PR data or nothing -- never a guessed URL when the route did not return one.
              ...(result.pullRequest
                ? {
                    action: {
                      label: 'View PR',
                      onClick: () => window.open(result.pullRequest!.htmlUrl, '_blank', 'noreferrer'),
                    },
                  }
                : {}),
            })
          }
          // Issue #82: the card has already snapped back by the time this fires (see
          // `use-board-drag-drop.ts`) -- this toast is what tells the person the drag didn't
          // actually move anything, the same "the screen that did it isn't there to say so" reasoning
          // `onImplementFailed` above already uses for a dialog that closed itself.
          onTicketTransitionFailed={(ticket, message) =>
            toast.push({
              tone: 'danger',
              icon: 'warning',
              title: `Couldn't move #${ticket.issueNumber}`,
              description: message,
            })
          }
        />
      )}
      <ToastStack toasts={toast.visible} onDismiss={toast.dismiss} />
    </>
  );
}
