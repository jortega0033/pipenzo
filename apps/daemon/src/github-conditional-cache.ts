import type { RepoRef } from './github-client.js';

/**
 * Per-`(repo, resource)` ETag storage for Pipenzo's GitHub reads (issue #161).
 *
 * ## Why this exists
 *
 * Pipenzo's reconciler re-reads the same handful of issues on a loop, and README's rate-limit row
 * is explicit about what that has to cost: a conditional request that comes back `304 Not Modified`
 * **does not consume rate-limit quota at all**, while the same read without an `If-None-Match`
 * spends one of 5,000 hourly points every time. A board polling twenty tickets a minute is 28,800
 * points an hour without this and effectively zero with it.
 *
 * ## What a "resource" is, and why the key is not just the URL
 *
 * An ETag is only meaningful against the exact response it was issued for. The key is therefore
 * `(owner, repo, resource)` where `resource` names both *what* was read and *which* one --
 * `issue:184`, `labels` -- so two different reads can never collide on one stored validator.
 * Owner and repo are lowercased because GitHub treats them case-insensitively and would otherwise
 * hand out two entries (and two cold misses) for `Owner/Repo` and `owner/repo`.
 *
 * ## Why the cached *body* is stored, not just the ETag
 *
 * A 304 carries no body. A cache that stored only validators could ask "has this changed?" and then
 * have nothing to answer the caller with, so it would have to re-request unconditionally -- which is
 * the quota cost the conditional request was there to avoid. The value is stored alongside.
 *
 * ## Why it is in memory and not on disk
 *
 * The saving is on the *poll loop*, which lives entirely inside one daemon lifetime. Persisting
 * would buy one avoided request per resource per daemon start and would cost a real hazard: a
 * cached body written by one build, read back by another whose normalizer has since changed shape,
 * and served to the phase machine as though it were fresh from GitHub. A bounded in-memory map has
 * no such failure mode, and a daemon restart simply pays one cold read per resource.
 *
 * ## Bounded, and least-recently-used
 *
 * A workspace-level connected-repos list (epic #4) times the issues in each is unbounded, and an
 * unbounded map holding whole issue bodies is a leak in a process meant to run for days. Entries
 * are evicted least-recently-used past `maxEntries`; an evicted entry costs exactly one
 * unconditional read the next time it is asked for.
 */

/** The bound. 512 issue-sized entries is a few megabytes at worst and far more than one board. */
export const DEFAULT_CONDITIONAL_CACHE_MAX_ENTRIES = 512;

export interface ConditionalCacheEntry<T> {
  readonly etag: string;
  readonly value: T;
}

/**
 * Counters, for the rate-limit degradation surface (#75) and for tests that need to prove a read
 * was actually served from a validator rather than merely returning the right shape.
 */
export interface ConditionalCacheStats {
  /** Lookups that found a stored validator to send. */
  readonly validatorsSent: number;
  /** Lookups with nothing stored, so the read went out unconditionally. */
  readonly cold: number;
  /** Requests GitHub answered `304 Not Modified` — the ones that cost no quota. */
  readonly notModified: number;
  /** Requests that came back with a body, replacing whatever was stored. */
  readonly modified: number;
  /** Entries dropped to stay under `maxEntries`. */
  readonly evictions: number;
}

interface MutableStats {
  validatorsSent: number;
  cold: number;
  notModified: number;
  modified: number;
  evictions: number;
}

function cacheKey(ref: RepoRef, resource: string): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${resource}`;
}

function repoPrefix(ref: RepoRef): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#`;
}

export class ConditionalRequestCache {
  /**
   * A `Map` is used as the LRU itself rather than carrying a separate recency list: JavaScript's
   * `Map` preserves insertion order, so deleting and re-inserting on every touch makes the first
   * key in iteration order the least recently used, which is exactly what eviction needs.
   */
  readonly #entries = new Map<string, ConditionalCacheEntry<unknown>>();
  readonly #maxEntries: number;
  readonly #stats: MutableStats = {
    validatorsSent: 0,
    cold: 0,
    notModified: 0,
    modified: 0,
    evictions: 0,
  };

  constructor(options: { maxEntries?: number } = {}) {
    const requested = options.maxEntries ?? DEFAULT_CONDITIONAL_CACHE_MAX_ENTRIES;
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new Error('conditional request cache maxEntries must be a positive integer');
    }
    this.#maxEntries = requested;
  }

  get size(): number {
    return this.#entries.size;
  }

  get stats(): ConditionalCacheStats {
    return { ...this.#stats };
  }

  /**
   * The stored entry for one resource, or `undefined` when there is nothing to revalidate against.
   *
   * Counts the lookup as it goes, so a caller cannot forget to. Touching moves the entry to the
   * most-recently-used end: a resource the reconciler asks about every cycle must not be the one
   * evicted by a burst of one-off reads.
   */
  get<T>(ref: RepoRef, resource: string): ConditionalCacheEntry<T> | undefined {
    const key = cacheKey(ref, resource);
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      this.#stats.cold += 1;
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#stats.validatorsSent += 1;
    return entry as ConditionalCacheEntry<T>;
  }

  /**
   * Records a fresh 200 response. An empty or non-string ETag stores nothing rather than storing a
   * validator GitHub would reject — a resource served without one simply stays uncached.
   */
  set<T>(ref: RepoRef, resource: string, etag: string, value: T): void {
    this.#stats.modified += 1;
    if (typeof etag !== 'string' || etag.trim() === '') return;
    const key = cacheKey(ref, resource);
    this.#entries.delete(key);
    this.#entries.set(key, { etag, value });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
      this.#stats.evictions += 1;
    }
  }

  /** Records that GitHub answered 304 and the stored value was reused. */
  noteNotModified(): void {
    this.#stats.notModified += 1;
  }

  /** Drops one resource. Used after a write to that resource; see `invalidateRepo`. */
  invalidate(ref: RepoRef, resource: string): void {
    this.#entries.delete(cacheKey(ref, resource));
  }

  /**
   * Drops every entry for one repository.
   *
   * Strictly, ETag semantics already make this unnecessary: after Pipenzo's own write GitHub issues
   * a new validator, so the next conditional read answers 200 with the new body. It is done anyway
   * because GitHub's own caching layer is documented as eventually consistent — a `304` served from
   * a replica moments after a write is a real, observed behaviour, and a phase machine that read a
   * label set from *before* its own transition would reconcile the ticket straight back to the lane
   * it just left. Dropping the entry costs one unconditional read and removes that class of bug
   * entirely.
   */
  invalidateRepo(ref: RepoRef): void {
    const prefix = repoPrefix(ref);
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}
