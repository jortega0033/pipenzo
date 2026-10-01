import { describe, expect, it } from 'vitest';
import {
  GITHUB_OPEN_ISSUE_PAGE_CAP,
  GitHubClientError,
  OctokitGitHubClient,
  type RepoRef,
} from '../src/github-client.js';
import { ConditionalRequestCache } from '../src/github-conditional-cache.js';

/**
 * `listOpenIssues` (issue #511): the read the reconciler's intake pass diffs against the ticket store.
 *
 * Driven through a stub `request` rather than `FakeGitHubClient`, because the two properties under
 * test -- pull-request exclusion and per-page conditional requests -- both live in the real client's
 * handling of GitHub's raw payload and headers, which the fake deliberately does not re-implement.
 */

const REF: RepoRef = { owner: 'jortega0033', repo: 'pipenzo' };
const NEXT = '<https://api.github.com/repositories/1/issues?page=2>; rel="next"';

interface Call {
  route: string;
  params: Record<string, unknown>;
}

type Responder = (params: Record<string, unknown>, call: number) => Promise<unknown>;

function stubOctokit(respond: Responder): { octokit: never; calls: Call[] } {
  const calls: Call[] = [];
  const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params });
      return respond(params, calls.length);
    },
    paginate: async () => {
      throw new Error('listOpenIssues must walk pages itself, never through paginate');
    },
  };
  return { octokit: octokit as never, calls };
}

function httpError(status: number, headers: Record<string, string> = {}): Error {
  const error = new Error(`HTTP ${status}`) as Error & {
    status: number;
    response: { headers: Record<string, string> };
  };
  error.status = status;
  error.response = { headers };
  return error;
}

const rawIssue = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  state: 'open',
  body: 'a long body nothing on the intake path reads',
  labels: [{ name: 'bug' }],
  html_url: `https://github.com/jortega0033/pipenzo/issues/${number}`,
  ...overrides,
});

const rawPullRequest = (number: number) =>
  rawIssue(number, { pull_request: { url: `https://api.github.com/pulls/${number}` } });

const ifNoneMatch = (call: Call | undefined): string | undefined =>
  (call?.params.headers as Record<string, string> | undefined)?.['if-none-match'];

describe('OctokitGitHubClient.listOpenIssues', () => {
  it('asks for open issues, newest first, a full page at a time', async () => {
    const { octokit, calls } = stubOctokit(async () => ({ headers: {}, data: [] }));
    await OctokitGitHubClient.withOctokit(octokit).listOpenIssues(REF);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.route).toBe('GET /repos/{owner}/{repo}/issues');
    expect(calls[0]?.params).toMatchObject({
      owner: 'jortega0033',
      repo: 'pipenzo',
      state: 'open',
      sort: 'created',
      direction: 'desc',
      per_page: 100,
      page: 1,
    });
  });

  it('excludes pull requests, which the issues endpoint returns alongside issues', async () => {
    const { octokit } = stubOctokit(async () => ({
      headers: {},
      data: [rawIssue(3), rawPullRequest(2), rawIssue(1)],
    }));
    const { issues, truncated } = await OctokitGitHubClient.withOctokit(octokit).listOpenIssues(REF);

    expect(truncated).toBe(false);
    expect(issues.map((issue) => issue.number)).toEqual([3, 1]);
  });

  it('drops a closed issue should one ever appear on an open listing', async () => {
    const { octokit } = stubOctokit(async () => ({
      headers: {},
      data: [rawIssue(2, { state: 'closed' }), rawIssue(1)],
    }));
    const { issues } = await OctokitGitHubClient.withOctokit(octokit).listOpenIssues(REF);
    expect(issues.map((issue) => issue.number)).toEqual([1]);
  });

  it('normalizes to number, title and label names only -- no body rides along into the cache', async () => {
    const { octokit } = stubOctokit(async () => ({
      headers: {},
      data: [rawIssue(7, { labels: [{ name: 'bug' }, 'pipenzo:queued'] })],
    }));
    const { issues } = await OctokitGitHubClient.withOctokit(octokit).listOpenIssues(REF);

    expect(issues).toEqual([{ number: 7, title: 'Issue 7', labels: ['bug', 'pipenzo:queued'] }]);
  });

  it('follows the Link header across pages and de-duplicates an issue that shifted pages', async () => {
    const { octokit, calls } = stubOctokit(async (params) => {
      if (params.page === 1) return { headers: { link: NEXT }, data: [rawIssue(5), rawIssue(4)] };
      // Issue 4 shifted onto page two between requests: seen twice, kept once.
      return { headers: {}, data: [rawIssue(4), rawIssue(3)] };
    });
    const { issues } = await OctokitGitHubClient.withOctokit(octokit).listOpenIssues(REF);

    expect(calls.map((call) => call.params.page)).toEqual([1, 2]);
    expect(issues.map((issue) => issue.number)).toEqual([5, 4, 3]);
  });

  it('keeps walking past a page that was entirely pull requests', async () => {
    const { octokit, calls } = stubOctokit(async (params) =>
      params.page === 1
        ? { headers: { link: NEXT }, data: [rawPullRequest(9), rawPullRequest(8)] }
        : { headers: {}, data: [rawIssue(1)] },
    );
    const { issues } = await OctokitGitHubClient.withOctokit(octokit).listOpenIssues(REF);

    expect(calls).toHaveLength(2);
    expect(issues.map((issue) => issue.number)).toEqual([1]);
  });

  it('stops at an empty page even when its Link header claims another', async () => {
    const { octokit, calls } = stubOctokit(async () => ({ headers: { link: NEXT }, data: [] }));
    await OctokitGitHubClient.withOctokit(octokit).listOpenIssues(REF);
    expect(calls).toHaveLength(1);
  });

  it('stops at the page cap and says the listing is truncated', async () => {
    const { octokit, calls } = stubOctokit(async (params) => ({
      headers: { link: NEXT },
      data: [rawIssue(10_000 - Number(params.page))],
    }));
    const { issues, truncated } = await OctokitGitHubClient.withOctokit(octokit).listOpenIssues(REF);

    expect(calls).toHaveLength(GITHUB_OPEN_ISSUE_PAGE_CAP);
    expect(issues).toHaveLength(GITHUB_OPEN_ISSUE_PAGE_CAP);
    expect(truncated).toBe(true);
  });

  it('refuses a response that is not an array rather than reading it as no issues', async () => {
    const { octokit } = stubOctokit(async () => ({ headers: {}, data: { message: 'nope' } }));
    const error = await OctokitGitHubClient.withOctokit(octokit)
      .listOpenIssues(REF)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubClientError);
    expect((error as GitHubClientError).code).toBe('invalid_response');
  });

  it('maps a rejected credential onto unauthorized', async () => {
    const { octokit } = stubOctokit(async () => {
      throw httpError(401);
    });
    const error = await OctokitGitHubClient.withOctokit(octokit)
      .listOpenIssues(REF)
      .catch((caught: unknown) => caught);
    expect((error as GitHubClientError).code).toBe('unauthorized');
  });

  describe('conditional requests, page one only', () => {
    it('serves an unchanged single-page listing from a free 304 on the next pass', async () => {
      const cache = new ConditionalRequestCache();
      let firstPass = true;
      const { octokit, calls } = stubOctokit(async () => {
        if (!firstPass) throw httpError(304);
        return { headers: { etag: 'W/"p1"' }, data: [rawIssue(2), rawIssue(1)] };
      });
      const client = OctokitGitHubClient.withOctokit(octokit, { cache });

      const first = await client.listOpenIssues(REF);
      firstPass = false;
      const second = await client.listOpenIssues(REF);

      expect(ifNoneMatch(calls[0])).toBeUndefined();
      expect(ifNoneMatch(calls[1])).toBe('W/"p1"');
      expect(second).toEqual(first);
      expect(cache.stats.notModified).toBe(1);
    });

    /**
     * The security review's L3: the cache is shared with the per-ticket `issue:<n>` validators that
     * keep every-minute polling free, so a listing must not fill it with every page it walks.
     */
    it('caches page one only, and reads every later page fresh', async () => {
      const cache = new ConditionalRequestCache();
      let firstPass = true;
      const { octokit, calls } = stubOctokit(async (params) => {
        if (!firstPass && params.page === 1) throw httpError(304, { link: NEXT });
        return params.page === 1
          ? { headers: { etag: 'W/"p1"', link: NEXT }, data: [rawIssue(2)] }
          : { headers: { etag: 'W/"p2"' }, data: [rawIssue(1)] };
      });
      const client = OctokitGitHubClient.withOctokit(octokit, { cache });

      const first = await client.listOpenIssues(REF);
      firstPass = false;
      const second = await client.listOpenIssues(REF);

      expect(calls.map(ifNoneMatch)).toEqual([undefined, undefined, 'W/"p1"', undefined]);
      expect(second).toEqual(first);
      expect(cache.size).toBe(1);
      expect(cache.get(REF, 'open-issues:2')).toBeUndefined();
    });

    it("follows a 304's own Link when a page cached as the last one has since grown a next page", async () => {
      const cache = new ConditionalRequestCache();
      let pass = 1;
      const { octokit, calls } = stubOctokit(async (params) => {
        if (pass === 1) return { headers: { etag: 'W/"p1"' }, data: [rawIssue(2)] };
        // Page one is byte-identical (304), but the list has grown past it.
        if (params.page === 1) throw httpError(304, { link: NEXT });
        return { headers: { etag: 'W/"p2"' }, data: [rawIssue(1)] };
      });
      const client = OctokitGitHubClient.withOctokit(octokit, { cache });

      await client.listOpenIssues(REF);
      pass = 2;
      const { issues } = await client.listOpenIssues(REF);

      expect(calls.slice(1).map((call) => call.params.page)).toEqual([1, 2]);
      expect(issues.map((issue) => issue.number)).toEqual([2, 1]);
    });

    it('still follows a page cached with a next page when its 304 arrives without a Link', async () => {
      const cache = new ConditionalRequestCache();
      let pass = 1;
      const { octokit, calls } = stubOctokit(async (params) => {
        if (params.page === 2) return { headers: {}, data: [rawIssue(1)] };
        if (pass === 1) return { headers: { etag: 'W/"p1"', link: NEXT }, data: [rawIssue(2)] };
        throw httpError(304);
      });
      const client = OctokitGitHubClient.withOctokit(octokit, { cache });

      await client.listOpenIssues(REF);
      pass = 2;
      const { issues } = await client.listOpenIssues(REF);

      expect(calls).toHaveLength(4);
      expect(issues.map((issue) => issue.number)).toEqual([2, 1]);
    });

    it('surfaces a malformed later page as invalid_response, not as a network failure', async () => {
      const { octokit } = stubOctokit(async (params) =>
        params.page === 1
          ? { headers: { link: NEXT }, data: [rawIssue(2)] }
          : { headers: {}, data: { message: 'nope' } },
      );
      const error = await OctokitGitHubClient.withOctokit(octokit)
        .listOpenIssues(REF)
        .catch((caught: unknown) => caught);
      expect((error as GitHubClientError).code).toBe('invalid_response');
    });

    it('sends no validator at all when no cache is supplied', async () => {
      const { octokit, calls } = stubOctokit(async () => ({
        headers: { etag: 'W/"p1"' },
        data: [rawIssue(1)],
      }));
      const client = OctokitGitHubClient.withOctokit(octokit);
      await client.listOpenIssues(REF);
      await client.listOpenIssues(REF);
      expect(calls.map(ifNoneMatch)).toEqual([undefined, undefined]);
    });
  });
});

/**
 * The security review's M1: intake decides eligibility from a listing that can be seconds (or a
 * lagging list endpoint's worth) old, so `setIssueLabels` re-checks it against its own fresh read
 * and refuses rather than erasing a lane somebody set in between.
 */
describe('OctokitGitHubClient.setIssueLabels precondition (issue #511)', () => {
  function labelWriteStub(currentLabels: readonly string[]) {
    const calls: Call[] = [];
    const octokit = {
      paginate: async (route: string, params: Record<string, unknown>) => {
        calls.push({ route, params });
        return currentLabels.map((name) => ({ name }));
      },
      request: async (route: string, params: Record<string, unknown>) => {
        calls.push({ route, params });
        return { data: (params.labels as string[]).map((name) => ({ name })) };
      },
    };
    return { octokit: octokit as never, calls };
  }

  it('writes nothing when the fresh labels fail the precondition', async () => {
    const { octokit, calls } = labelWriteStub(['bug', 'pipenzo:working']);
    let seen: readonly string[] | undefined;
    const error = await OctokitGitHubClient.withOctokit(octokit)
      .setIssueLabels(REF, 5, ['pipenzo:queued'], {
        precondition: (current) => {
          seen = current;
          return !current.includes('pipenzo:working');
        },
      })
      .catch((caught: unknown) => caught);

    expect((error as GitHubClientError).code).toBe('precondition_failed');
    expect(seen).toEqual(['bug', 'pipenzo:working']);
    expect(calls.some((call) => call.route.startsWith('PUT'))).toBe(false);
  });

  it('writes as usual when the precondition holds', async () => {
    const { octokit, calls } = labelWriteStub(['bug']);
    const result = await OctokitGitHubClient.withOctokit(octokit).setIssueLabels(
      REF,
      5,
      ['pipenzo:queued'],
      { precondition: () => true },
    );
    expect(result).toEqual(['bug', 'pipenzo:queued']);
    expect(calls.filter((call) => call.route.startsWith('PUT'))).toHaveLength(1);
  });
});
