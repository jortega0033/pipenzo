import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_CORE_RATE_LIMIT_RESOURCE,
  GitHubRateLimitTracker,
  MAX_RATE_LIMIT_RESET_HORIZON_MS,
  MAX_RATE_LIMIT_RESOURCES,
  readRateLimitHeaders,
} from '../src/github-rate-limit.js';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import { OctokitGitHubClient, createPipenzoOctokit } from '../src/github-client.js';

/**
 * Issue #229. Epic #4's rule is "below ~15% remaining quota: degrade, don't fail", and before this
 * module nothing could compute that fraction: the only rate-limit signal in the product arrived
 * *after* a 429 or an exhausted 403, which is the failure the rule exists to avoid.
 */

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
const RESET_SECONDS = Math.floor(NOW / 1000) + 3_600;

/**
 * The same fixture with its reset derived from the *real* clock.
 *
 * Two accessors on this surface take no `now` and read `Date.now()` for themselves --
 * `OctokitGitHubClient.rateLimit()` and `FakeGitHubClient.rateLimit()` -- and the parser refuses a
 * reading whose window has already closed. A pinned `RESET_SECONDS` in those tests would therefore
 * pass until that instant and fail forever after: a test with an expiry date rather than an
 * assertion. Faking the clock instead is not an option here, because the transport runs on real
 * timers (octokit throttles through bottleneck) and faking them deadlocks the request.
 */
function liveHeaders(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  return headers({
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3_600),
    ...overrides,
  });
}

function headers(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4321',
    'x-ratelimit-reset': String(RESET_SECONDS),
    'x-ratelimit-resource': 'core',
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(base).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
}

describe('readRateLimitHeaders', () => {
  it('reads a complete set of headers into a snapshot, with the reset in milliseconds', () => {
    expect(readRateLimitHeaders(headers(), NOW)).toEqual({
      resource: 'core',
      limit: 5000,
      remaining: 4321,
      resetAt: RESET_SECONDS * 1000,
      observedAt: NOW,
    });
  });

  /**
   * The load-bearing refusal. `remaining: 0` is what "GitHub has cut us off" looks like, so a
   * parser that fell back to a zero would turn a header-shape change on GitHub's side into a
   * product-wide degradation. `Number('')` and `Number(' ')` are both `0`, which is exactly how
   * that mistake gets made.
   */
  it('yields no snapshot at all for a missing, blank or non-numeric header, never a zero', () => {
    for (const broken of [
      { 'x-ratelimit-remaining': undefined },
      { 'x-ratelimit-remaining': '' },
      { 'x-ratelimit-remaining': '   ' },
      { 'x-ratelimit-remaining': 'none' },
      { 'x-ratelimit-remaining': '-1' },
      { 'x-ratelimit-remaining': '12.5' },
      { 'x-ratelimit-limit': undefined },
      { 'x-ratelimit-limit': 'lots' },
      { 'x-ratelimit-reset': undefined },
      { 'x-ratelimit-reset': 'soon' },
    ]) {
      expect(readRateLimitHeaders(headers(broken), NOW), JSON.stringify(broken)).toBeUndefined();
    }
    expect(readRateLimitHeaders(undefined, NOW)).toBeUndefined();
    expect(readRateLimitHeaders({}, NOW)).toBeUndefined();
  });

  /**
   * A response billed to `search` and recorded as `core` because the bucket name was missing would
   * be a wrong number presented with the confidence of a right one. An unattributable reading is
   * not a reading.
   */
  it('refuses to guess the bucket when x-ratelimit-resource is absent or blank', () => {
    expect(readRateLimitHeaders(headers({ 'x-ratelimit-resource': undefined }), NOW)).toBeUndefined();
    expect(readRateLimitHeaders(headers({ 'x-ratelimit-resource': '  ' }), NOW)).toBeUndefined();
  });

  it('refuses a limit of zero and a remaining above the limit, which are contradictions', () => {
    expect(readRateLimitHeaders(headers({ 'x-ratelimit-limit': '0' }), NOW)).toBeUndefined();
    expect(readRateLimitHeaders(headers({ 'x-ratelimit-remaining': '5001' }), NOW)).toBeUndefined();
  });

  /**
   * The failure this guard exists for: `x-ratelimit-reset` in milliseconds instead of seconds
   * passes every digit and safe-integer check and lands the reset around the year 57000. Stored,
   * it would be permanent -- `latest` would never expire it -- so epic #4's threshold would be
   * silently disabled for the life of the daemon, with no log and no error.
   */
  it('refuses a reset instant that is implausibly far away, such as one sent in milliseconds', () => {
    const asMilliseconds = String(RESET_SECONDS * 1000);
    expect(readRateLimitHeaders(headers({ 'x-ratelimit-reset': asMilliseconds }), NOW)).toBeUndefined();
    const justInside = String(Math.floor((NOW + MAX_RATE_LIMIT_RESET_HORIZON_MS) / 1000) - 1);
    expect(readRateLimitHeaders(headers({ 'x-ratelimit-reset': justInside }), NOW)).toBeDefined();
  });

  /**
   * Refused here as well as in `latest`, so the accessor and the push notification can state the
   * same rule: a reading born expired describes a window that has already refilled.
   */
  it('refuses a reset instant that has already passed', () => {
    const passed = String(Math.floor(NOW / 1000) - 1);
    expect(readRateLimitHeaders(headers({ 'x-ratelimit-reset': passed }), NOW)).toBeUndefined();
    const exactlyNow = String(Math.floor(NOW / 1000));
    expect(readRateLimitHeaders(headers({ 'x-ratelimit-reset': exactlyNow }), NOW)).toBeUndefined();
  });

  it('keeps a genuine zero remaining, which is the reading a consumer most needs', () => {
    expect(readRateLimitHeaders(headers({ 'x-ratelimit-remaining': '0' }), NOW)).toMatchObject({
      remaining: 0,
      limit: 5000,
    });
  });

  it('treats a numeric header value as the number it is, and anything else as absent', () => {
    expect(readRateLimitHeaders({ ...headers(), 'x-ratelimit-remaining': 42 }, NOW)).toMatchObject({
      remaining: 42,
    });
    expect(
      readRateLimitHeaders({ ...headers(), 'x-ratelimit-remaining': ['4321'] }, NOW),
    ).toBeUndefined();
  });
});

describe('GitHubRateLimitTracker', () => {
  it('keys readings by resource, so a search exhaustion cannot read as core headroom', () => {
    const tracker = new GitHubRateLimitTracker();
    tracker.record(headers(), NOW);
    tracker.record(
      headers({ 'x-ratelimit-resource': 'search', 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': '1' }),
      NOW,
    );
    expect(tracker.latest(GITHUB_CORE_RATE_LIMIT_RESOURCE, NOW)).toMatchObject({ remaining: 4321 });
    expect(tracker.latest('search', NOW)).toMatchObject({ remaining: 1, limit: 30 });
    expect(tracker.latest('graphql', NOW)).toBeUndefined();
  });

  it('defaults to the core bucket, which is what ordinary reads and writes are billed to', () => {
    const tracker = new GitHubRateLimitTracker();
    tracker.record(headers(), NOW);
    expect(tracker.latest(undefined, NOW)).toMatchObject({ resource: 'core' });
  });

  it('keeps the latest reading, including a refilled window where remaining rises', () => {
    const tracker = new GitHubRateLimitTracker();
    tracker.record(headers({ 'x-ratelimit-remaining': '12' }), NOW);
    expect(tracker.latest('core', NOW)).toMatchObject({ remaining: 12 });
    const later = String(RESET_SECONDS + 3_600);
    tracker.record(headers({ 'x-ratelimit-remaining': '5000', 'x-ratelimit-reset': later }), NOW + 1);
    expect(tracker.latest('core', NOW + 1)).toMatchObject({ remaining: 5000 });
  });

  /**
   * The key is a value a remote party supplies and this daemon runs for days, so the map is
   * bounded the way `ConditionalRequestCache` is. `latest` only ever evicts the bucket it was
   * asked for, so nothing else would ever remove a bucket nobody reads.
   */
  it('bounds how many buckets it retains, oldest first', () => {
    const tracker = new GitHubRateLimitTracker();
    for (let index = 0; index < MAX_RATE_LIMIT_RESOURCES + 4; index += 1) {
      tracker.record(headers({ 'x-ratelimit-resource': `bucket-${index}` }), NOW);
    }
    expect(tracker.latest('bucket-0', NOW)).toBeUndefined();
    expect(tracker.latest('bucket-3', NOW)).toBeUndefined();
    expect(tracker.latest('bucket-4', NOW)).toMatchObject({ remaining: 4321 });
    expect(tracker.latest(`bucket-${MAX_RATE_LIMIT_RESOURCES + 3}`, NOW)).toBeDefined();
  });

  it('refuses a bucket name long enough to be abuse rather than a bucket', () => {
    expect(
      readRateLimitHeaders(headers({ 'x-ratelimit-resource': 'x'.repeat(65) }), NOW),
    ).toBeUndefined();
  });

  /**
   * A snapshot whose window has refilled is not merely stale — its `remaining` is wrong in the
   * alarming direction, and "3% left" from an hour ago would degrade a product with a full
   * allowance. There is deliberately no accessor that hands one back.
   */
  it('drops an expired reading rather than returning it', () => {
    const tracker = new GitHubRateLimitTracker();
    tracker.record(headers({ 'x-ratelimit-remaining': '3' }), NOW);
    expect(tracker.latest('core', RESET_SECONDS * 1000 - 1)).toMatchObject({ remaining: 3 });
    expect(tracker.latest('core', RESET_SECONDS * 1000)).toBeUndefined();
    // And it stays gone, rather than reappearing for a caller that asks with an earlier clock.
    expect(tracker.latest('core', NOW)).toBeUndefined();
  });

  /**
   * A method rather than a constructor option because of construction order in `index.ts`: the
   * tracker is built before the components that would subscribe to it, so a listener supplied only
   * at construction could never be supplied by the consumer it exists for (#231).
   */
  it('pushes every recorded reading to subscribers, and stops on unsubscribe', () => {
    const seen: number[] = [];
    const tracker = new GitHubRateLimitTracker();
    const unsubscribe = tracker.subscribe((snapshot) => seen.push(snapshot.remaining));
    tracker.record(headers({ 'x-ratelimit-remaining': '100' }), NOW);
    tracker.record(headers({ 'x-ratelimit-remaining': '99' }), NOW + 1);
    // Not notified: a malformed set is not a reading at all.
    tracker.record(headers({ 'x-ratelimit-remaining': 'none' }), NOW + 2);
    unsubscribe();
    tracker.record(headers({ 'x-ratelimit-remaining': '98' }), NOW + 3);
    expect(seen).toEqual([100, 99]);
    // The reading itself still landed; only the notification stopped.
    expect(tracker.latest('core', NOW + 3)).toMatchObject({ remaining: 98 });
  });

  /**
   * This runs inside the client's response path, so a subscriber's bug must not become a failed
   * GitHub request.
   */
  it('records the reading even when the subscriber throws', () => {
    const tracker = new GitHubRateLimitTracker();
    tracker.subscribe(() => {
      throw new Error('subscriber is broken');
    });
    expect(() => tracker.record(headers(), NOW)).not.toThrow();
    expect(tracker.latest('core', NOW)).toMatchObject({ remaining: 4321 });
  });
});

/**
 * The capture is installed as an octokit hook rather than written into each client method, so what
 * has to be asserted is that it sees real traffic — including the two shapes a per-method capture
 * would have missed: `paginate`'s internal requests, and the `304` that `@octokit/request` raises
 * rather than returns.
 *
 * Everything here uses `liveHeaders` and the real clock. The hook stamps `observedAt` with
 * `Date.now()` itself, and the parser refuses a reading whose window has already closed, so a
 * pinned reset instant would quietly turn these into tests that expire.
 */
describe('rate-limit capture on the real transport', () => {
  function stubFetch(
    responses: Array<{ status: number; headers: Record<string, string>; body?: unknown }>,
  ): ReturnType<typeof vi.fn> {
    let index = 0;
    return vi.fn(async () => {
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return new Response(next?.status === 304 ? null : JSON.stringify(next?.body ?? {}), {
        status: next?.status ?? 200,
        headers: { 'content-type': 'application/json', ...(next?.headers ?? {}) },
      });
    });
  }

  it('records from an ordinary 200 without making a request of its own', async () => {
    const tracker = new GitHubRateLimitTracker();
    const fetchImpl = stubFetch([{ status: 200, headers: liveHeaders(), body: { login: 'someone' } }]);
    // Stubbed *globally*, not injected as `request.fetch`, and that is the whole point of this
    // test. A capture that issued a request of its own -- `GET /rate_limit`, say -- would build it
    // without the caller's `request` options and it would leave through global fetch: the injected
    // stub would still show exactly one call and this assertion would pass while a second request
    // went to the real network. Counting against the global covers any request the client makes.
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const octokit = createPipenzoOctokit('token-value', { rateLimits: tracker });
      await octokit.request('GET /user');
    } finally {
      vi.unstubAllGlobals();
    }

    expect(tracker.latest('core')).toMatchObject({ remaining: 4321, limit: 5000 });
    // The premise of the whole ticket: the reading is free. One request went out, the caller's own.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /**
   * A 304 arrives through octokit's *error* path. A capture written only into the success path
   * would see nothing during exactly the traffic the conditional-request layer (#161) produces,
   * which is when the reconciler most needs a current reading — and, since `latest` expires an old
   * snapshot, the tracker would go blank precisely while the daemon was busiest.
   */
  it('records from a 304, which arrives as a thrown error, and still rethrows it', async () => {
    const tracker = new GitHubRateLimitTracker();
    const fetchImpl = stubFetch([
      { status: 304, headers: liveHeaders({ 'x-ratelimit-remaining': '4000' }) },
    ]);
    const octokit = createPipenzoOctokit('token-value', { rateLimits: tracker });
    await expect(
      octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner: 'jortega0033',
        repo: 'pipenzo',
        issue_number: 161,
        headers: { 'if-none-match': 'W/"etag"' },
        request: { fetch: fetchImpl },
      }),
    ).rejects.toMatchObject({ status: 304 });
    expect(tracker.latest('core')).toMatchObject({ remaining: 4000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /**
   * `paginate` makes requests no client method can see, so a capture written per method would read
   * the first page's headers at best and miss every page after it — including the last one, which
   * is the only page whose reading is current.
   */
  it('records from the pages `paginate` fetches for itself, not just the first', async () => {
    const tracker = new GitHubRateLimitTracker();
    const page = (remaining: string, link?: string): { status: number; headers: Record<string, string>; body: unknown } => ({
      status: 200,
      headers: { ...liveHeaders({ 'x-ratelimit-remaining': remaining }), ...(link ? { link } : {}) },
      body: [{ name: 'pipenzo:refining', color: 'ededed', description: '' }],
    });
    const fetchImpl = stubFetch([
      page('300', '<https://api.github.com/repositories/1/labels?page=2>; rel="next"'),
      page('299'),
    ]);
    // Stubbed globally rather than passed as `request.fetch`, because that is the only way to
    // reach the second page: `@octokit/plugin-paginate-rest` rebuilds each follow-up request from
    // `{ method, url, headers }` alone and drops the caller's `request` options — so a per-call
    // fetch injection covers page one and lets page two out to the real network. That is itself
    // worth knowing: the pages this hook has to see are exactly the ones a caller cannot intercept.
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const octokit = createPipenzoOctokit('token-value', { rateLimits: tracker });
      await octokit.paginate('GET /repos/{owner}/{repo}/labels', {
        owner: 'jortega0033',
        repo: 'pipenzo',
        per_page: 100,
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The second page's reading, not the first's.
    expect(tracker.latest('core')).toMatchObject({ remaining: 299 });
  });

  it('records an exhausted quota from the 403 that reports it', async () => {
    const tracker = new GitHubRateLimitTracker();
    const fetchImpl = stubFetch([
      {
        status: 403,
        headers: liveHeaders({ 'x-ratelimit-remaining': '0' }),
        body: { message: 'API rate limit exceeded' },
      },
    ]);
    const octokit = createPipenzoOctokit('token-value', { rateLimits: tracker });
    await expect(octokit.request('GET /user', { request: { fetch: fetchImpl } })).rejects.toBeTruthy();
    expect(tracker.latest('core')).toMatchObject({ remaining: 0 });
  });

  it('exposes the reading through the client accessor the reconciler will call', async () => {
    const tracker = new GitHubRateLimitTracker();
    const fetchImpl = stubFetch([{ status: 200, headers: liveHeaders(), body: { login: 'someone' } }]);
    const octokit = createPipenzoOctokit('token-value', { rateLimits: tracker });
    const client = OctokitGitHubClient.withOctokit(octokit, { rateLimits: tracker });

    expect(client.rateLimit()).toBeUndefined();
    await octokit.request('GET /user', { request: { fetch: fetchImpl } });
    const snapshot = client.rateLimit();
    expect(snapshot).toMatchObject({ resource: 'core', remaining: 4321, limit: 5000 });
    // The fraction epic #4's ~15% rule compares against. Stored as two numbers on purpose, so the
    // threshold lives with the consumer that reacts to it rather than in here.
    expect(snapshot && snapshot.remaining / snapshot.limit).toBeCloseTo(0.8642, 4);
  });

  /**
   * The fake is what #231's reconciler and #75's pill will be tested against, so it has to answer
   * the same accessor under the same rules -- including the parser's refusals, which is why the
   * seeder takes headers rather than a ready-made snapshot. (Expiry itself is asserted directly on
   * the tracker above, where an explicit `now` can be passed.)
   */
  it('answers the same accessor on the fake, under the same parse rules', () => {
    expect(new FakeGitHubClient().rateLimit()).toBeUndefined();
    expect(
      new FakeGitHubClient()
        .seedRateLimitHeaders(liveHeaders({ 'x-ratelimit-remaining': '600' }))
        .rateLimit(),
    ).toMatchObject({ resource: 'core', remaining: 600, limit: 5000 });
    // A malformed seed is not a reading, on the fake exactly as on the real client.
    expect(
      new FakeGitHubClient()
        .seedRateLimitHeaders(liveHeaders({ 'x-ratelimit-remaining': 'none' }))
        .rateLimit(),
    ).toBeUndefined();
  });

  it('captures nothing, and breaks nothing, when no tracker is wired', async () => {
    const fetchImpl = stubFetch([{ status: 200, headers: liveHeaders(), body: { login: 'someone' } }]);
    const octokit = createPipenzoOctokit('token-value');
    await expect(octokit.request('GET /user', { request: { fetch: fetchImpl } })).resolves.toMatchObject(
      { status: 200 },
    );
    expect(OctokitGitHubClient.withOctokit(octokit).rateLimit()).toBeUndefined();
  });
});
