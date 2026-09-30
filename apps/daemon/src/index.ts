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
import { PipenzoAuditStore } from './pipenzo-audit-store.js';
import { ConnectedReposStore } from './connected-repos-store.js';
import { LessonStore } from './pipenzo-lesson-store.js';
import { PipenzoConcurrencyStore } from './pipenzo-concurrency-store.js';
import { PipenzoExecutionLimiter } from './pipenzo-execution-limiter.js';
import { PipenzoCaptureSettingsStore } from './pipenzo-capture-settings-store.js';
import { RepoCheckouts, reposRoot } from './repo-checkout.js';
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
import { OctokitGitHubClient, registerKnownSecret } from './github-client.js';
import { ConditionalRequestCache } from './github-conditional-cache.js';
import { GitHubRateLimitTracker } from './github-rate-limit.js';
import { DaemonGitHubCredential, readDaemonStartupMessage } from './github-credential.js';
import { PublishNonceGate } from './publish-nonce-gate.js';
import { PipenzoPhaseMachine } from './pipenzo-phase-machine.js';
import { MediumApprovalStore } from './medium-approval-store.js';
import { HighApprovalStore } from './high-approval-store.js';
import { StackApprovalStore } from './stack-approval-store.js';
import { PipenzoPhaseEventBus } from './pipenzo-phase-events.js';
import { PipenzoCrashRecovery } from './pipenzo-crash-recovery.js';
import { PipenzoReconciler } from './pipenzo-reconciler.js';

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

  // The one startup message, read from stdin before anything else so no code path can run against
  // a half-initialized daemon. `process.stdin` is a single stream -- only one reader may ever
  // consume it -- so this is the one read, and both the GitHub credential (issue #165) and the
  // publish-nonce secret (issue #182) are built from its parsed result rather than each reading
  // stdin for itself. It arrives over a pipe rather than in this process's environment because the
  // daemon is the *parent* of every provider subprocess, and a child can read its parent's initial
  // environment block (`/proc/<ppid>/environ`) — see `github-credential.ts`.
  const startupMessage = await readDaemonStartupMessage({ stdin: process.stdin });
  // When nothing was injected (a daemon started directly, the live-smoke harness, CI) this falls
  // back to `PIPENZO_GITHUB_TOKEN` exactly as before.
  const githubCredential = DaemonGitHubCredential.fromMessage(startupMessage);
  logger.info('github credential source', {
    source: githubCredential.injected ? 'injected' : 'environment-or-absent',
  });
  // Issue #182's second factor for the publish route. Same fallback shape as the credential above
  // (`PIPENZO_PUBLISH_NONCE_SECRET` for a daemon nobody injected into); `configured: false` here
  // means the publish route refuses every request rather than skipping the check.
  const publishNonceGate = PublishNonceGate.fromMessage(startupMessage);
  logger.info('publish nonce gate', { configured: publishNonceGate.configured });
  // Issue #211: `redactSecrets` cannot recognize a pre-2021 40-hex classic PAT by shape alone (see
  // its own doc comment) -- but now that the token is resolved once, here, into a first-class
  // object rather than re-read from the environment at each call site, registering the exact value
  // is cheap and format-independent. `tryResolve()`, not `resolve()`: a daemon with no credential
  // at all has nothing to register, and that is an ordinary, already-handled state, not a startup
  // failure.
  const resolvedGithubToken = githubCredential.tryResolve();
  if (resolvedGithubToken) registerKnownSecret(resolvedGithubToken);
  // Security-review nit on issue #182: the publish-nonce secret gets the same exact-match
  // redaction registration the GitHub token does, above -- belt-and-suspenders against the
  // secret ever surfacing in a log or error string, even though nothing in this codebase logs it
  // directly today.
  const nonceSecretForRedaction = publishNonceGate.secretHexForRedaction();
  if (nonceSecretForRedaction) registerKnownSecret(nonceSecretForRedaction);
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

  // Pipenzo's own audit log (issue #149): where a lane/label divergence the reconciler's polling
  // read finds lands, durably -- separate from `auditStore` above, which is agentdock's inherited
  // permission-approval log and has no field for this concept. See `pipenzo-audit-v1.ts`.
  const pipenzoAuditStore = new PipenzoAuditStore(
    join(durableStateDirectory, 'pipenzo-audit-v1.jsonl'),
  );

  // Pipenzo's connected-repos list (issue #115): which repositories a human chose in the first-run
  // picker, and therefore which ones the polling reconciler will iterate. A single file beside the
  // other durable stores rather than a per-workspace record, because the picker runs before any
  // repository has been cloned -- see the store's own comment on why it is not keyed by workspace.
  const connectedRepos = new ConnectedReposStore(
    join(durableStateDirectory, 'connected-repos-v1.json'),
  );
  // Local, human-gated lesson memory (issue #18): the one-line notes a person chose to keep when a
  // ticket resolved, listed and deletable from Settings (issue #128). Same single-file layout as
  // `connectedRepos` above, beside the other durable stores — see the store's own module comment for
  // why a lesson does not belong inside `FileTicketStore`.
  const lessonStore = new LessonStore(join(durableStateDirectory, 'lessons-v1.json'));
  // Bounded local concurrency's settings (issue #126): the execution-limit stepper and workspace
  // default run budget a person sets in Settings. Same single-file layout as `lessonStore` above,
  // read once at startup so the limiter below enforces whatever was last saved rather than always
  // restarting at the product default.
  const concurrencyStore = new PipenzoConcurrencyStore(join(durableStateDirectory, 'concurrency-v1.json'));
  const concurrencySettings = await concurrencyStore.read();
  // The Models & gates screen's agent-captured panel (issue #470): the
  // `screenshotEnabled`/`escapeHatchEnabled` preference. Same single-file layout as
  // `concurrencyStore` above, beside the other durable stores.
  const captureSettingsStore = new PipenzoCaptureSettingsStore(
    join(durableStateDirectory, 'capture-settings-v1.json'),
  );
  // The real enforcement layer (issue #126): refuses a new Implement dispatch once this many
  // tickets are already in flight, live-updated by `PUT /v2/pipenzo/concurrency` with no restart
  // required. See `pipenzo-execution-limiter.ts` for why this is a second, Pipenzo-owned gate
  // beside agentdock's own daemon-wide `SessionAdmissionController` above, not a replacement for it.
  const executionLimiter = new PipenzoExecutionLimiter(concurrencySettings.executionLimit);
  // Where a connected repo's local checkout lives (issues #342/#344): cloned on first need into
  // `<state dir>/repos/<owner>/<repo>` (or under `PIPENZO_REPOS_DIR`), reused after. One instance,
  // because it is also what serializes concurrent requests for the same repository -- see
  // `repo-checkout.ts`. The clone never sees the GitHub credential above; it goes through the
  // user's own git credential helper, the same floor the publish service's push uses.
  const repoCheckouts = new RepoCheckouts(reposRoot(durableStateDirectory));

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
  // the agent-runtime path receives a reference to it.
  //
  // This comment used to argue that the PAT never reaches a provider subprocess *because* every
  // provider spawn builds its environment from the reviewed OS/runtime allowlist rather than
  // inheriting `process.env`. Issue #165 established that this argument does not hold on its own:
  // an allowlist stops a child inheriting a variable, not a child reading it out of the parent's
  // environment block (`/proc/<ppid>/environ`, or the PEB on Windows). The allowlist is still in
  // force and still worth having; what actually carries the claim now is that the credential is
  // not in this process's environment at all — it arrives over stdin and lives in
  // `githubCredential`. See `github-credential.ts` for the full argument.
  const publishService = new PublishService({
    worktrees: worktreeManager,
    logger,
    resolveGitHubCredential: (env) => githubCredential.resolve(env),
    // Issue #160: every real publish attempt gets an audit entry. `resolveTicketId` is the reverse
    // of the direction `PublishService` is otherwise handed things in -- a worktree id, never a
    // ticket id -- so it is a plain scan of the ticket store's own `worktree.id` field rather than
    // a new index; that store is already read far more often (every phase-service call) than
    // publish is ever invoked (a human-paced, rate-limited action).
    audit: pipenzoAuditStore,
    resolveTicketId: (worktreeId) =>
      ticketStore.list().find((ticket) => ticket.worktree?.id === worktreeId)?.ticketId,
  });

  // Pipenzo's Refine/Implement/Review phases (issue #184). Same boundary as the publish gate: it
  // is constructed here, in the daemon process, and is reachable only through the `/v2/pipenzo/*`
  // routes behind the bearer token. The GitHub client is built lazily from a token read at call
  // time, so no authenticated client is retained between requests, and the gate commands run on
  // `buildGitEnvironment()`'s reviewed floor rather than inheriting this process's environment.
  // The per-`(repo, resource)` ETag store (issue #161). One per daemon, deliberately outside the
  // two client factories below: each of those builds a *fresh* authenticated client per request
  // (that is the token-boundary rule — no authenticated client is retained between requests), so a
  // cache each client owned would be thrown away before it ever served a validator. The cache holds
  // no credential, only response bodies and ETags, so sharing it across those short-lived clients
  // costs nothing the boundary was protecting.
  const githubConditionalCache = new ConditionalRequestCache();
  // Remaining GitHub quota, read off responses the daemon was making anyway (issue #229). Shared
  // and constructed here for exactly the reason the cache above is: each factory below builds a
  // fresh authenticated client per request, so a tracker a client owned would be discarded before
  // its second observation and the shipped daemon would capture nothing -- present in the source,
  // absent from the running app. It holds no credential: four numbers and a bucket name each.
  const githubRateLimits = new GitHubRateLimitTracker();

  // Pipenzo's phase machine (issue #188): README's precedence rule made executable -- GitHub labels
  // are authoritative for a ticket's lane, the ticket store for everything GitHub cannot hold, and
  // when the two disagree the label wins. Same GitHub boundary as the phase service below: the
  // client is built lazily from a token read at call time, so no authenticated client is retained
  // between requests and nothing in the agent-runtime path holds a reference to it.
  // The phase-change stream (issue #189). Held here rather than inside the machine so the routes
  // can subscribe to the same bus the machine publishes to, and so a daemon assembled for a test can
  // leave it out entirely.
  //
  // Built before the phase service (rather than after, as originally written) because the service
  // now needs it too (issue #144): a blown-estimate review outcome transitions the ticket through
  // this same machine.
  const phaseEvents = new PipenzoPhaseEventBus();
  const phaseMachine = new PipenzoPhaseMachine({
    tickets: ticketStore,
    github: () =>
      OctokitGitHubClient.fromToken(githubCredential.resolve(), {
        cache: githubConditionalCache,
        rateLimits: githubRateLimits,
      }),
    events: phaseEvents,
  });

  const phaseService = new PipenzoPhaseService({
    // Refine and Draft read a repository path the renderer names, so it must be a trusted
    // workspace; Review reads a daemon-owned worktree resolved by id.
    refineSessions: new AwaitedPhaseSessions({ sessionManager, workspaceTrust: trustStore }),
    reviewSessions: new AwaitedPhaseSessions({
      sessionManager,
      workspaceTrust: 'daemon-owned-worktree',
    }),
    implementSessions: new DispatchOnlyPhaseSessions({ sessionManager }),
    worktrees: worktreeManager,
    github: () =>
      OctokitGitHubClient.fromToken(githubCredential.resolve(), {
        cache: githubConditionalCache,
        rateLimits: githubRateLimits,
      }),
    commands: new ExecFileGateCommands({ probeCwd: durableStateDirectory }),
    // Issue #144: lets a blown-estimate review outcome transition the ticket to
    // pipenzo:awaiting-stack-approval and post the real-vs-predicted numbers as a comment.
    machine: phaseMachine,
    // Issue #159: lets a successful implement() best-effort record the worktree it just cut onto
    // the ticket record, which terminal-state cleanup (below) later reads back.
    tickets: ticketStore,
    logger,
    // Issue #160: every review-gate run that reaches an outcome gets an audit entry.
    audit: pipenzoAuditStore,
    // Issue #126: refuses a new Implement dispatch once the workspace's configured execution limit
    // is already at capacity.
    executionLimiter,
  });

  // Pipenzo's polling reconciler (issue #231): the loop that makes the connected-repos list worth
  // having. Same GitHub boundary and same shared cache/tracker as the phase machine above -- it
  // reaches GitHub only through `phaseMachine.read()`, never through a client of its own, which is
  // what makes every poll a conditional read against `githubConditionalCache` rather than a second,
  // uncached implementation of "fetch this issue".
  const pipenzoReconciler = new PipenzoReconciler({
    repos: connectedRepos,
    tickets: ticketStore,
    machine: phaseMachine,
    audit: pipenzoAuditStore,
    github: () =>
      OctokitGitHubClient.fromToken(githubCredential.resolve(), {
        cache: githubConditionalCache,
        rateLimits: githubRateLimits,
      }),
    // Issue #159: a ticket whose issue closes (merged or closed unmerged) since the last poll gets
    // its worktree cleaned up on this same tick.
    worktrees: worktreeManager,
    logger,
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

  // The MEDIUM inline approval flow's snapshot/decision store (issue #97). In-process and
  // per-daemon-lifetime, same as `publishNonceGate` above -- a pending or resolved-but-not-yet-undone
  // snapshot does not need to survive a daemon restart, since restarting mid-approval already means
  // whatever renderer state was waiting on it is gone too.
  const mediumApprovalStore = new MediumApprovalStore();

  // The HIGH full publish-gate card's own approval store (issue #98). In-process and
  // per-daemon-lifetime like `mediumApprovalStore` above, but there is no undo half to preserve on
  // restart even in principle -- a HIGH decision is never revisited once made.
  const highApprovalStore = new HighApprovalStore();

  // The stack approval panel's own approval store (issue #99). In-process and per-daemon-lifetime
  // like `highApprovalStore` above -- a pending stack proposal that outlives a daemon restart is
  // recoverable from the ticket's own `pipenzo:awaiting-stack-approval` label and cached `spec
  // .proposedSplit` (a fresh `captureStack` call re-reads both), so there is nothing this in-memory
  // store needs to persist across a restart either.
  const stackApprovalStore = new StackApprovalStore();

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
    publishNonceGate,
    phaseService,
    phaseMachine,
    phaseEvents,
    mediumApprovalStore,
    highApprovalStore,
    stackApprovalStore,
    crashRecovery,
    connectedRepos,
    repoCheckouts,
    lessonStore,
    // Issue #126: Settings' Concurrency panel, and the same limiter `phaseService` above enforces
    // against -- see `pipenzo-tickets.ts`'s own comment for why the ticket route reads it too.
    concurrencyStore,
    executionLimiter,
    // Issue #470: the Models & gates screen's agent-captured panel.
    captureSettingsStore,
    // Issue #159: lets the ticket-transition route look up a ticket's recorded worktree and clean
    // it up on an abandonment (working/ready-for-review -> queued).
    ticketStore,
    // Issue #82: the same audit log `pipenzoReconciler` above already writes a poll-found
    // divergence to, so a divergence the transition route finds (a board drag) lands in the one
    // audit trail rather than a second one this file would have to invent.
    pipenzoAuditStore,
    // The same lazy, per-call client boundary as the phase service and phase machine above: built
    // from a token read at call time, never retained between requests.
    pipenzoGitHubClient: () =>
      OctokitGitHubClient.fromToken(githubCredential.resolve(), {
        cache: githubConditionalCache,
        rateLimits: githubRateLimits,
      }),
    // The reconciler's health stream (issue #257): `health()`/`subscribeHealth()` are the only two
    // members the route needs, and it is the same object whose `start()`/`stop()` this file already
    // owns below.
    pipenzoHealth: pipenzoReconciler,
    // The daemon's own resolved-source report on `/health` (issue #209) — the same object every
    // `OctokitGitHubClient.fromToken` call above already resolves against.
    githubCredential,
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

  // Started after `listen()`, deliberately not awaited: `start()` runs its first tick immediately
  // rather than after one interval, and that first tick is one conditional GitHub read per
  // connected ticket. Awaiting it would make the daemon's startup wait on a rate-limited API the
  // same way awaiting `writeLabels()` above would, for the same reason it is not done there.
  pipenzoReconciler.start();

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    // Stopped first and awaited: a `setTimeout` nobody clears keeps this process alive past its own
    // shutdown, and a tick left in flight keeps spending GitHub quota after the window that wanted
    // it has closed. `stop()` never rejects.
    await pipenzoReconciler.stop();
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
