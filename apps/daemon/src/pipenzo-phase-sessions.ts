import { realpath } from 'node:fs';
import { promisify } from 'node:util';
import {
  reviewFindingV1Schema,
  type AgentEventEnvelope,
  type CreateSessionV2Request,
  type PermissionActionV2,
  type ProviderId,
  type ReviewFindingV1,
} from '@agent-dock/shared';
import {
  CLAUDE_CLI_SANDBOX_TOOLS,
  claudeToolEffects,
  type StartSessionOptions,
} from '@agent-dock/agent-runtime';
import { z } from 'zod';
import { normalizeEffectsAction } from './permission-policy.js';
import { WorkspaceAccessError, type SessionManager } from './session-manager.js';
import {
  evaluateRefinePermission,
  type RefineSessionOutcome,
  type RefineSessionPort,
} from './refine-subagent.js';
import {
  evaluateImplementPermission,
  type ImplementSessionEnd,
  type ImplementSessionOutcome,
  type ImplementSessionPort,
} from './implement-orchestrator.js';
import type { LlmPassOutcome, ReviewSessionPort } from './review-gates.js';
import { resolveWorkspaceIdentity, type WorkspaceIdentity } from './workspace-identity.js';
import { isWorkspaceTrusted } from './workspace-trust-guard.js';
import type { WorkspaceTrustStore } from './workspace-trust-store.js';

/**
 * The real adapters between the phase modules' session ports (issues #179-181) and agentdock's own
 * `SessionManager` (Pipenzo issue #184).
 *
 * The three modules were written against ports precisely so they could be unit-tested without a
 * provider subprocess. Nothing had implemented those ports against the real session machinery yet,
 * which is why none of the three had a route. This is that implementation, and there are two of
 * them because the phases genuinely want different things:
 *
 * - `DispatchOnlyPhaseSessions` starts a session and returns its id. Implement uses it: the
 *   session is long, the renderer streams it through the session routes it already speaks, and
 *   the daemon has nothing useful to do while it runs.
 * - `AwaitedPhaseSessions` starts a session and waits for its terminal event, collecting the tools
 *   it used and the JSON payload it ended with. Refine and Review use it, because both produce a
 *   value — a spec, a set of findings and a verdict — that only makes sense whole.
 *
 * ## Walking-skeleton simplification, stated rather than hidden
 *
 * `buildRefineSessionRequest()` sets `outputSchema`, and agentdock's structured-output capability
 * is negotiated on the **interactive v2** session path. These adapters use the simpler legacy
 * dispatch (`SessionManager.create`), so the schema is not enforced by the provider and the
 * payload is recovered from the session's final JSON block instead. That is *weaker*, and it is
 * why nothing here trusts it: `parseRefineSpec()` re-validates with Zod on the way out, exactly as
 * it would have done anyway ("a provider's structured-output guarantee is not something to take on
 * trust at a phase boundary"). Moving these onto the interactive path is a follow-up, not a
 * silent gap — a payload that does not parse fails the phase rather than being waved through.
 *
 * ## What a phase session is allowed to do, decided here rather than inherited
 *
 * The legacy path has no per-call permission callback, and a bare `claude -p` inherits whatever the
 * operator's own Claude settings allow plus any hooks in the repository's `.claude/settings.json`.
 * A Refine prompt carries an issue body a stranger may have written, and Implement's prompt is
 * built from the spec Refine derived from it, so every phase is inside a prompt-injection blast
 * radius. Three things close that before a provider process exists:
 *
 * 1. **A stated sandbox per phase** (issue #191): `read-only` for Refine, Draft and Review,
 *    `workspace-write` for Implement. For Claude that scope is a real launch restriction
 *    (`buildClaudeArgs()`: an explicit `--tools` set, a `--disallowedTools` floor, a fail-closed
 *    permission mode, no settings files, no MCP servers).
 * 2. **The phase's permission evaluator judges that grant before dispatch.** Every tool the Claude
 *    session will be launched with is classified with agentdock's own effects table and run through
 *    `evaluateRefinePermission()` (read-only phases) or `evaluateImplementPermission()`; a single
 *    denial refuses the dispatch (`assertPhaseToolGrant()`). Widening a grant past what a phase's
 *    evaluator allows is therefore a refused session, not a silently wider one.
 * 3. **Workspace trust for a caller-named repository.** Refine and Draft read a repository path
 *    the renderer sends. With a trust store configured, that path must resolve to a trusted
 *    workspace — the same check `/sessions` applies — and the session is bound to that workspace
 *    identity, so a revocation blocks or cancels it. Review and Implement run in daemon-owned
 *    worktrees whose trust is checked against the source repository by `OwnedWorktreeManager`.
 *
 * **Codex phases are refused, fail-closed.** `codex exec` has no tool list to restrict: its
 * `--sandbox` scope is the whole restriction and it leaves the shell available, it still loads the
 * operator's own Codex config including any `mcp_servers` (which run outside that sandbox), and a
 * process a Codex session spawns can outlive the session and race the daemon's post-session
 * commit over the worktree it controls. Every Codex grant includes a command, which every phase
 * evaluator denies, so `assertProviderGrant()` refuses Codex rather than skipping the check.
 * Re-enabling it needs Codex's MCP and approval config pinned and live-verified first.
 */

/** Recovers the last well-formed JSON object a session emitted. */
export function extractJsonPayload(texts: readonly string[]): unknown {
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const parsed = parseJsonBlock(texts[index] ?? '');
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseJsonBlock(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  const candidates: string[] = [];
  for (const match of text.matchAll(fenced)) if (match[1]) candidates.push(match[1]);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) candidates.push(trimmed);
  // Last fenced block first: a model that explains itself and then answers puts the answer last.
  for (const candidate of candidates.reverse()) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value;
    } catch {
      // Not JSON. Try the next candidate rather than failing the whole extraction on one miss.
    }
  }
  return undefined;
}

/** What an LLM review or verifier pass is required to end with. Re-validated, never trusted. */
export const llmPassPayloadSchema = z
  .object({
    findings: z.array(reviewFindingV1Schema).max(200).optional(),
    verdict: z.enum(['approved', 'rejected']).optional(),
  })
  .passthrough();

export interface PhaseSessionOptions {
  sessionManager: SessionManager;
  /**
   * How long a phase session may run before the adapter stops waiting. A phase that never
   * terminates must not pin an HTTP request open forever; this turns that into a typed failure the
   * route can report. The session itself is cancelled, not abandoned.
   */
  timeoutMs?: number;
}

export interface AwaitedPhaseSessionOptions extends PhaseSessionOptions {
  /**
   * Required, so every construction site states which one it is. A trust store means the request's
   * `cwd` is a caller-named repository (Refine, Draft) and must be a trusted workspace before
   * anything is dispatched into it. `'daemon-owned-worktree'` means the `cwd` is a worktree the
   * daemon resolved by id itself (Review), whose trust was bound to its source repository when
   * `OwnedWorktreeManager` created it.
   */
  workspaceTrust: WorkspaceTrustStore | 'daemon-owned-worktree';
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export class PhaseSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhaseSessionError';
  }
}

/**
 * The provider sandbox scope a phase runs under, stated at every call site rather than inherited
 * from whatever the provider CLI happens to default to (issue #191).
 *
 * Both values below used to be one missing argument. `SessionManager.create` takes the sandbox as
 * its eighth positional parameter and spreads it only when truthy, so the `undefined` this helper
 * used to pass arrived at `buildCodexArgs` as "emit no `--sandbox` flag" and `codex exec` fell back
 * to its own default, which is read-only. Implement could therefore never write a file: it planned
 * correctly, produced a correct patch, and had every `apply_patch` refused -- silently, because a
 * phase that writes nothing still terminates successfully and still returns a session id. Observed
 * end to end against this repository's own issue #78, which ran for fifteen minutes and left its
 * worktree byte-for-byte clean.
 *
 * Pinning Refine and Review is the half that outlives the bug. They were read-only before this only
 * because codex's default happened to agree with them -- a change to that default upstream would
 * have handed the read-only Refine subagent (#179) write access to the operator's worktree without
 * a line of Pipenzo changing. A scope that decides whether an agent can edit the working tree is
 * stated, not inherited.
 */
type PhaseSandbox = NonNullable<StartSessionOptions['sandbox']>;

const nativeRealpath = promisify(realpath.native);

/** A phase's fail-closed permission shape: exactly what `evaluate*Permission()` return. */
export type PhasePermissionEvaluator = (action: PermissionActionV2) => {
  readonly outcome: 'allow' | 'deny';
  readonly reason: string;
};

/**
 * The action the daemon derives for a Claude built-in tool: agentdock's own effects table
 * (`claudeToolEffects`, the one the SDK transport classifies every call with) normalized the same
 * way an approval request is. An unknown tool comes out as an incompletely-described external
 * side effect, which every phase evaluator denies.
 */
export function claudeToolAction(tool: string): PermissionActionV2 {
  return normalizeEffectsAction({ ...claudeToolEffects(tool), target: `tool:${tool}` });
}

/**
 * Refuses a tool grant the phase's own evaluator would deny for any one of its tools. Throws
 * before anything is dispatched, with the offending tools and reasons as the message.
 */
export function assertPhaseToolGrant(
  tools: readonly string[],
  evaluate: PhasePermissionEvaluator,
): void {
  const denied = tools
    .map((tool) => ({ tool, verdict: evaluate(claudeToolAction(tool)) }))
    .filter(({ verdict }) => verdict.outcome !== 'allow')
    .map(({ tool, verdict }) => `${tool}: ${verdict.reason}`);
  if (denied.length > 0) {
    throw new PhaseSessionError(
      `the phase session was not dispatched: its tool grant exceeds the phase's permissions (${denied.join(', ')})`,
    );
  }
}

function assertProviderGrant(
  provider: ProviderId,
  sandbox: PhaseSandbox,
  evaluate: PhasePermissionEvaluator,
): void {
  switch (provider) {
    case 'claude':
      assertPhaseToolGrant(CLAUDE_CLI_SANDBOX_TOOLS[sandbox], evaluate);
      return;
    case 'codex':
      // Fail closed. `codex exec` has no tool list to judge: it keeps a shell, loads the operator's
      // MCP servers outside its sandbox, and a process it spawns can outlive the session and race
      // the daemon's post-session commit. See the module comment.
      throw new PhaseSessionError(
        'phase sessions are not available on Codex yet: its launch cannot be restricted to the phase’s tools',
      );
    default: {
      const unreachable: never = provider;
      throw new PhaseSessionError(
        `no phase tool grant is defined for provider ${String(unreachable)}`,
      );
    }
  }
}

/** The `/sessions` route's admission check, for a phase whose `cwd` the caller named. */
async function trustedWorkspace(
  trustStore: WorkspaceTrustStore,
  cwd: string,
): Promise<WorkspaceIdentity> {
  const workspace = await resolveWorkspaceIdentity(cwd).catch(() => undefined);
  if (!workspace || !(await isWorkspaceTrusted(trustStore, workspace))) {
    throw new WorkspaceAccessError('workspace is not trusted');
  }
  return workspace;
}

async function startSession(
  manager: SessionManager,
  request: CreateSessionV2Request,
  sandbox: PhaseSandbox,
  evaluate: PhasePermissionEvaluator,
  workspaceTrust: WorkspaceTrustStore | 'daemon-owned-worktree',
): Promise<string> {
  assertProviderGrant(request.provider, sandbox, evaluate);
  // Issue #105's same-tier retry: `request.continuation` was unused here before this ticket --
  // every existing caller (Refine, Review, Implement's own first dispatch) never sets it. A fork
  // continues the prior attempt's provider-native session via the legacy dispatch's own
  // `resumeProviderSessionId` parameter, which is this codebase's real equivalent of agentdock's V2
  // `session.fork` for phase sessions (Implement does not run on the V2 protocol -- see this
  // module's own doc comment). CLAUDE.md hard rule 4's "a fork cannot change model" is enforced here,
  // fail closed, rather than left to whichever caller happens to build the request correctly: a
  // request that asks to continue a session *and* pick a model is refused outright, never silently
  // resolved by preferring one over the other.
  if (request.continuation && request.model) {
    throw new PhaseSessionError(
      'a continued phase session cannot select a model -- the provider-native thread is frozen to the model it started with',
    );
  }
  const workspace =
    workspaceTrust === 'daemon-owned-worktree'
      ? undefined
      : await trustedWorkspace(workspaceTrust, request.cwd);
  // The OS's own spelling of the path (`realpath.native`): Claude Code compares a tool's target with
  // its working directory by the long form, so a cwd spelled with an 8.3 short name (`GEBRUI~1`)
  // makes every in-tree read look like an out-of-tree one, which the phase's fail-closed permission
  // mode then denies. Observed live against a `%TEMP%` path.
  const cwd = workspace?.canonicalPath ?? request.cwd;
  const launchCwd = await nativeRealpath(cwd).catch(() => cwd);
  const session = manager.create(
    request.provider,
    launchCwd,
    request.prompt ?? '',
    request.continuation?.providerSessionId, // resumeProviderSessionId -- issue #105's fork retry
    1, // protocolVersion
    workspace, // binds the session to it: a blocked or revoked workspace refuses or cancels it
    undefined, // providerStatus
    sandbox,
    request.model,
  );
  return session.id;
}

/** Implement's port: dispatch and return. */
export class DispatchOnlyPhaseSessions implements ImplementSessionPort {
  readonly #manager: SessionManager;

  constructor(options: PhaseSessionOptions) {
    this.#manager = options.sessionManager;
  }

  /**
   * The one phase that exists to change files, and so the one that asks for write scope — and
   * only that: `evaluateImplementPermission()` denies anything that could run a command or reach
   * the network. Its `cwd` is the owned worktree `ImplementOrchestrator` just created, after
   * `OwnedWorktreeManager` checked the source repository's trust.
   */
  async run(request: CreateSessionV2Request): Promise<ImplementSessionOutcome> {
    const sessionId = await startSession(
      this.#manager,
      request,
      'workspace-write',
      evaluateImplementPermission,
      'daemon-owned-worktree',
    );
    // Still dispatch-only: `ended`/`tokensUsed` are promises the orchestrator (and, through it,
    // `PipenzoPhaseService`) hang their own post-session work on, not something this call waits for.
    const observed = observeImplementSession(this.#manager, sessionId);
    return { sessionId, ended: observed.ended, tokensUsed: observed.tokensUsed };
  }
}

interface ObservedImplementSession {
  readonly ended: Promise<ImplementSessionEnd>;
  /**
   * Settles with the session's total provider token usage (Pipenzo issue #143), once the session
   * reaches its terminal event -- 0 if it never reported a `usage` event, or could not be
   * observed at all. Never rejects, for the same reason `ended` never does: a usage report that
   * cannot be recovered must read as "nothing to add", not as a failure that could cascade into
   * the orchestrator's own commit path. See `usageEventTokens()` for why this is the *last*
   * `usage` event's own numbers, not a sum across every one observed.
   */
  readonly tokensUsed: Promise<number>;
}

/**
 * Settles with how a session ended, once its terminal event is recorded, and with the total
 * tokens it reported along the way. One subscription rather than two: `SessionManager.subscribe`
 * replays a session's whole recorded history synchronously before returning, so two independent
 * subscriptions would each have to solve the same "already terminated by the time I subscribed"
 * race `AwaitedPhaseSessions.#await` documents -- one subscription sidesteps it by construction.
 *
 * Never rejects: a session that cannot be observed reads as `failed` / `0` tokens, which the
 * orchestrator already treats as "commit nothing" and a usage caller reads as "nothing to add".
 */
function observeImplementSession(
  manager: SessionManager,
  sessionId: string,
): ObservedImplementSession {
  let resolveEnded!: (end: ImplementSessionEnd) => void;
  let resolveTokens!: (tokens: number) => void;
  const ended = new Promise<ImplementSessionEnd>((resolve) => {
    resolveEnded = resolve;
  });
  const tokensUsed = new Promise<number>((resolve) => {
    resolveTokens = resolve;
  });

  let settled = false;
  let tokens = 0;
  // Same replay subtlety as `AwaitedPhaseSessions.#await`: `subscribe()` replays synchronously,
  // so a session that already ended settles this before there is anything to unsubscribe.
  const observer: { off?: () => void } = {};
  const finish = (end: ImplementSessionEnd): void => {
    if (settled) return;
    settled = true;
    observer.off?.();
    resolveEnded(end);
    resolveTokens(tokens);
  };
  const subscription = manager.subscribe(
    sessionId,
    0,
    (_index, event: AgentEventEnvelope) => {
      if (event.type === 'usage') {
        tokens = usageEventTokens(event);
      } else if (event.type === 'session.completed') {
        finish('completed');
      } else if (event.type === 'session.failed') {
        finish('failed');
      } else if (event.type === 'session.cancelled') {
        finish('cancelled');
      }
    },
    1,
  );
  observer.off = subscription;
  if (!subscription) finish('failed');
  else if (settled) subscription();

  return { ended, tokensUsed };
}

/**
 * How much of a `usage` event's own numbers count toward a ticket's token budget (Pipenzo issue
 * #143). Every field is optional on the wire (`AgentEvent`'s `usage` variant), so each is treated
 * as `0` when absent rather than making the whole event uncountable -- a provider that reports
 * `outputTokens` but not `inputTokens` on a given turn still has real usage to record.
 *
 * `cachedInputTokens` is included alongside `inputTokens`/`outputTokens`, not netted against
 * them. A cache read is billed at a fraction of a fresh input token, not zero, and a ticket's
 * budget exists to bound real provider spend -- undercounting a heavy cache-read session would
 * defeat that, and this module has no per-provider pricing table to net it out correctly even if
 * it wanted to.
 *
 * ## Why the caller keeps only the *last* observed `usage` event, not a running sum
 *
 * Claude's own CLI (`claude -p --output-format stream-json`, see `parseClaudeLine` in
 * `packages/agent-runtime`) emits a `usage` event for *every* assistant/user message, each
 * carrying that individual API call's own numbers, and then one more at the final `result` line
 * carrying the CLI's own already-cumulative total for the whole invocation. A multi-turn session's
 * per-message `input_tokens` grows with the conversation, because each call re-sends the prior
 * turns as context -- so summing every `usage` event this session emits would count that growing
 * context repeatedly, once per turn, and then a second time over via the final cumulative report.
 * Keeping only the last one observed before the terminal event lands on the CLI's own total
 * instead, which is exactly the number a token budget should bound.
 */
function usageEventTokens(event: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }): number {
  return (event.inputTokens ?? 0) + (event.outputTokens ?? 0) + (event.cachedInputTokens ?? 0);
}

interface AwaitedSession {
  readonly sessionId: string;
  readonly toolsUsed: readonly string[];
  readonly output: unknown;
  /** See `usageEventTokens()`'s doc comment: the last `usage` event's own numbers, not a sum. */
  readonly tokensUsed: number;
}

/** Refine's and Review's port: dispatch, then wait for the session's one terminal event. */
export class AwaitedPhaseSessions implements RefineSessionPort, ReviewSessionPort {
  readonly #manager: SessionManager;
  readonly #timeoutMs: number;
  readonly #workspaceTrust: WorkspaceTrustStore | 'daemon-owned-worktree';

  constructor(options: AwaitedPhaseSessionOptions) {
    this.#manager = options.sessionManager;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#workspaceTrust = options.workspaceTrust;
  }

  /** Refine's pre-baseline admission check (see `RefineSessionPort.admit`). */
  async admit(cwd: string): Promise<void> {
    if (this.#workspaceTrust !== 'daemon-owned-worktree') {
      await trustedWorkspace(this.#workspaceTrust, cwd);
    }
  }

  async run(request: CreateSessionV2Request): Promise<RefineSessionOutcome & LlmPassOutcome> {
    const awaited = await this.#await(request);
    const payload = llmPassPayloadSchema.safeParse(awaited.output);
    const findings: ReviewFindingV1[] = payload.success ? [...(payload.data.findings ?? [])] : [];
    return {
      sessionId: awaited.sessionId,
      toolsUsed: awaited.toolsUsed,
      output: awaited.output,
      tokensUsed: awaited.tokensUsed,
      findings,
      ...(payload.success && payload.data.verdict ? { verdict: payload.data.verdict } : {}),
    };
  }

  async #await(request: CreateSessionV2Request): Promise<AwaitedSession> {
    // Refine and Review both only read: Refine produces a spec, Review produces findings and a
    // verdict, and neither is allowed to edit the tree it is judging. Pinned rather than inherited,
    // and judged by the read-only evaluator before dispatch (Review's shape is Refine's exactly).
    const sessionId = await startSession(
      this.#manager,
      request,
      'read-only',
      evaluateRefinePermission,
      this.#workspaceTrust,
    );
    const toolsUsed: string[] = [];
    const texts: string[] = [];
    let tokensUsed = 0;
    return new Promise<AwaitedSession>((resolve, reject) => {
      let settled = false;
      // `subscribe()` replays everything already recorded *synchronously, before it returns*, so a
      // session that has already terminated settles this promise while there is still nothing to
      // unsubscribe from. Hence a holder the listener can read through rather than a binding that
      // does not exist yet, plus the catch-up call after `subscribe()` returns.
      const observer: { off?: () => void } = {};
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer.off?.();
        action();
      };
      const timer = setTimeout(() => {
        finish(() => {
          void this.#manager.cancel(sessionId, 1).catch(() => undefined);
          reject(new PhaseSessionError('the phase session exceeded its time budget'));
        });
      }, this.#timeoutMs);
      // Node keeps the process alive for a pending timer; a phase timeout should never be the
      // reason the daemon cannot shut down.
      timer.unref?.();

      const subscription = this.#manager.subscribe(
        sessionId,
        0,
        (_index, event: AgentEventEnvelope) => {
          if (event.type === 'tool.started') toolsUsed.push(event.toolName);
          else if (event.type === 'assistant.message') texts.push(event.text);
          else if (event.type === 'usage') tokensUsed = usageEventTokens(event);
          else if (event.type === 'session.completed') {
            finish(() =>
              resolve({ sessionId, toolsUsed, output: extractJsonPayload(texts), tokensUsed }),
            );
          } else if (event.type === 'session.failed') {
            finish(() => reject(new PhaseSessionError(event.message)));
          } else if (event.type === 'session.cancelled') {
            finish(() => reject(new PhaseSessionError('the phase session was cancelled')));
          }
        },
        1,
      );
      observer.off = subscription;
      if (!subscription) {
        finish(() => reject(new PhaseSessionError('the phase session could not be observed')));
      } else if (settled) {
        // Settled during the synchronous replay above, before the holder was filled in.
        subscription();
      }
    });
  }
}
