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
 * ## Bounded twice, and least-recently-used
 *
 * A workspace-level connected-repos list (epic #4) times the issues in each is unbounded, and an
 * unbounded map holding whole issue bodies is a leak in a process meant to run for days. Entries
 * are evicted least-recently-used past **both** bounds; an evicted entry costs exactly one
 * unconditional read the next time it is asked for.
 *
 * There are two bounds rather than one because a count alone does not bound memory. GitHub's issue
 * body limit is 65,536 characters, which V8 stores as UTF-16 — so 512 maximal issues would be about
 * 64 MB, not the "few megabytes" a count-only bound suggests. Worse, that number is an assumption
 * about a third party's current limit rather than something this code enforces. The byte budget
 * makes the ceiling this module's own property.
 */

/** The entry-count bound: far more than one board's worth of tickets. */
export const DEFAULT_CONDITIONAL_CACHE_MAX_ENTRIES = 512;

/**
 * The memory bound, enforced rather than assumed. 8 MiB holds hundreds of ordinary issues and
 * caps the pathological case regardless of what GitHub's own body limit becomes.
 */
export const DEFAULT_CONDITIONAL_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface ConditionalCacheEntry<T> {
  readonly etag: string;
  readonly value: T;
}

interface StoredEntry {
  readonly etag: string;
  readonly value: unknown;
  /** Approximate retained size, so the byte budget does not have to re-measure on eviction. */
  readonly bytes: number;
}

/**
 * Approximate retained size of one entry, in bytes.
 *
 * `JSON.stringify` length times two, for V8's UTF-16 string storage, plus the key. Approximate on
 * purpose: an exact measurement would need `v8.serialize` or a heap walk, and the number is used
 * only to enforce a budget, where being within a small factor is the whole requirement. An
 * unserializable value is treated as maximal so it is refused rather than admitted unmeasured.
 */
function approximateBytes(key: string, value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return (serialized?.length ?? 0) * 2 + key.length * 2;
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
  /**
   * Requests GitHub answered with a body — the ones that spent quota. Counted whether or not the
   * response turned out to be storable (no ETag, too large, not a cacheable shape), because the
   * consumer of this number is the rate-limit surface, and quota is spent either way.
   */
  readonly modified: number;
  /** Entries dropped to stay inside `maxEntries` or `maxBytes`. */
  readonly evictions: number;
  /** Responses refused outright because one of them alone exceeded the byte budget. */
  readonly oversized: number;
}

interface MutableStats {
  validatorsSent: number;
  cold: number;
  notModified: number;
  modified: number;
  evictions: number;
  oversized: number;
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
  readonly #entries = new Map<string, StoredEntry>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  #bytes = 0;
  #generation = 0;
  readonly #stats: MutableStats = {
    validatorsSent: 0,
    cold: 0,
    notModified: 0,
    modified: 0,
    evictions: 0,
    oversized: 0,
  };

  constructor(options: { maxEntries?: number; maxBytes?: number } = {}) {
    const requestedEntries = options.maxEntries ?? DEFAULT_CONDITIONAL_CACHE_MAX_ENTRIES;
    if (!Number.isSafeInteger(requestedEntries) || requestedEntries < 1) {
      throw new Error('conditional request cache maxEntries must be a positive integer');
    }
    const requestedBytes = options.maxBytes ?? DEFAULT_CONDITIONAL_CACHE_MAX_BYTES;
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 1) {
      throw new Error('conditional request cache maxBytes must be a positive integer');
    }
    this.#maxEntries = requestedEntries;
    this.#maxBytes = requestedBytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Approximate retained bytes. See `approximateBytes` for what "approximate" means here. */
  get bytes(): number {
    return this.#bytes;
  }

  /**
   * Bumped by every *invalidation*, and read by callers that must detect one happening underneath
   * an in-flight request.
   *
   * The race this exists for is real, not theoretical: `index.ts` shares one cache between the
   * phase machine's reconciler and the phase service's request-scoped clients. A read captures its
   * validator, awaits GitHub, and meanwhile a write on the same resource lands and invalidates the
   * entry. If GitHub then answers the pre-write validator with a `304` — which its
   * eventually-consistent replicas really do — the read would return the pre-write body and, worse,
   * keep confirming it on every subsequent poll, because a matching `304` looks like agreement.
   * Comparing the generation across the await turns that into an ordinary cache miss.
   *
   * Eviction deliberately does **not** bump it. An entry dropped for space was never contradicted,
   * so a `304` against its validator is still the truth.
   */
  get generation(): number {
    return this.#generation;
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
    return { etag: entry.etag, value: entry.value as T };
  }

  /**
   * Records a fresh 200 response. An empty or non-string ETag stores nothing rather than storing a
   * validator GitHub would reject — a resource served without one simply stays uncached. A single
   * response larger than the whole byte budget is refused rather than admitted and then allowed to
   * evict everything else to make room for itself.
   */
  set<T>(ref: RepoRef, resource: string, etag: string, value: T): void {
    this.#stats.modified += 1;
    const key = cacheKey(ref, resource);
    if (typeof etag !== 'string' || etag.trim() === '') {
      this.#drop(key);
      return;
    }
    const bytes = approximateBytes(key, value);
    if (bytes > this.#maxBytes) {
      this.#stats.oversized += 1;
      this.#drop(key);
      return;
    }
    this.#drop(key);
    this.#entries.set(key, { etag, value, bytes });
    this.#bytes += bytes;
    while (
      this.#entries.size > this.#maxEntries ||
      (this.#bytes > this.#maxBytes && this.#entries.size > 1)
    ) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#drop(oldest.value);
      this.#stats.evictions += 1;
    }
  }

  /** Records that GitHub answered 304 and the stored value was reused. */
  noteNotModified(): void {
    this.#stats.notModified += 1;
  }

  /**
   * Drops one resource, and records that an invalidation happened. Used after a write to that
   * resource, and whenever a caller decides a stored entry can no longer be trusted; see
   * `generation` for the in-flight race this bump exists for.
   */
  invalidate(ref: RepoRef, resource: string): void {
    this.#generation += 1;
    this.#drop(cacheKey(ref, resource));
  }

  /** Removes a key and keeps the byte total honest. Never counts as an invalidation on its own. */
  #drop(key: string): void {
    const existing = this.#entries.get(key);
    if (existing === undefined) return;
    this.#bytes -= existing.bytes;
    this.#entries.delete(key);
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
    this.#generation += 1;
    const prefix = repoPrefix(ref);
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) this.#drop(key);
    }
  }

  clear(): void {
    this.#generation += 1;
    this.#entries.clear();
    this.#bytes = 0;
  }
}
