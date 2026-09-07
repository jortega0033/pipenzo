import {
  reviewFindingV1Schema,
  type AgentEventEnvelope,
  type CreateSessionV2Request,
  type ReviewFindingV1,
} from '@agent-dock/shared';
import type { StartSessionOptions } from '@agent-dock/agent-runtime';
import { z } from 'zod';
import type { SessionManager } from './session-manager.js';
import type { RefineSessionOutcome, RefineSessionPort } from './refine-subagent.js';
import type { ImplementSessionOutcome, ImplementSessionPort } from './implement-orchestrator.js';
import type { LlmPassOutcome, ReviewSessionPort } from './review-gates.js';

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

function startSession(
  manager: SessionManager,
  request: CreateSessionV2Request,
  sandbox: PhaseSandbox,
): string {
  const session = manager.create(
    request.provider,
    request.cwd,
    request.prompt ?? '',
    undefined, // resumeProviderSessionId
    1, // protocolVersion
    undefined, // workspace
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

  /** The one phase that exists to change files, and so the one that asks for write scope. */
  async run(request: CreateSessionV2Request): Promise<ImplementSessionOutcome> {
    return { sessionId: startSession(this.#manager, request, 'workspace-write') };
  }
}

interface AwaitedSession {
  readonly sessionId: string;
  readonly toolsUsed: readonly string[];
  readonly output: unknown;
}

/** Refine's and Review's port: dispatch, then wait for the session's one terminal event. */
export class AwaitedPhaseSessions implements RefineSessionPort, ReviewSessionPort {
  readonly #manager: SessionManager;
  readonly #timeoutMs: number;

  constructor(options: PhaseSessionOptions) {
    this.#manager = options.sessionManager;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async run(request: CreateSessionV2Request): Promise<RefineSessionOutcome & LlmPassOutcome> {
    const awaited = await this.#await(request);
    const payload = llmPassPayloadSchema.safeParse(awaited.output);
    const findings: ReviewFindingV1[] = payload.success ? [...(payload.data.findings ?? [])] : [];
    return {
      sessionId: awaited.sessionId,
      toolsUsed: awaited.toolsUsed,
      output: awaited.output,
      findings,
      ...(payload.success && payload.data.verdict ? { verdict: payload.data.verdict } : {}),
    };
  }

  async #await(request: CreateSessionV2Request): Promise<AwaitedSession> {
    // Refine and Review both only read: Refine produces a spec, Review produces findings and a
    // verdict, and neither is allowed to edit the tree it is judging. Pinned rather than inherited.
    const sessionId = startSession(this.#manager, request, 'read-only');
    const toolsUsed: string[] = [];
    const texts: string[] = [];
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
          else if (event.type === 'session.completed') {
            finish(() =>
              resolve({ sessionId, toolsUsed, output: extractJsonPayload(texts) }),
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
