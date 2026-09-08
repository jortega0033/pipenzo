import { describe, expect, it } from 'vitest';
import { GITHUB_REPO_PAGE_CAP, OctokitGitHubClient } from '../src/github-client.js';

/**
 * `listAccessibleRepositories` (issue #115).
 *
 * Its own stub rather than `github-client.test.ts`'s shared `stubOctokit`, because this is the one
 * method that walks `paginate.iterator` — the cap has to be enforced *while* paginating, not after,
 * and the shared stub models `paginate` as a function returning a flat array.
 */
function stubPaginatingOctokit(pages: readonly unknown[][]): {
  octokit: never;
  calls: { route: string; params: Record<string, unknown> }[];
  pagesFetched: () => number;
} {
  const calls: { route: string; params: Record<string, unknown> }[] = [];
  let fetched = 0;
  const octokit = {
    paginate: {
      iterator: (route: string, params: Record<string, unknown>) => {
        calls.push({ route, params });
        return {
          async *[Symbol.asyncIterator]() {
            for (const data of pages) {
              fetched += 1;
              yield { data };
            }
          },
        };
      },
    },
  };
  return { octokit: octokit as never, calls, pagesFetched: () => fetched };
}

const writable = (fullName: string, overrides: Record<string, unknown> = {}) => ({
  full_name: fullName,
  archived: false,
  default_branch: 'main',
  language: 'TypeScript',
  open_issues_count: 3,
  pushed_at: '2026-01-01T00:00:00.000Z',
  permissions: { push: true },
  ...overrides,
});

describe('OctokitGitHubClient.listAccessibleRepositories', () => {
  it('asks for the memberships that can carry write access, newest first', async () => {
    const { octokit, calls } = stubPaginatingOctokit([[writable('octocat/hello-world')]]);
    await OctokitGitHubClient.withOctokit(octokit).listAccessibleRepositories();

    expect(calls[0]?.route).toBe('GET /user/repos');
    // Without an explicit affiliation GitHub's default includes every organisation repository the
    // account can merely *see*, which on a large org is thousands of rows Pipenzo could never
    // manage -- a correctness problem and a quota problem at once.
    expect(calls[0]?.params.affiliation).toBe('owner,collaborator,organization_member');
    expect(calls[0]?.params.per_page).toBe(100);
    expect(calls[0]?.params.sort).toBe('pushed');
    expect(calls[0]?.params.direction).toBe('desc');
  });

  it('normalizes only the fields the picker renders', async () => {
    const { octokit } = stubPaginatingOctokit([
      [writable('octocat/hello-world', { html_url: 'https://example.invalid', private: true })],
    ]);
    const { repositories, truncated } = await OctokitGitHubClient.withOctokit(
      octokit,
    ).listAccessibleRepositories();

    expect(truncated).toBe(false);
    expect(repositories).toEqual([
      {
        fullName: 'octocat/hello-world',
        archived: false,
        defaultBranch: 'main',
        language: 'TypeScript',
        openIssues: 3,
        pushedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    // Nothing GitHub happened to send rides along. A field carried here is a field a renderer can
    // come to depend on, so widening this is a schema change somebody reviews.
    expect(Object.keys(repositories[0] ?? {}).sort()).toEqual([
      'archived',
      'defaultBranch',
      'fullName',
      'language',
      'openIssues',
      'pushedAt',
    ]);
  });

  /**
   * The filter that makes the picker honest. A repository Pipenzo can only read is one it can never
   * manage -- it exists to create labels and open pull requests -- so listing it would fill the
   * picker with rows that fail at the first write, long after the user chose them.
   */
  it('lists only repositories this credential can write to', async () => {
    const { octokit } = stubPaginatingOctokit([
      [
        writable('octocat/writable'),
        writable('octocat/read-only', { permissions: { push: false, pull: true } }),
        // A missing permissions block is "no push access", never "assume yes": the safe reading of
        // a missing capability is that it is missing.
        writable('octocat/no-permissions-block', { permissions: undefined }),
        writable('octocat/not-a-boolean', { permissions: { push: 'true' } }),
      ],
    ]);
    const { repositories } = await OctokitGitHubClient.withOctokit(
      octokit,
    ).listAccessibleRepositories();

    expect(repositories.map((repo) => repo.fullName)).toEqual(['octocat/writable']);
  });

  /**
   * Archived repositories are kept, not filtered. The picker has to *show* one in order to explain
   * why it cannot be chosen -- omitting it reads as Pipenzo being unable to see it at all.
   */
  it('keeps an archived repository so the picker can explain it', async () => {
    const { octokit } = stubPaginatingOctokit([
      [writable('octocat/retired', { archived: true })],
    ]);
    const { repositories } = await OctokitGitHubClient.withOctokit(
      octokit,
    ).listAccessibleRepositories();

    expect(repositories).toHaveLength(1);
    expect(repositories[0]?.archived).toBe(true);
  });

  it('omits optional fields rather than sending empty ones', async () => {
    const { octokit } = stubPaginatingOctokit([
      [writable('octocat/empty', { language: null, pushed_at: null })],
    ]);
    const { repositories } = await OctokitGitHubClient.withOctokit(
      octokit,
    ).listAccessibleRepositories();

    expect(repositories[0]).not.toHaveProperty('language');
    expect(repositories[0]).not.toHaveProperty('pushedAt');
  });

  /**
   * Stops *while* walking, which is why this uses `paginate.iterator` rather than `paginate`. The
   * latter fetches every page and lets the caller notice the size afterwards, which is the one
   * thing the cap exists to prevent.
   */
  it('stops at the page cap and says the list is incomplete', async () => {
    const pages = Array.from({ length: GITHUB_REPO_PAGE_CAP + 10 }, (_, index) => [
      writable(`octocat/repo-${index}`),
    ]);
    const { octokit } = stubPaginatingOctokit(pages);
    const { repositories, truncated } = await OctokitGitHubClient.withOctokit(
      octokit,
    ).listAccessibleRepositories();

    expect(truncated).toBe(true);
    expect(repositories).toHaveLength(GITHUB_REPO_PAGE_CAP);
  });

  /**
   * The boundary the flag is easiest to get wrong at. An account with *exactly* the cap's worth of
   * pages and nothing beyond them has a complete list, and reporting `truncated` there tells the
   * user their repositories are missing when they are all present -- the precise confusion this
   * flag exists to prevent. Breaking as soon as the cap is reached, rather than on discovering a
   * further page, produces exactly that.
   */
  it('does not claim truncation for an account that fits exactly', async () => {
    const pages = Array.from({ length: GITHUB_REPO_PAGE_CAP }, (_, index) => [
      writable(`octocat/repo-${index}`),
    ]);
    const { octokit } = stubPaginatingOctokit(pages);
    const { repositories, truncated } = await OctokitGitHubClient.withOctokit(
      octokit,
    ).listAccessibleRepositories();

    expect(truncated).toBe(false);
    expect(repositories).toHaveLength(GITHUB_REPO_PAGE_CAP);
  });

  it('does not claim truncation for an ordinary short list', async () => {
    const { octokit } = stubPaginatingOctokit([[writable('octocat/a')], [writable('octocat/b')]]);
    const { repositories, truncated } = await OctokitGitHubClient.withOctokit(
      octokit,
    ).listAccessibleRepositories();

    expect(truncated).toBe(false);
    expect(repositories).toHaveLength(2);
  });

  it('refuses a page that is not an array rather than guessing', async () => {
    const { octokit } = stubPaginatingOctokit([{ message: 'nope' } as never]);
    await expect(
      OctokitGitHubClient.withOctokit(octokit).listAccessibleRepositories(),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('refuses an entry missing a field the picker needs', async () => {
    const { octokit } = stubPaginatingOctokit([
      [writable('octocat/hello-world', { default_branch: undefined })],
    ]);
    // A *malformed* entry throws, unlike an unusable one: that means GitHub's shape changed, and
    // guessing would be worse than failing.
    await expect(
      OctokitGitHubClient.withOctokit(octokit).listAccessibleRepositories(),
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
      OctokitGitHubClient.withOctokit(octokit).listAccessibleRepositories(),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
