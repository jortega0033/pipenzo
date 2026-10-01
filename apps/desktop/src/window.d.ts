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
  PipenzoImplementDiffRequestV1,
  PipenzoImplementDiffResultV1,
  PipenzoReviewRequestV1,
  PipenzoReviewResultV1,
  PipenzoIssueClaimRequestV1,
  PipenzoIssueClaimResultV1,
  PipenzoIssueCommentRequestV1,
  PipenzoIssueCommentResultV1,
  PipenzoIssueCreateRequestV1,
  PipenzoIssueCreateResultV1,
  PipenzoCaptureCapabilityRequestV1,
  PipenzoCaptureCapabilityV1,
  PipenzoIdeaDraftRequestV1,
  PipenzoIdeaDraftResultV1,
  PipenzoTicketReadRequestV1,
  PipenzoTicketTransitionRequestV1,
  PipenzoTicketReconciliationV1,
  PipenzoTicketListV1,
  PipenzoPhaseEventV1,
  PipenzoGitHubHealthV1,
  PipenzoConnectReposRequestV1,
  PipenzoConnectedReposV1,
  PipenzoRepoListV1,
  PipenzoRepoCheckoutRequestV1,
  PipenzoRepoCheckoutResultV1,
  PipenzoLessonListV1,
  PipenzoLessonCreateV1,
  PipenzoLessonDeleteRequestV1,
  PipenzoConcurrencySettingsV1,
  PipenzoConcurrencySettingsUpdateV1,
  PipenzoCaptureSettingsV1,
  PipenzoCaptureSettingsUpdateV1,
  PipenzoDeviceCodeV1,
  PipenzoDeviceOutcomeV1,
  PipenzoGitHubConnectionV1,
  PipenzoTicketRiskActivityOpenedRequestV1,
  PipenzoTicketRiskApprovalOutcomeRequestV1,
  PipenzoTicketRiskResponseV1,
  PipenzoRunStatusRequestV1,
  PipenzoRunStatusResultV1,
  PipenzoSteerRequestV1,
  PipenzoSteerResultV1,
  PipenzoStopRequestV1,
  PipenzoStopResultV1,
  PipenzoMediumApprovalCaptureRequestV1,
  PipenzoMediumApprovalCaptureResultV1,
  PipenzoMediumApprovalDecideRequestV1,
  PipenzoMediumApprovalDecideResultV1,
  PipenzoMediumApprovalStatusRequestV1,
  PipenzoMediumApprovalStatusResultV1,
  PipenzoMediumApprovalUndoRequestV1,
  PipenzoMediumApprovalUndoResultV1,
  PipenzoHighApprovalCaptureRequestV1,
  PipenzoHighApprovalCaptureResultV1,
  PipenzoHighApprovalDecideRequestV1,
  PipenzoHighApprovalDecideResultV1,
  PipenzoStackApprovalCaptureRequestV1,
  PipenzoStackApprovalCaptureResultV1,
  PipenzoStackApprovalDecideRequestV1,
  PipenzoStackApprovalDecideResultV1,
  PipenzoPlanReviewCaptureRequestV1,
  PipenzoPlanReviewCaptureResultV1,
  PipenzoPlanReviewDecideRequestV1,
  PipenzoPlanReviewDecideResultV1,
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
  /** Reads the unified diff for a commit range already known to exist in an owned worktree
   * (issue #90's stack, step 2) -- what `DiffFileList.tsx` renders. */
  implementDiffPipenzo(input: PipenzoImplementDiffRequestV1): Promise<PipenzoImplementDiffResultV1>;
  /**
   * Runs the Review gates in order: deterministic gates first, then the advisory reviewer, then
   * the adversarial verifier — and a deterministic failure returns before either LLM pass is
   * constructed.
   */
  reviewPipenzo(input: PipenzoReviewRequestV1): Promise<PipenzoReviewResultV1>;
  /**
   * Live run controls (issue #103): Steer/Stop for a ticket's dispatched Implement session,
   * addressed by ticket id only -- the daemon resolves which session that is. `runStatusPipenzo`
   * is a read-only poll for `RunControls.tsx`'s own "present only while genuinely running" gate;
   * `steerPipenzo` delivers one instruction at the session's current turn boundary without ever
   * touching the ticket's approved spec; `stopPipenzo` abandons only that turn and parks the
   * ticket on `pipenzo:needs-human`, never discarding a commit or the worktree.
   */
  runStatusPipenzo(input: PipenzoRunStatusRequestV1): Promise<PipenzoRunStatusResultV1>;
  steerPipenzo(input: PipenzoSteerRequestV1): Promise<PipenzoSteerResultV1>;
  stopPipenzo(input: PipenzoStopRequestV1): Promise<PipenzoStopResultV1>;
  /**
   * The claim pre-flight (issue #83). Assigns the issue and then re-reads it uncached; an
   * `claimed_elsewhere` outcome means the race was lost and the ticket must not be started.
   */
  claimPipenzoIssue(input: PipenzoIssueClaimRequestV1): Promise<PipenzoIssueClaimResultV1>;
  /** Files a drafted issue (issue #84). Call only after a human approves the preview. */
  createPipenzoIssue(input: PipenzoIssueCreateRequestV1): Promise<PipenzoIssueCreateResultV1>;
  /**
   * Posts one comment on an issue (issue #228) -- what #100's refusal panel and #144's
   * blown-estimate record will publish through. Nothing in the renderer calls it yet; it is wired
   * ahead of those panels so the route is reachable rather than shipped dark. The body becomes
   * public under the operator's GitHub identity, so like `createPipenzoIssue` it must only ever be
   * called from a human's click, never on an agent's behalf -- and there is no retry behind it,
   * because GitHub has no idempotency key for a comment.
   */
  commentOnPipenzoIssue(input: PipenzoIssueCommentRequestV1): Promise<PipenzoIssueCommentResultV1>;
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
   * The board's list route (issue #255): every ticket the daemon's local store knows about,
   * already label-wins reconciled by the polling reconciler (#231) in the background. Cheaper than
   * `pipenzoTicketRead` by design — no GitHub call per ticket, so a screen may call this on mount
   * without the per-ticket rate limit `pipenzoTicketRead`/`pipenzoTicketTransition` carry. A ticket
   * here can be up to one reconciler interval stale; a caller that needs one ticket reconciled right
   * now still wants `pipenzoTicketRead`.
   */
  pipenzoListTickets(): Promise<PipenzoTicketListV1>;
  /**
   * Records a human's Allow/Reject outcome for a MEDIUM- or HIGH-graded action against the
   * cumulative risk score (issues #95/#97/#98). A HIGH approval resets the score; a MEDIUM approval
   * deliberately does not — see `risk-score.ts`'s own doc comment on `recordApprovalOutcome`.
   */
  pipenzoRecordRiskApprovalOutcome(
    input: PipenzoTicketRiskApprovalOutcomeRequestV1,
  ): Promise<PipenzoTicketRiskResponseV1>;
  /**
   * The reset rule's other half (issue #119): opening the ticket's Activity view always resets the
   * cumulative risk score to zero, unconditionally — see `risk-score.ts`'s own doc comment on
   * `recordActivityOpened` for why there is no "opened but doesn't count" case.
   */
  pipenzoRecordRiskActivityOpened(
    input: PipenzoTicketRiskActivityOpenedRequestV1,
  ): Promise<PipenzoTicketRiskResponseV1>;
  /**
   * The MEDIUM inline approval flow (issue #97), four calls for one gate's lifecycle:
   *
   * - `captureMediumApproval` snapshots the worktree's pre-action state for `touchedPaths` *before*
   *   the gated action is dispatched — "block run" in practice means a caller must hold this call's
   *   `snapshotId` before running the action at all.
   * - `decideMediumApproval` records the human's Allow/Reject. An `'allow'` also records the risk
   *   score outcome daemon-side (`pipenzoRecordRiskApprovalOutcome`'s own logic, applied
   *   server-side so the two can never be called out of order) and returns the ticket's risk record;
   *   a `'reject'` never touches the score.
   * - `mediumApprovalStatus` is a live, read-only poll for the resolved-line UI: whether Undo is
   *   still available, per issue #148's commit-based (not time-based) expiry.
   * - `undoMediumApproval` performs the one-shot restore.
   */
  captureMediumApproval(
    input: PipenzoMediumApprovalCaptureRequestV1,
  ): Promise<PipenzoMediumApprovalCaptureResultV1>;
  decideMediumApproval(
    input: PipenzoMediumApprovalDecideRequestV1,
  ): Promise<PipenzoMediumApprovalDecideResultV1>;
  mediumApprovalStatus(
    input: PipenzoMediumApprovalStatusRequestV1,
  ): Promise<PipenzoMediumApprovalStatusResultV1>;
  undoMediumApproval(
    input: PipenzoMediumApprovalUndoRequestV1,
  ): Promise<PipenzoMediumApprovalUndoResultV1>;
  /**
   * The HIGH full publish-gate card (issue #98), the HIGH-risk sibling of the four MEDIUM calls
   * above -- two calls, not four, since HIGH never offers Undo (see
   * `pipenzo-high-approval-v1.ts`'s module comment):
   *
   * - `captureHighApproval` records which ticket/branch a HIGH decision is about *before* the card
   *   is shown -- "block run" in practice means a caller must hold this call's `approvalId` before
   *   running the gated action at all.
   * - `decideHighApproval` records the human's Approve/Reject. An `'approve'` also resets the
   *   cumulative-risk strip to zero daemon-side (the asymmetric reset rule's HIGH half) and returns
   *   the ticket's risk record; a `'reject'` requires a non-empty `reason` (enforced on the wire, not
   *   just by a disabled button) and never touches the score.
   */
  captureHighApproval(
    input: PipenzoHighApprovalCaptureRequestV1,
  ): Promise<PipenzoHighApprovalCaptureResultV1>;
  decideHighApproval(
    input: PipenzoHighApprovalDecideRequestV1,
  ): Promise<PipenzoHighApprovalDecideResultV1>;
  /**
   * The stack approval panel (issue #99), for a ticket the diff-size gate parked on
   * `pipenzo:awaiting-stack-approval` from a Refine-time `stack` verdict -- same two-call,
   * capture-then-decide shape as HIGH above:
   *
   * - `captureStackApproval` freezes the ticket's currently-proposed split (`RefineSpecV1
   *   .proposedSplit`, cached on the ticket record) and returns it alongside a fresh `approvalId`.
   * - `decideStackApproval` records the human's Accept/Reject. An `'accept'` needs the
   *   human-approved `order` (a permutation of the captured parts' indices) and a
   *   `repositoryPath` to provision each child's worktree in, and returns the real child tickets
   *   created; a `'reject'` requires a non-empty `reason` (enforced on the wire, not just by a
   *   disabled button) and posts it as a comment on the original issue.
   */
  captureStackApproval(
    input: PipenzoStackApprovalCaptureRequestV1,
  ): Promise<PipenzoStackApprovalCaptureResultV1>;
  decideStackApproval(
    input: PipenzoStackApprovalDecideRequestV1,
  ): Promise<PipenzoStackApprovalDecideResultV1>;
  /**
   * The plan-review gate (issue #15, UI half #101), for a ticket Refine parked in the bare
   * `pipenzo:needs-human` lane (its local `awaitingPlanReview` marker set) after a clean verdict --
   * the real blocking checkpoint between Refine completing and Implement starting, same two-call,
   * capture-then-decide shape as HIGH and stack approval above:
   *
   * - `capturePlanReview` freezes the ticket's cached plan (`RefineSpecV1`, narrowed to the fields a
   *   human actually reviews) and returns it alongside a fresh `approvalId`.
   * - `decidePlanReview` records the human's Approve/Request changes/Reject. `'approve'` needs the
   *   same inputs Implement itself dispatches with and returns the real started session; it is the
   *   only path that moves the ticket off this gate into a running Implement session.
   *   `'request_changes'` requires non-empty `feedback`, which the *next* Refine pass for this
   *   ticket reads back. `'reject'` requires a non-empty `reason` (enforced on the wire, not just by
   *   a disabled button) and parks the ticket in the bare `pipenzo:needs-human` lane.
   */
  capturePlanReview(
    input: PipenzoPlanReviewCaptureRequestV1,
  ): Promise<PipenzoPlanReviewCaptureResultV1>;
  decidePlanReview(
    input: PipenzoPlanReviewDecideRequestV1,
  ): Promise<PipenzoPlanReviewDecideResultV1>;
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
   * The GitHub connection-health stream (issue #257): the current `PipenzoGitHubHealthV1` (#230)
   * immediately on subscribe, then a live update on every change the reconciler (#231) publishes.
   * Mirrors `preload.ts`'s declaration of the same method. Returns its own unsubscribe.
   */
  onPipenzoGitHubHealth(callback: (health: PipenzoGitHubHealthV1) => void): () => void;
  /**
   * "Retry now" / "Poll now" (#70/#71/#75). Mirrors `preload.ts`'s declaration of the same method.
   */
  pollGitHubHealthNow(): Promise<void>;
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
  /**
   * The repo picker (issue #115).
   *
   * `pipenzoListRepos` answers with every repository this credential can **write** to — the daemon
   * filters on GitHub's own `permissions.push`, because a repository Pipenzo can only read is one
   * it can never manage. It walks GitHub's pagination on the daemon side and answers once, so the
   * picker's filter searches the whole set rather than only the pages it happens to have; the
   * `truncated` flag says when even that hit its page cap. The daemon caches the answer for a
   * minute, because one call fans out to as many as fifty GitHub requests.
   *
   * `pipenzoConnectRepos` replaces the whole list rather than adding to it: the writer is a set of
   * checkboxes, and unticking one has to mean something — so a caller must send the complete
   * selection, including anything connected that its own listing could not show.
   */
  pipenzoListRepos(): Promise<PipenzoRepoListV1>;
  pipenzoConnectedRepos(): Promise<PipenzoConnectedReposV1>;
  pipenzoConnectRepos(input: PipenzoConnectReposRequestV1): Promise<PipenzoConnectedReposV1>;
  /**
   * A connected repository's managed local checkout (issues #342/#344): the `repositoryPath` the
   * board's Implement dialog passes to refine and implement. The daemon clones it on first need, so
   * a first call can take as long as a clone; it refuses any repository that is not connected.
   */
  resolvePipenzoCheckout(input: PipenzoRepoCheckoutRequestV1): Promise<PipenzoRepoCheckoutResultV1>;
  /**
   * Local, human-gated lesson memory (issue #18): Settings' lesson-memory panel (issue #128) and
   * `LessonPrompt`'s "Save lesson" button (issue #104). `pipenzoCreateLesson`/`pipenzoDeleteLesson`
   * each answer with the daemon's own list afterward, never a filtered view this renderer assembled
   * itself.
   */
  pipenzoLessons(): Promise<PipenzoLessonListV1>;
  pipenzoCreateLesson(input: PipenzoLessonCreateV1): Promise<PipenzoLessonListV1>;
  pipenzoDeleteLesson(input: PipenzoLessonDeleteRequestV1): Promise<PipenzoLessonListV1>;
  /**
   * Bounded local concurrency's settings (issue #126): Settings' Concurrency panel. An ordinary
   * daemon route, same reasoning as the lesson/repo channels above -- no credential in main.
   */
  pipenzoConcurrencySettings(): Promise<PipenzoConcurrencySettingsV1>;
  pipenzoUpdateConcurrencySettings(
    input: PipenzoConcurrencySettingsUpdateV1,
  ): Promise<PipenzoConcurrencySettingsV1>;
  /**
   * The Models & gates screen's agent-captured panel (issue #470): the
   * `screenshotEnabled`/`escapeHatchEnabled` preference. An ordinary daemon route, same reasoning
   * as the lesson/repo/concurrency channels above -- no credential in main.
   */
  pipenzoCaptureSettings(): Promise<PipenzoCaptureSettingsV1>;
  pipenzoUpdateCaptureSettings(
    input: PipenzoCaptureSettingsUpdateV1,
  ): Promise<PipenzoCaptureSettingsV1>;
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
