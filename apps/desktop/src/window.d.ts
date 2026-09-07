import type {
  AgentCommandV2,
  AgentEvent,
  AgentEventV2Envelope,
  AgentSession,
  AgentSessionV2,
  ApprovalDecisionV2,
  AuditReadResponseV2,
  CancelSessionV2Response,
  CommandAcknowledgementV2,
  CreateSessionV2Request,
  ProviderId,
  ProviderStatus,
  ProviderStatusV2,
  SessionContinuationInputV2,
  SessionEventHistoryV2Page,
  SessionEventHistoryV2Query,
  SessionListV2Page,
  SessionListV2Query,
  WorkspaceTrustUpdateRequestV2,
  WorkspaceTrustViewV2,
  McpCatalogV2,
  McpConfigureRequestV2,
  McpServerActionRequestV2,
  McpServerListV2,
  McpToolInvocationRequestV2,
  McpToolInvocationResultV2,
  ProviderComponentInvokeRequestV2,
  ProviderComponentListRequestV2,
  ProviderComponentListV2,
  ProviderComponentManageRequestV2,
  ProviderComponentOperationResultV2,
  OwnedWorktreeV2,
  SubagentControlRequestV2,
  SubagentGraphV2,
  WorktreeCreateRequestV2,
  WorktreePreviewRequestV2,
  WorktreePreviewV2,
  AttachmentMetadataV2,
  StructuredWorkflowRequestV2,
  StructuredWorkflowResultV2,
  PipenzoPublishRequestV1,
  PipenzoPublishResultV1,
  PipenzoRefineRequestV1,
  PipenzoRefineResultV1,
  PipenzoImplementRequestV1,
  PipenzoImplementResultV1,
  PipenzoImplementResultQueryV1,
  PipenzoImplementCommitsV1,
  PipenzoReviewRequestV1,
  PipenzoReviewResultV1,
  PipenzoIssueClaimRequestV1,
  PipenzoIssueClaimResultV1,
  PipenzoIssueCreateRequestV1,
  PipenzoIssueCreateResultV1,
  PipenzoCaptureCapabilityRequestV1,
  PipenzoCaptureCapabilityV1,
  PipenzoIdeaDraftRequestV1,
  PipenzoIdeaDraftResultV1,
  PipenzoTicketReadRequestV1,
  PipenzoTicketTransitionRequestV1,
  PipenzoTicketReconciliationV1,
  PipenzoPhaseEventV1,
  PipenzoDeviceCodeV1,
  PipenzoDeviceOutcomeV1,
  PipenzoGitHubConnectionV1,
} from '@agent-dock/shared';
import type {
  RendererInteraction,
  RendererInteractionResolution,
  RendererQuestionResponse,
} from '../electron/interaction-broker.js';

export type DaemonStatus =
  { state: 'connecting' } | { state: 'ready' } | { state: 'unavailable'; error: string };

export type InteractiveSessionStreamNotice =
  | { type: 'replay_reset'; session: AgentSessionV2 }
  | { type: 'error'; message: string; status?: number };

export interface CreateSessionInput {
  provider: ProviderId;
  cwd: string;
  prompt: string;
}

export interface InteractionResponseAcknowledgement {
  status: 'accepted';
}

export interface AuditReadOptionsV2 {
  cursor?: string;
  limit?: number;
  sessionId?: string;
}

export interface RendererMcpOAuthStatus {
  serverId: string;
  status: 'pending' | 'authenticated' | 'failed' | 'unsupported';
  authorizationHost?: string;
  safeSummary?: string;
}

type WithoutCommandId<T> = T extends unknown ? Omit<T, 'commandId'> : never;
export type RendererSessionCommand = WithoutCommandId<
  Exclude<AgentCommandV2, { type: 'approval.respond' | 'question.respond' }>
>;

export interface AgentDockBridge {
  getDaemonStatus(): Promise<DaemonStatus>;
  onDaemonStatus(callback: (status: DaemonStatus) => void): () => void;
  listProviders(): Promise<ProviderStatus[]>;
  listProvidersV2(): Promise<ProviderStatusV2[]>;
  openProviderInstallDocs(provider: ProviderId): Promise<void>;
  listMcpServers(provider: ProviderId, cwd: string): Promise<McpServerListV2>;
  configureMcpServer(input: McpConfigureRequestV2): Promise<McpServerListV2>;
  actionMcpServer(input: McpServerActionRequestV2): Promise<McpServerListV2>;
  getMcpCatalog(provider: ProviderId, serverId: string, cwd: string): Promise<McpCatalogV2>;
  startMcpOAuth(provider: ProviderId, serverId: string, cwd: string): Promise<RendererMcpOAuthStatus>;
  invokeMcpTool(input: McpToolInvocationRequestV2): Promise<McpToolInvocationResultV2>;
  listProviderComponents(input: ProviderComponentListRequestV2): Promise<ProviderComponentListV2>;
  manageProviderComponent(input: ProviderComponentManageRequestV2): Promise<ProviderComponentOperationResultV2>;
  invokeProviderComponent(input: ProviderComponentInvokeRequestV2): Promise<ProviderComponentOperationResultV2>;
  getSubagentGraph(sessionId: string): Promise<SubagentGraphV2>;
  controlSubagent(input: SubagentControlRequestV2): Promise<{ sessionId: string; agentId: string; status: 'accepted' | 'unsupported' | 'not_found'; safeSummary?: string }>;
  previewWorktree(input: WorktreePreviewRequestV2): Promise<WorktreePreviewV2>;
  createWorktree(input: WorktreeCreateRequestV2): Promise<OwnedWorktreeV2>;
  listWorktrees(): Promise<OwnedWorktreeV2[]>;
  /** `deleteUntracked` (issue #117/#112): removes an untracked-only-dirty worktree; any change to
   * a tracked file always refuses regardless of this flag -- see `worktree-manager.ts`'s own
   * `cleanupLocked()` comment. `deleteBranch` is a best-effort `git branch -D` after a successful
   * removal. */
  cleanupWorktree(
    worktreeId: string,
    options?: { deleteUntracked?: boolean; deleteBranch?: boolean },
  ): Promise<OwnedWorktreeV2>;
  /**
   * Pipenzo's publish gate (issue #178). Call this only in direct response to a human clicking
   * "Push branch" or "Push & open PR" — see `apps/daemon/src/routes/pipenzo-publish.ts`'s module
   * comment for why this boundary is non-negotiable (CLAUDE.md hard rule #1).
   */
  publishPipenzo(input: PipenzoPublishRequestV1): Promise<PipenzoPublishResultV1>;
  /**
   * Pipenzo's Refine phase (issue #184). Read-only by construction on the daemon side: the
   * session it starts is denied every write, command, network and MCP action, and a violation
   * fails the phase rather than being downgraded to a warning.
   */
  refinePipenzo(input: PipenzoRefineRequestV1): Promise<PipenzoRefineResultV1>;
  /**
   * Starts the Implement phase: creates the ticket's worktree, cuts its `issue-<n>` branch and
   * dispatches the session inside it. What comes back is a worktree id, a branch, a base commit
   * and a session id — never the worktree's filesystem path. Stream the returned session id
   * through the ordinary session APIs to watch it work.
   */
  implementPipenzo(input: PipenzoImplementRequestV1): Promise<PipenzoImplementResultV1>;
  /** Reads what the dispatched implement session committed, addressed by worktree id. */
  implementResultPipenzo(input: PipenzoImplementResultQueryV1): Promise<PipenzoImplementCommitsV1>;
  /**
   * Runs the Review gates in order: deterministic gates first, then the advisory reviewer, then
   * the adversarial verifier — and a deterministic failure returns before either LLM pass is
   * constructed.
   */
  reviewPipenzo(input: PipenzoReviewRequestV1): Promise<PipenzoReviewResultV1>;
  /**
   * The claim pre-flight (issue #83). Assigns the issue and then re-reads it uncached; an
   * `claimed_elsewhere` outcome means the race was lost and the ticket must not be started.
   */
  claimPipenzoIssue(input: PipenzoIssueClaimRequestV1): Promise<PipenzoIssueClaimResultV1>;
  /** Files a drafted issue (issue #84). Call only after a human approves the preview. */
  createPipenzoIssue(input: PipenzoIssueCreateRequestV1): Promise<PipenzoIssueCreateResultV1>;
  /**
   * What screenshot verification would actually do for a repository right now (issue #124): a
   * real probe of the repository's Playwright and its committed `pipenzo.verify.screenshot`
   * command, with the reason attached whenever something is unavailable.
   */
  pipenzoCaptureCapabilities(
    input: PipenzoCaptureCapabilityRequestV1,
  ): Promise<PipenzoCaptureCapabilityV1>;
  /**
   * Turns free text into a structured drafted issue (issue #84). Read-only and creates nothing —
   * filing the draft is a separate `createPipenzoIssue` a human clicks.
   */
  draftPipenzoIssue(input: PipenzoIdeaDraftRequestV1): Promise<PipenzoIdeaDraftResultV1>;
  /**
   * Reads a ticket through the phase machine (issue #188): reconciles the local record against
   * the issue's `pipenzo:` labels before returning it, so what comes back always reflects the
   * label rather than a possibly-stale local lane.
   */
  pipenzoTicketRead(input: PipenzoTicketReadRequestV1): Promise<PipenzoTicketReconciliationV1>;
  /**
   * Moves a ticket to a new `pipenzo:` label (issue #188). The label is the authoritative value —
   * this names the label, not the lane, because several labels share a lane and only the label
   * says why. GitHub is written first, the local record second; see
   * `apps/daemon/src/pipenzo-phase-machine.ts`'s module comment for why that order is self-healing
   * across a crash between the two writes.
   */
  pipenzoTicketTransition(
    input: PipenzoTicketTransitionRequestV1,
  ): Promise<PipenzoTicketReconciliationV1>;
  /**
   * Subscribes to live phase changes (issue #189).
   *
   * One stream carries every ticket, so the board subscribes once and a single-ticket view filters
   * on `ticketId` rather than opening its own connection. Events arrive for a transition the app
   * asked for *and* for a label a human edited on GitHub that a later read reconciled — both are
   * real lane changes, and the label is authoritative for both.
   *
   * Returns its own unsubscribe; call it on unmount.
   */
  onPipenzoPhaseEvent(callback: (event: PipenzoPhaseEventV1) => void): () => void;
  /**
   * The GitHub credential's state, never the credential (issue #165), and what the pre-app gate
   * routes on (issue #113). Mirrors `preload.ts`'s declaration of the same two methods, which is
   * the actual implementation — this interface is the renderer's view of that bridge, and the two
   * were out of step until #113 needed to call these from React.
   *
   * There is deliberately no counterpart that *sets* a token: the device-code flow runs entirely in
   * Electron main, so a `repo`-scoped credential never crosses this bridge in either direction.
   *
   * `disconnectGitHub` is the only write there is, and it is not as small as "forget a token"
   * sounds. The daemon is handed its credential once at spawn, so forgetting one **restarts the
   * daemon** — a `kill()` that is `TerminateProcess` on the packaging platform, which drops every
   * in-flight session uncancelled rather than going through `killDaemon`'s graceful path (see
   * `restartDaemonForCredentialChange` in `main.ts` for the full argument). Call it from a
   * deliberate human action, not from a retry or a lifecycle effect.
   */
  pipenzoGitHubConnection(): Promise<PipenzoGitHubConnectionV1>;
  disconnectGitHub(): Promise<PipenzoGitHubConnectionV1>;
  /**
   * The device-code sign-in (issue #114), which runs entirely in Electron main.
   *
   * `startGitHubDeviceFlow` answers with a pairing code the user is *meant* to read out — never the
   * device code, which for the length of the flow is as good as the token itself. Calling it while
   * an unexpired code is already outstanding returns that same code rather than minting a new one,
   * so this is not a way to hammer GitHub's endpoint. `openGitHubDeviceVerification` takes no
   * argument at all: main opens the URL it validated and pinned to github.com itself, so this
   * cannot be turned into an open-anything primitive. The outcome arrives on the subscription,
   * not as a return value, because the human is in another application for most of the flow.
   */
  startGitHubDeviceFlow(): Promise<PipenzoDeviceCodeV1>;
  openGitHubDeviceVerification(): Promise<void>;
  cancelGitHubDeviceFlow(): Promise<void>;
  onGitHubDeviceOutcome(callback: (outcome: PipenzoDeviceOutcomeV1) => void): () => void;
  selectAndUploadAttachments(sessionId?: string): Promise<AttachmentMetadataV2[]>;
  validateStructuredOutput(input: StructuredWorkflowRequestV2): Promise<StructuredWorkflowResultV2>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  cancelSession(sessionId: string): Promise<void>;
  onSessionEvent(callback: (sessionId: string, event: AgentEvent) => void): () => void;
  createInteractiveSession(input: CreateSessionV2Request): Promise<AgentSessionV2>;
  listInteractiveSessions(options?: SessionListV2Query): Promise<SessionListV2Page>;
  readInteractiveSessionHistory(
    sessionId: string,
    options?: SessionEventHistoryV2Query,
  ): Promise<SessionEventHistoryV2Page>;
  reconnectInteractiveSession(sessionId: string): Promise<AgentSessionV2>;
  resumeInteractiveSession(
    sessionId: string,
    input: SessionContinuationInputV2,
  ): Promise<AgentSessionV2>;
  forkInteractiveSession(
    sessionId: string,
    input: SessionContinuationInputV2,
  ): Promise<AgentSessionV2>;
  deleteInteractiveSession(sessionId: string): Promise<void>;
  sendSessionCommand(command: RendererSessionCommand): Promise<CommandAcknowledgementV2>;
  respondApproval(
    interactionHandle: string,
    decision: ApprovalDecisionV2,
  ): Promise<InteractionResponseAcknowledgement>;
  answerQuestions(
    interactionHandle: string,
    answers: RendererQuestionResponse['answers'],
  ): Promise<InteractionResponseAcknowledgement>;
  cancelInteractiveSession(sessionId: string): Promise<CancelSessionV2Response>;
  onInteractiveSessionEvent(
    callback: (sessionId: string, event: AgentEventV2Envelope) => void,
  ): () => void;
  onInteractiveSessionStreamNotice(
    callback: (sessionId: string, notice: InteractiveSessionStreamNotice) => void,
  ): () => void;
  onInteractionRequested(
    callback: (sessionId: string, interaction: RendererInteraction) => void,
  ): () => void;
  onInteractionResolved(
    callback: (sessionId: string, resolution: RendererInteractionResolution) => void,
  ): () => void;
  inspectWorkspace(cwd: string): Promise<WorkspaceTrustViewV2>;
  setWorkspaceTrust(
    workspaceId: string,
    input: WorkspaceTrustUpdateRequestV2,
  ): Promise<WorkspaceTrustViewV2>;
  readAudit(options?: AuditReadOptionsV2): Promise<AuditReadResponseV2>;
  selectDirectory(): Promise<string | null>;
}

declare global {
  interface Window {
    agentDock: AgentDockBridge;
  }
}

export {};
