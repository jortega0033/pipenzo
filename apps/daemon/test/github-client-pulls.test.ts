import { describe, expect, it } from 'vitest';
import { GITHUB_PR_PAGE_CAP, OctokitGitHubClient } from '../src/github-client.js';
import { ticketBranchName } from '../src/implement-orchestrator.js';

/**
 * `listPullRequests` (issue #205's first slice).
 *
 * Its own stub, mirroring `github-client-repos.test.ts`'s `stubPaginatingOctokit` exactly: this
 * method also walks `paginate.iterator`, so the cap has to be enforced while paginating.
 */
function stubPaginatingOctokit(pages: readonly unknown[][]): {
  octokit: never;
  calls: { route: string; params: Record<string, unknown> }[];
} {
  const calls: { route: string; params: Record<string, unknown> }[] = [];
  const octokit = {
    paginate: {
      iterator: (route: string, params: Record<string, unknown>) => {
        calls.push({ route, params });
        return {
          async *[Symbol.asyncIterator]() {
            for (const data of pages) yield { data };
          },
        };
      },
    },
  };
  return { octokit: octokit as never, calls };
}

const pr = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `PR #${number}`,
  user: { login: 'octocat' },
  head: { ref: `feature-${number}` },
  base: { ref: 'main' },
  updated_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('OctokitGitHubClient.listPullRequests', () => {
  it('asks for open PRs, most-recently-updated first', async () => {
    const { octokit, calls } = stubPaginatingOctokit([[pr(1)]]);
    await OctokitGitHubClient.withOctokit(octokit).listPullRequests({ owner: 'o', repo: 'r' });

    expect(calls[0]?.route).toBe('GET /repos/{owner}/{repo}/pulls');
    expect(calls[0]?.params).toMatchObject({
      owner: 'o',
      repo: 'r',
      state: 'open',
      per_page: 100,
      sort: 'updated',
      direction: 'desc',
    });
  });

  it('normalizes only the fields a listing renders, omitting changed-files entirely', async () => {
    const { octokit } = stubPaginatingOctokit([[pr(7, { title: 'Fix the thing' })]]);
    const { pullRequests, truncated } = await OctokitGitHubClient.withOctokit(octokit).listPullRequests({
      owner: 'o',
      repo: 'r',
    });

    expect(truncated).toBe(false);
    expect(pullRequests).toEqual([
      {
        number: 7,
        title: 'Fix the thing',
        author: 'octocat',
        headRef: 'feature-7',
        baseRef: 'main',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    // Not just "these fields happen to be equal" -- nothing else GitHub sent rides along either.
    expect(Object.keys(pullRequests[0] ?? {}).sort()).toEqual([
      'author',
      'baseRef',
      'headRef',
      'number',
      'title',
      'updatedAt',
    ]);
  });

  it('reports a deleted/ghost author as undefined, never a guessed login', async () => {
    const { octokit } = stubPaginatingOctokit([[pr(1, { user: null })]]);
    const { pullRequests } = await OctokitGitHubClient.withOctokit(octokit).listPullRequests({
      owner: 'o',
      repo: 'r',
    });
    expect(pullRequests[0]?.author).toBeUndefined();
  });

  /**
   * The filter that makes this an *external* PR listing. `ticketBranchName()` is
   * `implement-orchestrator.ts`'s own naming authority; this asserts the client's independently
   * declared pattern actually matches its real output, so the two documented-as-parallel
   * definitions cannot silently drift apart.
   */
  it('excludes every PR on a Pipenzo-owned ticket branch', async () => {
    const pipenzoBranch = ticketBranchName(42);
    const { octokit } = stubPaginatingOctokit([
      [pr(1, { head: { ref: pipenzoBranch } }), pr(2, { head: { ref: 'someone-elses-feature' } })],
    ]);
    const { pullRequests } = await OctokitGitHubClient.withOctokit(octokit).listPullRequests({
      owner: 'o',
      repo: 'r',
    });
    expect(pullRequests.map((p) => p.number)).toEqual([2]);
  });

  it('stops at the page cap and says the list is incomplete', async () => {
    const pages = Array.from({ length: GITHUB_PR_PAGE_CAP + 10 }, (_, index) => [pr(index)]);
    const { octokit } = stubPaginatingOctokit(pages);
    const { pullRequests, truncated } = await OctokitGitHubClient.withOctokit(octokit).listPullRequests({
      owner: 'o',
      repo: 'r',
    });
    expect(truncated).toBe(true);
    expect(pullRequests).toHaveLength(GITHUB_PR_PAGE_CAP);
  });

  it('does not claim truncation for an account that fits exactly', async () => {
    const pages = Array.from({ length: GITHUB_PR_PAGE_CAP }, (_, index) => [pr(index)]);
    const { octokit } = stubPaginatingOctokit(pages);
    const { truncated } = await OctokitGitHubClient.withOctokit(octokit).listPullRequests({
      owner: 'o',
      repo: 'r',
    });
    expect(truncated).toBe(false);
  });

  it('refuses a page that is not an array rather than guessing', async () => {
    const { octokit } = stubPaginatingOctokit([{ message: 'nope' } as never]);
    await expect(
      OctokitGitHubClient.withOctokit(octokit).listPullRequests({ owner: 'o', repo: 'r' }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('refuses an entry missing a field the listing needs', async () => {
    const { octokit } = stubPaginatingOctokit([[pr(1, { head: undefined })]]);
    await expect(
      OctokitGitHubClient.withOctokit(octokit).listPullRequests({ owner: 'o', repo: 'r' }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('maps a transport failure onto the closed error union', async () => {
    const octokit = {
      paginate: {
        iterator: () => ({
          // eslint-disable-next-line require-yield
          async *[Symbol.asyncIterator]() {
            throw Object.assign(new Error('bad credentials'), {
              status: 401,
              response: { headers: {} },
            });
          },
        }),
      },
    } as never;
    await expect(
      OctokitGitHubClient.withOctokit(octokit).listPullRequests({ owner: 'o', repo: 'r' }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
