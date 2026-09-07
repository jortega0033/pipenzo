import { describe, expect, it } from 'vitest';
import {
  ConditionalRequestCache,
  DEFAULT_CONDITIONAL_CACHE_MAX_ENTRIES,
} from '../src/github-conditional-cache.js';
import type { RepoRef } from '../src/github-client.js';

const REF: RepoRef = { owner: 'jortega0033', repo: 'pipenzo' };
const OTHER: RepoRef = { owner: 'jortega0033', repo: 'agent-dock' };

describe('ConditionalRequestCache', () => {
  it('stores and returns one entry per (repo, resource)', () => {
    const cache = new ConditionalRequestCache();
    cache.set(REF, 'issue:161', 'W/"a"', { number: 161 });
    cache.set(REF, 'issue:165', 'W/"b"', { number: 165 });
    cache.set(OTHER, 'issue:161', 'W/"c"', { number: 1 });

    expect(cache.get(REF, 'issue:161')).toEqual({ etag: 'W/"a"', value: { number: 161 } });
    expect(cache.get(REF, 'issue:165')?.etag).toBe('W/"b"');
    // Same issue number, different repository: never the same entry.
    expect(cache.get(OTHER, 'issue:161')?.etag).toBe('W/"c"');
    expect(cache.size).toBe(3);
  });

  /**
   * GitHub treats `Owner/Repo` and `owner/repo` as the same repository. Two entries for one
   * resource would mean two cold reads and two validators, one of which is always stale.
   */
  it('treats owner and repo case-insensitively', () => {
    const cache = new ConditionalRequestCache();
    cache.set({ owner: 'JOrtega0033', repo: 'Pipenzo' }, 'labels', 'W/"x"', ['pipenzo:queued']);
    expect(cache.get(REF, 'labels')?.etag).toBe('W/"x"');
    expect(cache.size).toBe(1);
  });

  it('reports nothing for a resource it has never seen', () => {
    const cache = new ConditionalRequestCache();
    expect(cache.get(REF, 'issue:1')).toBeUndefined();
    expect(cache.stats.cold).toBe(1);
    expect(cache.stats.validatorsSent).toBe(0);
  });

  it('refuses to store a blank validator rather than sending one GitHub would reject', () => {
    const cache = new ConditionalRequestCache();
    cache.set(REF, 'issue:1', '   ', { number: 1 });
    expect(cache.get(REF, 'issue:1')).toBeUndefined();
    // The response is still counted: it was a real 200, it just cannot be revalidated later.
    expect(cache.stats.modified).toBe(1);
    expect(cache.size).toBe(0);
  });

  it('counts what the rate-limit surface needs to know', () => {
    const cache = new ConditionalRequestCache();
    cache.get(REF, 'issue:1'); // cold
    cache.set(REF, 'issue:1', 'W/"a"', 1);
    cache.get(REF, 'issue:1'); // validator sent
    cache.noteNotModified();
    expect(cache.stats).toEqual({
      validatorsSent: 1,
      cold: 1,
      notModified: 1,
      modified: 1,
      evictions: 0,
      oversized: 0,
    });
  });

  /**
   * The memory bound, enforced here rather than assumed from GitHub's own body limit. A count-only
   * bound says nothing about bytes: 512 maximal issue bodies would be tens of megabytes.
   */
  describe('bounded in bytes as well as in entries', () => {
    const big = (kilobytes: number): string => 'x'.repeat(kilobytes * 1024);

    it('evicts least-recently-used until it is back inside the byte budget', () => {
      // Each 20 KiB value costs about 41 KB retained (UTF-16), so two fit in 100 KiB and three
      // do not — the third store has to evict exactly one.
      const budget = 100 * 1024;
      const cache = new ConditionalRequestCache({ maxEntries: 100, maxBytes: budget });
      cache.set(REF, 'a', 'W/"a"', big(20));
      cache.set(REF, 'b', 'W/"b"', big(20));
      cache.get(REF, 'a'); // make 'b' the least recently used
      cache.set(REF, 'c', 'W/"c"', big(20));

      expect(cache.bytes).toBeLessThanOrEqual(budget);
      expect(cache.get(REF, 'b')).toBeUndefined();
      expect(cache.get(REF, 'a')).toBeDefined();
      expect(cache.get(REF, 'c')).toBeDefined();
      expect(cache.stats.evictions).toBeGreaterThan(0);
    });

    /** One response larger than the whole budget is refused, not admitted to evict everything else. */
    it('refuses a single response bigger than the entire budget', () => {
      const cache = new ConditionalRequestCache({ maxBytes: 16 * 1024 });
      cache.set(REF, 'keep', 'W/"a"', 'small');
      cache.set(REF, 'huge', 'W/"b"', big(64));

      expect(cache.get(REF, 'huge')).toBeUndefined();
      expect(cache.get(REF, 'keep')?.value).toBe('small');
      expect(cache.stats.oversized).toBe(1);
    });

    it('keeps its byte total honest across replacement, invalidation and clear', () => {
      const cache = new ConditionalRequestCache();
      cache.set(REF, 'a', 'W/"1"', big(4));
      const afterFirst = cache.bytes;
      cache.set(REF, 'a', 'W/"2"', big(4));
      expect(cache.bytes).toBe(afterFirst);

      cache.invalidate(REF, 'a');
      expect(cache.bytes).toBe(0);

      cache.set(REF, 'b', 'W/"3"', big(4));
      cache.clear();
      expect(cache.bytes).toBe(0);
    });

    it('rejects a nonsensical byte bound', () => {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(() => new ConditionalRequestCache({ maxBytes: bad })).toThrow(/positive integer/);
      }
    });
  });

  /**
   * The counter that lets an in-flight conditional read notice a write landing underneath it.
   * Invalidation bumps it; eviction deliberately does not, because an entry dropped for space was
   * never contradicted.
   */
  describe('generation', () => {
    it('advances on every invalidation', () => {
      const cache = new ConditionalRequestCache();
      const start = cache.generation;
      cache.invalidate(REF, 'issue:1');
      expect(cache.generation).toBe(start + 1);
      cache.invalidateRepo(REF);
      expect(cache.generation).toBe(start + 2);
      cache.clear();
      expect(cache.generation).toBe(start + 3);
    });

    it('does not advance on a store, a read, or an eviction', () => {
      const cache = new ConditionalRequestCache({ maxEntries: 1 });
      cache.set(REF, 'a', 'W/"a"', 1);
      const start = cache.generation;
      cache.get(REF, 'a');
      cache.set(REF, 'b', 'W/"b"', 2); // evicts 'a'
      expect(cache.get(REF, 'a')).toBeUndefined();
      expect(cache.generation).toBe(start);
    });
  });

  describe('bounded, least-recently-used', () => {
    it('evicts the least recently used entry past maxEntries', () => {
      const cache = new ConditionalRequestCache({ maxEntries: 2 });
      cache.set(REF, 'a', 'W/"a"', 'a');
      cache.set(REF, 'b', 'W/"b"', 'b');
      cache.set(REF, 'c', 'W/"c"', 'c');
      expect(cache.size).toBe(2);
      expect(cache.get(REF, 'a')).toBeUndefined();
      expect(cache.get(REF, 'b')?.value).toBe('b');
      expect(cache.get(REF, 'c')?.value).toBe('c');
      expect(cache.stats.evictions).toBe(1);
    });

    /**
     * The property that actually matters for a poll loop: the ticket the reconciler asks about
     * every cycle must survive a burst of one-off reads, or the cache degrades to permanently cold
     * on exactly the resource it exists for.
     */
    it('keeps an entry alive by reading it', () => {
      const cache = new ConditionalRequestCache({ maxEntries: 2 });
      cache.set(REF, 'hot', 'W/"a"', 'a');
      cache.set(REF, 'cold', 'W/"b"', 'b');
      cache.get(REF, 'hot');
      cache.set(REF, 'new', 'W/"c"', 'c');
      expect(cache.get(REF, 'hot')?.value).toBe('a');
      expect(cache.get(REF, 'cold')).toBeUndefined();
    });

    it('re-storing an existing resource does not grow the map', () => {
      const cache = new ConditionalRequestCache({ maxEntries: 2 });
      cache.set(REF, 'a', 'W/"1"', 1);
      cache.set(REF, 'a', 'W/"2"', 2);
      expect(cache.size).toBe(1);
      expect(cache.get(REF, 'a')).toEqual({ etag: 'W/"2"', value: 2 });
      expect(cache.stats.evictions).toBe(0);
    });

    it('rejects a nonsensical bound rather than silently using the default', () => {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(() => new ConditionalRequestCache({ maxEntries: bad })).toThrow(/positive integer/);
      }
      expect(DEFAULT_CONDITIONAL_CACHE_MAX_ENTRIES).toBeGreaterThan(0);
    });
  });

  describe('invalidation', () => {
    it('drops one resource without touching its siblings', () => {
      const cache = new ConditionalRequestCache();
      cache.set(REF, 'issue:1', 'W/"a"', 1);
      cache.set(REF, 'issue:2', 'W/"b"', 2);
      cache.invalidate(REF, 'issue:1');
      expect(cache.get(REF, 'issue:1')).toBeUndefined();
      expect(cache.get(REF, 'issue:2')?.value).toBe(2);
    });

    it('drops a whole repository without touching another one', () => {
      const cache = new ConditionalRequestCache();
      cache.set(REF, 'issue:1', 'W/"a"', 1);
      cache.set(REF, 'labels', 'W/"b"', 2);
      cache.set(OTHER, 'issue:1', 'W/"c"', 3);
      cache.invalidateRepo({ owner: 'JOrtega0033', repo: 'PIPENZO' });
      expect(cache.get(REF, 'issue:1')).toBeUndefined();
      expect(cache.get(REF, 'labels')).toBeUndefined();
      expect(cache.get(OTHER, 'issue:1')?.value).toBe(3);
    });

    /**
     * A repository whose name is a prefix of another one (`pipenzo` and `pipenzo-docs`) must not be
     * caught by a repo-wide invalidation. The `#` separator in the key is what prevents it.
     */
    it('does not drop a repository whose name merely starts with the invalidated one', () => {
      const cache = new ConditionalRequestCache();
      const sibling: RepoRef = { owner: 'jortega0033', repo: 'pipenzo-docs' };
      cache.set(REF, 'issue:1', 'W/"a"', 1);
      cache.set(sibling, 'issue:1', 'W/"b"', 2);
      cache.invalidateRepo(REF);
      expect(cache.get(REF, 'issue:1')).toBeUndefined();
      expect(cache.get(sibling, 'issue:1')?.value).toBe(2);
    });

    it('clears everything', () => {
      const cache = new ConditionalRequestCache();
      cache.set(REF, 'issue:1', 'W/"a"', 1);
      cache.clear();
      expect(cache.size).toBe(0);
    });
  });
});
