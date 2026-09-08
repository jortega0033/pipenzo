import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Tray, Menu } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  agentCommandV2Schema,
  createSessionRequestSchema,
  createSessionV2RequestSchema,
  sessionContinuationInputV2Schema,
  sessionEventHistoryV2QuerySchema,
  sessionIdParamSchema,
  sessionListV2QuerySchema,
  workspaceInspectRequestV2Schema,
  workspaceTrustUpdateRequestV2Schema,
  mcpCatalogRequestV2Schema,
  mcpConfigureRequestV2Schema,
  mcpListRequestV2Schema,
  mcpOAuthStartRequestV2Schema,
  mcpServerActionRequestV2Schema,
  mcpToolInvocationRequestV2Schema,
  providerComponentInvokeRequestV2Schema,
  providerComponentListRequestV2Schema,
  providerComponentManageRequestV2Schema,
  subagentControlRequestV2Schema,
  worktreeCleanupRequestV2Schema,
  worktreeCreateRequestV2Schema,
  worktreePreviewRequestV2Schema,
  pipenzoPublishRequestV1Schema,
  pipenzoRefineRequestV1Schema,
  pipenzoImplementRequestV1Schema,
  pipenzoImplementResultQueryV1Schema,
  pipenzoReviewRequestV1Schema,
  pipenzoIssueClaimRequestV1Schema,
  pipenzoIssueCommentRequestV1Schema,
  pipenzoIssueCreateRequestV1Schema,
  pipenzoCaptureCapabilityRequestV1Schema,
  pipenzoIdeaDraftRequestV1Schema,
  pipenzoConnectReposRequestV1Schema,
  pipenzoTicketReadRequestV1Schema,
  pipenzoTicketTransitionRequestV1Schema,
  structuredWorkflowRequestV2Schema,
  providerIdSchema,
  type AgentCommandV2,
  type AgentEventV2Envelope,
  type AgentSessionV2,
  type PipenzoDeviceCodeV1,
  type PipenzoDeviceFailureReasonV1,
  type PipenzoGitHubConnectionV1,
  type ProviderId,
  type WorkspaceTrustUpdateRequestV2,
} from '@agent-dock/shared';
import { AgentDockClient, DaemonError } from '@agent-dock/client';
import { resolveDaemonEntry } from './resolve-daemon-entry.js';
import { GitHubTokenVault, GitHubTokenVaultError } from './github-token-vault.js';
import {
  DeviceFlowError,
  GITHUB_VERIFICATION_HOST,
  GitHubDeviceFlow,
} from './github-device-flow.js';
import { DeviceFlowSession, toWireFailure } from './device-flow-session.js';
import { GITHUB_OAUTH_CLIENT_ID } from './github-oauth-app.js';
import {
  buildDaemonCredentialMessage,
  buildDaemonEnvironment,
  reconcileDaemonTokenSource,
  resolveDaemonGitHubToken,
  type DaemonGitHubTokenSource,
} from './daemon-environment.js';
import { devTokenFilePath, readDevTokenFile } from './dev-token-file.js';
import { resolveWindowIcon } from './resolve-window-icon.js';
import { sendToRenderer } from './send-to-renderer.js';
import {
  PendingInteractiveCreates,
  relayInteractiveSessionEvents,
} from './interactive-session-lifecycle.js';
import { relayPipenzoPhaseEvents } from './pipenzo-phase-stream.js';
import { relayPipenzoGitHubHealthEvents } from './pipenzo-health-stream.js';
import { InteractionBroker, type RendererInteractionResolution } from './interaction-broker.js';
import {
  externalUrlLogSummary,
  handleWillNavigate,
  handleWindowOpen,
  openAllowedExternalUrl,
  resolveOAuthLaunch,
} from './allowed-external-url.js';
import { isFromMainWindowFrame } from './ipc-sender-guard.js';

/**
 * Substituted by the bundler (see `vite.config.ts`'s electron-main `define`). `false` — refuse the
 * development credential fallback — is the safe answer, so a missing substitution fails closed
 * rather than quietly re-enabling it. See `resolveDaemonGitHubToken` for why `app.isPackaged`
 * alone is not enough.
 */
declare const __PIPENZO_DEVELOPMENT_BUILD__: boolean | undefined;
const IS_DEVELOPMENT_BUILD =
  typeof __PIPENZO_DEVELOPMENT_BUILD__ === 'boolean' ? __PIPENZO_DEVELOPMENT_BUILD__ : false;

const __dirname = dirname(fileURLToPath(import.meta.url));

// Two AgentDock windows would each spawn their own daemon sidecar and race over the same
// discovery file (the daemon's own single-instance guard, see SECURITY.md, would make the
// second one fail to start). Rather than let that surface as a confusing "daemon unavailable"
// error, refuse to open a second window at all and focus the existing one instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

/**
 * Renderer status only, never the token or base URL. The renderer talks to the daemon
 * exclusively through the IPC handlers below, which delegate to `@agent-dock/client`; the
 * `AgentDockClient` instance (which carries the bearer token) never crosses into the renderer
 * process. See SECURITY.md.
 */
type DaemonStatus =
  { state: 'connecting' } | { state: 'ready' } | { state: 'unavailable'; error: string };

let daemonChild: ChildProcess | undefined;
let client: AgentDockClient | undefined;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
// Closing the window hides it to the tray instead of quitting (see createWindow's 'close'
// handler below); only a real quit (tray menu, OS shutdown, before-quit) should let it through.
let isQuitting = false;
const activeSessionIds = new Set<string>();
const streamAborts = new Map<string, AbortController>();
const activeInteractiveSessionIds = new Set<string>();
const interactiveStreamAborts = new Map<string, AbortController>();
/**
 * The single phase-stream subscription (#189). One per daemon connection, not one per ticket: the
 * daemon serves every ticket's transitions on one stream, and the renderer filters. Held here so a
 * daemon restart can tear the old one down before starting the next.
 */
let phaseStreamAbort: AbortController | undefined;
/** The single GitHub connection-health subscription (#257), held the same way `phaseStreamAbort` is. */
let healthStreamAbort: AbortController | undefined;
const pendingInteractiveCreates = new PendingInteractiveCreates();
const interactionBroker = new InteractionBroker();
// Startup may use the 30-second handshake bound plus graceful and hard-stop reap windows.
const INTERACTIVE_CREATE_SHUTDOWN_TIMEOUT_MS = 41_000;
const DAEMON_CANCELLATION_TIMEOUT_MS = 20_000;
/** How long a credential-change restart waits for a graceful shutdown before forcing one. */
const DAEMON_CREDENTIAL_RESTART_TIMEOUT_MS = 15_000;

// Namespaces the daemon rendezvous per application (AD-02); see apps/daemon/src/discovery-file.ts
// for the daemon side of this. A fork shipping its own product under a different name should set
// this to its own id (env var, or hardcode a different literal here) so it doesn't collide with
// another AgentDock-based app's daemon on the same machine; the reference app just uses the
// default. The daemon validates/sanitizes this value itself and refuses to start on an invalid
// one, so it isn't duplicated here.
const APP_ID = process.env.AGENT_DOCK_APP_ID?.trim() || 'agent-dock';

function discoveryFilePath(): string {
  return join(tmpdir(), 'agent-dock', `${APP_ID}.json`);
}

/**
 * Pipenzo's GitHub token vault (issue #165). Main-process-only, by construction: this binding is
 * never passed to a window, never reachable from `preload.ts`, and its `readToken()` has exactly
 * one caller — `spawnDaemon` below — which
 * `apps/desktop/test/github-token-boundary.test.ts` asserts at the source level.
 *
 * The one writer is the device-code flow (issue #114), which runs in main too, for the reason
 * `pipenzo-credential-v1.ts` sets out: main asks GitHub for the code, main polls, main receives the
 * token, so the credential never crosses into the renderer in either direction. See
 * `device-flow-session.ts` for the rules about when it is allowed to store.
 */
const tokenVault = new GitHubTokenVault({
  directory: app.getPath('userData'),
  safeStorage,
});

/** Which credential the currently running daemon was started with. Reported, never inferred. */
let daemonTokenSource: DaemonGitHubTokenSource = 'none';

/**
 * The child a deliberate restart is waiting on, so its `exit` handler starts the next daemon
 * instead of reporting the app broken.
 *
 * A `ChildProcess` rather than a boolean, and compared by identity in the handler: a flag that
 * outlived the process it was set for would silently respawn a *later*, genuinely crashed daemon
 * instead of reporting it unavailable — and the daemon handles SIGTERM with a graceful shutdown
 * that can take seconds, so the window is real rather than theoretical.
 */
let respawnAfterExit: ChildProcess | undefined;

/** True while a credential-change restart is between the kill and the next daemon's spawn. */
let credentialRestartPending = false;

/**
 * Set once by `pipenzo:disconnect-github` and never cleared for the rest of this process's life
 * (issue #210). See `resolveDaemonGitHubToken`'s `developmentFallbackSuppressed` for why: without
 * it, a development build's next spawn falls straight back to the same inherited
 * `PIPENZO_GITHUB_TOKEN`, so "disconnect" would clear the vault and then immediately re-arm from
 * the shell. Signing in again (a real vault write) is unaffected — the vault always wins over this
 * flag, checked first in `resolveDaemonGitHubToken`.
 */
let developmentFallbackSuppressed = false;

function sendStatus(status: DaemonStatus): void {
  sendToRenderer(mainWindow, 'daemon:status', status);
}

function spawnDaemon(): void {
  const { cwd, args } = resolveDaemonEntry({
    mainDir: __dirname,
    isDevServer: !!process.env.VITE_DEV_SERVER_URL,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  const spawnedAt = Date.now();

  // The one place in this app that turns a stored credential back into plaintext, and the one
  // place that decides which credential the daemon gets. See `daemon-environment.ts` for why the
  // daemon's own inherited environment is stripped rather than merged, and why the development
  // fallback is narrow and named rather than silent.
  //
  // `IS_DEVELOPMENT_BUILD ? readDevTokenFile(...) : undefined`, not a bare call, so a packaged
  // build's bundle contains no reachable call to `readDevTokenFile` at all once Rollup folds the
  // condition to the literal `false` (issue #212; verified against the built output the same way
  // `vite.config.ts`'s own comment on this constant documents for `resolveDaemonGitHubToken`'s
  // internal gate) -- not just "the result is unused", but "the file is never even opened" in a
  // shipped Pipenzo.
  const credential = resolveDaemonGitHubToken({
    vaultToken: tokenVault.readToken(),
    developmentToken: IS_DEVELOPMENT_BUILD ? readDevTokenFile(app.getPath('userData')) : undefined,
    isPackaged: app.isPackaged,
    isDevelopmentBuild: IS_DEVELOPMENT_BUILD,
    developmentFallbackSuppressed,
  });
  // Not `credential.source` here (issue #209): that is main's pre-handoff *intent*, unconfirmed
  // until the daemon's own `/health` report lands in `waitForDaemonReady`'s success branch, which
  // is the only place `daemonTokenSource` is set to anything more specific than `'none'`. A daemon
  // that never becomes ready -- a spawn failure, a timeout -- must not leave a stale, optimistic
  // `'vault'` behind for `gitHubConnectionStatus()` to keep reporting; unconfirmed is `'none'`
  // until proven otherwise, the same fail-honest default `reconcileDaemonTokenSource` applies to
  // every other unconfirmed case.
  daemonTokenSource = 'none';
  if (credential.source === 'environment') {
    console.warn(
      `[pipenzo] no GitHub token in the vault; this development build is using the token at ${devTokenFilePath(app.getPath('userData'))}. A packaged build would refuse.`,
    );
  }

  const child = spawn(process.execPath, args, {
    cwd,
    // The credential is *not* in here. The daemon is the parent of every provider subprocess, and a
    // child can read its parent's initial environment block, so it goes down the pipe below
    // instead — see `daemon-environment.ts` and the daemon's `github-credential.ts`.
    env: buildDaemonEnvironment(process.env, { appId: APP_ID, credentialOnStdin: true }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  daemonChild = child;

  // Node emits `error` on a ChildProcess for more than a failed spawn — a `kill()` that fails
  // (`TerminateProcess` on the packaging platform) and a failed `send()` both arrive on the same
  // event, and in those cases the child is still running. Only a spawn that never started may tear
  // down the live-daemon state below; see the `error` handler for what tearing it down wrongly
  // costs. `spawn` fires exactly once, before any other event, on a child that did start.
  let started = false;
  child.once('spawn', () => {
    started = true;
  });

  // One line, then close: the daemon reads exactly one message and never listens again. An `error`
  // listener is required rather than tidy — a child that died before this write turns an ordinary
  // EPIPE into an unhandled stream error that would take the app down with it.
  child.stdin?.on('error', () => {
    // The daemon's own exit handler below is what reports a child that failed to start.
  });
  child.stdin?.end(buildDaemonCredentialMessage(credential.token), 'utf8');

  daemonChild.stdout?.on('data', (chunk: Buffer) => {
    // The daemon's own logger already redacts secrets; forward for local debugging only.
    console.log(`[daemon] ${chunk.toString('utf8').trim()}`);
  });
  daemonChild.stderr?.on('data', (chunk: Buffer) => {
    console.error(`[daemon] ${chunk.toString('utf8').trim()}`);
  });
  // Spawn itself can fail — a missing entry point, a permissions problem — and an unhandled
  // `error` on a ChildProcess is a hard crash. Newly reachable at runtime now that a credential
  // change respawns, rather than only at startup.
  child.on('error', (error: Error) => {
    if (daemonChild !== child) return;
    // The child is alive and this is a `kill()`/`send()` failure, not a spawn failure. Dropping
    // `daemonChild` here would be worse than the error being reported: `before-quit` short-circuits
    // on `!daemonChild` and would never call `killDaemon()`, orphaning a live daemon that still
    // holds the old credential and still blocks the next launch through the single-instance guard,
    // while `client` kept routing requests to it and the next disconnect spawned a *second* daemon
    // alongside it. Report and keep the state.
    if (started) {
      sendStatus({ state: 'unavailable', error: `daemon process error: ${error.message}` });
      return;
    }
    // A spawn that never started emits `error` and `close`, but not `exit` — so the exit handler
    // below, which is where every one of these latches is normally released, never runs. Left set,
    // `daemonChild` names a process with no pid: the next credential change would take it as the
    // live daemon, arm `credentialRestartPending`, `kill()` nothing, wait for an `exit` that cannot
    // come, and wedge every later credential change permanently behind a latch nothing clears.
    daemonChild = undefined;
    respawnAfterExit = undefined;
    credentialRestartPending = false;
    sendStatus({ state: 'unavailable', error: `daemon could not be started: ${error.message}` });
  });

  child.on('exit', (code, signal) => {
    const wasReady = client !== undefined;
    const wasAwaitingRespawn = respawnAfterExit === child;
    // Released here rather than further down, beside the respawn itself: everything below the
    // `!isCurrent` early return is skipped for a child that has already been replaced, and this is
    // a latch that refuses future credential changes while it is set. A guard that fails *closed*
    // on a path that forgets to release it is how one superseded child disables the feature for the
    // rest of the session.
    if (wasAwaitingRespawn) {
      respawnAfterExit = undefined;
      credentialRestartPending = false;
    }
    // Both handles are guarded by the same identity check, for the same reason: a slow-exiting
    // predecessor must not blank out the client or the handle belonging to the daemon that has
    // already replaced it.
    const isCurrent = daemonChild === child;
    if (isCurrent) {
      client = undefined;
      daemonChild = undefined;
      // No live daemon means no confirmed credential source (issue #209) -- harmless to also set
      // this on the credential-change respawn path below, since `spawnDaemon()` sets it again for
      // the next child; what it must not do is leave a *dead* daemon's last-confirmed (or never-
      // confirmed) source on display after an ordinary, non-respawning crash.
      daemonTokenSource = 'none';
    }
    // Teardown is for *this* child's state. It runs whether or not the daemon ever became ready —
    // every collection below is empty in that case, so clearing costs nothing, and skipping it on
    // a restart path would leak an aborted stream's controller into the next daemon's lifetime —
    // but never for a child that has already been replaced, whose collections now belong to its
    // successor.
    if (!isCurrent) return;
    for (const controller of streamAborts.values()) controller.abort();
    streamAborts.clear();
    activeSessionIds.clear();
    for (const sessionId of activeInteractiveSessionIds) {
      clearInteractionSession(sessionId, 'stream_disconnected');
    }
    for (const controller of interactiveStreamAborts.values()) controller.abort();
    interactiveStreamAborts.clear();
    activeInteractiveSessionIds.clear();
    // The next daemon is a new process with a new, empty phase buffer, so the old cursor names a
    // sequence that will never exist again. Aborting the relay discards it: the cursor is relay-
    // local, and the next daemon gets a fresh `forwardPipenzoPhaseEvents` call.
    phaseStreamAbort?.abort();
    phaseStreamAbort = undefined;
    // Same reasoning as the phase stream above: the next daemon starts its reconciler fresh, so the
    // old connection's last-known value belongs to a process that no longer exists.
    healthStreamAbort?.abort();
    healthStreamAbort = undefined;
    if (wasAwaitingRespawn) {
      // `isQuitting` is the guard that stops a disconnect racing a quit from leaving an orphaned
      // daemon behind — one still holding a credential, still listening, and still blocking the
      // next launch through the single-instance guard.
      if (!isQuitting) {
        // A credential change (issue #165). The daemon is handed its GitHub token once, at spawn,
        // so a new credential is a new process — the alternative would be a credential-accepting
        // route inside the one process the whole publish boundary rests on.
        sendStatus({ state: 'connecting' });
        spawnDaemon();
        return;
      }
    }
    if (!wasReady) return; // never became ready; startup error already reported
    sendStatus({
      state: 'unavailable',
      error: `daemon process exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'null'})`,
    });
  });

  waitForDaemonReady(child, spawnedAt, credential.source).catch((err: Error) => {
    if (daemonChild !== child) return; // a replacement is already reporting for itself
    sendStatus({ state: 'unavailable', error: `daemon failed to start: ${err.message}` });
  });
}

function sendInteractionResolutions(
  sessionId: string,
  resolutions: readonly RendererInteractionResolution[],
): void {
  for (const resolution of resolutions) {
    sendToRenderer(mainWindow, 'daemon:interaction-resolved', { sessionId, resolution });
  }
}

function clearInteractionSession(
  sessionId: string,
  reason: 'stream_disconnected' | 'shutdown',
): void {
  sendInteractionResolutions(sessionId, interactionBroker.clearSession(sessionId, reason));
}

function forwardInteractiveEvent(event: AgentEventV2Envelope): void {
  switch (event.type) {
    case 'approval.requested':
    case 'question.requested':
      sendToRenderer(mainWindow, 'daemon:interaction-requested', {
        sessionId: event.sessionId,
        interaction: interactionBroker.publish(event),
      });
      return;
    case 'approval.resolved':
    case 'question.resolved':
    case 'question.cancelled':
      sendInteractionResolutions(event.sessionId, interactionBroker.consumeResolution(event));
      return;
    case 'session.completed':
    case 'session.failed':
    case 'session.cancelled':
    case 'session.interrupted':
      sendInteractionResolutions(event.sessionId, interactionBroker.consumeResolution(event));
      activeInteractiveSessionIds.delete(event.sessionId);
      sendToRenderer(mainWindow, 'daemon:interactive-session-event', {
        sessionId: event.sessionId,
        event,
      });
      return;
    default:
      sendToRenderer(mainWindow, 'daemon:interactive-session-event', {
        sessionId: event.sessionId,
        event,
      });
  }
}

/**
 * Polls the discovery file until the daemon answers, then adopts it as the live client.
 *
 * Takes the `child` it is waiting for, and stops the moment that child stops being the current one.
 * Without that, a credential-change restart landing before the first daemon became ready would
 * leave this loop polling for a dead process all the way to its own deadline — and then reporting
 * `unavailable` *after* the replacement had already reported `ready`, leaving the UI wrongly
 * broken. It could also adopt a discovery file the new daemon had just written, as the old child's
 * client.
 *
 * `intendedSource` is `spawnDaemon`'s own `resolveDaemonGitHubToken` answer for *this* child —
 * what main attempted to send, before it knew whether the stdin handoff would actually land. Once
 * `health()` succeeds, `reconcileDaemonTokenSource` (issue #209) confirms it against what the
 * daemon itself reports having resolved and only then does `daemonTokenSource` become that
 * confirmed answer — never the bare intent, which a failed handoff could leave wrong.
 */
async function waitForDaemonReady(
  child: ChildProcess,
  spawnedAt: number,
  intendedSource: DaemonGitHubTokenSource,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const file = discoveryFilePath();

  while (Date.now() < deadline) {
    if (daemonChild !== child) return; // superseded; the current child has its own waiter
    if (existsSync(file) && statSync(file).mtimeMs >= spawnedAt - 1000) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { port: number; token: string };
        const candidate = new AgentDockClient({
          baseUrl: `http://127.0.0.1:${parsed.port}`,
          token: parsed.token,
        });
        // health() also verifies protocol compatibility (see @agent-dock/client); this doubles
        // as both the readiness check and the version-compatibility check in one call.
        const health = await candidate.health();
        // Re-checked after the await: the restart could have landed while `health()` was in flight.
        if (daemonChild !== child) return;
        client = candidate;
        // A daemon built before issue #209 has no `githubCredentialSource` at all; treated as
        // `'none'` rather than trusting `intendedSource` unconfirmed, the same fail-honest default
        // `reconcileDaemonTokenSource` applies to every other unconfirmed case.
        daemonTokenSource = reconcileDaemonTokenSource(
          intendedSource,
          health.githubCredentialSource ?? 'none',
        );
        // Subscribed once here rather than on a renderer request: the board must not miss a
        // transition that happens between the daemon coming up and a window being opened.
        forwardPipenzoPhaseEvents();
        forwardPipenzoGitHubHealthEvents();
        sendStatus({ state: 'ready' });
        return;
      } catch {
        // discovery file mid-write, daemon not reachable yet, or (in dev only, across a protocol
        // bump) a stale daemon still shutting down: keep polling rather than fail on one miss
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for daemon to become ready');
}

/** Streams one legacy session independently; protocol-v2 uses the reconnecting relay below. */
function forwardSessionEvents(sessionId: string): void {
  if (!client) return;
  streamAborts.get(sessionId)?.abort();
  const controller = new AbortController();
  streamAborts.set(sessionId, controller);
  const activeClient = client;

  void (async () => {
    try {
      for await (const event of activeClient.sessions.events(sessionId, {
        signal: controller.signal,
      })) {
        sendToRenderer(mainWindow, 'daemon:session-event', { sessionId, event });
        if (
          event.type === 'session.completed' ||
          event.type === 'session.failed' ||
          event.type === 'session.cancelled'
        ) {
          activeSessionIds.delete(sessionId);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      sendToRenderer(mainWindow, 'daemon:session-event', {
        sessionId,
        event: {
          type: 'error',
          message: `event stream failed: ${(err as Error).message}`,
          recoverable: false,
        },
      });
    } finally {
      if (streamAborts.get(sessionId) === controller) streamAborts.delete(sessionId);
    }
  })();
}

/**
 * Relays the daemon's phase-change stream (#189) to the renderer.
 *
 * The reconnect and cursor logic lives in `relayPipenzoPhaseEvents` so it is testable outside
 * Electron; this only supplies the client and forwards what comes out. A `replay_gap` is logged
 * rather than swallowed: it means transitions were lost, so a board reading these events should
 * treat its lanes as stale and re-read.
 */
function forwardPipenzoPhaseEvents(): void {
  if (!client) return;
  phaseStreamAbort?.abort();
  const controller = new AbortController();
  phaseStreamAbort = controller;
  const activeClient = client;

  void relayPipenzoPhaseEvents({
    signal: controller.signal,
    events: (options) => activeClient.v2.pipenzo.ticketEvents(options),
    onEvent: (event) => sendToRenderer(mainWindow, 'daemon:pipenzo-phase-event', event),
    onReplayGap: (window) => {
      console.warn(
        `phase event stream fell behind the daemon's replay window; transitions were lost${
          window === undefined ? '' : ` (resuming from ${window.earliestSequence})`
        }`,
      );
    },
    onRetry: (error, lastEventId) => {
      console.warn(
        `phase event stream reconnecting${lastEventId === undefined ? '' : ` after ${lastEventId}`}: ${boundedErrorMessage(error)}`,
      );
    },
    onFatal: (error) => {
      console.error(`phase event stream stopped: ${boundedErrorMessage(error)}`);
    },
  }).finally(() => {
    if (phaseStreamAbort === controller) phaseStreamAbort = undefined;
  });
}

/**
 * Relays the daemon's GitHub connection-health stream (#257) to the renderer, for #70/#71/#72/#73/
 * #75's banners.
 *
 * Simpler than `forwardPipenzoPhaseEvents` above for the reason `pipenzo-health-stream.ts`
 * documents: no cursor, no replay gap, just "try again" on a drop.
 */
function forwardPipenzoGitHubHealthEvents(): void {
  if (!client) return;
  healthStreamAbort?.abort();
  const controller = new AbortController();
  healthStreamAbort = controller;
  const activeClient = client;

  void relayPipenzoGitHubHealthEvents({
    signal: controller.signal,
    events: (options) => activeClient.v2.pipenzo.githubHealthEvents(options),
    onEvent: (health) => sendToRenderer(mainWindow, 'daemon:pipenzo-github-health', health),
    onRetry: (error) => {
      console.warn(`GitHub health stream reconnecting: ${boundedErrorMessage(error)}`);
    },
    onFatal: (error) => {
      console.error(`GitHub health stream stopped: ${boundedErrorMessage(error)}`);
    },
  }).finally(() => {
    if (healthStreamAbort === controller) healthStreamAbort = undefined;
  });
}

/** Streams validated protocol-v2 envelopes without changing the existing v1 renderer flow. */
function forwardInteractiveSessionEvents(sessionId: string): void {
  if (!client) return;
  const previousController = interactiveStreamAborts.get(sessionId);
  if (previousController) {
    previousController.abort();
    clearInteractionSession(sessionId, 'stream_disconnected');
  }
  const controller = new AbortController();
  interactiveStreamAborts.set(sessionId, controller);
  const activeClient = client;

  void relayInteractiveSessionEvents({
    sessionId,
    signal: controller.signal,
    events: (id, options) => activeClient.v2.sessions.events(id, { ...options, responder: true }),
    snapshot: (id) => activeClient.v2.sessions.get(id),
    isActive: () => activeInteractiveSessionIds.has(sessionId),
    onEvent: forwardInteractiveEvent,
    onRetry: (error, lastEventId) => {
      console.warn(
        `interactive event stream ${sessionId} reconnecting${lastEventId === undefined ? '' : ` after ${lastEventId}`}: ${(error as Error).message}`,
      );
    },
    onReplayGap: (session) => {
      clearInteractionSession(sessionId, 'stream_disconnected');
      sendToRenderer(mainWindow, 'daemon:interactive-session-stream-notice', {
        sessionId,
        notice: { type: 'replay_reset', session },
      });
    },
    onFatal: (error) => {
      sendToRenderer(mainWindow, 'daemon:interactive-session-stream-notice', {
        sessionId,
        notice: {
          type: 'error',
          message: boundedErrorMessage(error),
          ...(error instanceof DaemonError ? { status: error.status } : {}),
        },
      });
    },
  }).finally(() => {
    if (interactiveStreamAborts.get(sessionId) === controller) {
      interactiveStreamAborts.delete(sessionId);
      clearInteractionSession(sessionId, 'stream_disconnected');
    }
  });
}

function activateInteractiveSession(session: AgentSessionV2): void {
  if (isTerminalInteractiveStatus(session.status)) return;
  activeInteractiveSessionIds.add(session.id);
  if (!interactiveStreamAborts.has(session.id)) forwardInteractiveSessionEvents(session.id);
}

function createTrackedInteractiveSession(
  start: (signal: AbortSignal) => Promise<AgentSessionV2>,
): Promise<AgentSessionV2> {
  if (!client) return Promise.reject(new Error('daemon is not ready yet'));
  const activeClient = client;
  return pendingInteractiveCreates.run(start, activateInteractiveSession, async (session) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('late interactive session cancellation timed out')),
      DAEMON_CANCELLATION_TIMEOUT_MS,
    );
    try {
      await waitWithin(
        activeClient.v2.sessions.cancel(session.id, { signal: controller.signal }),
        DAEMON_CANCELLATION_TIMEOUT_MS,
      );
    } finally {
      clearTimeout(timer);
    }
  });
}

function isTerminalInteractiveStatus(status: AgentSessionV2['status']): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'interactive event stream failed';
  return message.slice(0, 4 * 1024);
}

async function waitWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = Promise.resolve(work).then(
    () => true,
    () => true,
  );
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([settled, timedOut]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function sendInteractionCommand(
  activeClient: AgentDockClient,
  command: AgentCommandV2,
): Promise<{ status: 'accepted' }> {
  try {
    const acknowledgement = await activeClient.v2.sessions.send(command);
    if (
      acknowledgement.commandId !== command.commandId ||
      acknowledgement.sessionId !== command.sessionId ||
      acknowledgement.turnId !== command.turnId
    ) {
      throw new Error('mismatched acknowledgement');
    }
    return { status: 'accepted' };
  } catch {
    throw new Error('interaction response failed');
  }
}

function parseWorkspaceTrustInput(input: unknown): {
  workspaceId: string;
  update: WorkspaceTrustUpdateRequestV2;
} {
  if (!isRecordWithExactKeys(input, ['workspaceId', 'update'])) {
    throw new Error('invalid workspace trust input');
  }
  if (typeof input.workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(input.workspaceId)) {
    throw new Error('invalid workspace id');
  }
  return {
    workspaceId: input.workspaceId,
    update: workspaceTrustUpdateRequestV2Schema.parse(input.update),
  };
}

function parseRendererSessionCommand(input: unknown): AgentCommandV2 {
  if (!input || typeof input !== 'object' || Array.isArray(input) || 'commandId' in input) {
    throw new Error('renderer session commands must not provide a command id');
  }
  const command = agentCommandV2Schema.parse({ ...input, commandId: randomUUID() });
  if (command.type === 'approval.respond' || command.type === 'question.respond') {
    throw new Error('interactive responses require an opaque interaction handle');
  }
  return command;
}

interface AuditReadInput {
  cursor?: string;
  limit?: number;
  sessionId?: string;
}

function parseAuditReadInput(input: unknown): AuditReadInput {
  if (!isRecordWithAllowedKeys(input, ['cursor', 'limit', 'sessionId'])) {
    throw new Error('invalid audit read input');
  }
  const cursor = input.cursor;
  const limit = input.limit;
  const sessionId = input.sessionId;
  if (
    cursor !== undefined &&
    (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(cursor))
  ) {
    throw new Error('invalid audit cursor');
  }
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100)
  ) {
    throw new Error('invalid audit limit');
  }
  const parsedSessionId =
    sessionId === undefined ? undefined : sessionIdParamSchema.parse({ sessionId }).sessionId;
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit: limit as number }),
    ...(parsedSessionId === undefined ? {} : { sessionId: parsedSessionId }),
  };
}

function isRecordWithExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
}

function isRecordWithAllowedKeys(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

async function killDaemon(): Promise<void> {
  pendingInteractiveCreates.beginShutdown();
  for (const controller of streamAborts.values()) controller.abort();
  for (const sessionId of activeInteractiveSessionIds) {
    clearInteractionSession(sessionId, 'shutdown');
  }
  for (const controller of interactiveStreamAborts.values()) controller.abort();
  phaseStreamAbort?.abort();
  phaseStreamAbort = undefined;
  healthStreamAbort?.abort();
  healthStreamAbort = undefined;
  await pendingInteractiveCreates.waitForPending(INTERACTIVE_CREATE_SHUTDOWN_TIMEOUT_MS);
  const activeClient = client;
  if (activeClient) {
    const cancellationController = new AbortController();
    const cancellationTimer = setTimeout(
      () => cancellationController.abort(new Error('daemon cancellation deadline exceeded')),
      DAEMON_CANCELLATION_TIMEOUT_MS,
    );
    const cancellations = Promise.allSettled([
      // Cancels every in-flight session over HTTP. On Windows,
      // daemonChild.kill() below maps to TerminateProcess, so bounded HTTP cancellation is the
      // reliable opportunity for the daemon to reap each provider tree before the hard stop.
      activeClient.sessions.cancelAll({ signal: cancellationController.signal }),
      ...[...activeInteractiveSessionIds].map((sessionId) =>
        activeClient.v2.sessions.cancel(sessionId, {
          signal: cancellationController.signal,
        }),
      ),
    ]);
    await waitWithin(cancellations, DAEMON_CANCELLATION_TIMEOUT_MS);
    clearTimeout(cancellationTimer);
    cancellationController.abort(new Error('desktop shutdown completed'));
  }
  activeSessionIds.clear();
  streamAborts.clear();
  activeInteractiveSessionIds.clear();
  interactiveStreamAborts.clear();
  daemonChild?.kill();
}

const packagedEntryUrl = pathToFileURL(join(__dirname, '..', 'dist', 'index.html')).href;

/**
 * Scopes `will-navigate` to exactly the app's own content instead of "any http(s) origin that
 * happens to start with the dev-server URL" or "any file:// path at all". Both of the previous
 * checks were prefix-based (`url.startsWith(...)`), which a URL like
 * `http://localhost:5173.evil.example` passes against an allowed `http://localhost:5173`. Real
 * origin comparison (dev) and exact-path comparison against the one file this app ever loads
 * (packaged) close that gap.
 */
function isAllowedNavigationTarget(url: string): boolean {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    try {
      return new URL(url).origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }
  return url === packagedEntryUrl;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    icon: resolveWindowIcon({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'preload.js'),
    },
  });

  // Defense in depth for forks of this boilerplate that later render untrusted content (e.g. a
  // link in a tool result): never let the window navigate away from our own app, and never let
  // it spawn an unrestricted child window. Legitimate external links go to the OS browser instead,
  // and only after passing the same validated allowlist (see allowed-external-url.ts) -- an
  // unvalidated URL must never reach shell.openExternal.
  mainWindow.webContents.setWindowOpenHandler(({ url }) =>
    handleWindowOpen(url, (target) => shell.openExternal(target)),
  );
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (handleWillNavigate(url, isAllowedNavigationTarget, (target) => shell.openExternal(target))) {
      event.preventDefault();
    }
  });

  // Deny every permission request by default: nothing in this UI currently asks for camera,
  // microphone, geolocation, notifications, etc, so there's no legitimate request to allow.
  // Electron's own per-permission/per-platform defaults are inconsistent; this makes the policy
  // explicit and uniform instead of relying on them.
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (client) sendStatus({ state: 'ready' });
  });

  // The daemon keeps running for the tray icon's sake; only a real quit should tear it down, so
  // the window's own close button hides it instead (see the tray menu's Quit and before-quit).
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
}

function createTray(): void {
  const iconPath = resolveWindowIcon({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  if (!iconPath) return; // no icon asset resolved (see resolveWindowIcon); skip rather than show a blank tray glyph
  tray = new Tray(iconPath);
  tray.setToolTip('AgentDock');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open AgentDock',
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

type IpcHandlerListener = Parameters<typeof ipcMain.handle>[1];

/** Every privileged handler below routes through this instead of `ipcMain.handle` directly: the
 * message must come from the current main window's own top-level frame, not a devtools window, a
 * destroyed window, or a non-main child frame (see ipc-sender-guard.ts). */
function handle(channel: string, listener: IpcHandlerListener): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isFromMainWindowFrame(mainWindow, event)) {
      throw new Error(`rejected IPC message on ${channel} from an unexpected sender`);
    }
    return listener(event, ...args);
  });
}

handle('daemon:get-status', (): DaemonStatus =>
  client ? { state: 'ready' } : { state: 'connecting' },
);

/**
 * What the renderer may know about the GitHub credential (issue #165).
 *
 * Assembled field by field from the vault's own status rather than spread from it, for the reason
 * `preload.ts`'s `toDaemonStatus` gives about the daemon status: a spread carries whatever the
 * source object happens to have, and this is the one object in the app whose source sits next to a
 * credential. Building it explicitly means a field added to the vault's status tomorrow cannot
 * reach a window by accident.
 */
function gitHubConnectionStatus(): PipenzoGitHubConnectionV1 {
  const status = tokenVault.status();
  switch (status.state) {
    case 'connected':
      return {
        state: 'connected',
        login: status.login,
        storedAt: status.storedAt,
        source: daemonTokenSource,
      };
    case 'unavailable':
      return { state: 'unavailable', reason: status.reason, source: daemonTokenSource };
    default:
      return { state: 'disconnected', source: daemonTokenSource };
  }
}

/**
 * Restarts the daemon so it picks up a changed credential.
 *
 * The daemon is handed its GitHub token once, on stdin at spawn, and that is on purpose: the
 * alternative — a daemon route that accepts a credential at runtime — would put a credential-
 * writing endpoint inside the exact process the publish boundary rests on, reachable by anything
 * holding the local bearer token. A process restart has no such surface.
 *
 * **A credential change hard-cancels running work, and does not go through `killDaemon`'s graceful
 * path.** `child.kill()` is SIGTERM on POSIX but maps to `TerminateProcess` on Windows — the
 * platform this app packages for — so the bounded HTTP `sessions.cancelAll` that `killDaemon`
 * exists to perform does not happen here. Provider trees are still reaped by the Job Object host,
 * but in-flight sessions die uncancelled. That was acceptable while connecting and disconnecting
 * were pre-app actions taken before any ticket could be running.
 *
 * **That premise no longer holds.** Settings' Account panel (#130) puts "Disconnect GitHub" on a
 * screen reachable with work in flight, which is exactly the case this comment used to rule out.
 * Issue #224 owns the real fix — routing a credential change through a bounded `sessions.cancelAll`
 * before the kill, or refusing the disconnect until the work finishes. Until then the mitigation is
 * in the UI rather than here: the panel confirms first and says in the dialog that anything running
 * stops without a clean cancel, and it latches the in-flight call so a second click cannot turn one
 * restart into a loop.
 */
function restartDaemonForCredentialChange(): void {
  // A restart during shutdown is how an orphaned, credential-holding daemon outlives the app.
  if (isQuitting) return;
  // Already restarting: a second request would kill the daemon that has not started yet, and a
  // renderer that can trigger an unbounded restart loop can terminate every running session at
  // will.
  if (credentialRestartPending) return;
  const child = daemonChild;
  if (!child) {
    spawnDaemon();
    return;
  }
  credentialRestartPending = true;
  respawnAfterExit = child;
  sendStatus({ state: 'connecting' });
  child.kill();
  // On POSIX the daemon handles SIGTERM with a graceful shutdown of its own, so exiting can
  // legitimately take seconds. If it takes far longer than that it is wedged, and waiting forever
  // would leave the UI stuck on `connecting` with the *old* credential still serving requests.
  const hardStop = setTimeout(() => {
    if (respawnAfterExit === child) child.kill('SIGKILL');
  }, DAEMON_CREDENTIAL_RESTART_TIMEOUT_MS);
  hardStop.unref?.();
  child.once('exit', () => clearTimeout(hardStop));
}

handle('pipenzo:github-connection', (): PipenzoGitHubConnectionV1 => gitHubConnectionStatus());

/**
 * Forgets the stored credential. There is deliberately no matching "store" channel: the device-code
 * flow (#114) runs entirely in main, so a token never crosses the bridge in either direction.
 */
handle('pipenzo:disconnect-github', (): PipenzoGitHubConnectionV1 => {
  // Restarting only when something actually changed or would change. `clear()` on an empty vault
  // succeeds silently, so without this half of the guard a renderer could loop this channel and
  // kill the daemon — and every running session with it — over and over, while changing nothing
  // at all.
  //
  // The test for "something changed" is `clear()`'s own report, deliberately not `status()`.
  // `status()` resolves availability before it looks for a record, so on any machine without a
  // usable OS credential store — headless Linux, no gnome-keyring/kwallet, a `basic_text` backend,
  // CI — it returns `unavailable` permanently, no vault file can exist there (`store()` refuses on
  // exactly those machines), and a guard keyed on `!== 'disconnected'` is therefore always true.
  // That turned this channel into the unbounded restart loop the guard was written to prevent,
  // which matters because `restartDaemonForCredentialChange` intentionally bypasses `killDaemon`'s
  // bounded `sessions.cancelAll`: every repetition kills in-flight sessions uncancelled.
  // Issue #210: an explicit disconnect must stick in a development build too, where the vault
  // being empty would otherwise fall straight back to an inherited `PIPENZO_GITHUB_TOKEN` on the
  // very next spawn -- silently turning "forget this credential" into "keep using it". Set
  // unconditionally, before either branch below: harmless when there is nothing to suppress yet,
  // and it must be in effect before a restart this same click triggers, not after.
  developmentFallbackSuppressed = true;
  // Restarting when `clear()` found a real record to remove is the pre-existing guard (its own
  // comment above explains why an unconditional restart would loop). The `daemonTokenSource ===
  // 'environment'` half is new: a machine with no working credential store at all (`state:
  // 'unavailable'`, `os_encryption_unavailable`/`plaintext_backend`) has no vault file `clear()`
  // could ever find, so without this a daemon already running on the inherited variable would
  // keep running on it -- the flag above would be set but would do nothing until some unrelated
  // future restart. This still cannot loop: the second click finds `daemonTokenSource` already
  // `'none'` (the first restart's own confirmed report, issue #209), so the condition is false and
  // nothing restarts a second time.
  if (tokenVault.clear() || daemonTokenSource === 'environment') {
    restartDaemonForCredentialChange();
  }
  // `source` in this reply still describes the daemon that is on its way out; the restart it just
  // triggered recomputes it. The renderer re-reads the connection when `daemon:status` next goes
  // `ready`, which is the same moment the new daemon's credential actually takes effect.
  return gitHubConnectionStatus();
});

/**
 * The device-code sign-in (issue #114), which runs here and only here.
 *
 * The renderer's whole part is three verbs with no payloads worth the name: start, open the
 * verification page, cancel. It never sees the device code, never sees the token, and cannot even
 * name the URL to open — `openVerification` uses the URL this process validated itself, which is
 * the same rule the provider-OAuth handler further down already follows.
 *
 * The lifecycle lives in `device-flow-session.ts` rather than in variables here, because the rule
 * that decides whether a `repo`-scoped token is kept has to be something a test can drive. See that
 * module for the concurrency argument.
 */
const deviceFlow = new GitHubDeviceFlow({ clientId: GITHUB_OAUTH_CLIENT_ID });

const deviceSession = new DeviceFlowSession({
  requestCode: () => deviceFlow.requestCode(),
  poll: (grant, options) => deviceFlow.poll(grant, options),
  canStore: () => tokenVault.encryptionAvailability().available,
  store: (credential) => tokenVault.store(credential),
  isStorageFailure: (error) =>
    error instanceof GitHubTokenVaultError && error.code === 'encryption_unavailable',
  report: (outcome) => sendToRenderer(mainWindow, 'pipenzo:github-device-outcome', outcome),
  // The daemon is handed its credential once, at spawn, so a new one is a new process.
  onStored: () => restartDaemonForCredentialChange(),
});

handle('pipenzo:github-device-start', async (): Promise<PipenzoDeviceCodeV1> => {
  try {
    return await deviceSession.start();
  } catch (error) {
    // Reported on the outcome channel as well as rejecting the call. `DeviceFlowError.reason` does
    // not survive IPC — Electron flattens the error and drops the field — so a renderer left to
    // interpret the rejection alone can only guess, and the guess it used to make was
    // `not_configured`: the one piece of copy whose whole purpose is to tell the user to stop
    // retrying, shown to someone whose network was merely down. Main knows the real reason, so
    // main says it.
    const reason: PipenzoDeviceFailureReasonV1 =
      error instanceof DeviceFlowError ? toWireFailure(error.reason) : 'unreachable';
    sendToRenderer(mainWindow, 'pipenzo:github-device-outcome', { state: 'failed', reason });
    throw error;
  }
});

/**
 * Opens GitHub's device page in the user's own browser — no embedded browser, which is the whole
 * point of this grant type. Takes no argument: the renderer cannot supply a URL, so there is no
 * path by which a compromised renderer turns this into a general "open anything" primitive.
 *
 * Re-pinned here rather than trusted to the grant-time check. `openAllowedExternalUrl` validates
 * the scheme, host presence and userinfo, but it does not know this URL is only ever allowed to be
 * github.com — so the host check is repeated at the moment of launch, where the consequence lives.
 */
handle('pipenzo:github-device-open-verification', (): void => {
  const uri = deviceSession.verificationUri;
  if (!uri) return;
  if (new URL(uri).hostname !== GITHUB_VERIFICATION_HOST) return;
  openAllowedExternalUrl(uri, (url) => shell.openExternal(url));
});

handle('pipenzo:github-device-cancel', (): void => {
  deviceSession.cancel();
});

/**
 * The repo picker (issue #115). Ordinary daemon routes, unlike the credential channels above: the
 * listing needs the daemon's GitHub client, and the connected list is daemon state that the polling
 * reconciler reads. Nothing here touches a credential, which is why it goes through
 * `@agent-dock/client` rather than being handled in main.
 */
handle('daemon:pipenzo-list-repos', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.listRepos();
});

handle('daemon:pipenzo-connected-repos', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.connectedRepos();
});

handle('daemon:pipenzo-connect-repos', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.connectRepos(pipenzoConnectReposRequestV1Schema.parse(input));
});

handle('daemon:list-providers', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.providers.list();
});

handle('daemon:list-providers-v2', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.providers.list();
});

handle('daemon:list-mcp-servers', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const parsed = mcpListRequestV2Schema.parse(input);
  return client.v2.integrations.mcp.list(parsed.provider, parsed.cwd);
});

handle('daemon:configure-mcp-server', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.integrations.mcp.configure(mcpConfigureRequestV2Schema.parse(input));
});

handle('daemon:action-mcp-server', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.integrations.mcp.action(mcpServerActionRequestV2Schema.parse(input));
});

handle('daemon:get-mcp-catalog', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const parsed = mcpCatalogRequestV2Schema.parse(input);
  return client.v2.integrations.mcp.catalog(parsed.provider, parsed.serverId, parsed.cwd);
});

handle('daemon:start-mcp-oauth', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const parsed = mcpOAuthStartRequestV2Schema.parse(input);
  const result = await client.v2.integrations.mcp.oauth(parsed.provider, parsed.serverId, parsed.cwd);
  const launch = resolveOAuthLaunch(result.authorizationUrl);
  if (launch) {
    console.log('[main] opening external URL', externalUrlLogSummary(launch.url));
    await shell.openExternal(launch.url.toString());
  }
  const authorizationHost = launch?.host;
  return {
    serverId: result.serverId,
    status: result.status,
    ...(authorizationHost ? { authorizationHost } : {}),
    ...(result.safeSummary ? { safeSummary: result.safeSummary } : {}),
  };
});

handle('daemon:invoke-mcp-tool', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.integrations.mcp.invoke(mcpToolInvocationRequestV2Schema.parse(input));
});

handle('daemon:list-provider-components', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.integrations.components.list(providerComponentListRequestV2Schema.parse(input));
});

handle('daemon:manage-provider-component', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.integrations.components.manage(providerComponentManageRequestV2Schema.parse(input));
});

handle('daemon:invoke-provider-component', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.integrations.components.invoke(providerComponentInvokeRequestV2Schema.parse(input));
});

handle('daemon:get-subagent-graph', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input });
  return client.v2.agents.graph(sessionId);
});
handle('daemon:control-subagent', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.agents.control(subagentControlRequestV2Schema.parse(input));
});
handle('daemon:preview-worktree', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.worktrees.preview(worktreePreviewRequestV2Schema.parse(input));
});
handle('daemon:create-worktree', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.worktrees.create(worktreeCreateRequestV2Schema.parse(input));
});
handle('daemon:list-worktrees', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.worktrees.list();
});
handle('daemon:cleanup-worktree', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const parsed = worktreeCleanupRequestV2Schema.parse(input);
  return client.v2.worktrees.cleanup(parsed.worktreeId, {
    deleteUntracked: parsed.deleteUntracked,
    deleteBranch: parsed.deleteBranch,
  });
});
// Pipenzo's publish gate (issue #178). Reachable only from this main-process handler, invoked
// only by the renderer's own "Push branch" / "Push & open PR" click — never from anything agent
// session-facing (CLAUDE.md hard rule #1; see routes/pipenzo-publish.ts's module comment).
handle('daemon:pipenzo-publish', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.publish(pipenzoPublishRequestV1Schema.parse(input));
});
// Pipenzo's Refine/Implement/Review phases and the two GitHub issue write ops (issue #184). Same
// boundary and same reasoning as the publish handler above: main-process only, invoked by a
// renderer click, never by anything agent session-facing. Note what does not cross back here —
// every one of these speaks worktree ids, so the renderer is never handed a worktree path and
// cannot ask the daemon to run a phase in a directory of its choosing.
handle('daemon:pipenzo-refine', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.refine(pipenzoRefineRequestV1Schema.parse(input));
});
handle('daemon:pipenzo-implement', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.implement(pipenzoImplementRequestV1Schema.parse(input));
});
handle('daemon:pipenzo-implement-result', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.implementResult(pipenzoImplementResultQueryV1Schema.parse(input));
});
handle('daemon:pipenzo-review', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.review(pipenzoReviewRequestV1Schema.parse(input));
});
handle('daemon:pipenzo-claim-issue', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.claimIssue(pipenzoIssueClaimRequestV1Schema.parse(input));
});
handle('daemon:pipenzo-create-issue', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.createIssue(pipenzoIssueCreateRequestV1Schema.parse(input));
});
// Issue #228. Same boundary as `daemon:pipenzo-create-issue` directly above and for a sharper
// reason: this posts prose that becomes public under the operator's GitHub identity, so it lives
// in main, behind the same sender guard, and can only ever be reached by a renderer click rather
// than by anything a model can reach. There is no renderer caller yet -- #100's refusal panel is
// the one this exists for. What is here is the wire, not the button.
handle('daemon:pipenzo-comment-issue', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.commentOnIssue(pipenzoIssueCommentRequestV1Schema.parse(input));
});
handle('daemon:pipenzo-draft-issue', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.draftIssue(pipenzoIdeaDraftRequestV1Schema.parse(input));
});
handle('daemon:pipenzo-capabilities', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.captureCapabilities(
    pipenzoCaptureCapabilityRequestV1Schema.parse(input),
  );
});
// The phase machine's ticket surface (issue #188): reading a ticket reconciles it against its
// issue's labels, and transitioning writes a new label to GitHub first, then reconciles the same
// way. Same boundary as the handlers above -- main-process only, invoked by a renderer click --
// and same reasoning for why there is no worktree path in the request: neither route needs one,
// since the ticket is addressed by ticket id, not by the worktree it may own.
handle('daemon:pipenzo-ticket-read', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.readTicket(pipenzoTicketReadRequestV1Schema.parse(input));
});
handle('daemon:pipenzo-ticket-transition', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.transitionTicket(pipenzoTicketTransitionRequestV1Schema.parse(input));
});
// The board's list route (issue #255): a local read through the reconciler's already-reconciled
// state, no per-ticket GitHub call and no worktree path in the response, same boundary as the two
// handlers above.
handle('daemon:pipenzo-list-tickets', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.pipenzo.listTickets();
});
/**
 * "Retry now" / "Poll now" (#70/#71/#75): forces the reconciler's next tick to run immediately.
 * Fire-and-forget, same as the client method it calls -- the triggered tick's result reaches the
 * renderer through `onPipenzoGitHubHealth` (#257) rather than through this call's own return.
 */
handle('daemon:pipenzo-github-health-poll', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  await client.v2.pipenzo.pollGitHubHealthNow();
});

handle('dialog:select-and-upload-attachments', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  if (!isRecordWithAllowedKeys(input, ['sessionId'])) throw new Error('invalid attachment picker input');
  const sessionId = input.sessionId === undefined ? undefined : sessionIdParamSchema.parse({ sessionId: input.sessionId }).sessionId;
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
  if (result.canceled) return [];
  if (result.filePaths.length > 20) throw new Error('select at most 20 files');
  const uploaded = [];
  for (const path of result.filePaths) {
    const metadata = statSync(path);
    if (!metadata.isFile()) throw new Error('attachment selection must contain files only');
    uploaded.push(await client.v2.attachments.upload({ fileName: basename(path), size: metadata.size, stream: createReadStream(path), ...(sessionId ? { sessionId } : {}) }));
  }
  return uploaded;
});

handle('daemon:validate-structured-output', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.structured.validate(structuredWorkflowRequestV2Schema.parse(input));
});

handle('daemon:create-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  // Validated here too, at the IPC boundary from the (untrusted) renderer. @agent-dock/client
  // validates again before it ever builds a request, but that's a different concern (protecting
  // the client's own contract), not a substitute for validating what crossed the privileged
  // boundary from the renderer in the first place.
  const parsed = createSessionRequestSchema.parse(input);
  const session = await client.sessions.create(parsed);
  activeSessionIds.add(session.id);
  forwardSessionEvents(session.id);
  return session;
});

handle('daemon:cancel-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input });
  await client.sessions.cancel(sessionId);
});

handle('daemon:create-interactive-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const parsed = createSessionV2RequestSchema.parse(input);
  const activeClient = client;
  return createTrackedInteractiveSession((signal) =>
    activeClient.v2.sessions.create(parsed, { signal }),
  );
});

handle('daemon:list-interactive-sessions', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.sessions.list(sessionListV2QuerySchema.parse(input));
});

handle('daemon:read-interactive-session-history', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  if (!isRecordWithExactKeys(input, ['sessionId', 'query'])) {
    throw new Error('invalid interactive session history input');
  }
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input.sessionId });
  const query = sessionEventHistoryV2QuerySchema.parse(input.query);
  return client.v2.sessions.history(sessionId, query);
});

handle('daemon:reconnect-interactive-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input });
  const session = await client.v2.sessions.get(sessionId);
  activateInteractiveSession(session);
  return session;
});

for (const kind of ['resume', 'fork'] as const) {
  handle(`daemon:${kind}-interactive-session`, async (_event, input: unknown) => {
    if (!client) throw new Error('daemon is not ready yet');
    if (!isRecordWithExactKeys(input, ['sessionId', 'input'])) {
      throw new Error(`invalid interactive session ${kind} input`);
    }
    const { sessionId } = sessionIdParamSchema.parse({ sessionId: input.sessionId });
    const continuation = sessionContinuationInputV2Schema.parse(input.input);
    const activeClient = client;
    return createTrackedInteractiveSession((signal) =>
      activeClient.v2.sessions[kind](sessionId, continuation, { signal }),
    );
  });
}

handle('daemon:delete-interactive-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input });
  await client.v2.sessions.delete(sessionId);
  activeInteractiveSessionIds.delete(sessionId);
  interactiveStreamAborts.get(sessionId)?.abort();
  interactiveStreamAborts.delete(sessionId);
  clearInteractionSession(sessionId, 'stream_disconnected');
});

handle('daemon:send-session-command', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.sessions.send(parseRendererSessionCommand(input));
});

handle('daemon:respond-approval', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return sendInteractionCommand(client, interactionBroker.resolveApproval(input));
});

handle('daemon:answer-questions', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return sendInteractionCommand(client, interactionBroker.resolveQuestions(input));
});

handle('daemon:cancel-interactive-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input });
  return client.v2.sessions.cancel(sessionId);
});

handle('daemon:inspect-workspace', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { cwd } = workspaceInspectRequestV2Schema.parse(input);
  return client.v2.workspaces.inspect(cwd);
});

handle('daemon:set-workspace-trust', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { workspaceId, update } = parseWorkspaceTrustInput(input);
  return client.v2.workspaces.setTrust(workspaceId, update);
});

handle('daemon:read-audit', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.audit.list(parseAuditReadInput(input));
});

// Fixed, main-process-owned constants (issue #73) -- the renderer only ever names which provider
// via a closed enum, never supplies a URL, so this never touches the OAuth-style validated-but-
// dynamic launch path above. Still routed through the same `openAllowedExternalUrl` gate as
// defense in depth against a future edit accidentally making either value request-controlled.
const PROVIDER_INSTALL_DOCS_URL: Record<ProviderId, string> = {
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://github.com/openai/codex',
};

handle('shell:open-provider-install-docs', async (_event, input: unknown) => {
  const provider = providerIdSchema.parse(input);
  openAllowedExternalUrl(PROVIDER_INSTALL_DOCS_URL[provider], (target) => shell.openExternal(target));
});

handle('dialog:select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    spawnDaemon();
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else mainWindow?.show();
    });
  });

  app.on('window-all-closed', () => {
    // The window hides rather than closes (see createWindow's 'close' handler), so this only
    // fires on an actual close (e.g. macOS's Cmd+Q path); the tray icon otherwise keeps the app
    // and daemon alive after the window is hidden.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    isQuitting = true;
    // A poll landing after this point would store a credential and then hit
    // `restartDaemonForCredentialChange`'s own `isQuitting` guard, leaving the token saved but not
    // delivered until the next launch, while the UI's last frame said it was restarting.
    deviceSession.abandon();
    if (pendingInteractiveCreates.isClosing || !daemonChild) return;
    pendingInteractiveCreates.beginShutdown();
    event.preventDefault();
    void killDaemon().finally(() => app.quit());
  });
}
