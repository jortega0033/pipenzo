import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Logger, ProviderRegistry } from '@agent-dock/agent-runtime';
import { extractBearerToken, tokensMatch } from './auth-token.js';
import { registerHealthRoute } from './routes/health.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerV2ProviderRoutes } from './routes/v2-providers.js';
import { registerV2SessionRoutes } from './routes/v2-sessions.js';
import { registerV2AuditRoutes } from './routes/v2-audit.js';
import { registerV2WorkspaceRoutes } from './routes/v2-workspaces.js';
import { registerV2McpRoutes } from './routes/v2-mcp.js';
import { registerV2ComponentRoutes } from './routes/v2-components.js';
import type { AuditStore } from './audit-store.js';
import type { SessionManager } from './session-manager.js';
import type { WorkspaceTrustStore } from './workspace-trust-store.js';
import type { SubagentGraphStore } from './subagent-graph-store.js';
import type { OwnedWorktreeManager } from './worktree-manager.js';
import { registerV2AgentWorktreeRoutes } from './routes/v2-agents-worktrees.js';
import type { AttachmentStore } from './attachment-store.js';
import { registerV2MultimodalRoutes } from './routes/v2-multimodal.js';
import type { PublishService } from './publish-service.js';
import { registerPipenzoPublishRoutes } from './routes/pipenzo-publish.js';
import { PublishNonceGate } from './publish-nonce-gate.js';
import type { PipenzoPhaseService } from './pipenzo-phase-service.js';
import { registerPipenzoPhaseRoutes } from './routes/pipenzo-phases.js';
import type { PipenzoPhaseMachine } from './pipenzo-phase-machine.js';
import { registerPipenzoTicketRoutes } from './routes/pipenzo-tickets.js';
import type { PipenzoAuditStore } from './pipenzo-audit-store.js';
import { registerPipenzoMediumApprovalRoutes } from './routes/pipenzo-medium-approval.js';
import type { MediumApprovalStore } from './medium-approval-store.js';
import { registerPipenzoHighApprovalRoutes } from './routes/pipenzo-high-approval.js';
import type { HighApprovalStore } from './high-approval-store.js';
import { registerPipenzoStackApprovalRoutes } from './routes/pipenzo-stack-approval.js';
import type { StackApprovalStore } from './stack-approval-store.js';
import type { PipenzoPhaseEventBus } from './pipenzo-phase-events.js';
import type { PipenzoCrashRecovery } from './pipenzo-crash-recovery.js';
import { registerPipenzoRecoveryRoutes } from './routes/pipenzo-recovery.js';
import { registerPipenzoRepoRoutes } from './routes/pipenzo-repos.js';
import {
  registerPipenzoCheckoutRoutes,
  type RepoCheckoutResolver,
} from './routes/pipenzo-checkout.js';
import type { ConnectedReposStore } from './connected-repos-store.js';
import type { GitHubClient } from './github-client.js';
import { registerPipenzoLessonRoutes } from './routes/pipenzo-lessons.js';
import type { LessonStore } from './pipenzo-lesson-store.js';
import { registerPipenzoHealthRoutes, type PipenzoHealthSource } from './routes/pipenzo-health.js';
import type { DaemonGitHubCredential } from './github-credential.js';
import type { TicketWorktreeStorePort } from './pipenzo-worktree-lifecycle.js';
import { registerPipenzoConcurrencyRoutes } from './routes/pipenzo-concurrency.js';
import type { PipenzoConcurrencyStore } from './pipenzo-concurrency-store.js';
import type { PipenzoExecutionLimiter } from './pipenzo-execution-limiter.js';
import { registerPipenzoCaptureSettingsRoutes } from './routes/pipenzo-capture-settings.js';
import type { PipenzoCaptureSettingsStore } from './pipenzo-capture-settings-store.js';

export interface BuildServerOptions {
  registry: ProviderRegistry;
  sessionManager: SessionManager;
  token: string;
  logger: Logger;
  auditStore?: AuditStore;
  trustStore?: WorkspaceTrustStore;
  subagentStore?: SubagentGraphStore;
  worktreeManager?: OwnedWorktreeManager;
  attachmentStore?: AttachmentStore;
  /**
   * Pipenzo's publish gate (issue #178). Optional so a daemon built without it simply has no
   * publish route at all — the boundary's default is "cannot publish," not "publishes unless
   * configured otherwise."
   */
  publishService?: PublishService;
  /**
   * Issue #182's second factor. Optional the same way `publishService` is, but for the opposite
   * default: a `publishService` with no gate given here still registers the route behind
   * `PublishNonceGate.none()`, which refuses every request — never "the check is simply skipped."
   */
  publishNonceGate?: PublishNonceGate;
  /**
   * Pipenzo's Refine/Implement/Review phases and GitHub issue write ops (issue #184). Optional for
   * the same reason `publishService` is: a daemon built without it has no phase routes at all,
   * rather than routes that fail at call time.
   */
  phaseService?: PipenzoPhaseService;
  /** Pipenzo's phase machine (issue #188). Optional for the same reason `phaseService` is. */
  phaseMachine?: PipenzoPhaseMachine;
  /**
   * The phase-change stream (issue #189). Optional, and independently so: without it the two
   * ticket routes still serve, they just have no live counterpart, which is what a daemon built for
   * a route test wants.
   */
  phaseEvents?: PipenzoPhaseEventBus;
  /**
   * Terminal-state worktree cleanup (issue #159). Optional, and independently of `worktreeManager`:
   * without a ticket store the transition route has nowhere to read a ticket's recorded worktree id
   * back from, so it degrades to transitioning exactly as it did before this ticket, the same
   * "no dependency, no new behaviour" rule every other optional surface here follows.
   */
  ticketStore?: TicketWorktreeStorePort;
  /**
   * Issue #82's board drag-and-drop divergence audit, narrowed to just the `append` the ticket-
   * transition route calls -- the same store (and the same `Pick`) `PipenzoReconciler` already
   * writes a poll-found divergence to. Optional for the same reason every other Pipenzo surface is:
   * a daemon assembled without one still transitions tickets exactly as before, it just has nowhere
   * to record a drag that disagreed with what GitHub reported.
   */
  pipenzoAuditStore?: Pick<PipenzoAuditStore, 'append'>;
  /**
   * Crash recovery's parked set (issue #190). Optional for the same reason the rest of this surface
   * is: a daemon built without it has no recovery route at all, rather than one that answers with an
   * empty report a caller cannot distinguish from "nothing was interrupted".
   */
  crashRecovery?: PipenzoCrashRecovery;
  /**
   * The repo picker's two surfaces (issue #115). Both are needed together: the store answers what
   * was chosen, and the client answers what there was to choose from. A daemon assembled without a
   * GitHub credential leaves both out, and the routes simply do not exist.
   */
  connectedRepos?: ConnectedReposStore;
  pipenzoGitHubClient?: () => GitHubClient;
  /**
   * Connected repo -> managed local checkout (issues #342/#344). Registered only alongside
   * `connectedRepos`, because the route refuses anything not on that list -- without the list it
   * would have nothing to check a request against.
   */
  repoCheckouts?: RepoCheckoutResolver;
  /**
   * The GitHub connection-health stream (issue #257): the transport `PipenzoReconciler` (#231) left
   * for "the first banner to need it". Optional for the same reason every other Pipenzo surface is —
   * a daemon assembled without a reconciler has no health route at all, rather than one that answers
   * with a payload nobody produced.
   */
  pipenzoHealth?: PipenzoHealthSource;
  /**
   * The daemon's own GitHub credential, reported (not assumed) on `/health` (issue #209). Optional
   * for the same reason every other Pipenzo surface is: a daemon assembled without one just omits
   * `githubCredentialSource` from its `/health` response, rather than reporting a value nobody
   * resolved.
   */
  githubCredential?: DaemonGitHubCredential;
  /**
   * Local, human-gated lesson memory (issue #18): Settings' lesson-memory panel (issue #128).
   * Optional for the same reason every other Pipenzo surface is — a daemon assembled without one
   * has no lesson routes at all, rather than routes that fail at call time.
   */
  lessonStore?: LessonStore;
  /**
   * The MEDIUM inline approval flow's snapshot/decision store (issue #97). Optional for the same
   * reason every other Pipenzo surface is -- a daemon assembled without one, or without the
   * `phaseMachine`/`worktreeManager` it also needs, has no medium-approval routes at all, rather
   * than routes that fail at call time.
   */
  mediumApprovalStore?: MediumApprovalStore;
  /**
   * The HIGH full publish-gate card's own approval store (issue #98), the HIGH-risk sibling of
   * `mediumApprovalStore` above. Optional for the same reason: a daemon assembled without one, or
   * without the `phaseMachine`/`worktreeManager` it also needs, has no high-approval routes at all.
   */
  highApprovalStore?: HighApprovalStore;
  /**
   * The stack approval panel's own approval store (issue #99). Optional for the same reason
   * `highApprovalStore` is: a daemon assembled without one, or without the `phaseMachine`/
   * `phaseService` it also needs, has no stack-approval routes at all.
   */
  stackApprovalStore?: StackApprovalStore;
  /**
   * Bounded local concurrency's settings (Pipenzo issue #126): Settings' Concurrency panel. Both
   * optional, and only ever registered together -- the route has nothing to enforce a change
   * against without the live limiter, and nothing to persist a change to without the store. A
   * daemon assembled without either has no concurrency route at all, matching every other Pipenzo
   * surface's own convention.
   */
  concurrencyStore?: PipenzoConcurrencyStore;
  executionLimiter?: PipenzoExecutionLimiter;
  /**
   * The Models & gates screen's agent-captured panel (issue #470): the
   * `screenshotEnabled`/`escapeHatchEnabled` preference. Optional for the same reason every other
   * store-backed Pipenzo route is: a daemon assembled without one has no capture-settings route at
   * all, rather than one that fails at call time.
   */
  captureSettingsStore?: PipenzoCaptureSettingsStore;
}

/**
 * Builds (but does not start) the daemon's HTTP server.
 *
 * Local-auth model (see SECURITY.md): every route except /health requires
 * `Authorization: Bearer <token>` with the token generated at process startup and handed to the
 * desktop client out-of-band (a local file, not the network). No CORS headers are ever added, so
 * a browser page cannot read cross-origin responses even if it guessed the token; and because
 * `Authorization` is a non-simple header, any cross-origin browser request triggers a CORS
 * preflight that this server never approves, so the request is never even sent to a route
 * handler. The Origin check below is an additional, explicit layer on top of that.
 */
export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: false });
  const startedAt = Date.now();

  app.addHook('onRequest', async (req, reply) => {
    // AD-04: any Origin header at all is treated as browser-authored and rejected outright. A
    // non-browser client (curl, Electron main's own fetch, another local process) never sends
    // one. The previous version only recognized the literal `null` and `http(s)://` schemes, so a
    // `chrome-extension://` origin (or any other future scheme) fell straight through
    // unrecognized. There is no legitimate browser-originated caller of this API today: the
    // renderer talks to the daemon only through Electron main, never directly (see SECURITY.md),
    // so there's nothing to allowlist. An `AGENT_DOCK_ALLOWED_ORIGINS` escape hatch used to
    // exist for a hypothetical dev-server case, but nothing ever paired it with a real CORS
    // response header, so an allowlisted origin still couldn't complete a request; it was dead
    // configuration and has been removed rather than fixed, since nothing currently needs it.
    if (req.headers.origin !== undefined) {
      opts.logger.warn('rejected request carrying an Origin header', { method: req.method });
      reply.code(403).send(
        req.url.startsWith('/v2/')
          ? {
              error: 'browser-originated requests are not allowed',
              code: 'browser_origin_forbidden',
            }
          : { error: 'browser-originated requests are not allowed' },
      );
      return reply;
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    const provided = extractBearerToken(req.headers.authorization);
    if (!provided || !tokensMatch(opts.token, provided)) {
      reply
        .code(401)
        .send(
          req.url.startsWith('/v2/')
            ? { error: 'unauthorized', code: 'unauthorized' }
            : { error: 'unauthorized' },
        );
      return reply;
    }
  });

  app.register(rateLimit, { global: false });
  app.addContentTypeParser('application/octet-stream', (request, payload, done) =>
    done(null, payload),
  );

  registerHealthRoute(app, startedAt, opts.githubCredential);
  registerProviderRoutes(app, opts.registry);
  registerSessionRoutes(app, opts.sessionManager, opts.registry, opts.trustStore);
  registerV2ProviderRoutes(app, opts.registry);
  // Route-level limiter configuration is bound by @fastify/rate-limit's onRoute hook. Register
  // this route only after the plugin has booted so the hook sees it in this synchronous builder.
  app.after(() => {
    registerV2SessionRoutes(app, opts.sessionManager, opts.registry, opts.trustStore);
    if (opts.auditStore) registerV2AuditRoutes(app, opts.auditStore);
    if (opts.trustStore) {
      registerV2WorkspaceRoutes(app, opts.trustStore, opts.sessionManager);
      registerV2McpRoutes(app, opts.registry, opts.trustStore);
      registerV2ComponentRoutes(app, opts.registry, opts.trustStore);
    }
    registerV2AgentWorktreeRoutes(app, opts.subagentStore, opts.worktreeManager);
    if (opts.publishService)
      registerPipenzoPublishRoutes(app, opts.publishService, opts.publishNonceGate ?? PublishNonceGate.none());
    if (opts.phaseService) registerPipenzoPhaseRoutes(app, opts.phaseService);
    if (opts.phaseMachine)
      registerPipenzoTicketRoutes(
        app,
        opts.phaseMachine,
        opts.phaseEvents,
        opts.ticketStore && opts.worktreeManager
          ? { tickets: opts.ticketStore, worktrees: opts.worktreeManager }
          : undefined,
        opts.executionLimiter,
        opts.pipenzoAuditStore,
      );
    if (opts.phaseMachine && opts.worktreeManager && opts.mediumApprovalStore)
      registerPipenzoMediumApprovalRoutes(
        app,
        opts.phaseMachine,
        opts.worktreeManager,
        opts.mediumApprovalStore,
      );
    if (opts.phaseMachine && opts.worktreeManager && opts.highApprovalStore)
      registerPipenzoHighApprovalRoutes(
        app,
        opts.phaseMachine,
        opts.worktreeManager,
        opts.highApprovalStore,
      );
    if (opts.phaseMachine && opts.phaseService && opts.stackApprovalStore)
      registerPipenzoStackApprovalRoutes(
        app,
        opts.phaseMachine,
        opts.phaseService,
        opts.stackApprovalStore,
      );
    if (opts.crashRecovery) registerPipenzoRecoveryRoutes(app, opts.crashRecovery);
    if (opts.connectedRepos && opts.pipenzoGitHubClient)
      registerPipenzoRepoRoutes(app, opts.connectedRepos, opts.pipenzoGitHubClient);
    if (opts.connectedRepos && opts.repoCheckouts)
      registerPipenzoCheckoutRoutes(app, opts.connectedRepos, opts.repoCheckouts);
    if (opts.pipenzoHealth) registerPipenzoHealthRoutes(app, opts.pipenzoHealth);
    if (opts.lessonStore) registerPipenzoLessonRoutes(app, opts.lessonStore);
    if (opts.concurrencyStore && opts.executionLimiter)
      registerPipenzoConcurrencyRoutes(app, opts.concurrencyStore, opts.executionLimiter);
    if (opts.captureSettingsStore)
      registerPipenzoCaptureSettingsRoutes(app, opts.captureSettingsStore);
    if (opts.attachmentStore)
      registerV2MultimodalRoutes(app, opts.attachmentStore, opts.sessionManager);
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Fastify's own body-parsing errors (malformed JSON, payload-too-large, ...) carry a real
    // 4xx statusCode already. Preserving it (rather than flattening everything to 500) keeps
    // client-error semantics correct without risking leaking anything: these messages describe
    // the malformed request, never internal state. Anything without a 4xx statusCode is treated
    // as unexpected and sanitized to a generic 500, same as before.
    const statusCode =
      typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500
        ? err.statusCode
        : 500;

    if (statusCode >= 500) {
      opts.logger.error('unhandled route error', { method: req.method, statusCode });
      reply
        .code(500)
        .send(
          req.url.startsWith('/v2/')
            ? { error: 'internal server error', code: 'internal_error' }
            : { error: 'internal server error' },
        );
      return;
    }
    opts.logger.warn('client error', { method: req.method, statusCode });
    if (req.url.startsWith('/v2/')) {
      const isPayloadTooLarge = statusCode === 413;
      const isRateLimited = statusCode === 429;
      reply.code(statusCode).send({
        error: isPayloadTooLarge
          ? 'payload too large'
          : isRateLimited
            ? 'rate limit exceeded'
            : err.message,
        code: isPayloadTooLarge
          ? 'payload_too_large'
          : isRateLimited
            ? 'rate_limited'
            : 'invalid_request',
      });
      return;
    }
    reply.code(statusCode).send({ error: err.message });
  });

  app.setNotFoundHandler((req, reply) => {
    reply
      .code(404)
      .send(
        req.url.startsWith('/v2/')
          ? { error: 'not found', code: 'not_found' }
          : { error: 'not found' },
      );
  });

  return app;
}
