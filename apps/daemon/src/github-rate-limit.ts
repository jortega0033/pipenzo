/**
 * Remaining GitHub quota, read off responses the client was making anyway (issue #229).
 *
 * ## Why this exists
 *
 * Epic #4's rate-limit rule is *"below ~15% remaining quota: degrade, don't fail — widen poll
 * intervals, surface 'syncing slowly'."* Before this module the product could not compute that
 * percentage. `github-client.ts` read `x-ratelimit-remaining` in exactly one place — inside
 * `toGitHubClientError`, and only to tell a primary-limit 403 apart from a permission failure — and
 * `PipenzoThrottleObserver.onRateLimit` fires only once `@octokit/plugin-throttling` has already
 * seen a 429 or an exhausted 403. So the one signal available was *"a limit has already fired"*,
 * which is the failure the rule exists to avoid rather than the early warning it is written around.
 *
 * Every response GitHub sends carries the answer. Recording it costs no request and no quota.
 *
 * ## Why there is no `GET /rate_limit` call here
 *
 * That endpoint is free of charge and tempting, and it is deliberately not used. A client that has
 * made any request already holds the numbers; adding a second source of truth invites the two to
 * disagree, and the one that is a separate round trip is the one that will be stale. The cost of
 * leaving it out is a cold start with no reading at all, which every consumer already has to handle
 * because a reading can also expire (see `latest`).
 *
 * ## Why the tracker is shared rather than owned by a client
 *
 * `index.ts` builds a *fresh* authenticated `OctokitGitHubClient` per request — that is the
 * token-boundary rule, no authenticated client is retained between requests. A tracker each client
 * constructed for itself would be thrown away before its second observation, so this is injected
 * and shared exactly as `ConditionalRequestCache` is, and for the same reason. It holds no
 * credential: five numbers and a bucket name per resource.
 */

/**
 * GitHub's `core` bucket — the one ordinary REST reads and writes are billed to, and the one the
 * polling reconciler (#231) consults.
 */
export const GITHUB_CORE_RATE_LIMIT_RESOURCE = 'core';

/**
 * One reading of one rate-limit bucket, as of one response.
 *
 * `remaining` and `limit` are both stored rather than a pre-computed percentage, so the ~15%
 * threshold lives in exactly one place (the consumer that reacts to it) and this stays a record of
 * what GitHub said. `limit` is guaranteed positive by `readRateLimitHeaders`, so `remaining / limit`
 * is always a safe division.
 */
export interface GitHubRateLimitSnapshot {
  /**
   * Which bucket this describes, from `x-ratelimit-resource`. GitHub meters `core`, `search`,
   * `graphql` and `code_search` separately.
   */
  readonly resource: string;
  /** The window's total allowance. Always greater than zero. */
  readonly limit: number;
  /** How much of it is left. Zero is a real, meaningful value here. */
  readonly remaining: number;
  /** How much has been spent, when GitHub reported it. */
  readonly used: number | undefined;
  /** When the window refills, in unix milliseconds. */
  readonly resetAt: number;
  /** When this reading was taken, in unix milliseconds. */
  readonly observedAt: number;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const value = (headers as Record<string, unknown>)[name];
  if (typeof value === 'string') return value;
  // `@octokit/request` normalises headers to strings, but a hand-built fixture or a future
  // transport may hand back a number. Anything else -- an array, a null, an object -- is a shape
  // this function does not claim to understand, and is treated as absent.
  if (typeof value === 'number') return String(value);
  return undefined;
}

/**
 * A non-negative integer, or `undefined`.
 *
 * `Number('')` is `0` and `Number(' ')` is `0`, so a blank header would otherwise parse as the most
 * alarming value this type can hold. Everything is required to look like an integer before it is
 * believed.
 */
function integerHeader(headers: unknown, name: string): number | undefined {
  const raw = headerValue(headers, name);
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Reads a snapshot off one set of response headers, or returns `undefined`.
 *
 * **A malformed header yields no snapshot, never a zero.** `remaining: 0` is the most alarming
 * value in this type — it is what "GitHub has cut us off" looks like — so inventing one from a
 * parse failure would make a header-shape change on GitHub's side present as an exhausted quota and
 * degrade the entire product. Every field is checked, and any one of them failing means this
 * response simply carried no reading.
 *
 * `x-ratelimit-resource` is required rather than defaulted to `core` for the same reason. A
 * response billed to the `search` bucket, recorded as `core` because the header was missing, would
 * let a search exhaustion read as core headroom or the reverse — a wrong number presented with the
 * same confidence as a right one. An absent bucket name means an unattributable reading, and an
 * unattributable reading is not recorded.
 */
export function readRateLimitHeaders(
  headers: unknown,
  observedAt: number,
): GitHubRateLimitSnapshot | undefined {
  const resource = headerValue(headers, 'x-ratelimit-resource')?.trim();
  if (!resource) return undefined;
  const limit = integerHeader(headers, 'x-ratelimit-limit');
  const remaining = integerHeader(headers, 'x-ratelimit-remaining');
  const resetSeconds = integerHeader(headers, 'x-ratelimit-reset');
  if (limit === undefined || remaining === undefined || resetSeconds === undefined) return undefined;
  // A zero or absent limit would make `remaining / limit` meaningless, and a `remaining` above the
  // limit is a contradiction rather than good news. Neither is a reading worth storing.
  if (limit <= 0 || remaining > limit) return undefined;
  if (!Number.isFinite(observedAt)) return undefined;
  return {
    resource,
    limit,
    remaining,
    used: integerHeader(headers, 'x-ratelimit-used'),
    resetAt: resetSeconds * 1000,
    observedAt,
  };
}

/**
 * The latest reading per bucket.
 *
 * Deliberately tiny: it stores what GitHub said and hands it back. It does not know the ~15%
 * threshold, does not decide what "degraded" means, and does not widen anything — those belong to
 * the polling reconciler (#231), which is the only thing with an interval to widen, and to the
 * status pill (#75), which is the only thing with somewhere to say it.
 */
export class GitHubRateLimitTracker {
  readonly #byResource = new Map<string, GitHubRateLimitSnapshot>();
  readonly #onSnapshot: ((snapshot: GitHubRateLimitSnapshot) => void) | undefined;

  /**
   * `onSnapshot` is the push half of this surface, alongside — not replacing —
   * `PipenzoThrottleObserver.onRateLimit`. The two report different facts and the difference is the
   * point: `onRateLimit` says *a limit has fired*, which arrives too late to avoid anything, while
   * this says *here is the current headroom*, which arrives on every response. A long-lived
   * consumer like the reconciler reacts to this one without polling `latest` on a timer.
   *
   * It is invoked inside the client's response path, so a throwing callback would surface as a
   * failed GitHub request. `record` therefore isolates it; see there.
   */
  constructor(options: { onSnapshot?: (snapshot: GitHubRateLimitSnapshot) => void } = {}) {
    this.#onSnapshot = options.onSnapshot;
  }

  /**
   * Records the headers of one response, and returns what was stored.
   *
   * Total by construction: any input that is not a well-formed set of rate-limit headers is a
   * no-op returning `undefined`. This runs on the success path of every GitHub request the daemon
   * makes, so it must never be the reason one fails.
   *
   * ## Why an older reading cannot overwrite a newer one
   *
   * The reconciler polls many issues concurrently, so responses complete out of order: a request
   * billed *earlier* can return *later*, carrying a higher `remaining` than one already recorded.
   * Within a single window `remaining` only ever falls, so a same-window reading that claims more
   * headroom than the stored one is an out-of-order arrival and is dropped. A reading from a
   * *later* window always wins, because that is a genuine refill.
   *
   * The consequence worth stating: under concurrency this holds the most pessimistic reading seen
   * in the current window rather than the strict latest. That is the correct direction to err for a
   * threshold whose whole job is to notice scarcity early.
   */
  record(headers: unknown, observedAt: number = Date.now()): GitHubRateLimitSnapshot | undefined {
    const snapshot = readRateLimitHeaders(headers, observedAt);
    if (snapshot === undefined) return undefined;
    const previous = this.#byResource.get(snapshot.resource);
    if (
      previous !== undefined &&
      previous.resetAt === snapshot.resetAt &&
      snapshot.remaining > previous.remaining
    ) {
      return undefined;
    }
    if (previous !== undefined && snapshot.resetAt < previous.resetAt) return undefined;
    this.#byResource.set(snapshot.resource, snapshot);
    if (this.#onSnapshot) {
      try {
        this.#onSnapshot(snapshot);
      } catch {
        // A subscriber's bug is not a reason for a GitHub read to fail. Swallowed rather than
        // logged because this module holds no logger and the thing that would be logged is the
        // subscriber's own stack, which the subscriber is better placed to handle.
      }
    }
    return snapshot;
  }

  /**
   * The latest reading for one bucket, or `undefined` when there is none worth believing.
   *
   * **An expired reading is dropped rather than returned.** A snapshot whose `resetAt` has passed
   * describes a window that has since refilled, so its `remaining` is not merely stale, it is
   * wrong in the alarming direction — "3% left" from an hour ago would degrade a product that
   * actually has a full allowance. Consumers therefore cannot accidentally act on one: there is no
   * accessor that hands back an expired snapshot.
   *
   * The cost is that a daemon which has made no request in over an hour reads as "no information",
   * which is the honest answer and is the same state it starts in.
   */
  latest(
    resource: string = GITHUB_CORE_RATE_LIMIT_RESOURCE,
    now: number = Date.now(),
  ): GitHubRateLimitSnapshot | undefined {
    const snapshot = this.#byResource.get(resource);
    if (snapshot === undefined) return undefined;
    if (snapshot.resetAt <= now) {
      this.#byResource.delete(resource);
      return undefined;
    }
    return snapshot;
  }
}
