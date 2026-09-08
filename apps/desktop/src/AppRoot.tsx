import { useCallback, useState } from 'react';
import { App } from './App.js';
import { createDemoBridge } from './demo-bridge.js';
import { clearBridgeOverride, getBridge, setBridgeOverride } from './bridge.js';
import { SyncStatusPill } from './components/primitives/SyncStatusPill.js';
import { ConnectionHealthBanner } from './pipenzo/ConnectionHealthBanner.js';
import { ConnectScreen } from './pipenzo/ConnectScreen.js';
import { EnvironmentCredentialBanner } from './pipenzo/EnvironmentCredentialBanner.js';
import { PipenzoAppShell } from './pipenzo/PipenzoAppShell.js';
import { deriveSyncStatus } from './pipenzo/sync-status.js';
import { routePipenzoStartup } from './pipenzo/startup-route.js';
import { useConnectedRepos } from './pipenzo/use-connected-repos.js';
import { useGitHubConnection } from './pipenzo/use-github-connection.js';
import { usePipenzoGitHubHealth } from './pipenzo/use-pipenzo-github-health.js';

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

  return <PipenzoStartup key={instanceKey} {...{ demoMode, enterDemoMode, exitDemoMode }} />;
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
  const connection = useGitHubConnection();
  const { connectedRepos, refresh: refreshConnectedRepos } = useConnectedRepos();
  // Subscribed unconditionally (rules of hooks), rendered only past the pre-app gate below: there
  // is nothing connected to poll, and so nothing this could report differently, before that point.
  const health = usePipenzoGitHubHealth();
  // #113 shipped this router with `connectedRepos` defaulting to `'not-tracked'`, because nothing
  // recorded a list. #115 is what makes it real -- and the hook keeps answering `'not-tracked'`
  // whenever the count is genuinely unknown, so a daemon that has not finished starting never gets
  // read as "no repositories chosen".
  const route = routePipenzoStartup({ connection, connectedRepos });

  // Nothing at all until the credential state is known. A spinner here would be worse than blank:
  // this resolves in one IPC round trip, and a spinner that appears and vanishes inside a frame is
  // a flicker, not a progress report. `role="status"` with an accessible name keeps the moment
  // announced for a screen reader, which is the one audience for whom it is not instantaneous.
  if (route.screen === 'loading') {
    return <div className="preapp" role="status" aria-label="Checking your GitHub connection" />;
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
  const onRefreshSync = () => void getBridge().pollGitHubHealthNow().catch(() => {});

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
      ) : (
        <PipenzoAppShell sync={sync} onRefreshSync={onRefreshSync} />
      )}
    </>
  );
}
