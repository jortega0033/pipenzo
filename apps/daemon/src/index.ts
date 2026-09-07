import { closeAllMcpConnections, createConsoleLogger } from '@agent-dock/agent-runtime';
import { join } from 'node:path';
import { AuditStore } from './audit-store.js';
import { generateToken } from './auth-token.js';
import {
  DEFAULT_APP_ID,
  assertNoLiveDaemon,
  discoveryFilePath,
  removeDiscoveryFile,
  writeDiscoveryFile,
} from './discovery-file.js';
import { buildProviderRegistry } from './providers.js';
import { buildServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { SessionAdmissionController, resolveMaxActiveSessions } from './session-admission.js';
import { FileSessionStore } from './session-store.js';
import { FileExecutionGraphStore } from './execution-graph-store.js';
import { FileTicketStore } from './pipenzo-ticket-store.js';
import { ensureStateDirectory, stateDirectory } from './state-directory.js';
import { SubagentGraphStore } from './subagent-graph-store.js';
import { OwnedWorktreeManager } from './worktree-manager.js';
import { AttachmentStore } from './attachment-store.js';
import { WorkspaceTrustStore } from './workspace-trust-store.js';
import { PublishService } from './publish-service.js';
import { PipenzoPhaseService } from './pipenzo-phase-service.js';
import {
  AwaitedPhaseSessions,
  DispatchOnlyPhaseSessions,
} from './pipenzo-phase-sessions.js';
import { ExecFileGateCommands } from './gate-commands.js';
import { OctokitGitHubClient } from './github-client.js';
import { PipenzoPhaseMachine } from './pipenzo-phase-machine.js';
import { PipenzoPhaseEventBus } from './pipenzo-phase-events.js';
import { PipenzoCrashRecovery } from './pipenzo-crash-recovery.js';

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([promise.then(() => true), timedOut]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function main() {
  const logger = createConsoleLogger(
    'daemon',
    process.env.AGENT_DOCK_LOG_LEVEL === 'debug' ? 'debug' : 'info',
  );
  // Namespaces the discovery rendezvous per application (AD-02) so two different products built
  // on this boilerplate can each run their own daemon at once instead of colliding on one
  // machine-global path. The reference desktop app never sets this: it only matters for a fork
  // that wants to coexist with another AgentDock-based app on the same machine.
  const appId = process.env.AGENT_DOCK_APP_ID?.trim() || DEFAULT_APP_ID;
  assertNoLiveDaemon(appId);
  const registry = buildProviderRegistry(logger);
  const durableStateDirectory = stateDirectory({ appId });
  // Every subdirectory below is created independently, some via ensureStateDirectory() (which
  // now re-verifies an existing directory itself, see state-directory.ts), some via a store's own
  // recursive mkdir -- but only ensureStateDirectory() actually re-checks ownership/mode against
  // one it did not just create, so the durable-state root itself needs one direct call here rather
  // than relying on a subdirectory's recursive mkdir to have implicitly hardened its ancestor.
  await ensureStateDirectory(durableStateDirectory);
  const subagentStore = new SubagentGraphStore(join(durableStateDirectory, 'subagents-v1.json'));
  const trustStore = new WorkspaceTrustStore(
    join(durableStateDirectory, 'workspace-trust-v1.json'),
  );
  const worktreeManager = new OwnedWorktreeManager(
    join(durableStateDirectory, 'worktrees'),
    join(durableStateDirectory, 'worktrees-v1.json'),
    undefined,
    trustStore,
  );
  await worktreeManager.load();
  const attachmentStore = new AttachmentStore(
    join(durableStateDirectory, 'attachments-v1'),
    join(durableStateDirectory, 'attachments-v1.json'),
    undefined,
    undefined,
    logger,
  );
  await attachmentStore.load();
  const auditStore = new AuditStore(join(durableStateDirectory, 'audit-v1.jsonl'));
  const sessionStoreDirectory = join(durableStateDirectory, 'sessions-v1');
  const sessionStore = new FileSessionStore(sessionStoreDirectory);
  const executionGraphStore = new FileExecutionGraphStore(
    join(durableStateDirectory, 'execution-graph-v1'),
    {
      additionalQuotaPaths: [sessionStoreDirectory],
      onLineageRemoving: (records) => {
        for (const record of records) sessionStore.delete(record.session.id);
        // Whole-lineage attachment cleanup (issue #67): a session's attachments should not
        // outlive the lineage they belong to, regardless of their own age cap. Fire-and-forget --
        // this hook itself is synchronous -- with errors logged rather than left unhandled.
        void attachmentStore
          .releaseSessions(records.map((record) => record.session.id))
          .catch((error: unknown) => {
            logger.warn('failed to release attachments for a removed lineage', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      },
    },
  );
  // Pipenzo's ticket store (issue #187): the JSON-file record of everything GitHub's labels can't
  // hold (worktree id/path, attempt lineage, budget, risk score, pre-commitment events, poll
  // ETags — README's *Ticket store* section). Constructed here, beside the other durable stores,
  // for the same reason they are: `stateDirectory()` is the one root every durable store hangs off
  // of, and `tickets-v1` keeps this store's on-disk layout parallel to `sessions-v1`. The phase
  // machine below (#188) is what reads and writes it.
  const ticketStore = new FileTicketStore(join(durableStateDirectory, 'tickets-v1'));

  const sessionRecovery = sessionStore.getRecoveryReport();
  const graphRecovery = executionGraphStore.recoveryReport();
  const ticketRecovery = ticketStore.getRecoveryReport();
  if (
    sessionRecovery.quarantinedFiles.length > 0 ||
    sessionRecovery.interruptedSessionIds.length > 0 ||
    graphRecovery.quarantinedPaths.length > 0 ||
    graphRecovery.interruptedSessionIds.length > 0 ||
    ticketRecovery.quarantinedFiles.length > 0
  ) {
    logger.warn('durable session recovery required repairs', {
      quarantinedSessionRecords: sessionRecovery.quarantinedFiles.length,
      quarantinedExecutionRecords: graphRecovery.quarantinedPaths.length,
      quarantinedTicketRecords: ticketRecovery.quarantinedFiles.length,
      interruptedCompatibilitySessions: sessionRecovery.interruptedSessionIds.length,
      interruptedExecutions: graphRecovery.interruptedSessionIds.length,
    });
  }
  // Fails fast (throws, caught by main().catch() below) on an out-of-range or non-integer value
  // rather than silently clamping, so a misconfigured deployment never launches with a capacity
  // limit it never intended.
  const admission = new SessionAdmissionController({
    maxActiveSessions: resolveMaxActiveSessions(process.env.AGENT_DOCK_MAX_ACTIVE_SESSIONS),
  });
  const sessionManager = new SessionManager(registry, logger, sessionStore, {
    auditStore,
    trustStore,
    providerStateDirectory: durableStateDirectory,
    executionGraphStore,
    attachmentStore,
    subagentStore,
    admission,
  });
  const token = generateToken();

  // Pipenzo's publish gate (issue #178). It is constructed here, in the daemon process, and is
  // reachable only through `POST /v2/pipenzo/publish` behind the bearer token above. Nothing in
  // the agent-runtime path receives a reference to it, and the GitHub PAT it reads at call time
  // never reaches a provider subprocess: every provider spawn builds its environment from the
  // reviewed OS/runtime allowlist rather than inheriting this process's `process.env`.
  const publishService = new PublishService({ worktrees: worktreeManager, logger });

  // Pipenzo's Refine/Implement/Review phases (issue #184). Same boundary as the publish gate: it
  // is constructed here, in the daemon process, and is reachable only through the `/v2/pipenzo/*`
  // routes behind the bearer token. The GitHub client is built lazily from a token read at call
  // time, so no authenticated client is retained between requests, and the gate commands run on
  // `buildGitEnvironment()`'s reviewed floor rather than inheriting this process's environment.
  const phaseService = new PipenzoPhaseService({
    refineSessions: new AwaitedPhaseSessions({ sessionManager }),
    reviewSessions: new AwaitedPhaseSessions({ sessionManager }),
    implementSessions: new DispatchOnlyPhaseSessions({ sessionManager }),
    worktrees: worktreeManager,
    github: () => OctokitGitHubClient.fromEnvironment(),
    commands: new ExecFileGateCommands({ probeCwd: durableStateDirectory }),
  });

  // Pipenzo's phase machine (issue #188): README's precedence rule made executable -- GitHub labels
  // are authoritative for a ticket's lane, the ticket store for everything GitHub cannot hold, and
  // when the two disagree the label wins. Same GitHub boundary as the phase service above: the
  // client is built lazily from a token read at call time, so no authenticated client is retained
  // between requests and nothing in the agent-runtime path holds a reference to it.
  // The phase-change stream (issue #189). Held here rather than inside the machine so the routes
  // can subscribe to the same bus the machine publishes to, and so a daemon assembled for a test can
  // leave it out entirely.
  const phaseEvents = new PipenzoPhaseEventBus();
  const phaseMachine = new PipenzoPhaseMachine({
    tickets: ticketStore,
    github: () => OctokitGitHubClient.fromEnvironment(),
    events: phaseEvents,
  });

  // Pipenzo's crash recovery (issue #190). The two recovery reports read above already mark the
  // sessions interrupted; this is what maps them back onto tickets, parks each one in Needs-human,
  // and records what a human's two options are. Same GitHub boundary as everything else on this
  // surface -- it reaches GitHub only through the phase machine above, which builds its client
  // lazily from a token read at call time.
  const crashRecovery = new PipenzoCrashRecovery({
    tickets: ticketStore,
    executions: executionGraphStore,
    sessions: sessionStore,
    logger,
    machine: phaseMachine,
    events: phaseEvents,
  });
  // The local half runs here, before the server listens, so the recovery route can never answer with
  // a half-built report. It writes only ticket-store files, so it cannot fail on a network and
  // cannot be the reason a daemon does not start. The GitHub half runs after `listen()` below.
  crashRecovery.park({
    interruptedSessionIds: [
      ...sessionRecovery.interruptedSessionIds,
      ...graphRecovery.interruptedSessionIds,
    ],
    quarantinedTicketRecordCount: ticketRecovery.quarantinedFiles.length,
  });

  const app = buildServer({
    registry,
    sessionManager,
    token,
    logger,
    auditStore,
    trustStore,
    subagentStore,
    worktreeManager,
    attachmentStore,
    publishService,
    phaseService,
    phaseMachine,
    phaseEvents,
    crashRecovery,
  });

  const requestedPort = Number(process.env.AGENT_DOCK_PORT ?? '0');
  await app.listen({ port: requestedPort, host: '127.0.0.1' });

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;

  const filePath = writeDiscoveryFile(
    { port, token, pid: process.pid, startedAt: new Date().toISOString() },
    appId,
  );
  logger.info('daemon listening', {
    url: `http://127.0.0.1:${port}`,
    appId,
    discoveryFile: filePath,
  });

  // Crash recovery's GitHub half, deliberately after `listen()` and deliberately not awaited. Every
  // parked ticket is already durable and already served by `GET /v2/pipenzo/recovery`; all this adds
  // is `pipenzo:interrupted` on the issue. Awaiting it would make the daemon's startup -- and so the
  // desktop's first connection -- wait on a rate-limited API for one round trip per parked ticket,
  // and a GitHub outage would turn one crash into a daemon that never finishes starting. `void` is
  // safe rather than sloppy here: `writeLabels()` catches per ticket and cannot reject.
  void crashRecovery.writeLabels();

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    sessionManager.beginShutdown();
    await sessionManager.cancelAll();
    await closeAllMcpConnections().catch(() => {
      logger.warn('MCP connection cleanup failed');
    });
    const closing = app.close().catch(() => {
      logger.warn('daemon HTTP shutdown failed');
    });
    if (!(await settlesWithin(closing, 5_000))) {
      logger.warn('daemon HTTP shutdown exceeded deadline; closing active sockets');
      app.server.closeAllConnections();
      await settlesWithin(closing, 1_000);
    }
    removeDiscoveryFile(appId);
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  // Say *why*, not just *that*. Every throw reachable from `main()` is daemon-authored and written
  // to be read by the operator who has to act on it: `assertNoLiveDaemon` names the pid already
  // holding the discovery file, `ensureSecureRuntimeDir` names the directory and the mode it
  // refused, `resolveMaxActiveSessions` names the value it rejected, and `app.listen` reports
  // `EADDRINUSE`. Discarding all of that left "daemon failed to start" as the entire diagnostic --
  // an operator (and, observed here, an agent driving the daemon) had to bisect the startup path by
  // hand to recover a message the process already had in its hands.
  //
  // The message only, never the stack: a stack is noise on a startup failure whose causes are all
  // named above, and this runs before any provider session exists, so nothing provider-controlled
  // (which `run-session.ts` is careful never to decode or log) can reach this string.
  console.error(
    `daemon failed to start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});

export { discoveryFilePath };
