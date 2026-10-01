import {
  AGENT_DOCK_PROTOCOL_VERSION,
  AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS,
  agentCommandV2Schema,
  agentEventEnvelopeSchema,
  agentEventOrStreamErrorV2Schema,
  agentSessionSchema,
  agentSessionV2Schema,
  cancelSessionV2ResponseSchema,
  commandAcknowledgementV2Schema,
  createSessionRequestSchema,
  createSessionV2RequestSchema,
  healthResponseSchema,
  providerIdSchema,
  providerStatusSchema,
  providerStatusV2Schema,
  providersV2ResponseSchema,
  sessionContinuationInputV2Schema,
  sessionEventHistoryV2PageSchema,
  sessionEventHistoryV2QuerySchema,
  sessionIdParamSchema,
  sessionListV2PageSchema,
  sessionListV2QuerySchema,
  auditReadResponseV2Schema,
  workspaceInspectRequestV2Schema,
  workspaceTrustUpdateRequestV2Schema,
  workspaceTrustViewV2Schema,
  mcpCatalogV2Schema,
  mcpConfigureRequestV2Schema,
  mcpOAuthStartRequestV2Schema,
  mcpOAuthStatusV2Schema,
  mcpServerActionRequestV2Schema,
  mcpServerListV2Schema,
  mcpToolInvocationRequestV2Schema,
  mcpToolInvocationResultV2Schema,
  type AgentEventEnvelope,
  type AgentEventV2Envelope,
  type AgentCommandV2,
  type AgentSession,
  type AgentSessionV2,
  type AuditReadResponseV2,
  type CancelSessionV2Response,
  type CommandAcknowledgementV2,
  type CreateSessionRequest,
  type CreateSessionV2Request,
  type DaemonCredentialSourceV1,
  type ProviderId,
  type ProviderStatus,
  type ProviderStatusV2,
  type ProvidersV2Response,
  type SessionContinuationInputV2,
  type SessionEventHistoryV2Page,
  type SessionEventHistoryV2Query,
  type SessionListV2Page,
  type SessionListV2Query,
  type WorkspaceTrustUpdateRequestV2,
  type WorkspaceTrustViewV2,
  type McpCatalogV2,
  type McpConfigureRequestV2,
  type McpOAuthStatusV2,
  type McpServerActionRequestV2,
  type McpServerListV2,
  type McpToolInvocationRequestV2,
  type McpToolInvocationResultV2,
  providerComponentInvokeRequestV2Schema,
  providerComponentListRequestV2Schema,
  providerComponentListV2Schema,
  providerComponentManageRequestV2Schema,
  providerComponentOperationResultV2Schema,
  type ProviderComponentInvokeRequestV2,
  type ProviderComponentListRequestV2,
  type ProviderComponentListV2,
  type ProviderComponentManageRequestV2,
  type ProviderComponentOperationResultV2,
  ownedWorktreeListV2Schema,
  ownedWorktreeV2Schema,
  subagentControlRequestV2Schema,
  subagentControlResultV2Schema,
  subagentGraphV2Schema,
  worktreeCleanupRequestV2Schema,
  worktreeCreateRequestV2Schema,
  worktreePreviewRequestV2Schema,
  worktreePreviewV2Schema,
  type OwnedWorktreeV2,
  type SubagentControlRequestV2,
  type SubagentGraphV2,
  type WorktreeCreateRequestV2,
  type WorktreePreviewRequestV2,
  type WorktreePreviewV2,
  ATTACHMENT_LIMITS_V2,
  attachmentListV2Schema,
  attachmentMetadataV2Schema,
  attachmentReferenceRequestV2Schema,
  structuredWorkflowRequestV2Schema,
  structuredWorkflowResultV2Schema,
  type AttachmentMetadataV2,
  type StructuredWorkflowRequestV2,
  type StructuredWorkflowResultV2,
  PIPENZO_PUBLISH_NONCE_HEADER,
  pipenzoPublishRequestV1Schema,
  pipenzoPublishResultV1Schema,
  type PipenzoPublishRequestV1,
  type PipenzoPublishResultV1,
  pipenzoRefineRequestV1Schema,
  pipenzoRefineResultV1Schema,
  pipenzoImplementRequestV1Schema,
  pipenzoImplementResultV1Schema,
  pipenzoImplementResultQueryV1Schema,
  pipenzoImplementCommitsV1Schema,
  pipenzoImplementDiffRequestV1Schema,
  pipenzoImplementDiffResultV1Schema,
  pipenzoRunStatusRequestV1Schema,
  pipenzoRunStatusResultV1Schema,
  pipenzoSteerRequestV1Schema,
  pipenzoSteerResultV1Schema,
  pipenzoStopRequestV1Schema,
  pipenzoStopResultV1Schema,
  pipenzoRetryRequestV1Schema,
  pipenzoRetryResultV1Schema,
  pipenzoReviewRequestV1Schema,
  pipenzoReviewResultV1Schema,
  pipenzoIssueClaimRequestV1Schema,
  pipenzoIssueClaimResultV1Schema,
  pipenzoIssueCreateRequestV1Schema,
  pipenzoIssueCreateResultV1Schema,
  pipenzoIssueCommentRequestV1Schema,
  pipenzoIssueCommentResultV1Schema,
  pipenzoCaptureCapabilityRequestV1Schema,
  pipenzoCaptureCapabilityV1Schema,
  pipenzoIdeaDraftRequestV1Schema,
  pipenzoIdeaDraftResultV1Schema,
  pipenzoConnectReposRequestV1Schema,
  pipenzoConnectedReposV1Schema,
  pipenzoRepoListV1Schema,
  pipenzoRepoCheckoutRequestV1Schema,
  pipenzoRepoCheckoutResultV1Schema,
  pipenzoLessonListV1Schema,
  pipenzoLessonCreateV1Schema,
  pipenzoLessonDeleteRequestV1Schema,
  pipenzoConcurrencySettingsV1Schema,
  pipenzoConcurrencySettingsUpdateV1Schema,
  pipenzoCaptureSettingsV1Schema,
  pipenzoCaptureSettingsUpdateV1Schema,
  pipenzoNotificationSettingsV1Schema,
  pipenzoNotificationSettingsUpdateV1Schema,
  pipenzoTicketReadRequestV1Schema,
  pipenzoTicketTransitionRequestV1Schema,
  pipenzoTicketReconciliationV1Schema,
  pipenzoTicketListV1Schema,
  pipenzoTicketRiskActivityOpenedRequestV1Schema,
  pipenzoTicketRiskApprovalOutcomeRequestV1Schema,
  pipenzoTicketRiskResponseV1Schema,
  pipenzoMediumApprovalCaptureRequestV1Schema,
  pipenzoMediumApprovalCaptureResultV1Schema,
  pipenzoMediumApprovalDecideRequestV1Schema,
  pipenzoMediumApprovalDecideResultV1Schema,
  pipenzoMediumApprovalStatusRequestV1Schema,
  pipenzoMediumApprovalStatusResultV1Schema,
  pipenzoMediumApprovalUndoRequestV1Schema,
  pipenzoMediumApprovalUndoResultV1Schema,
  pipenzoHighApprovalCaptureRequestV1Schema,
  pipenzoHighApprovalCaptureResultV1Schema,
  pipenzoHighApprovalDecideRequestV1Schema,
  pipenzoHighApprovalDecideResultV1Schema,
  pipenzoStackApprovalCaptureRequestV1Schema,
  pipenzoStackApprovalCaptureResultV1Schema,
  pipenzoStackApprovalDecideRequestV1Schema,
  pipenzoStackApprovalDecideResultV1Schema,
  pipenzoPlanReviewCaptureRequestV1Schema,
  pipenzoPlanReviewCaptureResultV1Schema,
  pipenzoPlanReviewDecideRequestV1Schema,
  pipenzoPlanReviewDecideResultV1Schema,
  pipenzoPhaseEventOrStreamErrorV1Schema,
  pipenzoGitHubHealthV1Schema,
  type PipenzoGitHubHealthV1,
  type PipenzoRefineRequestV1,
  type PipenzoRefineResultV1,
  type PipenzoImplementRequestV1,
  type PipenzoImplementResultV1,
  type PipenzoImplementResultQueryV1,
  type PipenzoImplementCommitsV1,
  type PipenzoImplementDiffRequestV1,
  type PipenzoImplementDiffResultV1,
  type PipenzoRunStatusRequestV1,
  type PipenzoRunStatusResultV1,
  type PipenzoSteerRequestV1,
  type PipenzoSteerResultV1,
  type PipenzoStopRequestV1,
  type PipenzoStopResultV1,
  type PipenzoRetryRequestV1,
  type PipenzoRetryResultV1,
  type PipenzoReviewRequestV1,
  type PipenzoReviewResultV1,
  type PipenzoIssueClaimRequestV1,
  type PipenzoIssueClaimResultV1,
  type PipenzoIssueCreateRequestV1,
  type PipenzoIssueCreateResultV1,
  type PipenzoIssueCommentRequestV1,
  type PipenzoIssueCommentResultV1,
  type PipenzoCaptureCapabilityRequestV1,
  type PipenzoCaptureCapabilityV1,
  type PipenzoIdeaDraftRequestV1,
  type PipenzoIdeaDraftResultV1,
  type PipenzoConnectReposRequestV1,
  type PipenzoConnectedReposV1,
  type PipenzoRepoListV1,
  type PipenzoRepoCheckoutRequestV1,
  type PipenzoRepoCheckoutResultV1,
  type PipenzoLessonListV1,
  type PipenzoLessonCreateV1,
  type PipenzoLessonDeleteRequestV1,
  type PipenzoConcurrencySettingsV1,
  type PipenzoConcurrencySettingsUpdateV1,
  type PipenzoCaptureSettingsV1,
  type PipenzoCaptureSettingsUpdateV1,
  type PipenzoNotificationSettingsV1,
  type PipenzoNotificationSettingsUpdateV1,
  type PipenzoTicketReadRequestV1,
  type PipenzoTicketTransitionRequestV1,
  type PipenzoTicketReconciliationV1,
  type PipenzoTicketListV1,
  type PipenzoTicketRiskActivityOpenedRequestV1,
  type PipenzoTicketRiskApprovalOutcomeRequestV1,
  type PipenzoTicketRiskResponseV1,
  type PipenzoMediumApprovalCaptureRequestV1,
  type PipenzoMediumApprovalCaptureResultV1,
  type PipenzoMediumApprovalDecideRequestV1,
  type PipenzoMediumApprovalDecideResultV1,
  type PipenzoMediumApprovalStatusRequestV1,
  type PipenzoMediumApprovalStatusResultV1,
  type PipenzoMediumApprovalUndoRequestV1,
  type PipenzoMediumApprovalUndoResultV1,
  type PipenzoHighApprovalCaptureRequestV1,
  type PipenzoHighApprovalCaptureResultV1,
  type PipenzoHighApprovalDecideRequestV1,
  type PipenzoHighApprovalDecideResultV1,
  type PipenzoStackApprovalCaptureRequestV1,
  type PipenzoStackApprovalCaptureResultV1,
  type PipenzoStackApprovalDecideRequestV1,
  type PipenzoStackApprovalDecideResultV1,
  type PipenzoPlanReviewCaptureRequestV1,
  type PipenzoPlanReviewCaptureResultV1,
  type PipenzoPlanReviewDecideRequestV1,
  type PipenzoPlanReviewDecideResultV1,
  type PipenzoPhaseEventV1,
} from '@agent-dock/shared';
import {
  DaemonError,
  DaemonUnavailableError,
  ProtocolMismatchError,
  ProviderUnavailableError,
  SessionNotFoundError,
  UnauthorizedError,
  ValidationError,
  type AgentDockClientError,
} from './errors.js';
import { parseSseStream, type RuntimeSchema } from './sse.js';

export interface AgentDockClientOptions {
  /** e.g. `http://127.0.0.1:54321`, no trailing slash required. */
  baseUrl: string;
  token: string;
  /** Injectable for tests; defaults to the ambient global `fetch`. */
  fetch?: typeof fetch;
}

export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
  protocolVersion: number;
  supportedProtocolVersions?: readonly number[];
  /** The daemon's own report of its resolved GitHub credential source (issue #209). Absent from a
   * daemon built before this field existed. */
  githubCredentialSource?: DaemonCredentialSourceV1;
}

export interface SessionEventsOptions {
  signal?: AbortSignal;
  /** Resume from the SSE `id:` after this value, instead of a full replay from the start. */
  lastEventId?: string;
  /** Claims the sole interaction-responder stream for this session. Observers should omit it. */
  responder?: boolean;
}

export interface SessionRequestOptions {
  signal?: AbortSignal;
}

export interface PipenzoTicketEventsOptions {
  signal?: AbortSignal;
  /** Resume after this SSE `id:` (a phase-event `sequence`), instead of the retained window. */
  lastEventId?: string;
}

/**
 * No `lastEventId`, unlike `PipenzoTicketEventsOptions` -- the GitHub connection-health stream
 * (issue #257) has no cursor to resume from. It is a latest-value snapshot, not an event log: a
 * fresh connection is handed the current value immediately, so there is nothing a resume protocol
 * would add. See `apps/daemon/src/pipenzo-health-events.ts` for the full reasoning.
 */
export interface PipenzoGitHubHealthEventsOptions {
  signal?: AbortSignal;
}

export interface AuditReadOptions {
  cursor?: string;
  limit?: number;
  sessionId?: string;
}

export interface AttachmentUploadInput {
  fileName: string;
  size: number;
  stream: unknown;
  sessionId?: string;
}

export type SessionListV2Options = SessionListV2Query;
export type SessionEventHistoryV2Options = SessionEventHistoryV2Query;

/** `worktreeCleanupRequestV2Schema`'s two opt-in flags (issue #117), without the `worktreeId`
 * this method already takes as its own parameter -- see `v2.worktrees.cleanup`. */
export interface WorktreeCleanupOptions {
  deleteUntracked?: boolean;
  deleteBranch?: boolean;
}

interface CompatibilityResult {
  health: HealthResponse;
  daemonVersions: readonly number[];
  selectedProtocolVersion: number;
}

const PROTOCOL_V2 = 2;
/** Mirrors the daemon's per-envelope ceiling (session-manager.ts's `MAX_LEGACY_EVENT_ENVELOPE_BYTES`);
 * a v1 session that emits an oversized envelope fails itself server-side rather than ever putting
 * one on the wire, so this is defense in depth against a daemon that doesn't. */
const MAX_V1_SSE_FRAME_BYTES = 1024 * 1024;
const MAX_V2_SSE_FRAME_BYTES = 1024 * 1024;
const RESPONDER_LEASE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_SUPPORTED_PROTOCOL_VERSIONS: readonly number[] =
  AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS;

/**
 * Typed client for the AgentDock daemon's HTTP + SSE APIs. Owns everything a caller shouldn't
 * have to hand-write: the daemon URL, the bearer token, JSON request/response handling,
 * incremental SSE parsing, and protocol-version negotiation performed automatically before the
 * first real request. The top-level namespaces are the frozen v1 API; `v2` uses `/v2` routes.
 * See docs/protocol-v1.md and docs/protocol-v2.md.
 *
 * No reconnect logic: `sessions.events()` opens exactly one stream and ends when the daemon
 * closes it (at the session's terminal event) or `signal` aborts. If the connection drops for any
 * other reason, the generator throws: call `sessions.events()` again to resume; because the
 * daemon replays its full stored event history to a fresh subscriber (or from `lastEventId`
 * onward), a bare retry is a complete, correct "reconnect" with no separate resume protocol needed.
 */
export class AgentDockClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private compatibilityCheck: Promise<CompatibilityResult> | undefined;
  private readonly responderLeases = new Map<string, string>();

  readonly providers = {
    list: (): Promise<ProviderStatus[]> => this.listProviders(),
    get: (id: ProviderId): Promise<ProviderStatus> => this.getProvider(id),
  };

  readonly sessions = {
    create: (input: CreateSessionRequest): Promise<AgentSession> => this.createSession(input),
    get: (id: string): Promise<AgentSession> => this.getSession(id),
    events: (
      id: string,
      options?: SessionEventsOptions,
    ): AsyncGenerator<AgentEventEnvelope, void, void> => this.streamSessionEvents(id, options),
    cancel: (id: string): Promise<void> => this.cancelSession(id),
    delete: (id: string): Promise<void> => this.deleteSession(id),
    /** Cancels every in-flight protocol-v1 session on the daemon. Used by the desktop shutdown path so
     * quitting the app doesn't orphan any session besides the one it happens to be tracking,
     * see electron/main.ts#killDaemon. */
    cancelAll: (options?: SessionRequestOptions): Promise<void> => this.cancelAllSessions(options),
  };

  /** Protocol-v2 routes. The existing top-level namespaces remain protocol v1. */
  readonly v2 = {
    providers: {
      list: (): Promise<ProviderStatusV2[]> => this.listProvidersV2(),
      get: (id: ProviderId): Promise<ProviderStatusV2> => this.getProviderV2(id),
    },
    sessions: {
      create: (
        input: CreateSessionV2Request,
        options?: SessionRequestOptions,
      ): Promise<AgentSessionV2> => this.createSessionV2(input, options),
      list: (options?: SessionListV2Options): Promise<SessionListV2Page> =>
        this.listSessionsV2(options),
      get: (id: string): Promise<AgentSessionV2> => this.getSessionV2(id),
      history: (
        id: string,
        options?: SessionEventHistoryV2Options,
      ): Promise<SessionEventHistoryV2Page> => this.getSessionEventHistoryV2(id, options),
      resume: (
        parentSessionId: string,
        input: SessionContinuationInputV2,
        options?: SessionRequestOptions,
      ): Promise<AgentSessionV2> =>
        this.continueSessionV2(parentSessionId, 'resume', input, options),
      fork: (
        parentSessionId: string,
        input: SessionContinuationInputV2,
        options?: SessionRequestOptions,
      ): Promise<AgentSessionV2> => this.continueSessionV2(parentSessionId, 'fork', input, options),
      events: (
        id: string,
        options?: SessionEventsOptions,
      ): AsyncGenerator<AgentEventV2Envelope, void, void> =>
        this.streamSessionEventsV2(id, options),
      send: (command: AgentCommandV2): Promise<CommandAcknowledgementV2> =>
        this.sendSessionCommandV2(command),
      cancel: (id: string, options?: SessionRequestOptions): Promise<CancelSessionV2Response> =>
        this.cancelSessionV2(id, options),
      delete: (id: string): Promise<void> => this.deleteSessionV2(id),
    },
    workspaces: {
      inspect: (cwd: string): Promise<WorkspaceTrustViewV2> => this.inspectWorkspaceV2(cwd),
      setTrust: (
        workspaceId: string,
        input: WorkspaceTrustUpdateRequestV2,
      ): Promise<WorkspaceTrustViewV2> => this.setWorkspaceTrustV2(workspaceId, input),
    },
    audit: {
      list: (options?: AuditReadOptions): Promise<AuditReadResponseV2> => this.readAuditV2(options),
    },
    agents: {
      graph: (sessionId: string): Promise<SubagentGraphV2> => this.getSubagentGraphV2(sessionId),
      control: (input: SubagentControlRequestV2) => this.controlSubagentV2(input),
    },
    worktrees: {
      preview: (input: WorktreePreviewRequestV2): Promise<WorktreePreviewV2> => this.previewWorktreeV2(input),
      create: (input: WorktreeCreateRequestV2): Promise<OwnedWorktreeV2> => this.createWorktreeV2(input),
      list: (): Promise<OwnedWorktreeV2[]> => this.listWorktreesV2(),
      cleanup: (
        worktreeId: string,
        options?: WorktreeCleanupOptions,
      ): Promise<OwnedWorktreeV2> => this.cleanupWorktreeV2(worktreeId, options),
    },
    attachments: {
      upload: (input: AttachmentUploadInput): Promise<AttachmentMetadataV2> => this.uploadAttachmentV2(input),
      list: (): Promise<AttachmentMetadataV2[]> => this.listAttachmentsV2(),
      reference: (attachmentIds: string[], sessionId: string): Promise<AttachmentMetadataV2[]> => this.referenceAttachmentsV2(attachmentIds, sessionId),
    },
    structured: {
      validate: (input: StructuredWorkflowRequestV2): Promise<StructuredWorkflowResultV2> => this.validateStructuredWorkflowV2(input),
    },
    /**
     * Pipenzo's publish gate (issue #178). The one route this client speaks that can push a
     * branch or open a pull request — never call it except in direct response to a human clicking
     * "Push branch" or "Push & open PR" (see `apps/daemon/src/routes/pipenzo-publish.ts`'s module
     * comment). Errors surface as `DaemonError` with the daemon's own closed `code` union
     * (`uncommitted_changes`, `push_rejected`, `publish_busy`, ...) via the generic
     * `fetchAuthenticated` error path — no route-specific error handling needed here.
     *
     * `nonce` (issue #182) is required, not optional: the caller must mint one with
     * `mintPublishNonce`, from the same secret the daemon was handed over stdin, in direct
     * response to that same click — never ahead of time, never reused. Its own doc comment in
     * `@agent-dock/shared`'s `publish-nonce-v1.ts` explains why it travels as a header rather than
     * a body field.
     */
    pipenzo: {
      publish: (input: PipenzoPublishRequestV1, nonce: string): Promise<PipenzoPublishResultV1> =>
        this.publishPipenzoV1(input, nonce),
      /**
       * The three phases and the two GitHub issue write ops (issue #184).
       *
       * Every one of these addresses a worktree by id, never by path, exactly as `publish` does:
       * `implement` answers with a worktree id and a session id, and `review` takes a worktree id.
       * The daemon resolves ids to directories on its own side of the boundary, so this client
       * has no way to name a directory for the daemon to work in.
       */
      refine: (input: PipenzoRefineRequestV1): Promise<PipenzoRefineResultV1> =>
        this.refinePipenzoV1(input),
      implement: (input: PipenzoImplementRequestV1): Promise<PipenzoImplementResultV1> =>
        this.implementPipenzoV1(input),
      implementResult: (
        input: PipenzoImplementResultQueryV1,
      ): Promise<PipenzoImplementCommitsV1> => this.implementResultPipenzoV1(input),
      /** The unified diff for a commit range already known to exist in an owned worktree (issue
       * #90's stack, step 2) -- what `DiffFileList.tsx` renders. */
      implementDiff: (
        input: PipenzoImplementDiffRequestV1,
      ): Promise<PipenzoImplementDiffResultV1> => this.implementDiffPipenzoV1(input),
      review: (input: PipenzoReviewRequestV1): Promise<PipenzoReviewResultV1> =>
        this.reviewPipenzoV1(input),
      /**
       * Steer/Stop for a ticket's dispatched Implement session (issue #103), addressed by ticket
       * id only -- the daemon resolves which session that is and whether it is genuinely live
       * right now, never a session or worktree id this client could get out of date.
       */
      runStatus: (input: PipenzoRunStatusRequestV1): Promise<PipenzoRunStatusResultV1> =>
        this.runStatusPipenzoV1(input),
      steer: (input: PipenzoSteerRequestV1): Promise<PipenzoSteerResultV1> =>
        this.steerPipenzoV1(input),
      stop: (input: PipenzoStopRequestV1): Promise<PipenzoStopResultV1> => this.stopPipenzoV1(input),
      /** "Retry phase" (issue #105): classified retry for a ticket parked on
       *  `pipenzo:needs-human`, addressed by ticket id only -- same reasoning as Steer/Stop above. */
      retry: (input: PipenzoRetryRequestV1): Promise<PipenzoRetryResultV1> =>
        this.retryPipenzoV1(input),
      claimIssue: (input: PipenzoIssueClaimRequestV1): Promise<PipenzoIssueClaimResultV1> =>
        this.claimPipenzoIssueV1(input),
      createIssue: (input: PipenzoIssueCreateRequestV1): Promise<PipenzoIssueCreateResultV1> =>
        this.createPipenzoIssueV1(input),
      /**
       * Posts one comment on an issue (issue #228), for #100's refusal panel and #144's
       * blown-estimate record. Not retried anywhere in this client: GitHub has no idempotency key
       * for a comment, so a retry posts a second one.
       */
      commentOnIssue: (
        input: PipenzoIssueCommentRequestV1,
      ): Promise<PipenzoIssueCommentResultV1> => this.commentOnPipenzoIssueV1(input),
      /**
       * What screenshot verification would actually do for a repository right now (issue #124).
       * A real probe on the daemon side, not a settings read.
       */
      captureCapabilities: (
        input: PipenzoCaptureCapabilityRequestV1,
      ): Promise<PipenzoCaptureCapabilityV1> => this.pipenzoCaptureCapabilitiesV1(input),
      /** Free text in, a structured draft out (issue #84). Creates nothing. */
      draftIssue: (input: PipenzoIdeaDraftRequestV1): Promise<PipenzoIdeaDraftResultV1> =>
        this.draftPipenzoIssueV1(input),
      /**
       * The repo picker (issue #115).
       *
       * `listRepos` is what this credential can *write* to — the daemon filters on GitHub's own
       * `permissions.push`, since a repository Pipenzo can only read is one it can never manage.
       * It costs real quota (up to fifty paginated requests), so it is a first-run and settings
       * action rather than something to poll.
       *
       * `connectRepos` replaces the whole list rather than adding to it: the writer is a set of
       * checkboxes, and unticking one has to mean something.
       */
      listRepos: (): Promise<PipenzoRepoListV1> => this.listPipenzoReposV1(),
      connectedRepos: (): Promise<PipenzoConnectedReposV1> => this.connectedPipenzoReposV1(),
      connectRepos: (input: PipenzoConnectReposRequestV1): Promise<PipenzoConnectedReposV1> =>
        this.connectPipenzoReposV1(input),
      /**
       * A connected repository's managed local checkout (issues #342/#344) -- the
       * `repositoryPath` refine and implement need. Clones on first call, so it can take as long as
       * a clone does; later calls are a local check. Refused for anything not on the connected
       * list.
       */
      resolveCheckout: (
        input: PipenzoRepoCheckoutRequestV1,
      ): Promise<PipenzoRepoCheckoutResultV1> => this.resolvePipenzoCheckoutV1(input),
      /**
       * Local, human-gated lesson memory (issue #18): `lessons`/`deleteLesson` back Settings' panel
       * (issue #128); `createLesson` is `LessonPrompt`'s "Save lesson" button (issue #104). All
       * three are a local read/write with no GitHub cost behind them.
       */
      lessons: (): Promise<PipenzoLessonListV1> => this.pipenzoLessonsV1(),
      createLesson: (input: PipenzoLessonCreateV1): Promise<PipenzoLessonListV1> =>
        this.createPipenzoLessonV1(input),
      deleteLesson: (input: PipenzoLessonDeleteRequestV1): Promise<PipenzoLessonListV1> =>
        this.deletePipenzoLessonV1(input),
      /**
       * Bounded local concurrency's settings (issue #126): Settings' Concurrency panel.
       * `concurrencySettings` reads the workspace's execution-limit / run-budget values;
       * `updateConcurrencySettings` changes one or both and takes effect immediately -- the daemon
       * updates its live enforcement the moment the write lands, not on next restart.
       */
      concurrencySettings: (): Promise<PipenzoConcurrencySettingsV1> =>
        this.pipenzoConcurrencySettingsV1(),
      updateConcurrencySettings: (
        input: PipenzoConcurrencySettingsUpdateV1,
      ): Promise<PipenzoConcurrencySettingsV1> => this.updatePipenzoConcurrencySettingsV1(input),
      /**
       * The Models & gates screen's agent-captured panel (issue #470): `captureSettings` reads the
       * workspace's `screenshotEnabled`/`escapeHatchEnabled` preference;
       * `updateCaptureSettings` changes one or both and answers with the daemon's own confirmed
       * record, never an echo of the request.
       */
      captureSettings: (): Promise<PipenzoCaptureSettingsV1> => this.pipenzoCaptureSettingsV1(),
      updateCaptureSettings: (
        input: PipenzoCaptureSettingsUpdateV1,
      ): Promise<PipenzoCaptureSettingsV1> => this.updatePipenzoCaptureSettingsV1(input),
      /**
       * Settings' Notifications panel (issue #129): `notificationSettings` reads the workspace's
       * `refusal`/`medium`/`badge`/`sound` preferences; `updateNotificationSettings` changes one or
       * more and answers with the daemon's own confirmed record, never an echo of the request.
       * There is no `high` preference to read or write -- see `pipenzo-notification-settings-v1.ts`.
       */
      notificationSettings: (): Promise<PipenzoNotificationSettingsV1> =>
        this.pipenzoNotificationSettingsV1(),
      updateNotificationSettings: (
        input: PipenzoNotificationSettingsUpdateV1,
      ): Promise<PipenzoNotificationSettingsV1> => this.updatePipenzoNotificationSettingsV1(input),
      /**
       * The phase machine's ticket surface (issue #188). `readTicket` reconciles a ticket against
       * its issue's labels and returns the result; `transitionTicket` writes a new `pipenzo:` label
       * to GitHub first, then reconciles the same way `readTicket` does. In both cases the label is
       * authoritative for the lane — see `pipenzo-phase-machine-v1.ts` and
       * `apps/daemon/src/pipenzo-phase-machine.ts` for why a transition names a label rather than a
       * lane, and why divergence between the two stores resolves in the label's favour.
       */
      readTicket: (
        input: PipenzoTicketReadRequestV1,
      ): Promise<PipenzoTicketReconciliationV1> => this.readPipenzoTicketV1(input),
      transitionTicket: (
        input: PipenzoTicketTransitionRequestV1,
      ): Promise<PipenzoTicketReconciliationV1> => this.transitionPipenzoTicketV1(input),
      /**
       * The board's list route (issue #255): every ticket the daemon's local store knows about,
       * already label-wins reconciled by the polling reconciler (#231) rather than triggering one
       * live GitHub read per ticket. See `apps/daemon/src/routes/pipenzo-tickets.ts`'s module
       * comment for why this is now affordable in a way it deliberately was not before that
       * reconciler existed.
       */
      listTickets: (): Promise<PipenzoTicketListV1> => this.listPipenzoTicketsV1(),
      /**
       * Records a human's Allow/Reject outcome for a MEDIUM- or HIGH-graded action against the
       * cumulative risk score (issues #95/#97/#98). See `risk-score.ts`'s own doc comment for the
       * asymmetric reset rule: HIGH resets, MEDIUM deliberately does not.
       */
      recordRiskApprovalOutcome: (
        input: PipenzoTicketRiskApprovalOutcomeRequestV1,
      ): Promise<PipenzoTicketRiskResponseV1> => this.recordPipenzoRiskApprovalOutcomeV1(input),
      /**
       * The reset rule's other half (issue #119): opening the ticket's Activity view always resets
       * the cumulative risk score to zero, unconditionally -- see `risk-score.ts`'s
       * `recordActivityOpened` for why there is no "opened but doesn't count" case.
       */
      recordRiskActivityOpened: (
        input: PipenzoTicketRiskActivityOpenedRequestV1,
      ): Promise<PipenzoTicketRiskResponseV1> => this.recordPipenzoRiskActivityOpenedV1(input),
      /**
       * The MEDIUM inline approval flow (issue #97) -- see `pipenzo-medium-approval-v1.ts`'s module
       * comment for why capture and decide are two separate calls, and `undo-snapshot.ts`'s for why
       * expiry is commit-based rather than time-based.
       */
      captureMediumApproval: (
        input: PipenzoMediumApprovalCaptureRequestV1,
      ): Promise<PipenzoMediumApprovalCaptureResultV1> => this.captureMediumApprovalV1(input),
      decideMediumApproval: (
        input: PipenzoMediumApprovalDecideRequestV1,
      ): Promise<PipenzoMediumApprovalDecideResultV1> => this.decideMediumApprovalV1(input),
      mediumApprovalStatus: (
        input: PipenzoMediumApprovalStatusRequestV1,
      ): Promise<PipenzoMediumApprovalStatusResultV1> => this.mediumApprovalStatusV1(input),
      undoMediumApproval: (
        input: PipenzoMediumApprovalUndoRequestV1,
      ): Promise<PipenzoMediumApprovalUndoResultV1> => this.undoMediumApprovalV1(input),
      /**
       * The HIGH full publish-gate card (issue #98), the HIGH-risk sibling of the MEDIUM calls
       * above -- see `pipenzo-high-approval-v1.ts`'s module comment for why there is no
       * status/undo pair here (HIGH never offers Undo, full stop).
       */
      captureHighApproval: (
        input: PipenzoHighApprovalCaptureRequestV1,
      ): Promise<PipenzoHighApprovalCaptureResultV1> => this.captureHighApprovalV1(input),
      decideHighApproval: (
        input: PipenzoHighApprovalDecideRequestV1,
      ): Promise<PipenzoHighApprovalDecideResultV1> => this.decideHighApprovalV1(input),
      captureStackApproval: (
        input: PipenzoStackApprovalCaptureRequestV1,
      ): Promise<PipenzoStackApprovalCaptureResultV1> => this.captureStackApprovalV1(input),
      decideStackApproval: (
        input: PipenzoStackApprovalDecideRequestV1,
      ): Promise<PipenzoStackApprovalDecideResultV1> => this.decideStackApprovalV1(input),
      /**
       * The plan-review gate (issue #15, UI half #101) -- see `pipenzo-plan-review-v1.ts`'s module
       * comment for why capture and decide are two separate calls, and why `decide` takes three
       * decisions where stack approval's own takes two.
       */
      capturePlanReview: (
        input: PipenzoPlanReviewCaptureRequestV1,
      ): Promise<PipenzoPlanReviewCaptureResultV1> => this.capturePlanReviewV1(input),
      decidePlanReview: (
        input: PipenzoPlanReviewDecideRequestV1,
      ): Promise<PipenzoPlanReviewDecideResultV1> => this.decidePlanReviewV1(input),
      /**
       * The phase-change stream (issue #189): one daemon-wide stream carrying every ticket's
       * transitions, so a board needs one connection rather than one per card.
       *
       * No reconnect logic, exactly like `sessions.events()`: this opens one stream and the
       * generator ends or throws when it closes. Pass the last `sequence` you saw back as
       * `lastEventId` to resume from a cursor; the daemon refuses a cursor older than its bounded
       * window rather than replaying a truncated history, so treat that refusal as "resync from a
       * fresh read" instead of retrying the same cursor.
       */
      ticketEvents: (
        options?: PipenzoTicketEventsOptions,
      ): AsyncGenerator<PipenzoPhaseEventV1, void, void> => this.streamPipenzoTicketEventsV1(options),
      /**
       * The GitHub connection-health stream (issue #257): one daemon-wide latest-value stream for
       * `PipenzoGitHubHealthV1` (#230), which #70/#71/#72/#73/#75's banners render.
       *
       * No reconnect logic and no `lastEventId`, unlike `ticketEvents` above: this is not an event
       * log, so there is no cursor to resume from. The daemon sends the current value the instant a
       * connection opens, so a bare retry after any drop is a complete "reconnect" on its own.
       */
      githubHealthEvents: (
        options?: PipenzoGitHubHealthEventsOptions,
      ): AsyncGenerator<PipenzoGitHubHealthV1, void, void> =>
        this.streamPipenzoGitHubHealthEventsV1(options),
      /**
       * "Retry now" / "Poll now" (#70/#71/#75): forces the reconciler's next tick to run
       * immediately instead of waiting out its current interval or backoff delay.
       *
       * Fire-and-forget by design -- the daemon answers as soon as it has accepted the request, not
       * once the triggered tick finishes, and the result of that tick reaches this client through
       * `githubHealthEvents` above rather than through this call's own response.
       */
      pollGitHubHealthNow: (options?: SessionRequestOptions): Promise<void> =>
        this.pollPipenzoGitHubHealthV1(options),
    },
    integrations: {
      mcp: {
        list: (provider: ProviderId, cwd: string): Promise<McpServerListV2> =>
          this.listMcpServersV2(provider, cwd),
        configure: (input: McpConfigureRequestV2): Promise<McpServerListV2> =>
          this.configureMcpV2(input),
        action: (input: McpServerActionRequestV2): Promise<McpServerListV2> =>
          this.actionMcpV2(input),
        catalog: (provider: ProviderId, serverId: string, cwd: string): Promise<McpCatalogV2> =>
          this.getMcpCatalogV2(provider, serverId, cwd),
        oauth: (provider: ProviderId, serverId: string, cwd: string): Promise<McpOAuthStatusV2> =>
          this.startMcpOAuthV2(provider, serverId, cwd),
        invoke: (input: McpToolInvocationRequestV2): Promise<McpToolInvocationResultV2> =>
          this.invokeMcpToolV2(input),
      },
      components: {
        list: (input: ProviderComponentListRequestV2): Promise<ProviderComponentListV2> =>
          this.listProviderComponentsV2(input),
        manage: (input: ProviderComponentManageRequestV2): Promise<ProviderComponentOperationResultV2> =>
          this.manageProviderComponentV2(input),
        invoke: (input: ProviderComponentInvokeRequestV2): Promise<ProviderComponentOperationResultV2> =>
          this.invokeProviderComponentV2(input),
      },
    },
  };

  constructor(options: AgentDockClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Checks the daemon is reachable and protocol-compatible. Also the check every other method runs before its own request. */
  async health(): Promise<HealthResponse> {
    return (await this.ensureCompatible()).health;
  }

  private ensureCompatible(): Promise<CompatibilityResult> {
    if (!this.compatibilityCheck) {
      this.compatibilityCheck = this.checkCompatibility().catch((err: unknown) => {
        // Don't let a transient failure (daemon still starting up, briefly unreachable) poison
        // every future call: the next one gets a fresh check.
        this.compatibilityCheck = undefined;
        throw err;
      });
    }
    return this.compatibilityCheck;
  }

  private async checkCompatibility(): Promise<CompatibilityResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/health`);
    } catch (err) {
      throw new DaemonUnavailableError(
        `could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`,
        {
          cause: err,
        },
      );
    }
    if (!res.ok) {
      throw new DaemonUnavailableError(`daemon health check failed with status ${res.status}`);
    }
    const json = await res.json().catch(() => undefined);
    const parsed = healthResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ValidationError(
        `daemon /health response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    const daemonVersions = parsed.data.supportedProtocolVersions ?? [parsed.data.protocolVersion];
    const sharedVersions = CLIENT_SUPPORTED_PROTOCOL_VERSIONS.filter((version) =>
      daemonVersions.includes(version),
    );
    if (sharedVersions.length === 0) {
      throw new ProtocolMismatchError(
        highestVersion(CLIENT_SUPPORTED_PROTOCOL_VERSIONS),
        highestVersion(daemonVersions),
      );
    }
    return {
      health: parsed.data,
      daemonVersions,
      selectedProtocolVersion: highestVersion(sharedVersions),
    };
  }

  private async ensureProtocolVersion(version: number): Promise<CompatibilityResult> {
    const compatibility = await this.ensureCompatible();
    const available =
      version === AGENT_DOCK_PROTOCOL_VERSION
        ? compatibility.daemonVersions.includes(version)
        : compatibility.selectedProtocolVersion === version;
    if (!available) {
      throw new ProtocolMismatchError(version, highestVersion(compatibility.daemonVersions));
    }
    return compatibility;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    opts: { notFound?: () => AgentDockClientError } = {},
  ): Promise<T> {
    const res = await this.fetchAuthenticated(AGENT_DOCK_PROTOCOL_VERSION, path, init, opts);

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async fetchAuthenticated(
    protocolVersion: number,
    path: string,
    init: RequestInit = {},
    opts: { notFound?: () => AgentDockClientError; notFoundCode?: string } = {},
  ): Promise<Response> {
    await this.ensureProtocolVersion(protocolVersion);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      throw new DaemonUnavailableError(
        `could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`,
        {
          cause: err,
        },
      );
    }

    if (res.status === 401) throw new UnauthorizedError();

    let body: unknown;
    let bodyRead = false;
    if (res.status === 404 && opts.notFound) {
      if (opts.notFoundCode === undefined) throw opts.notFound();
      body = await res.json().catch(() => undefined);
      bodyRead = true;
      if (daemonErrorCode(body) === opts.notFoundCode) throw opts.notFound();
    }

    if (!res.ok) {
      if (!bodyRead) body = await res.json().catch(() => undefined);
      const message = daemonErrorMessage(body) ?? `daemon request failed with status ${res.status}`;
      if (res.status === 400) throw new ValidationError(message);
      throw new DaemonError(message, res.status, daemonErrorCode(body), daemonErrorDetails(body));
    }
    return res;
  }

  private async listProviders(): Promise<ProviderStatus[]> {
    const body = await this.request<{ providers: unknown[] }>('/providers');
    return body.providers.map((raw) => validate(providerStatusSchema, raw, 'provider status'));
  }

  private async getProvider(id: ProviderId): Promise<ProviderStatus> {
    const raw = await this.request<unknown>(`/providers/${encodeURIComponent(id)}`, undefined, {
      notFound: () => new ProviderUnavailableError(`provider not registered: ${id}`),
    });
    return validate(providerStatusSchema, raw, 'provider status');
  }

  private async createSession(input: CreateSessionRequest): Promise<AgentSession> {
    createSessionRequestSchema.parse(input); // fail fast client-side before ever making the request
    const raw = await this.request<unknown>('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return validate(agentSessionSchema, raw, 'session');
  }

  private async getSession(id: string): Promise<AgentSession> {
    const raw = await this.request<unknown>(`/sessions/${encodeURIComponent(id)}`, undefined, {
      notFound: () => new SessionNotFoundError(id),
    });
    return validate(agentSessionSchema, raw, 'session');
  }

  private async *streamSessionEvents(
    id: string,
    options: SessionEventsOptions = {},
  ): AsyncGenerator<AgentEventEnvelope, void, void> {
    await this.ensureProtocolVersion(AGENT_DOCK_PROTOCOL_VERSION);

    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (options.lastEventId) headers['Last-Event-ID'] = options.lastEventId;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(id)}/events`, {
        headers,
        signal: options.signal,
      });
    } catch (err) {
      if (options.signal?.aborted) return; // caller cancelled before/while connecting; not an error
      throw new DaemonUnavailableError(
        `could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`,
        {
          cause: err,
        },
      );
    }

    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 404) throw new SessionNotFoundError(id);
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new DaemonError(
        body.error ?? `failed to open event stream (status ${res.status})`,
        res.status,
      );
    }

    yield* parseSseStream(res.body, {
      schema: agentEventEnvelopeSchema,
      label: 'AgentEvent v1',
      signal: options.signal,
      maxFrameBytes: MAX_V1_SSE_FRAME_BYTES,
    });
  }

  private async cancelSession(id: string): Promise<void> {
    await this.request<unknown>(
      `/sessions/${encodeURIComponent(id)}/cancel`,
      { method: 'POST' },
      { notFound: () => new SessionNotFoundError(id) },
    );
  }

  private async deleteSession(id: string): Promise<void> {
    await this.request<void>(
      `/sessions/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      { notFound: () => new SessionNotFoundError(id) },
    );
  }

  private async cancelAllSessions(options: SessionRequestOptions = {}): Promise<void> {
    await this.request<unknown>('/sessions/cancel-all', {
      method: 'POST',
      signal: options.signal,
    });
  }

  private async requestV2<T>(
    path: string,
    schema: RuntimeSchema<T>,
    label: string,
    init: RequestInit = {},
    opts: {
      expectedStatus: number;
      notFound?: () => AgentDockClientError;
      notFoundCode?: string;
    },
  ): Promise<T> {
    const res = await this.fetchAuthenticated(PROTOCOL_V2, path, init, opts);
    if (res.status !== opts.expectedStatus) {
      throw new ValidationError(
        `daemon returned status ${res.status} for ${label}; protocol v2 requires ${opts.expectedStatus}`,
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new ValidationError(
        `daemon returned malformed JSON for ${label}: ${errorMessage(err)}`,
      );
    }
    return validate(schema, json, label);
  }

  private async requestV2NoContent(
    path: string,
    init: RequestInit,
    opts: { notFound?: () => AgentDockClientError } = {},
  ): Promise<void> {
    const res = await this.fetchAuthenticated(PROTOCOL_V2, path, init, opts);
    if (res.status !== 204) {
      throw new ValidationError(
        `daemon returned status ${res.status}; protocol v2 requires 204 with no content`,
      );
    }
  }

  private async listProvidersV2(): Promise<ProviderStatusV2[]> {
    const body: ProvidersV2Response = await this.requestV2(
      '/v2/providers',
      providersV2ResponseSchema,
      'protocol-v2 provider list',
      {},
      { expectedStatus: 200 },
    );
    return body.providers;
  }

  private async getProviderV2(id: ProviderId): Promise<ProviderStatusV2> {
    const providerId = validateInput(providerIdSchema, id, 'protocol-v2 provider id');
    return this.requestV2(
      `/v2/providers/${encodeURIComponent(providerId)}`,
      providerStatusV2Schema,
      'protocol-v2 provider status',
      {},
      {
        expectedStatus: 200,
        notFound: () => new ProviderUnavailableError(`provider not registered: ${providerId}`),
      },
    );
  }

  private async listMcpServersV2(provider: ProviderId, cwd: string): Promise<McpServerListV2> {
    const providerId = validateInput(providerIdSchema, provider, 'MCP provider id');
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 32_768) {
      throw new ValidationError('MCP workspace path is invalid');
    }
    const query = new URLSearchParams({ provider: providerId, cwd });
    return this.requestV2(
      `/v2/integrations/mcp?${query.toString()}`,
      mcpServerListV2Schema,
      'protocol-v2 MCP server list',
      {},
      { expectedStatus: 200 },
    );
  }

  private async configureMcpV2(input: McpConfigureRequestV2): Promise<McpServerListV2> {
    const parsed = validateInput(mcpConfigureRequestV2Schema, input, 'MCP configuration request');
    return this.requestV2('/v2/integrations/mcp/configure', mcpServerListV2Schema, 'protocol-v2 MCP server list', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed),
    }, { expectedStatus: 200 });
  }

  private async actionMcpV2(input: McpServerActionRequestV2): Promise<McpServerListV2> {
    const parsed = validateInput(mcpServerActionRequestV2Schema, input, 'MCP server action');
    return this.requestV2('/v2/integrations/mcp/action', mcpServerListV2Schema, 'protocol-v2 MCP server list', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed),
    }, { expectedStatus: 200 });
  }

  private async getMcpCatalogV2(provider: ProviderId, serverId: string, cwd: string): Promise<McpCatalogV2> {
    const providerId = validateInput(providerIdSchema, provider, 'MCP provider id');
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(serverId) || !cwd || cwd.length > 32_768) {
      throw new ValidationError('MCP catalog request is invalid');
    }
    return this.requestV2(`/v2/integrations/mcp/${encodeURIComponent(providerId)}/${encodeURIComponent(serverId)}/catalog?${new URLSearchParams({ cwd }).toString()}`, mcpCatalogV2Schema, 'protocol-v2 MCP catalog', {}, { expectedStatus: 200 });
  }

  private async startMcpOAuthV2(provider: ProviderId, serverId: string, cwd: string): Promise<McpOAuthStatusV2> {
    const parsed = validateInput(mcpOAuthStartRequestV2Schema, { provider, serverId, cwd }, 'MCP OAuth request');
    return this.requestV2('/v2/integrations/mcp/oauth', mcpOAuthStatusV2Schema, 'protocol-v2 MCP OAuth status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed),
    }, { expectedStatus: 200 });
  }

  private async invokeMcpToolV2(input: McpToolInvocationRequestV2): Promise<McpToolInvocationResultV2> {
    const parsed = validateInput(mcpToolInvocationRequestV2Schema, input, 'MCP tool invocation');
    return this.requestV2('/v2/integrations/mcp/invoke', mcpToolInvocationResultV2Schema, 'protocol-v2 MCP tool result', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed),
    }, { expectedStatus: 200 });
  }

  private async listProviderComponentsV2(input: ProviderComponentListRequestV2): Promise<ProviderComponentListV2> {
    const parsed = validateInput(providerComponentListRequestV2Schema, input, 'provider component inspection');
    const query = new URLSearchParams({ provider: parsed.provider, cwd: parsed.cwd });
    if (parsed.kind) query.set('kind', parsed.kind);
    return this.requestV2(`/v2/integrations/components?${query.toString()}`, providerComponentListV2Schema, 'protocol-v2 provider component list', {}, { expectedStatus: 200 });
  }

  private async manageProviderComponentV2(input: ProviderComponentManageRequestV2): Promise<ProviderComponentOperationResultV2> {
    const parsed = validateInput(providerComponentManageRequestV2Schema, input, 'provider component management');
    return this.requestV2('/v2/integrations/components/manage', providerComponentOperationResultV2Schema, 'protocol-v2 provider component result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) }, { expectedStatus: 200 });
  }

  private async invokeProviderComponentV2(input: ProviderComponentInvokeRequestV2): Promise<ProviderComponentOperationResultV2> {
    const parsed = validateInput(providerComponentInvokeRequestV2Schema, input, 'provider component invocation');
    return this.requestV2('/v2/integrations/components/invoke', providerComponentOperationResultV2Schema, 'protocol-v2 provider component result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) }, { expectedStatus: 200 });
  }

  private async getSubagentGraphV2(id: string): Promise<SubagentGraphV2> {
    const sessionId = validateSessionIdV2(id);
    return this.requestV2(`/v2/sessions/${encodeURIComponent(sessionId)}/agents`, subagentGraphV2Schema, 'protocol-v2 subagent graph', {}, { expectedStatus: 200 });
  }

  private async controlSubagentV2(input: SubagentControlRequestV2) {
    const parsed = validateInput(subagentControlRequestV2Schema, input, 'subagent control request');
    return this.requestV2(`/v2/sessions/${encodeURIComponent(parsed.sessionId)}/agents/control`, subagentControlResultV2Schema, 'protocol-v2 subagent control result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) }, { expectedStatus: 200 });
  }

  private async previewWorktreeV2(input: WorktreePreviewRequestV2): Promise<WorktreePreviewV2> {
    const parsed = validateInput(worktreePreviewRequestV2Schema, input, 'worktree preview request');
    return this.requestV2('/v2/worktrees/preview', worktreePreviewV2Schema, 'protocol-v2 worktree preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) }, { expectedStatus: 200 });
  }

  private async createWorktreeV2(input: WorktreeCreateRequestV2): Promise<OwnedWorktreeV2> {
    const parsed = validateInput(worktreeCreateRequestV2Schema, input, 'worktree create request');
    return this.requestV2('/v2/worktrees', ownedWorktreeV2Schema, 'protocol-v2 owned worktree', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) }, { expectedStatus: 201 });
  }

  private async listWorktreesV2(): Promise<OwnedWorktreeV2[]> {
    return (await this.requestV2('/v2/worktrees', ownedWorktreeListV2Schema, 'protocol-v2 owned worktrees', {}, { expectedStatus: 200 })).worktrees;
  }

  private async cleanupWorktreeV2(
    worktreeId: string,
    options?: WorktreeCleanupOptions,
  ): Promise<OwnedWorktreeV2> {
    const parsed = validateInput(
      worktreeCleanupRequestV2Schema,
      { worktreeId, ...options },
      'worktree cleanup request',
    );
    return this.requestV2('/v2/worktrees/cleanup', ownedWorktreeV2Schema, 'protocol-v2 owned worktree', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) }, { expectedStatus: 200 });
  }

  private async publishPipenzoV1(
    input: PipenzoPublishRequestV1,
    nonce: string,
  ): Promise<PipenzoPublishResultV1> {
    const parsed = validateInput(pipenzoPublishRequestV1Schema, input, 'pipenzo publish request');
    return this.requestV2(
      '/v2/pipenzo/publish',
      pipenzoPublishResultV1Schema,
      'pipenzo publish result',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [PIPENZO_PUBLISH_NONCE_HEADER]: nonce },
        body: JSON.stringify(parsed),
      },
      { expectedStatus: 200 },
    );
  }

  private async refinePipenzoV1(input: PipenzoRefineRequestV1): Promise<PipenzoRefineResultV1> {
    const parsed = validateInput(pipenzoRefineRequestV1Schema, input, 'pipenzo refine request');
    return this.requestV2(
      '/v2/pipenzo/refine',
      pipenzoRefineResultV1Schema,
      'pipenzo refine result',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async implementPipenzoV1(
    input: PipenzoImplementRequestV1,
  ): Promise<PipenzoImplementResultV1> {
    const parsed = validateInput(pipenzoImplementRequestV1Schema, input, 'pipenzo implement request');
    return this.requestV2(
      '/v2/pipenzo/implement',
      pipenzoImplementResultV1Schema,
      'pipenzo implement result',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async implementResultPipenzoV1(
    input: PipenzoImplementResultQueryV1,
  ): Promise<PipenzoImplementCommitsV1> {
    const parsed = validateInput(
      pipenzoImplementResultQueryV1Schema,
      input,
      'pipenzo implement result request',
    );
    return this.requestV2(
      '/v2/pipenzo/implement/result',
      pipenzoImplementCommitsV1Schema,
      'pipenzo implement commits',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async implementDiffPipenzoV1(
    input: PipenzoImplementDiffRequestV1,
  ): Promise<PipenzoImplementDiffResultV1> {
    const parsed = validateInput(
      pipenzoImplementDiffRequestV1Schema,
      input,
      'pipenzo implement diff request',
    );
    return this.requestV2(
      '/v2/pipenzo/implement/diff',
      pipenzoImplementDiffResultV1Schema,
      'pipenzo implement diff',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  /** Issue #103's read-only poll: whether a ticket's most recent Implement attempt is genuinely
   *  live right now. */
  private async runStatusPipenzoV1(
    input: PipenzoRunStatusRequestV1,
  ): Promise<PipenzoRunStatusResultV1> {
    const parsed = validateInput(pipenzoRunStatusRequestV1Schema, input, 'pipenzo run status request');
    return this.requestV2(
      '/v2/pipenzo/implement/status',
      pipenzoRunStatusResultV1Schema,
      'pipenzo run status',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  /** Issue #103: delivers one instruction to a genuinely running Implement session. */
  private async steerPipenzoV1(input: PipenzoSteerRequestV1): Promise<PipenzoSteerResultV1> {
    const parsed = validateInput(pipenzoSteerRequestV1Schema, input, 'pipenzo steer request');
    return this.requestV2(
      '/v2/pipenzo/implement/steer',
      pipenzoSteerResultV1Schema,
      'pipenzo steer result',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  /** Issue #103: abandons only the running Implement session's current in-flight turn. */
  private async stopPipenzoV1(input: PipenzoStopRequestV1): Promise<PipenzoStopResultV1> {
    const parsed = validateInput(pipenzoStopRequestV1Schema, input, 'pipenzo stop request');
    return this.requestV2(
      '/v2/pipenzo/implement/stop',
      pipenzoStopResultV1Schema,
      'pipenzo stop result',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  /** Issue #105: classified retry for a ticket parked on `pipenzo:needs-human`. */
  private async retryPipenzoV1(input: PipenzoRetryRequestV1): Promise<PipenzoRetryResultV1> {
    const parsed = validateInput(pipenzoRetryRequestV1Schema, input, 'pipenzo retry request');
    return this.requestV2(
      '/v2/pipenzo/implement/retry',
      pipenzoRetryResultV1Schema,
      'pipenzo retry result',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async reviewPipenzoV1(input: PipenzoReviewRequestV1): Promise<PipenzoReviewResultV1> {
    const parsed = validateInput(pipenzoReviewRequestV1Schema, input, 'pipenzo review request');
    return this.requestV2(
      '/v2/pipenzo/review',
      pipenzoReviewResultV1Schema,
      'pipenzo review report',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async claimPipenzoIssueV1(
    input: PipenzoIssueClaimRequestV1,
  ): Promise<PipenzoIssueClaimResultV1> {
    const parsed = validateInput(
      pipenzoIssueClaimRequestV1Schema,
      input,
      'pipenzo issue claim request',
    );
    return this.requestV2(
      '/v2/pipenzo/issues/claim',
      pipenzoIssueClaimResultV1Schema,
      'pipenzo issue claim result',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async createPipenzoIssueV1(
    input: PipenzoIssueCreateRequestV1,
  ): Promise<PipenzoIssueCreateResultV1> {
    const parsed = validateInput(
      pipenzoIssueCreateRequestV1Schema,
      input,
      'pipenzo issue create request',
    );
    return this.requestV2(
      '/v2/pipenzo/issues',
      pipenzoIssueCreateResultV1Schema,
      'pipenzo created issue',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 201 },
    );
  }

  private async commentOnPipenzoIssueV1(
    input: PipenzoIssueCommentRequestV1,
  ): Promise<PipenzoIssueCommentResultV1> {
    const parsed = validateInput(
      pipenzoIssueCommentRequestV1Schema,
      input,
      'pipenzo issue comment request',
    );
    return this.requestV2(
      '/v2/pipenzo/issues/comment',
      pipenzoIssueCommentResultV1Schema,
      'pipenzo posted comment',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 201 },
    );
  }

  private async draftPipenzoIssueV1(
    input: PipenzoIdeaDraftRequestV1,
  ): Promise<PipenzoIdeaDraftResultV1> {
    const parsed = validateInput(pipenzoIdeaDraftRequestV1Schema, input, 'pipenzo idea draft request');
    return this.requestV2(
      '/v2/pipenzo/issues/draft',
      pipenzoIdeaDraftResultV1Schema,
      'pipenzo drafted issue',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async pipenzoCaptureCapabilitiesV1(
    input: PipenzoCaptureCapabilityRequestV1,
  ): Promise<PipenzoCaptureCapabilityV1> {
    const parsed = validateInput(
      pipenzoCaptureCapabilityRequestV1Schema,
      input,
      'pipenzo capability request',
    );
    return this.requestV2(
      '/v2/pipenzo/capabilities',
      pipenzoCaptureCapabilityV1Schema,
      'pipenzo capability report',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async listPipenzoReposV1(): Promise<PipenzoRepoListV1> {
    return this.requestV2(
      '/v2/pipenzo/repos',
      pipenzoRepoListV1Schema,
      'pipenzo repository list',
      { method: 'GET' },
      { expectedStatus: 200 },
    );
  }

  private async connectedPipenzoReposV1(): Promise<PipenzoConnectedReposV1> {
    return this.requestV2(
      '/v2/pipenzo/repos/connected',
      pipenzoConnectedReposV1Schema,
      'pipenzo connected repositories',
      { method: 'GET' },
      { expectedStatus: 200 },
    );
  }

  private async connectPipenzoReposV1(
    input: PipenzoConnectReposRequestV1,
  ): Promise<PipenzoConnectedReposV1> {
    const parsed = validateInput(
      pipenzoConnectReposRequestV1Schema,
      input,
      'pipenzo connect repos request',
    );
    return this.requestV2(
      '/v2/pipenzo/repos/connected',
      pipenzoConnectedReposV1Schema,
      'pipenzo connected repositories',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      },
      { expectedStatus: 200 },
    );
  }

  private async pipenzoConcurrencySettingsV1(): Promise<PipenzoConcurrencySettingsV1> {
    return this.requestV2(
      '/v2/pipenzo/concurrency',
      pipenzoConcurrencySettingsV1Schema,
      'pipenzo concurrency settings',
      { method: 'GET' },
      { expectedStatus: 200 },
    );
  }

  private async updatePipenzoConcurrencySettingsV1(
    input: PipenzoConcurrencySettingsUpdateV1,
  ): Promise<PipenzoConcurrencySettingsV1> {
    const parsed = validateInput(
      pipenzoConcurrencySettingsUpdateV1Schema,
      input,
      'pipenzo concurrency settings update request',
    );
    return this.requestV2(
      '/v2/pipenzo/concurrency',
      pipenzoConcurrencySettingsV1Schema,
      'pipenzo concurrency settings',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      },
      { expectedStatus: 200 },
    );
  }

  private async pipenzoCaptureSettingsV1(): Promise<PipenzoCaptureSettingsV1> {
    return this.requestV2(
      '/v2/pipenzo/capture-settings',
      pipenzoCaptureSettingsV1Schema,
      'pipenzo capture settings',
      { method: 'GET' },
      { expectedStatus: 200 },
    );
  }

  private async updatePipenzoCaptureSettingsV1(
    input: PipenzoCaptureSettingsUpdateV1,
  ): Promise<PipenzoCaptureSettingsV1> {
    const parsed = validateInput(
      pipenzoCaptureSettingsUpdateV1Schema,
      input,
      'pipenzo capture settings update request',
    );
    return this.requestV2(
      '/v2/pipenzo/capture-settings',
      pipenzoCaptureSettingsV1Schema,
      'pipenzo capture settings',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      },
      { expectedStatus: 200 },
    );
  }

  private async pipenzoNotificationSettingsV1(): Promise<PipenzoNotificationSettingsV1> {
    return this.requestV2(
      '/v2/pipenzo/notification-settings',
      pipenzoNotificationSettingsV1Schema,
      'pipenzo notification settings',
      { method: 'GET' },
      { expectedStatus: 200 },
    );
  }

  private async updatePipenzoNotificationSettingsV1(
    input: PipenzoNotificationSettingsUpdateV1,
  ): Promise<PipenzoNotificationSettingsV1> {
    const parsed = validateInput(
      pipenzoNotificationSettingsUpdateV1Schema,
      input,
      'pipenzo notification settings update request',
    );
    return this.requestV2(
      '/v2/pipenzo/notification-settings',
      pipenzoNotificationSettingsV1Schema,
      'pipenzo notification settings',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      },
      { expectedStatus: 200 },
    );
  }

  private async resolvePipenzoCheckoutV1(
    input: PipenzoRepoCheckoutRequestV1,
  ): Promise<PipenzoRepoCheckoutResultV1> {
    const parsed = validateInput(
      pipenzoRepoCheckoutRequestV1Schema,
      input,
      'pipenzo repo checkout request',
    );
    return this.requestV2(
      '/v2/pipenzo/repos/checkout',
      pipenzoRepoCheckoutResultV1Schema,
      'pipenzo repo checkout',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async pipenzoLessonsV1(): Promise<PipenzoLessonListV1> {
    return this.requestV2(
      '/v2/pipenzo/lessons',
      pipenzoLessonListV1Schema,
      'pipenzo saved lessons',
      { method: 'GET' },
      { expectedStatus: 200 },
    );
  }

  private async createPipenzoLessonV1(input: PipenzoLessonCreateV1): Promise<PipenzoLessonListV1> {
    const parsed = validateInput(
      pipenzoLessonCreateV1Schema,
      input,
      'pipenzo lesson create request',
    );
    return this.requestV2(
      '/v2/pipenzo/lessons',
      pipenzoLessonListV1Schema,
      'pipenzo saved lessons',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      },
      { expectedStatus: 200 },
    );
  }

  private async deletePipenzoLessonV1(
    input: PipenzoLessonDeleteRequestV1,
  ): Promise<PipenzoLessonListV1> {
    const parsed = validateInput(
      pipenzoLessonDeleteRequestV1Schema,
      input,
      'pipenzo lesson delete request',
    );
    return this.requestV2(
      '/v2/pipenzo/lessons/delete',
      pipenzoLessonListV1Schema,
      'pipenzo saved lessons',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      },
      { expectedStatus: 200 },
    );
  }

  private async readPipenzoTicketV1(
    input: PipenzoTicketReadRequestV1,
  ): Promise<PipenzoTicketReconciliationV1> {
    const parsed = validateInput(pipenzoTicketReadRequestV1Schema, input, 'pipenzo ticket read request');
    return this.requestV2(
      '/v2/pipenzo/tickets/read',
      pipenzoTicketReconciliationV1Schema,
      'pipenzo ticket reconciliation',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async transitionPipenzoTicketV1(
    input: PipenzoTicketTransitionRequestV1,
  ): Promise<PipenzoTicketReconciliationV1> {
    const parsed = validateInput(
      pipenzoTicketTransitionRequestV1Schema,
      input,
      'pipenzo ticket transition request',
    );
    return this.requestV2(
      '/v2/pipenzo/tickets/transition',
      pipenzoTicketReconciliationV1Schema,
      'pipenzo ticket reconciliation',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async listPipenzoTicketsV1(): Promise<PipenzoTicketListV1> {
    return this.requestV2(
      '/v2/pipenzo/tickets',
      pipenzoTicketListV1Schema,
      'pipenzo ticket list',
      { method: 'GET' },
      { expectedStatus: 200 },
    );
  }

  private async recordPipenzoRiskApprovalOutcomeV1(
    input: PipenzoTicketRiskApprovalOutcomeRequestV1,
  ): Promise<PipenzoTicketRiskResponseV1> {
    const parsed = validateInput(
      pipenzoTicketRiskApprovalOutcomeRequestV1Schema,
      input,
      'pipenzo risk approval outcome request',
    );
    return this.requestV2(
      '/v2/pipenzo/tickets/risk/approval-outcome',
      pipenzoTicketRiskResponseV1Schema,
      'pipenzo ticket risk',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async recordPipenzoRiskActivityOpenedV1(
    input: PipenzoTicketRiskActivityOpenedRequestV1,
  ): Promise<PipenzoTicketRiskResponseV1> {
    const parsed = validateInput(
      pipenzoTicketRiskActivityOpenedRequestV1Schema,
      input,
      'pipenzo risk activity-opened request',
    );
    return this.requestV2(
      '/v2/pipenzo/tickets/risk/activity-opened',
      pipenzoTicketRiskResponseV1Schema,
      'pipenzo ticket risk',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async captureMediumApprovalV1(
    input: PipenzoMediumApprovalCaptureRequestV1,
  ): Promise<PipenzoMediumApprovalCaptureResultV1> {
    const parsed = validateInput(
      pipenzoMediumApprovalCaptureRequestV1Schema,
      input,
      'pipenzo medium-approval capture request',
    );
    return this.requestV2(
      '/v2/pipenzo/tickets/risk/medium-approval/capture',
      pipenzoMediumApprovalCaptureResultV1Schema,
      'pipenzo medium-approval snapshot',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async decideMediumApprovalV1(
    input: PipenzoMediumApprovalDecideRequestV1,
  ): Promise<PipenzoMediumApprovalDecideResultV1> {
    const parsed = validateInput(
      pipenzoMediumApprovalDecideRequestV1Schema,
      input,
      'pipenzo medium-approval decide request',
    );
    return this.requestV2(
      '/v2/pipenzo/tickets/risk/medium-approval/decide',
      pipenzoMediumApprovalDecideResultV1Schema,
      'pipenzo medium-approval decision',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async mediumApprovalStatusV1(
    input: PipenzoMediumApprovalStatusRequestV1,
  ): Promise<PipenzoMediumApprovalStatusResultV1> {
    const parsed = validateInput(
      pipenzoMediumApprovalStatusRequestV1Schema,
      input,
      'pipenzo medium-approval status request',
    );
    return this.requestV2(
      '/v2/pipenzo/tickets/risk/medium-approval/status',
      pipenzoMediumApprovalStatusResultV1Schema,
      'pipenzo medium-approval status',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async undoMediumApprovalV1(
    input: PipenzoMediumApprovalUndoRequestV1,
  ): Promise<PipenzoMediumApprovalUndoResultV1> {
    const parsed = validateInput(
      pipenzoMediumApprovalUndoRequestV1Schema,
      input,
      'pipenzo medium-approval undo request',
    );
    return this.requestV2(
      '/v2/pipenzo/tickets/risk/medium-approval/undo',
      pipenzoMediumApprovalUndoResultV1Schema,
      'pipenzo medium-approval undo outcome',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async captureHighApprovalV1(
    input: PipenzoHighApprovalCaptureRequestV1,
  ): Promise<PipenzoHighApprovalCaptureResultV1> {
    const parsed = validateInput(
      pipenzoHighApprovalCaptureRequestV1Schema,
      input,
      'pipenzo high-approval capture request',
    );
    return this.requestV2(
      '/v2/pipenzo/tickets/risk/high-approval/capture',
      pipenzoHighApprovalCaptureResultV1Schema,
      'pipenzo high-approval pending record',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async decideHighApprovalV1(
    input: PipenzoHighApprovalDecideRequestV1,
  ): Promise<PipenzoHighApprovalDecideResultV1> {
    const parsed = validateInput(
      pipenzoHighApprovalDecideRequestV1Schema,
      input,
      'pipenzo high-approval decide request',
    );
    return this.requestV2(
      '/v2/pipenzo/tickets/risk/high-approval/decide',
      pipenzoHighApprovalDecideResultV1Schema,
      'pipenzo high-approval decision',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async captureStackApprovalV1(
    input: PipenzoStackApprovalCaptureRequestV1,
  ): Promise<PipenzoStackApprovalCaptureResultV1> {
    const parsed = validateInput(
      pipenzoStackApprovalCaptureRequestV1Schema,
      input,
      'pipenzo stack-approval capture request',
    );
    return this.requestV2(
      '/v2/pipenzo/tickets/risk/stack-approval/capture',
      pipenzoStackApprovalCaptureResultV1Schema,
      'pipenzo stack-approval pending record',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async decideStackApprovalV1(
    input: PipenzoStackApprovalDecideRequestV1,
  ): Promise<PipenzoStackApprovalDecideResultV1> {
    const parsed = validateInput(
      pipenzoStackApprovalDecideRequestV1Schema,
      input,
      'pipenzo stack-approval decide request',
    );
    return this.requestV2(
      '/v2/pipenzo/tickets/risk/stack-approval/decide',
      pipenzoStackApprovalDecideResultV1Schema,
      'pipenzo stack-approval decision',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async capturePlanReviewV1(
    input: PipenzoPlanReviewCaptureRequestV1,
  ): Promise<PipenzoPlanReviewCaptureResultV1> {
    const parsed = validateInput(
      pipenzoPlanReviewCaptureRequestV1Schema,
      input,
      'pipenzo plan-review capture request',
    );
    return this.requestV2(
      '/v2/pipenzo/tickets/risk/plan-review/capture',
      pipenzoPlanReviewCaptureResultV1Schema,
      'pipenzo plan-review pending record',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async decidePlanReviewV1(
    input: PipenzoPlanReviewDecideRequestV1,
  ): Promise<PipenzoPlanReviewDecideResultV1> {
    const parsed = validateInput(
      pipenzoPlanReviewDecideRequestV1Schema,
      input,
      'pipenzo plan-review decide request',
    );
    return this.requestV2(
      '/v2/pipenzo/tickets/risk/plan-review/decide',
      pipenzoPlanReviewDecideResultV1Schema,
      'pipenzo plan-review decision',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) },
      { expectedStatus: 200 },
    );
  }

  private async uploadAttachmentV2(input: AttachmentUploadInput): Promise<AttachmentMetadataV2> {
    if (!input.fileName || input.fileName.length > 255 || !Number.isInteger(input.size) || input.size < 0 || input.size > ATTACHMENT_LIMITS_V2.maxFileBytes) throw new ValidationError('Attachment selection is invalid');
    const res = await this.fetchAuthenticated(PROTOCOL_V2, '/v2/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(input.size), 'X-AgentDock-Filename': encodeURIComponent(input.fileName), ...(input.sessionId ? { 'X-AgentDock-Session-Id': validateSessionIdV2(input.sessionId) } : {}) },
      body: input.stream as RequestInit['body'],
      duplex: 'half',
    } as RequestInit);
    if (res.status !== 201) throw new ValidationError(`daemon returned status ${res.status} for attachment upload`);
    return validate(attachmentMetadataV2Schema, await res.json().catch(() => undefined), 'attachment metadata');
  }

  private async listAttachmentsV2(): Promise<AttachmentMetadataV2[]> {
    return (await this.requestV2('/v2/attachments', attachmentListV2Schema, 'protocol-v2 attachments', {}, { expectedStatus: 200 })).attachments;
  }

  private async referenceAttachmentsV2(attachmentIds: string[], sessionId: string): Promise<AttachmentMetadataV2[]> {
    const parsed = validateInput(attachmentReferenceRequestV2Schema, { attachmentIds, sessionId }, 'attachment reference request');
    return (await this.requestV2('/v2/attachments/reference', attachmentListV2Schema, 'protocol-v2 attachments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) }, { expectedStatus: 200 })).attachments;
  }

  private async validateStructuredWorkflowV2(input: StructuredWorkflowRequestV2): Promise<StructuredWorkflowResultV2> {
    const parsed = validateInput(structuredWorkflowRequestV2Schema, input, 'structured workflow request');
    return this.requestV2('/v2/workflows/structured/validate', structuredWorkflowResultV2Schema, 'protocol-v2 structured workflow result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) }, { expectedStatus: 200 });
  }

  private async createSessionV2(
    input: CreateSessionV2Request,
    options: SessionRequestOptions = {},
  ): Promise<AgentSessionV2> {
    const parsedInput = validateInput(
      createSessionV2RequestSchema,
      input,
      'protocol-v2 session request',
    );
    return this.requestV2(
      '/v2/sessions',
      agentSessionV2Schema,
      'protocol-v2 session',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsedInput),
        signal: options.signal,
      },
      { expectedStatus: 201 },
    );
  }

  private async getSessionV2(id: string): Promise<AgentSessionV2> {
    const sessionId = validateSessionIdV2(id);
    return this.requestV2(
      `/v2/sessions/${encodeURIComponent(sessionId)}`,
      agentSessionV2Schema,
      'protocol-v2 session',
      {},
      { expectedStatus: 200, notFound: () => new SessionNotFoundError(sessionId) },
    );
  }

  private async listSessionsV2(options: SessionListV2Options = {}): Promise<SessionListV2Page> {
    const parsed = validateInput(
      sessionListV2QuerySchema,
      options,
      'protocol-v2 session list query',
    );
    const query = new URLSearchParams();
    if (parsed.cursor !== undefined) query.set('cursor', parsed.cursor);
    if (parsed.limit !== undefined) query.set('limit', String(parsed.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.requestV2(
      `/v2/sessions${suffix}`,
      sessionListV2PageSchema,
      'protocol-v2 session page',
      {},
      { expectedStatus: 200 },
    );
  }

  private async getSessionEventHistoryV2(
    id: string,
    options: SessionEventHistoryV2Options = {},
  ): Promise<SessionEventHistoryV2Page> {
    const sessionId = validateSessionIdV2(id);
    const parsed = validateInput(
      sessionEventHistoryV2QuerySchema,
      options,
      'protocol-v2 session event history query',
    );
    const query = new URLSearchParams();
    if (parsed.cursor !== undefined) query.set('cursor', parsed.cursor);
    if (parsed.limit !== undefined) query.set('limit', String(parsed.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.requestV2(
      `/v2/sessions/${encodeURIComponent(sessionId)}/history${suffix}`,
      sessionEventHistoryV2PageSchema,
      'protocol-v2 session event history page',
      {},
      { expectedStatus: 200, notFound: () => new SessionNotFoundError(sessionId) },
    );
  }

  private async continueSessionV2(
    parentSessionId: string,
    kind: 'resume' | 'fork',
    input: SessionContinuationInputV2,
    options: SessionRequestOptions = {},
  ): Promise<AgentSessionV2> {
    const sessionId = validateSessionIdV2(parentSessionId);
    const parsed = validateInput(
      sessionContinuationInputV2Schema,
      input,
      `protocol-v2 session ${kind} request`,
    );
    return this.requestV2(
      `/v2/sessions/${encodeURIComponent(sessionId)}/${kind}`,
      agentSessionV2Schema,
      'protocol-v2 session',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
        signal: options.signal,
      },
      {
        expectedStatus: 201,
        notFound: () => new SessionNotFoundError(sessionId),
        notFoundCode: 'session_not_found',
      },
    );
  }

  private async *streamSessionEventsV2(
    id: string,
    options: SessionEventsOptions = {},
  ): AsyncGenerator<AgentEventV2Envelope, void, void> {
    const sessionId = validateSessionIdV2(id);
    validateLastEventIdV2(options.lastEventId);
    let previousSequence =
      options.lastEventId === undefined ? undefined : Number(options.lastEventId);
    await this.ensureProtocolVersion(PROTOCOL_V2);

    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (options.lastEventId) headers['Last-Event-ID'] = options.lastEventId;
    if (options.responder) headers['X-AgentDock-Responder'] = '1';

    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.baseUrl}/v2/sessions/${encodeURIComponent(sessionId)}/events`,
        {
          headers,
          signal: options.signal,
        },
      );
    } catch (err) {
      if (options.signal?.aborted) return;
      throw new DaemonUnavailableError(
        `could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`,
        {
          cause: err,
        },
      );
    }

    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 404) throw new SessionNotFoundError(sessionId);
    if (!res.ok) {
      const body = await res.json().catch(() => undefined);
      const message =
        daemonErrorMessage(body) ?? `failed to open event stream (status ${res.status})`;
      if (res.status === 400) throw new ValidationError(message);
      throw new DaemonError(message, res.status);
    }
    if (res.status !== 200) {
      throw new ValidationError(
        `daemon returned status ${res.status} for a protocol-v2 event stream; expected 200`,
      );
    }
    if (!res.body) {
      throw new ValidationError(
        'daemon returned a protocol-v2 event stream without a response body',
      );
    }

    const responderLease = options.responder
      ? res.headers.get('X-AgentDock-Responder-Lease')
      : null;
    if (options.responder && (!responderLease || !RESPONDER_LEASE_PATTERN.test(responderLease))) {
      await res.body.cancel().catch(() => undefined);
      throw new ValidationError('daemon returned an invalid protocol-v2 responder lease');
    }
    if (responderLease) this.responderLeases.set(sessionId, responderLease);

    try {
      for await (const event of parseSseStream(res.body, {
        schema: agentEventOrStreamErrorV2Schema,
        label: 'AgentEvent v2',
        signal: options.signal,
        maxFrameBytes: MAX_V2_SSE_FRAME_BYTES,
        fatalUtf8: true,
        rejectUnterminatedFrame: true,
        validateEvent: (event, frame) => {
          if (event.type === 'stream.error') return;
          if (event.sessionId !== sessionId) {
            throw new ValidationError(
              `received an AgentEvent v2 for session ${event.sessionId} on the ${sessionId} stream`,
            );
          }
          if (frame.id === undefined) {
            throw new ValidationError('received an AgentEvent v2 SSE frame without an id');
          }
          if (frame.id !== String(event.sequence)) {
            throw new ValidationError(
              `received AgentEvent v2 SSE id ${frame.id} for sequence ${event.sequence}`,
            );
          }
          if (previousSequence !== undefined && event.sequence <= previousSequence) {
            throw new ValidationError(
              `received non-monotonic AgentEvent v2 sequence ${event.sequence} after ${previousSequence}`,
            );
          }
          previousSequence = event.sequence;
        },
      })) {
        if (event.type === 'stream.error') {
          const cursor =
            event.lastSequence === undefined ? '' : ` after sequence ${event.lastSequence}`;
          throw new DaemonError(`protocol-v2 event stream overflowed${cursor}`, 429);
        }
        yield event;
      }
    } finally {
      if (responderLease && this.responderLeases.get(sessionId) === responderLease) {
        this.responderLeases.delete(sessionId);
      }
    }
  }

  /**
   * The phase-change stream (issue #189).
   *
   * Simpler than the v2 session stream in the two ways that stream is complicated: there is no
   * responder lease to claim (nobody answers a phase event) and no session id to check each frame
   * against (the stream is daemon-wide by design). What it keeps is the part that catches a real
   * desync -- the SSE `id:` must agree with the envelope's `sequence`, and sequences must advance,
   * because a cursor built from a sequence the daemon never sent would silently resume in the wrong
   * place on the next reconnect.
   */
  private async *streamPipenzoTicketEventsV1(
    options: PipenzoTicketEventsOptions = {},
  ): AsyncGenerator<PipenzoPhaseEventV1, void, void> {
    if (options.lastEventId !== undefined && !/^\d+$/.test(options.lastEventId)) {
      throw new ValidationError('lastEventId must be a non-negative integer sequence');
    }
    let previousSequence =
      options.lastEventId === undefined ? undefined : Number(options.lastEventId);
    await this.ensureProtocolVersion(PROTOCOL_V2);

    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (options.lastEventId !== undefined) headers['Last-Event-ID'] = options.lastEventId;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v2/pipenzo/tickets/events`, {
        headers,
        signal: options.signal,
      });
    } catch (err) {
      if (options.signal?.aborted) return;
      throw new DaemonUnavailableError(
        `could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`,
        { cause: err },
      );
    }

    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok) {
      const body = await res.json().catch(() => undefined);
      const message =
        daemonErrorMessage(body) ?? `failed to open the phase stream (status ${res.status})`;
      if (res.status === 400) throw new ValidationError(message);
      // 409 is `replay_gap`: the cursor is outside the daemon's bounded window. Surfaced as a plain
      // DaemonError carrying the status *and* the window the daemon reported, because the status
      // alone is not enough to recover: a caller that only knows "the cursor was refused" can do
      // nothing but drop it and reconnect from zero, which is refused again the moment the window
      // has moved off zero. The window says which cursors would be accepted.
      throw new DaemonError(message, res.status, daemonErrorCode(body), daemonErrorDetails(body));
    }
    if (!res.body) {
      throw new ValidationError('daemon returned a phase stream without a response body');
    }

    for await (const event of parseSseStream(res.body, {
      schema: pipenzoPhaseEventOrStreamErrorV1Schema,
      label: 'Pipenzo phase event',
      signal: options.signal,
      maxFrameBytes: MAX_V2_SSE_FRAME_BYTES,
      fatalUtf8: true,
      rejectUnterminatedFrame: true,
      validateEvent: (event, frame) => {
        if (event.type === 'stream.error') return;
        if (frame.id === undefined) {
          throw new ValidationError('received a Pipenzo phase event SSE frame without an id');
        }
        if (frame.id !== String(event.sequence)) {
          throw new ValidationError(
            `received Pipenzo phase event SSE id ${frame.id} for sequence ${event.sequence}`,
          );
        }
        if (previousSequence !== undefined && event.sequence <= previousSequence) {
          throw new ValidationError(
            `received non-monotonic Pipenzo phase event sequence ${event.sequence} after ${previousSequence}`,
          );
        }
        previousSequence = event.sequence;
      },
    })) {
      if (event.type === 'stream.error') {
        const cursor =
          event.lastSequence === undefined ? '' : ` after sequence ${event.lastSequence}`;
        throw new DaemonError(`the Pipenzo phase stream overflowed${cursor}`, 429);
      }
      yield event;
    }
  }

  /**
   * The GitHub connection-health stream (issue #257). Much simpler than the phase stream above: no
   * `Last-Event-ID`, no sequence-monotonicity check, no `stream.error` variant to unwrap -- every
   * frame this stream ever sends is a plain `PipenzoGitHubHealthV1`, because a latest-value stream
   * has nothing else to say. See `PipenzoGitHubHealthEventsOptions` for why there is no cursor.
   */
  private async *streamPipenzoGitHubHealthEventsV1(
    options: PipenzoGitHubHealthEventsOptions = {},
  ): AsyncGenerator<PipenzoGitHubHealthV1, void, void> {
    await this.ensureProtocolVersion(PROTOCOL_V2);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v2/pipenzo/github/health/events`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: options.signal,
      });
    } catch (err) {
      if (options.signal?.aborted) return;
      throw new DaemonUnavailableError(
        `could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`,
        { cause: err },
      );
    }

    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok) {
      const body = await res.json().catch(() => undefined);
      const message =
        daemonErrorMessage(body) ?? `failed to open the health stream (status ${res.status})`;
      throw new DaemonError(message, res.status, daemonErrorCode(body), daemonErrorDetails(body));
    }
    if (!res.body) {
      throw new ValidationError('daemon returned a health stream without a response body');
    }

    yield* parseSseStream(res.body, {
      schema: pipenzoGitHubHealthV1Schema,
      label: 'Pipenzo GitHub health',
      signal: options.signal,
      maxFrameBytes: MAX_V2_SSE_FRAME_BYTES,
      fatalUtf8: true,
      rejectUnterminatedFrame: true,
    });
  }

  private async pollPipenzoGitHubHealthV1(options: SessionRequestOptions = {}): Promise<void> {
    await this.requestV2NoContent('/v2/pipenzo/github/health/poll', {
      method: 'POST',
      signal: options.signal,
    });
  }

  private async sendSessionCommandV2(command: AgentCommandV2): Promise<CommandAcknowledgementV2> {
    const parsedCommand = validateInput(agentCommandV2Schema, command, 'protocol-v2 agent command');
    const acknowledgement = await this.requestV2(
      `/v2/sessions/${encodeURIComponent(parsedCommand.sessionId)}/commands`,
      commandAcknowledgementV2Schema,
      'protocol-v2 command acknowledgement',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...((parsedCommand.type === 'approval.respond' ||
            parsedCommand.type === 'question.respond') &&
          this.responderLeases.has(parsedCommand.sessionId)
            ? {
                'X-AgentDock-Responder-Lease': this.responderLeases.get(parsedCommand.sessionId)!,
              }
            : {}),
        },
        body: JSON.stringify(parsedCommand),
      },
      {
        expectedStatus: 202,
        notFound: () => new SessionNotFoundError(parsedCommand.sessionId),
      },
    );

    if (
      acknowledgement.commandId !== parsedCommand.commandId ||
      acknowledgement.sessionId !== parsedCommand.sessionId ||
      acknowledgement.turnId !== parsedCommand.turnId
    ) {
      throw new ValidationError(
        'daemon returned a protocol-v2 command acknowledgement that does not match the command',
      );
    }
    return acknowledgement;
  }

  private async cancelSessionV2(
    id: string,
    options: SessionRequestOptions = {},
  ): Promise<CancelSessionV2Response> {
    const sessionId = validateSessionIdV2(id);
    return this.requestV2(
      `/v2/sessions/${encodeURIComponent(sessionId)}/cancel`,
      cancelSessionV2ResponseSchema,
      'protocol-v2 cancellation acknowledgement',
      { method: 'POST', signal: options.signal },
      { expectedStatus: 202, notFound: () => new SessionNotFoundError(sessionId) },
    );
  }

  private async deleteSessionV2(id: string): Promise<void> {
    const sessionId = validateSessionIdV2(id);
    await this.requestV2NoContent(
      `/v2/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
      { notFound: () => new SessionNotFoundError(sessionId) },
    );
  }

  private async inspectWorkspaceV2(cwd: string): Promise<WorkspaceTrustViewV2> {
    const input = validateInput(
      workspaceInspectRequestV2Schema,
      { cwd },
      'protocol-v2 workspace inspection',
    );
    return this.requestV2(
      '/v2/workspaces/inspect',
      workspaceTrustViewV2Schema,
      'protocol-v2 workspace trust view',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      { expectedStatus: 200 },
    );
  }

  private async setWorkspaceTrustV2(
    workspaceId: string,
    input: WorkspaceTrustUpdateRequestV2,
  ): Promise<WorkspaceTrustViewV2> {
    if (!/^[a-f0-9]{64}$/.test(workspaceId)) {
      throw new ValidationError('invalid protocol-v2 workspace id');
    }
    const parsed = validateInput(
      workspaceTrustUpdateRequestV2Schema,
      input,
      'protocol-v2 workspace trust update',
    );
    return this.requestV2(
      `/v2/workspaces/${workspaceId}/trust`,
      workspaceTrustViewV2Schema,
      'protocol-v2 workspace trust view',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      },
      { expectedStatus: 200 },
    );
  }

  private async readAuditV2(options: AuditReadOptions = {}): Promise<AuditReadResponseV2> {
    if (
      options.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
    ) {
      throw new ValidationError('protocol-v2 audit limit must be between 1 and 100');
    }
    if (options.cursor !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(options.cursor)) {
      throw new ValidationError('invalid protocol-v2 audit cursor');
    }
    if (options.sessionId !== undefined) validateSessionIdV2(options.sessionId);
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.sessionId !== undefined) query.set('sessionId', options.sessionId);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.requestV2(
      `/v2/audit${suffix}`,
      auditReadResponseV2Schema,
      'protocol-v2 audit page',
      {},
      { expectedStatus: 200 },
    );
  }
}

function validate<T>(schema: RuntimeSchema<T>, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(
      `daemon returned a ${label} that does not match the protocol: ${result.error.message}`,
    );
  }
  return result.data;
}

function validateInput<T>(schema: RuntimeSchema<T>, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`invalid ${label}: ${result.error.message}`);
  }
  return result.data;
}

function validateSessionIdV2(id: string): string {
  return validateInput(sessionIdParamSchema, { sessionId: id }, 'protocol-v2 session id').sessionId;
}

function validateLastEventIdV2(lastEventId: string | undefined): void {
  if (lastEventId === undefined) return;
  if (
    typeof lastEventId !== 'string' ||
    !/^\d+$/.test(lastEventId) ||
    !Number.isSafeInteger(Number(lastEventId))
  ) {
    throw new ValidationError(
      'invalid protocol-v2 Last-Event-ID: expected a non-negative safe integer',
    );
  }
}

function highestVersion(versions: readonly number[]): number {
  return Math.max(...versions);
}

function daemonErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return undefined;
}

/** The daemon's `details` payload, if it sent one. Deliberately unvalidated -- the caller parses it. */
function daemonErrorDetails(body: unknown): unknown {
  if (!body || typeof body !== 'object') return undefined;
  return (body as { details?: unknown }).details;
}

function daemonErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const code = (body as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const nestedCode = (error as { code?: unknown }).code;
  return typeof nestedCode === 'string' ? nestedCode : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
