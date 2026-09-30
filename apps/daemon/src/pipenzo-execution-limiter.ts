import {
  PIPENZO_EXECUTION_LIMIT_DEFAULT,
  PIPENZO_EXECUTION_LIMIT_MAX,
  PIPENZO_EXECUTION_LIMIT_MIN,
} from '@agent-dock/shared';

/**
 * Real enforcement for epic #5's "Configurable execution limit, default 2, hard cap 4" (Pipenzo
 * issue #126).
 *
 * ## Why this exists beside agentdock's own `SessionAdmissionController`
 *
 * `session-admission.ts` already gates every provider-launching call daemon-wide (`AGENT_DOCK_MAX_
 * ACTIVE_SESSIONS`, default 4, ceiling 32) -- and, since `DispatchOnlyPhaseSessions.run()` dispatches
 * through `SessionManager.create()`, an Implement session already passes through it. But that gate is
 * agentdock's own generic safety valve against launching *any* provider process (Refine, Review,
 * Chat, Implement, alike), sized for the whole daemon, not read from anywhere a person can change it
 * short of restarting the process with a new environment variable. Epic #5's own execution limit is a
 * narrower, Pipenzo-specific concept: how many *tickets* may be in Working (running an Implement
 * session) at once, configurable live from Settings, default 2 and never above 4. Repurposing the
 * generic controller for this would mean either lowering the whole daemon's process cap to 2 (leaving
 * no room for a Refine or Review session to run alongside two Implements) or hand-editing its private
 * MIN/CEILING constants to match a bound that has nothing to do with agentdock's own reasoning for
 * 1..32. CLAUDE.md's repo-layout note says exactly this: check whether inherited agentdock
 * infrastructure already covers a gap before "fixing" it, and where it does not, add a thin
 * Pipenzo-owned layer rather than reshape the agentdock class. This is that thin layer -- it composes
 * with the generic gate rather than replacing it; both must admit a session for an Implement dispatch
 * to proceed.
 *
 * ## Why `acquire()` throws instead of queuing
 *
 * Unlike `OwnedWorktreeManager`'s per-repository queue (issue #118, which this ticket's own
 * investigation confirmed already serializes worktree provisioning instead of throwing
 * `worktree_busy` -- see that file's own comment), an Implement dispatch that cannot get a slot has
 * nowhere useful to wait *inside this call*: the caller is an HTTP route handling one ticket's
 * transition, not a background loop that can block. Queuing here would mean holding an HTTP request
 * open for however long it takes another ticket's whole Implement session to finish -- minutes to
 * hours -- which is a resource-exhaustion shape of its own (piled-up open requests, one per refused
 * ticket) as much as it is a UX problem. Refusing outright, mirroring `SessionAdmissionController`'s
 * own `acquire()`, means the ticket stays exactly where it was and can be retried once a slot frees --
 * the phase machine (or a human) decides when that retry happens, not this class.
 */
export class PipenzoExecutionLimiterError extends Error {
  readonly code = 'execution_limit_exceeded' as const;

  constructor(message = 'workspace execution limit reached') {
    super(message);
    this.name = 'PipenzoExecutionLimiterError';
  }
}

export interface PipenzoExecutionLease {
  /** Idempotent: a second call is a no-op, so a slot is never released more than once. */
  release(): void;
}

function assertBounds(value: number): void {
  if (
    !Number.isInteger(value) ||
    value < PIPENZO_EXECUTION_LIMIT_MIN ||
    value > PIPENZO_EXECUTION_LIMIT_MAX
  ) {
    throw new RangeError(
      `execution limit must be an integer between ${PIPENZO_EXECUTION_LIMIT_MIN} and ${PIPENZO_EXECUTION_LIMIT_MAX}, got: ${value}`,
    );
  }
}

/**
 * One instance per daemon, constructed with the concurrency store's persisted `executionLimit` and
 * kept live-updated by `PUT /v2/pipenzo/concurrency` via `setLimit()` -- no daemon restart required
 * for a changed Settings value to take effect, which is what makes the Settings stepper a real
 * control rather than one that only takes effect on next launch.
 */
export class PipenzoExecutionLimiter {
  #limit: number;
  #held = 0;

  constructor(initialLimit: number = PIPENZO_EXECUTION_LIMIT_DEFAULT) {
    assertBounds(initialLimit);
    this.#limit = initialLimit;
  }

  /** The configured ceiling. Read by `routes/pipenzo-tickets.ts` for the Working lane's own
   *  capacity-pill denominator, so a person changing the stepper in Settings changes what the board
   *  shows too -- one number, one source of truth, not two that could drift apart. */
  get limit(): number {
    return this.#limit;
  }

  /** How many Implement dispatches currently hold a slot. Exposed for tests and for a future
   *  daemon-health surface; not currently read by any route. */
  get running(): number {
    return this.#held;
  }

  /** Changes the ceiling with immediate effect. Never evicts a session already holding a slot --
   *  lowering the limit below the current `running` count just means no new dispatch is admitted
   *  until enough of those finish to fall back under the new ceiling, exactly like lowering
   *  `SessionAdmissionController`'s limit would (if it supported changing it at all, which it does
   *  not -- another reason this is its own class rather than a reused instance of that one). */
  setLimit(next: number): void {
    assertBounds(next);
    this.#limit = next;
  }

  /** Throws `PipenzoExecutionLimiterError` instead of queueing when already at the configured
   *  limit -- see the module comment for why queuing here is the wrong shape. */
  acquire(): PipenzoExecutionLease {
    if (this.#held >= this.#limit) throw new PipenzoExecutionLimiterError();
    this.#held += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#held -= 1;
      },
    };
  }
}
