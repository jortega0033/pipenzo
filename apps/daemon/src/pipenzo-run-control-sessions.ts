import { randomUUID } from 'node:crypto';
import type { AgentCommandV2 } from '@agent-dock/shared';
import type { V2SessionFacade } from './v2-session-facade.js';

/**
 * The seam onto agentdock's generic V2 session commands (Pipenzo issue #103's Steer/Stop),
 * mirroring `ImplementSessionPort`'s "seam onto agentdock's session machinery" shape in
 * `implement-orchestrator.ts`.
 *
 * `input.steer` and `session.interrupt` are agentdock's own primitives, not something this ticket
 * invents — see `packages/shared/src/protocol-v2.ts` and `V2SessionFacade`'s own
 * `commandMatchesState`. This file adds nothing new to agentdock's protocol; it only narrows
 * `V2SessionFacade` to the three operations `PipenzoPhaseService` needs and builds the two
 * commands it sends.
 *
 * Both commands require the session's *current* `turnId` — `V2SessionFacade.commandMatchesState`
 * refuses anything else with `session_terminal` — so `status()` is what a caller reads that from.
 * It is never cached: every call reads `V2SessionFacade`'s own live metadata, which is exactly the
 * "real session-state data" issue #103 asks a caller to gate on rather than a ticket's own
 * `pipenzo:working` label (reconciler-polled, and blind to a session ending between polls).
 */
export interface PipenzoRunControlSessionPort {
  /** `undefined` when this facade has never seen a session by this id. */
  status(sessionId: string): { readonly active: boolean; readonly turnId?: string } | undefined;
  /** Delivers one instruction at the session's current turn boundary. */
  steer(sessionId: string, turnId: string, instruction: string): Promise<{ readonly ok: boolean }>;
  /** Abandons only the session's current in-flight turn. Never touches a worktree or a commit —
   *  neither this method nor anything it calls reaches that far; see `V2SessionFacade.dispatch()`
   *  and `SessionManager`'s own `session.interrupt` handling, which only calls the provider
   *  transport's `interrupt()`. */
  interrupt(sessionId: string, turnId: string): Promise<{ readonly ok: boolean }>;
}

export class V2RunControlSessions implements PipenzoRunControlSessionPort {
  readonly #facade: V2SessionFacade;

  constructor(facade: V2SessionFacade) {
    this.#facade = facade;
  }

  status(sessionId: string): { active: boolean; turnId?: string } | undefined {
    const session = this.#facade.get(sessionId);
    if (!session) return undefined;
    return {
      active: this.#facade.isActive(sessionId),
      ...(session.currentTurnId ? { turnId: session.currentTurnId } : {}),
    };
  }

  async steer(sessionId: string, turnId: string, instruction: string): Promise<{ ok: boolean }> {
    const command: AgentCommandV2 = {
      commandId: randomUUID(),
      sessionId,
      turnId,
      type: 'input.steer',
      content: [{ type: 'text', id: randomUUID(), text: instruction }],
    };
    const result = await this.#facade.dispatch(command);
    return { ok: result.ok };
  }

  async interrupt(sessionId: string, turnId: string): Promise<{ ok: boolean }> {
    const command: AgentCommandV2 = {
      commandId: randomUUID(),
      sessionId,
      turnId,
      type: 'session.interrupt',
    };
    const result = await this.#facade.dispatch(command);
    return { ok: result.ok };
  }
}
