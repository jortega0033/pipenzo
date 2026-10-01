import type { SessionManager } from './session-manager.js';

/**
 * The one extra fact `PipenzoPhaseService.retryImplement()` needs that `ImplementSessionPort`
 * itself has no reason to expose (issue #105): a prior attempt's own provider-native session id, so
 * a same-tier retry can continue it via `startSession()`'s own `resumeProviderSessionId` (see
 * `pipenzo-phase-sessions.ts`'s own doc comment on why that parameter, not agentdock's V2
 * `session.fork`, is this codebase's real fork mechanism for phase sessions). Mirrors
 * `pipenzo-run-control-sessions.ts`'s own "narrow the real session manager down to exactly the one
 * operation this ticket needs" shape.
 *
 * `undefined` is a real, expected answer, not a failure: a session this daemon process never
 * observed report a provider event carrying its native id (ended before any did, or this process
 * restarted since) genuinely has nothing to fork. `retryImplement()` turns that into the real,
 * typed `fork_unavailable` refusal rather than silently falling back to a fresh dispatch wearing a
 * fork's label.
 */
export interface PipenzoRetrySessionPort {
  providerSessionId(sessionId: string): string | undefined;
}

export class SessionManagerRetrySessions implements PipenzoRetrySessionPort {
  readonly #manager: Pick<SessionManager, 'get'>;

  constructor(manager: Pick<SessionManager, 'get'>) {
    this.#manager = manager;
  }

  providerSessionId(sessionId: string): string | undefined {
    return this.#manager.get(sessionId)?.providerSessionId;
  }
}
