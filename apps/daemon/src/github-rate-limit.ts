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
 * credential and no reference to an octokit instance: four numbers and a bucket name per resource.
 */

/**
 * GitHub's `core` bucket — the one ordinary REST reads and writes are billed to, and the one the
 * polling reconciler (#231) consults.
 */
export const GITHUB_CORE_RATE_LIMIT_RESOURCE = 'core';

/**
 * How far in the future a reset instant may sit before it is refused.
 *
 * GitHub's longest documented window is an hour, so a day is generous by a factor of 24 and still
 * catches the failure this bound exists for: a reset value that is not in seconds. A header shipping
 * milliseconds instead — the most likely shape change on GitHub's side, and trivial for an
 * intercepting proxy to inject — passes every digit and safe-integer check and lands `resetAt`
 * around the year 57000. Storing that would freeze the bucket for the life of the daemon, because
 * nothing would ever look newer than it and `latest` would never expire it: epic #4's threshold
 * would be silently disabled, or the product permanently "syncing slowly", with no log and no error.
 */
export const MAX_RATE_LIMIT_RESET_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * How many buckets are retained. GitHub documents four (`core`, `search`, `graphql`,
 * `code_search`); sixteen leaves room for ones it adds without an allowlist that would silently
 * drop them. The bound exists because the key is a *remote* header value: `ConditionalRequestCache`
 * is bounded for the same reason, and this is the daemon's other long-lived store.
 */
export const MAX_RATE_LIMIT_RESOURCES = 16;

/** Longest bucket name accepted. GitHub's are single short words; this only rules out abuse. */
const MAX_RESOURCE_NAME_LENGTH = 64;

/**
 * One reading of one rate-limit bucket, as of one response.
 *
 * `remaining` and `limit` are both stored rather than a pre-computed percentage, so the ~15%
 * threshold lives in exactly one place (the consumer that reacts to it) and this stays a record of
 * what GitHub said. `limit` is guaranteed positive by `readRateLimitHeaders`, so `remaining / limit`
 * is always a safe division.
 *
 * `x-ratelimit-used` is deliberately not carried. It is `limit - remaining` by definition, nothing
 * needs it, and a field with no reader is a field that can be wrong without anything noticing.
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
  /** When the window refills, in unix milliseconds. Always after `observedAt`. */
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
 * A non-negative safe integer, or `undefined`.
 *
 * `Number('')` is `0` and `Number(' ')` is `0`, so a blank header would otherwise parse as the most
 * alarming value this type can hold. Everything is required to look like an integer before it is
 * believed. The regex is ASCII-only by design: JavaScript's `\d` without the `u` flag does not match
 * full-width or Arabic-Indic digits, so there is no non-ASCII numeral that reaches `Number`.
 */
function integerHeader(headers: unknown, name: string): number | undefined {
  const raw = headerValue(headers, name);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Reads a snapshot off one set of response headers, or returns `undefined`.
 *
 * **A malformed header yields no snapshot, never a zero and never an implausible instant.**
 * `remaining: 0` is what "GitHub has cut us off" looks like, so inventing one from a parse failure
 * would make a header-shape change present as an exhausted quota and degrade the entire product.
 * Every one of the four fields is checked — including `x-ratelimit-reset`, which is checked for
 * *plausibility* and not merely for digits; see `MAX_RATE_LIMIT_RESET_HORIZON_MS` for what a
 * digits-only check lets through and why it would be permanent.
 *
 * `x-ratelimit-resource` is required rather than defaulted to `core` for the same reason. A
 * response billed to the `search` bucket, recorded as `core` because the header was missing, would
 * let a search exhaustion read as core headroom or the reverse — a wrong number presented with the
 * same confidence as a right one. An absent bucket name means an unattributable reading, and an
 * unattributable reading is not recorded.
 *
 * A reset instant that has *already passed* is refused too, rather than stored as a snapshot born
 * expired. Its `remaining` describes a window that has since refilled, which is wrong in the
 * alarming direction, and refusing it here is what lets both halves of this module — the accessor
 * and the push notification — state the same rule.
 */
export function readRateLimitHeaders(
  headers: unknown,
  observedAt: number,
): GitHubRateLimitSnapshot | undefined {
  if (!Number.isFinite(observedAt)) return undefined;
  const resource = headerValue(headers, 'x-ratelimit-resource')?.trim();
  if (!resource || resource.length > MAX_RESOURCE_NAME_LENGTH) return undefined;
  const limit = integerHeader(headers, 'x-ratelimit-limit');
  const remaining = integerHeader(headers, 'x-ratelimit-remaining');
  const resetSeconds = integerHeader(headers, 'x-ratelimit-reset');
  if (limit === undefined || remaining === undefined || resetSeconds === undefined) return undefined;
  // A zero or absent limit would make `remaining / limit` meaningless, and a `remaining` above the
  // limit is a contradiction rather than good news. Neither is a reading worth storing.
  if (limit <= 0 || remaining > limit) return undefined;
  const resetAt = resetSeconds * 1000;
  if (!Number.isSafeInteger(resetAt)) return undefined;
  if (resetAt <= observedAt) return undefined;
  if (resetAt - observedAt > MAX_RATE_LIMIT_RESET_HORIZON_MS) return undefined;
  return { resource, limit, remaining, resetAt, observedAt };
}

/**
 * The latest reading per bucket.
 *
 * Deliberately tiny: it stores what GitHub said and hands it back. It does not know the ~15%
 * threshold, does not decide what "degraded" means, and does not widen anything — those belong to
 * the polling reconciler (#231), which is the only thing with an interval to widen, and to the
 * status pill (#75), which is the only thing with somewhere to say it.
 *
 * ## Last reading wins, and why there is no cleverer rule
 *
 * Responses complete out of order, so a request billed slightly earlier can land later carrying one
 * or two more points of headroom than the reading already stored. An earlier draft of this class
 * suppressed those. It was removed: the error it corrected is a couple of points out of five
 * thousand — nothing a 15% threshold can see — while the rule itself needed `x-ratelimit-reset` to
 * be byte-identical across a window to recognise one, which is true for `core` and false for the
 * sliding-window buckets, and it silently let a reading through whenever that value jittered
 * upward. A rule that is inert where it is safe and wrong where it is not is worse than no rule.
 * What actually protects a consumer is `readRateLimitHeaders` refusing an expired or implausible
 * reading, which is a property of one response rather than of an ordering.
 */
export class GitHubRateLimitTracker {
  readonly #byResource = new Map<string, GitHubRateLimitSnapshot>();
  readonly #listeners = new Set<(snapshot: GitHubRateLimitSnapshot) => void>();

  /**
   * The push half of this surface, alongside — not replacing —
   * `PipenzoThrottleObserver.onRateLimit`. The two report different facts and the difference is the
   * point: `onRateLimit` says *a limit has fired*, which arrives too late to avoid anything, while
   * this says *here is the current headroom*, which arrives on every response that carried a
   * reading. A long-lived consumer like the reconciler (#231) reacts to this without polling
   * `latest` on a timer.
   *
   * It is a method rather than a constructor option because of construction order in `index.ts`:
   * the tracker is built before the components that would subscribe to it, so a listener that could
   * only be supplied at construction could never be supplied by the consumer it exists for.
   *
   * Returns its own unsubscribe. Listeners are invoked inside the client's response path, so a
   * throwing one would surface as a failed GitHub request; see `record` for how that is contained.
   */
  subscribe(listener: (snapshot: GitHubRateLimitSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Records the headers of one response, and returns what was stored.
   *
   * Total by construction: any input that is not a well-formed, plausible set of rate-limit headers
   * is a no-op returning `undefined`. This runs on the response path of every GitHub request the
   * daemon makes, so it must never be the reason one fails — which is also why a listener's
   * exception is caught here rather than allowed to propagate into octokit's hook chain.
   */
  record(headers: unknown, observedAt: number = Date.now()): GitHubRateLimitSnapshot | undefined {
    const snapshot = readRateLimitHeaders(headers, observedAt);
    if (snapshot === undefined) return undefined;
    this.#byResource.set(snapshot.resource, snapshot);
    this.#evictOldestBeyondBound();
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // A subscriber's bug is not a reason for a GitHub read to fail. Swallowed rather than
        // logged because this module holds no logger, and what would be logged is the subscriber's
        // own stack, which the subscriber is better placed to handle.
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
   * actually has a full allowance.
   *
   * Between this and `readRateLimitHeaders` refusing an already-expired reading, no consumer of
   * this class can be handed one: not through this accessor, and not through `subscribe`.
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

  /**
   * Keeps the map bounded. The key is a value a remote party supplies, and this daemon runs for
   * days; `Map` iterates in insertion order, so the oldest bucket goes first. Evicting one costs
   * nothing but a cold reading for that bucket on its next response.
   */
  #evictOldestBeyondBound(): void {
    while (this.#byResource.size > MAX_RATE_LIMIT_RESOURCES) {
      const oldest = this.#byResource.keys().next();
      if (oldest.done === true) return;
      this.#byResource.delete(oldest.value);
    }
  }
}
