import type { Logger } from '@agent-dock/agent-runtime';
import type { PipenzoGitHubHealthV1, PipenzoGitHubQuotaV1 } from '@agent-dock/shared';
import type { ConnectedReposStore } from './connected-repos-store.js';
import type { GitHubClient } from './github-client.js';
import { PipenzoPhaseMachineError, type PipenzoPhaseMachine } from './pipenzo-phase-machine.js';
import type { FileTicketStore } from './pipenzo-ticket-store.js';

/**
 * The polling loop over the connected-repos list (issue #231).
 *
 * ## Why a whole component for `setTimeout`
 *
 * Before this, Pipenzo had no polling loop at all — `grep -r setInterval apps/daemon/src` returned
 * nothing. That absence is load-bearing on more of epic #4 than it looks. #70's *"attempt 2 of 5"*
 * and #71's *"5 polls failed since 14:02"* describe the behaviour of a loop nobody had written;
 * #75's *"widen poll intervals"* had no interval to widen; #73's recovery banner had no
 * "it is working again" to fire on; `routes/pipenzo-tickets.ts` says outright that the board's list
 * route is unaffordable until a reconciler with `If-None-Match` exists; and
 * `connected-repos-store.ts` already sorts its list because *"this file is read back by a
 * reconciler that iterates it"* — naming a consumer that did not exist.
 *
 * ## What one tick actually costs
 *
 * `GitHubClient` has no "list this repo's issues" method, deliberately, so a tick does not discover
 * work — it re-reads work already known. The ticket store holds the issue numbers, and one tick
 * calls `PipenzoPhaseMachine.read()` once per ticket belonging to a connected repo. That is one
 * conditional GET each, and the whole reason a per-minute loop is affordable is that an unchanged
 * issue answers `304` and costs no quota at all (#161).
 *
 * Going through the phase machine rather than the GitHub client directly is not incidental: `read()`
 * is the label-wins reconciliation, so a lane a human changed on GitHub self-heals locally as a
 * side effect of polling. A reconciler that called `getIssue` itself would be a second, quieter
 * implementation of README's precedence rule.
 *
 * ## Self-scheduling, never `setInterval`
 *
 * The next tick is scheduled only once the current one has finished. An interval fires on a clock
 * regardless of whether the previous tick returned, which is exactly how an interval-driven loop
 * silently becomes concurrent the first time GitHub is slow — twenty in-flight reads per repo,
 * multiplying against the quota the whole design is trying to protect. Ticks therefore cannot
 * overlap by construction rather than by a guard someone can forget to check.
 *
 * ## What this does not do
 *
 * **No second retry ladder.** `@octokit/plugin-throttling` and `@octokit/plugin-retry` are already
 * configured and `MAX_RATE_LIMIT_SLEEP_SECONDS` already decides what is slept through versus
 * surfaced. What backs off here is the *poll interval*, not the request: by the time a failure
 * reaches this class the transport has finished with it. Two ladders would multiply.
 *
 * **No writes.** This reads. Label writes stay with the phase machine behind a human action, which
 * is the whole publish-boundary rule; a loop that could write to GitHub unattended is the one thing
 * this product must not grow.
 *
 * **No transport for the health payload.** It is published in process, through `health()` and
 * `subscribeHealth()`. Whether it reaches the renderer on the phase event stream or on a route of
 * its own is a decision with a consumer attached, and the first banner to need it is the change
 * that should make it — adding a route now would be one more surface with no caller, which is the
 * failure `SyncStatusPill` already stands for in this codebase.
 */

/** The base interval between clean polls. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Below this fraction of remaining core quota the interval widens rather than the loop failing.
 *
 * Epic #4's rule is "~15%", and the threshold lives *here* rather than in the renderer because this
 * is the thing with an interval to widen. `PipenzoGitHubQuotaV1.degraded` carries the decision, so
 * #75 renders what was decided instead of re-deriving it from the fraction — two places computing
 * "degraded" is two places free to disagree the moment either is tuned.
 */
export const DEGRADED_QUOTA_FRACTION = 0.15;

/** How much wider a degraded interval is. Slower, never stopped: "degrade, don't fail". */
export const DEGRADED_INTERVAL_MULTIPLIER = 5;

/** Attempts in the failure ladder before the loop reports `unreachable`. #70's "of 5". */
export const DEFAULT_MAX_POLL_ATTEMPTS = 5;

/** The longest gap the ladder will ever schedule, jitter aside. */
export const MAX_POLL_BACKOFF_MS = 15 * 60_000;

/**
 * The scheduling seam, matching `MonotonicScheduler` in `interaction-state.ts`.
 *
 * Injected rather than reaching for `setTimeout` directly because a reconciler only testable by
 * waiting is one whose backoff nobody will ever assert on — every interval in here is minutes long.
 */
export interface PipenzoReconcilerScheduler {
  now(): number;
  set(delayMs: number, callback: () => void): unknown;
  clear(timer: unknown): void;
}

const systemScheduler: PipenzoReconcilerScheduler = {
  now: () => Date.now(),
  set: (delayMs, callback) => setTimeout(callback, delayMs),
  clear: (timer) => {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

export interface PipenzoReconcilerOptions {
  repos: ConnectedReposStore;
  tickets: FileTicketStore;
  /** Reconciles one ticket against its issue's labels. The label-wins path, reused rather than redone. */
  machine: Pick<PipenzoPhaseMachine, 'read'>;
  /**
   * Built lazily per call, exactly as everywhere else on this surface, and used *only* for
   * `rateLimit()` — which reads the shared tracker and makes no request. The reconciler never
   * calls GitHub through this.
   */
  github?: () => GitHubClient;
  logger?: Logger;
  scheduler?: PipenzoReconcilerScheduler;
  /** Injected so jitter is assertable. `Math.random` in production. */
  random?: () => number;
  pollIntervalMs?: number;
  maxAttempts?: number;
}

/** What one tick concluded, before it is turned into a health payload. */
type TickOutcome =
  | { kind: 'clean' }
  | { kind: 'nothing_to_poll' }
  | { kind: 'unreachable'; retryAfterMs: number | undefined }
  | { kind: 'credential_rejected' };

export class PipenzoReconciler {
  readonly #repos: ConnectedReposStore;
  readonly #tickets: FileTicketStore;
  readonly #machine: Pick<PipenzoPhaseMachine, 'read'>;
  readonly #github: (() => GitHubClient) | undefined;
  readonly #logger: Logger | undefined;
  readonly #scheduler: PipenzoReconcilerScheduler;
  readonly #random: () => number;
  readonly #pollIntervalMs: number;
  readonly #maxAttempts: number;

  readonly #listeners = new Set<(health: PipenzoGitHubHealthV1) => void>();
  #health: PipenzoGitHubHealthV1 = { state: 'unknown' };
  #timer: unknown;
  #running = false;
  #ticking: Promise<void> | undefined;

  /** Failure-run bookkeeping. All of it is rendered by #70 and #71; none of it is inferred later. */
  #attempt = 0;
  #consecutiveFailures = 0;
  #firstFailureAt: number | undefined;
  #lastCleanPollAt: number | undefined;

  constructor(options: PipenzoReconcilerOptions) {
    this.#repos = options.repos;
    this.#tickets = options.tickets;
    this.#machine = options.machine;
    this.#github = options.github;
    this.#logger = options.logger;
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#random = options.random ?? Math.random;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
  }

  /** The latest health payload. Synchronous, and never a request. */
  health(): PipenzoGitHubHealthV1 {
    return this.#health;
  }

  /**
   * Push notification for the same payload, returning its own unsubscribe.
   *
   * Every publish notifies, with no attempt to suppress an "unchanged" one — a clean tick always
   * moves `lastCleanPollAt`, so there is no such thing as an identical consecutive payload, and a
   * dedup check would only be a place for the comparison to be wrong.
   */
  subscribeHealth(listener: (health: PipenzoGitHubHealthV1) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Idempotent. Runs the first tick immediately rather than after one interval. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#scheduleIn(0);
  }

  /**
   * Stops the loop and waits for any tick already in flight.
   *
   * Idempotent, and awaiting the in-flight tick matters: a `setTimeout` nobody clears keeps a Node
   * process alive, and a tick nobody waits for keeps spending quota after the window that wanted it
   * has closed. `stop()` never rejects — a tick that fails during shutdown is not a shutdown
   * failure, and `#tick` has already absorbed its own errors.
   */
  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== undefined) {
      this.#scheduler.clear(this.#timer);
      this.#timer = undefined;
    }
    await this.#ticking;
  }

  #scheduleIn(delayMs: number): void {
    if (!this.#running) return;
    this.#timer = this.#scheduler.set(delayMs, () => {
      this.#timer = undefined;
      // Held so `stop()` can await it. `#tick` never rejects, so this promise never does either.
      // Cleared only if `#ticking` still points at *this* tick's promise -- a `start()` called
      // while `stop()` is awaiting an in-flight tick can schedule a new one that overwrites
      // `#ticking` before this settles, and clobbering it unconditionally here would let `stop()`
      // resolve without actually waiting for the still-running tick (see `stop()`'s doc comment).
      const ticking: Promise<void> = this.#tick().finally(() => {
        if (this.#ticking === ticking) this.#ticking = undefined;
      });
      this.#ticking = ticking;
    });
  }

  /**
   * One pass over every ticket of every connected repo.
   *
   * Never rejects. The loop is the only caller and a throw here would leave the timer unscheduled
   * and the daemon silently un-polled, which is a worse failure than any single tick's.
   */
  async #tick(): Promise<void> {
    let outcome: TickOutcome;
    try {
      outcome = await this.#pollAll();
    } catch (error) {
      // Reaching here means a bug in `#pollAll` rather than a GitHub failure -- those are already
      // classified inside it. Logged and treated as a poll that reached nothing, so the loop keeps
      // its cadence rather than either stopping or entering a failure ladder it cannot exit.
      this.#logger?.error('pipenzo reconciler tick failed unexpectedly', {
        error: error instanceof Error ? error.message : String(error),
      });
      outcome = { kind: 'nothing_to_poll' };
    }
    const nextDelayMs = this.#recordOutcome(outcome);
    this.#scheduleIn(nextDelayMs);
  }

  async #pollAll(): Promise<TickOutcome> {
    let repositories: readonly string[];
    try {
      repositories = (await this.#repos.read()).repositories;
    } catch (error) {
      // A local file problem, not a GitHub one. It must not enter the failure ladder, because
      // #71's banner would then tell a user GitHub is unreachable when the network is fine.
      this.#logger?.warn('pipenzo reconciler could not read the connected-repos list', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: 'nothing_to_poll' };
    }
    if (repositories.length === 0) return { kind: 'nothing_to_poll' };

    const connected = new Set(repositories);
    const ticketIds = this.#tickets
      .list()
      .filter((ticket) => connected.has(ticket.repo))
      .map((ticket) => ticket.ticketId);
    if (ticketIds.length === 0) return { kind: 'nothing_to_poll' };

    let reachedGitHub = false;
    let unreachable: { retryAfterMs: number | undefined } | undefined;
    for (const ticketId of ticketIds) {
      if (!this.#running) break;
      try {
        await this.#machine.read(ticketId);
        reachedGitHub = true;
      } catch (error) {
        const verdict = classifyFailure(error);
        if (verdict.kind === 'credential_rejected') return { kind: 'credential_rejected' };
        if (verdict.kind === 'unreachable') {
          // Remembered rather than returned: a later ticket may still succeed, and one repo being
          // rate-limited is not the whole connection being down. Only a tick that reached GitHub
          // for nothing at all is a failed tick.
          unreachable ??= { retryAfterMs: verdict.retryAfterMs };
          continue;
        }
        // A ticket-level problem: a deleted issue, a repo this token cannot read, a response shape
        // this client does not understand. GitHub answered, so the *connection* is healthy and the
        // failure ladder must not move. Reporting these as "GitHub unreachable" would put #71's
        // blocking banner in front of a user whose network is fine and whose ticket is stale.
        reachedGitHub = true;
        this.#logger?.warn('pipenzo reconciler could not reconcile a ticket', {
          ticketId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (unreachable !== undefined && !reachedGitHub) {
      return { kind: 'unreachable', retryAfterMs: unreachable.retryAfterMs };
    }
    return { kind: 'clean' };
  }

  /** Folds one outcome into the failure bookkeeping, publishes health, and returns the next delay. */
  #recordOutcome(outcome: TickOutcome): number {
    const now = this.#scheduler.now();
    const quota = this.#readQuota(now);

    if (outcome.kind === 'credential_rejected') {
      // No ladder: retrying a credential GitHub has rejected does not fix it, and only a human
      // reconnecting resolves this. The loop keeps its base cadence so that a reconnect is noticed.
      this.#attempt = 0;
      this.#consecutiveFailures += 1;
      this.#firstFailureAt ??= now;
      this.#publish({
        state: 'credential_rejected',
        rejectedAt: now,
        ...optional('lastCleanPollAt', this.#cleanPollBefore(now)),
        ...optional('quota', quota),
      });
      return this.#baseDelay(quota);
    }

    if (outcome.kind === 'unreachable') {
      this.#attempt += 1;
      this.#consecutiveFailures += 1;
      this.#firstFailureAt ??= now;
      const firstFailureAt = this.#firstFailureAt;
      const ladderDelay = this.#backoffDelay(this.#attempt);
      // GitHub's own hint wins when it is further out. Not a second retry policy -- the request is
      // long finished -- just a refusal to poll again before the reset it named.
      const untilReset = outcome.retryAfterMs === undefined ? 0 : outcome.retryAfterMs - now;
      const delay = Math.max(ladderDelay, untilReset);
      const nextAttemptAt = now + delay;
      const lastCleanPollAt = this.#cleanPollBefore(firstFailureAt);
      this.#publish(
        this.#attempt >= this.#maxAttempts
          ? {
              state: 'unreachable',
              consecutiveFailures: this.#consecutiveFailures,
              firstFailureAt,
              nextAttemptAt,
              maxAttempts: this.#maxAttempts,
              ...optional('lastCleanPollAt', lastCleanPollAt),
              ...optional('quota', quota),
            }
          : {
              state: 'retrying',
              attempt: this.#attempt,
              maxAttempts: this.#maxAttempts,
              nextAttemptAt,
              consecutiveFailures: this.#consecutiveFailures,
              firstFailureAt,
              ...optional('lastCleanPollAt', lastCleanPollAt),
              ...optional('quota', quota),
            },
      );
      return delay;
    }

    if (outcome.kind === 'nothing_to_poll') {
      // Not a failure and not a clean poll: no repo was read, so nothing was learned about the
      // connection. An empty connected-repos list is a legitimate steady state (first run, before
      // the picker), and reporting it as `healthy` would be claiming an observation never made.
      this.#resetFailureRun();
      this.#publish({
        state: 'unknown',
        ...optional('lastCleanPollAt', this.#lastCleanPollAt),
        ...optional('quota', quota),
      });
      return this.#baseDelay(quota);
    }

    this.#resetFailureRun();
    this.#lastCleanPollAt = now;
    this.#publish({ state: 'healthy', lastCleanPollAt: now, ...optional('quota', quota) });
    return this.#baseDelay(quota);
  }

  /**
   * The last clean poll, but only if it precedes `boundary`.
   *
   * `pipenzoGitHubHealthV1Schema` refuses a `lastCleanPollAt` that follows the failure it is
   * reported alongside, and it is right to: a clean poll recorded *after* the current run of
   * failures began would mean the run should have been reset. Rather than publish a payload the
   * wire contract would reject, the field is dropped -- "we have no clean poll before this failure"
   * is a true statement and the banner renders one fewer line.
   */
  #cleanPollBefore(boundary: number): number | undefined {
    const last = this.#lastCleanPollAt;
    return last !== undefined && last <= boundary ? last : undefined;
  }

  #resetFailureRun(): void {
    this.#attempt = 0;
    this.#consecutiveFailures = 0;
    this.#firstFailureAt = undefined;
  }

  /** Base cadence, widened while quota is scarce. Slower, never stopped. */
  #baseDelay(quota: PipenzoGitHubQuotaV1 | undefined): number {
    const interval =
      quota?.degraded === true
        ? this.#pollIntervalMs * DEGRADED_INTERVAL_MULTIPLIER
        : this.#pollIntervalMs;
    return this.#jitter(interval);
  }

  #backoffDelay(attempt: number): number {
    const doubled = this.#pollIntervalMs * 2 ** Math.max(0, attempt - 1);
    return this.#jitter(Math.min(doubled, MAX_POLL_BACKOFF_MS));
  }

  /**
   * Equal jitter: half the delay, plus a random half.
   *
   * Every connected repo failing at once against a single upstream is the normal shape of an
   * outage, and an unjittered ladder turns recovery into a synchronised thundering herd against the
   * very API whose limit may have caused it. Half is kept fixed so a jittered delay can never
   * collapse toward zero and hammer.
   */
  #jitter(delayMs: number): number {
    return Math.round(delayMs / 2 + this.#random() * (delayMs / 2));
  }

  /**
   * The current quota reading as the wire carries it, or `undefined`.
   *
   * `rateLimit()` reads the shared tracker and makes no request, so this is free. `undefined` is a
   * real answer: a daemon that has made no request yet, or whose last reading describes a window
   * that has since refilled, genuinely does not know its headroom -- and "no information" is not
   * "plenty of quota".
   */
  #readQuota(now: number): PipenzoGitHubQuotaV1 | undefined {
    let snapshot;
    try {
      snapshot = this.#github?.().rateLimit();
    } catch {
      // Resolving a client can throw when no credential is configured. That is not a quota reading
      // and not a poll failure; it is simply no information.
      return undefined;
    }
    if (snapshot === undefined || snapshot.resetAt <= now) return undefined;
    const remainingFraction = snapshot.remaining / snapshot.limit;
    return {
      remainingFraction,
      resetAt: snapshot.resetAt,
      degraded: remainingFraction < DEGRADED_QUOTA_FRACTION,
    };
  }

  #publish(health: PipenzoGitHubHealthV1): void {
    this.#health = health;
    for (const listener of this.#listeners) {
      try {
        listener(health);
      } catch {
        // A subscriber's bug must not stop the poll loop. Swallowed rather than logged for the
        // same reason the rate-limit tracker swallows: what would be logged is the subscriber's
        // own stack, and the subscriber is better placed to handle it.
      }
    }
  }
}

/**
 * Which failures are the *connection's* and which are one ticket's.
 *
 * `#machine.read()` never throws `GitHubClientError` directly -- `pipenzo-phase-machine.ts`'s
 * `toMachineError` always wraps it into a `PipenzoPhaseMachineError` first (that is what lets
 * `read()`'s throw carry `ticket_not_found` and `store_failed` alongside GitHub's own codes under
 * one type routes already switch on). So this classifies the *wrapped* code, not the client's, and
 * `retryAfterMs` is read off the same wrapper -- `toMachineError` copies it over from the
 * `GitHubClientError` it wrapped for exactly this reason.
 *
 * The distinction decides whether #71 puts a blocking "GitHub is unreachable" banner in front of a
 * user, so it is drawn narrowly on purpose:
 *
 * - `github_unauthorized` is GitHub refusing the credential. It is the one failure a ladder cannot
 *   fix, so it short-circuits to `credential_rejected` and #72 asks for a reconnect.
 * - `github_rate_limited` and `github_failed` are the connection. A quota window is not a lost
 *   connection, but it does mean this poll got nothing and the next one must wait, so it enters the
 *   same ladder; `pipenzo-health-v1.ts` records that this surfaces as `retrying` with a degraded
 *   quota rather than as a fifth state neither banner renders differently. `github_failed` covers
 *   both a network failure and a response shape this client did not understand
 *   (`GITHUB_CODES` collapses `network` and `invalid_response` together); treating the latter as
 *   unreachable rather than a ticket problem is the conservative reading -- "slow down and retry"
 *   degrades gracefully, where guessing it is one ticket's problem risks masking a real outage.
 * - Everything else -- `issue_not_found` on a deleted issue, `github_forbidden` on a repo this
 *   token cannot read, `invalid_repository`, `invalid_request`, `token_missing`, `ticket_not_found`,
 *   `illegal_transition`, `store_failed` -- is either a ticket-level problem where **GitHub
 *   answered** (the connection is healthy) or a purely local one (no GitHub round trip happened at
 *   all). Reporting either as unreachable would block a user whose connection is fine, and would do
 *   it permanently for a deleted issue, since re-polling it fails forever.
 */
function classifyFailure(
  error: unknown,
): { kind: 'credential_rejected' } | { kind: 'unreachable'; retryAfterMs: number | undefined } | { kind: 'ticket' } {
  if (!(error instanceof PipenzoPhaseMachineError)) return { kind: 'ticket' };
  if (error.code === 'github_unauthorized') return { kind: 'credential_rejected' };
  if (error.code === 'github_rate_limited' || error.code === 'github_failed') {
    return { kind: 'unreachable', retryAfterMs: error.retryAfterMs };
  }
  return { kind: 'ticket' };
}

/** Spreads a key only when it has a value, so an optional field is absent rather than `undefined`. */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<K, never> {
  return (value === undefined ? {} : { [key]: value }) as Record<K, V>;
}
