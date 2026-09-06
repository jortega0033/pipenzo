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
