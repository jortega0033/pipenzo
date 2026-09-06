import { describe, expect, it } from 'vitest';
import {
  FakeGitHubClient,
} from '../src/github-client-fake.js';
import {
  GITHUB_TOKEN_ENV_KEYS,
  GitHubClientError,
  OctokitGitHubClient,
  parseRepoRef,
  redactSecrets,
  resolveConfiguredRepo,
  resolveGitHubToken,
  toGitHubClientError,
  type GitHubClient,
  type RepoRef,
} from '../src/github-client.js';

const REF: RepoRef = { owner: 'jortega0033', repo: 'pipenzo' };

/**
 * Builds a realistic token prefix at runtime so no literal in this file matches a real GitHub
 * token pattern on disk — the repository's own `gitleaks` gate should never have to decide whether
 * a test fixture is a leak.
 */
const gh = (kind: string): string => `${'gh'}${kind}_`;

interface StubCall {
  route: string;
  params: Record<string, unknown>;
}

/**
 * Minimal stand-in for the configured octokit instance. Deliberately not a mock of the whole
 * library: `OctokitGitHubClient` only ever calls `request` and `paginate`, so a test that satisfies
 * those two exercises every real code path without a network or a fixture server.
 */
function stubOctokit(handlers: {
  request?: (route: string, params: Record<string, unknown>) => Promise<unknown>;
  paginate?: (route: string, params: Record<string, unknown>) => Promise<unknown[]>;
}): { octokit: never; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params });
      if (!handlers.request) throw new Error(`unexpected request ${route}`);
      return handlers.request(route, params);
    },
    paginate: async (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params });
      if (!handlers.paginate) throw new Error(`unexpected paginate ${route}`);
      return handlers.paginate(route, params);
    },
  };
  return { octokit: octokit as never, calls };
}

function httpError(status: number, message: string, headers: Record<string, string> = {}): Error {
  const error = new Error(message) as Error & {
    status: number;
    response: { headers: Record<string, string> };
  };
  error.status = status;
  error.response = { headers };
  return error;
}

describe('parseRepoRef', () => {
  it('accepts a real owner/name pair and trims surrounding whitespace', () => {
    expect(parseRepoRef('  jortega0033/pipenzo  ')).toEqual(REF);
    expect(parseRepoRef('owner/repo.with.dots')).toEqual({ owner: 'owner', repo: 'repo.with.dots' });
  });

  it('rejects anything that is not owner/name', () => {
    for (const bad of ['pipenzo', 'owner/', '/repo', 'owner/repo/extra', 'own er/repo', 'owner/..']) {
      expect(() => parseRepoRef(bad)).toThrowError(GitHubClientError);
    }
  });
});

describe('resolveGitHubToken', () => {
  it('reads the Pipenzo-specific variable, and trims it', () => {
    expect(resolveGitHubToken({ PIPENZO_GITHUB_TOKEN: `  ${gh('p')}padded  ` })).toBe(
      `${gh('p')}padded`,
    );
  });

  /**
   * No `GITHUB_TOKEN` fallback, on purpose: GitHub Actions injects that variable automatically, so
   * a daemon started inside CI would silently publish as the Actions token rather than refusing.
   * Ambiguity about which credential just pushed is exactly what a publish gate must not have.
   */
  it('ignores GITHUB_TOKEN, so a CI-injected credential can never be published with', () => {
    const error = catchError(() => resolveGitHubToken({ GITHUB_TOKEN: `${gh('p')}fromActions` }));
    expect((error as GitHubClientError).code).toBe('token_missing');
  });

  it('treats a blank variable as unset rather than as a token', () => {
    const error = catchError(() => resolveGitHubToken({ PIPENZO_GITHUB_TOKEN: '   ' }));
    expect(error).toBeInstanceOf(GitHubClientError);
    expect((error as GitHubClientError).code).toBe('token_missing');
    for (const key of GITHUB_TOKEN_ENV_KEYS) expect((error as Error).message).toContain(key);
  });
});

describe('resolveConfiguredRepo', () => {
  it('reads the walking skeleton repository pin', () => {
    expect(resolveConfiguredRepo({ PIPENZO_GITHUB_REPO: 'jortega0033/pipenzo' })).toEqual(REF);
  });

  it('reports a missing pin as invalid_repository', () => {
    const error = catchError(() => resolveConfiguredRepo({}));
    expect((error as GitHubClientError).code).toBe('invalid_repository');
  });
});

describe('redactSecrets', () => {
  it('scrubs every credential shape a GitHub error can carry', () => {
    const secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const scrubbed = redactSecrets(
      [
        `classic ${gh('p')}${secret}`,
        `fine-grained ${'github'}_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789abcdef`,
        `header Authorization: Bearer ${gh('s')}0123456789abcdefghijklmnop`,
        `remote https://x-access-token:${gh('p')}${secret}@github.com/o/r.git`,
      ].join('\n'),
    );
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).not.toMatch(/gh[ps]_[A-Za-z0-9]{16}/);
    expect(scrubbed).not.toContain('github_pat_11ABCDEFG0');
    expect(scrubbed).toContain('[redacted]');
  });

  /**
   * The shape a header rule that stops at the scheme word leaves behind. `Basic` carries
   * base64(`x-access-token:<pat>`), which is exactly how git's HTTPS transport and octokit put a
   * PAT on the wire — so it is what a `GIT_CURL_VERBOSE` line or a proxy error contains.
   */
  it('consumes the whole value of an auth header, not just its scheme', () => {
    const basic = `eDphY2Nlc3MtdG9rZW46${'Z2hwX1NFQ1JFVFZBTFVF'}`;
    for (const line of [
      `Authorization: Basic ${basic}`,
      `AUTHORIZATION: BEARER ${basic}`,
      `proxy-authorization: Basic ${basic}`,
      `{"access_token":"${basic}"}`,
    ]) {
      const scrubbed = redactSecrets(line);
      expect(scrubbed).not.toContain(basic);
      expect(scrubbed.toLowerCase()).toContain('[redacted]');
    }
  });

  it('scrubs a bare JWT and a base64-encoded GitHub token', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOjEyM30.aabbCCddEEffGGhh';
    expect(redactSecrets(`installation token ${jwt}`)).not.toContain(jwt);

    const encoded = 'Z2hwX0FiQ2RFZkdoSWpLbE1uT3BRclN0VXZXeFl6MDEyMzQ1Njc4OQ==';
    expect(redactSecrets(`payload ${encoded}`)).not.toContain(encoded);
  });

  it('scrubs a credential in a URL with no colon, the other form git accepts', () => {
    const scrubbed = redactSecrets('https://sup3rs3cretP4ssw0rd@git.internal/o/r.git');
    expect(scrubbed).not.toContain('sup3rs3cretP4ssw0rd');
    expect(scrubbed).toBe('https://[redacted]@git.internal/o/r.git');
  });

  /**
   * Redaction should remove the secret, not the sentence. A header rule firing first on the literal
   * `x-access-token:` inside a URL would swallow the host and repository path with it, leaving an
   * operator a push failure with no diagnostic in it at all.
   */
  it('keeps the diagnostic when scrubbing a credential out of a remote URL', () => {
    const scrubbed = redactSecrets(
      `fatal: unable to access https://x-access-token:${gh('p')}AbCdEfGhIjKlMnOpQrStUvWx@github.com/o/r.git/`,
    );
    expect(scrubbed).toContain('github.com/o/r.git');
    expect(scrubbed).not.toMatch(/ghp_[A-Za-z0-9]{16}/);
  });

  it('leaves ordinary text, including commit shas, alone', () => {
    expect(redactSecrets('pull request #12 has 3 failing checks')).toBe(
      'pull request #12 has 3 failing checks',
    );
    // A deliberate limit, recorded rather than re-litigated: a pre-2021 40-hex classic PAT cannot
    // be matched without also redacting every commit sha this module puts in a message.
    const sha = 'a'.repeat(40);
    expect(redactSecrets(`pushed ${sha}`)).toBe(`pushed ${sha}`);
  });
});

describe('GitHubClientError', () => {
  it('redacts at construction, so a leaked message cannot become a leaked token', () => {
    const error = new GitHubClientError(
      'unauthorized',
      'request to https://x-access-token:ghp_AbCdEfGhIjKlMnOpQrStUvWx@api.github.com failed',
      { status: 401 },
    );
    expect(error.message).not.toContain('ghp_AbCdEfGhIjKlMnOpQrStUvWx');
    expect(error.code).toBe('unauthorized');
    expect(error.status).toBe(401);
    expect(error.name).toBe('GitHubClientError');
  });
});

describe('toGitHubClientError', () => {
  it('separates a real permission failure from an exhausted rate limit', () => {
    const forbidden = toGitHubClientError(httpError(403, 'nope'), 'op');
    expect(forbidden.code).toBe('forbidden');

    const throttled = toGitHubClientError(
      httpError(403, 'nope', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' }),
      'op',
    );
    expect(throttled.code).toBe('rate_limited');
    expect(throttled.retryAfterMs).toBe(1700000000 * 1000);
  });

  it('maps the secondary-limit 429 and its Retry-After', () => {
    const throttled = toGitHubClientError(httpError(429, 'slow down', { 'retry-after': '30' }), 'op');
    expect(throttled.code).toBe('rate_limited');
    expect(throttled.retryAfterMs).toBeGreaterThan(Date.now());
  });

  it('maps the remaining statuses onto the closed union', () => {
    expect(toGitHubClientError(httpError(401, 'bad creds'), 'op').code).toBe('unauthorized');
    expect(toGitHubClientError(httpError(404, 'missing'), 'op').code).toBe('not_found');
    expect(toGitHubClientError(httpError(422, 'exists'), 'op').code).toBe('invalid_request');
    expect(toGitHubClientError(httpError(502, 'bad gateway'), 'op').code).toBe('network');
    expect(toGitHubClientError(new Error('ECONNRESET'), 'op').code).toBe('network');
  });

  it('passes a GitHubClientError through unchanged', () => {
    const original = new GitHubClientError('token_missing', 'no token');
    expect(toGitHubClientError(original, 'op')).toBe(original);
  });
});

describe('OctokitGitHubClient', () => {
  it('normalizes an issue, including object-shaped labels and assignee logins', async () => {
    const { octokit, calls } = stubOctokit({
      request: async () => ({
        headers: { etag: 'W/"abc"' },
        data: {
          number: 177,
          title: 'Backend: GitHub API client',
          body: 'body text',
          state: 'open',
          labels: [{ name: 'enhancement' }, 'pipenzo:queued'],
          assignees: [{ login: 'jortega0033' }],
          html_url: 'https://github.com/jortega0033/pipenzo/issues/177',
          updated_at: '2026-09-06T00:00:00Z',
        },
      }),
    });
    const issue = await OctokitGitHubClient.withOctokit(octokit).getIssue(REF, 177);

    expect(issue).toMatchObject({
      owner: 'jortega0033',
      repo: 'pipenzo',
      number: 177,
      state: 'open',
      labels: ['enhancement', 'pipenzo:queued'],
      assignees: ['jortega0033'],
      etag: 'W/"abc"',
    });
    expect(calls[0]?.params).toMatchObject({ owner: 'jortega0033', repo: 'pipenzo', issue_number: 177 });
  });

  it('refuses a pull request handed in as an issue number', async () => {
    const { octokit } = stubOctokit({
      request: async () => ({ headers: {}, data: { number: 1, pull_request: { url: 'x' } } }),
    });
    const error = await catchAsync(() => OctokitGitHubClient.withOctokit(octokit).getIssue(REF, 1));
    expect((error as GitHubClientError).code).toBe('not_found');
  });

  it('rejects a non-positive issue number before making a request', async () => {
    const { octokit, calls } = stubOctokit({});
    const error = await catchAsync(() => OctokitGitHubClient.withOctokit(octokit).getIssue(REF, 0));
    expect((error as GitHubClientError).code).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });

  it('reports a malformed payload as invalid_response rather than passing undefined onward', async () => {
    const { octokit } = stubOctokit({
      request: async () => ({ headers: {}, data: { number: 'not-a-number' } }),
    });
    const error = await catchAsync(() => OctokitGitHubClient.withOctokit(octokit).getIssue(REF, 5));
    expect((error as GitHubClientError).code).toBe('invalid_response');
  });

  it('paginates labels and lowercases their colors', async () => {
    const { octokit, calls } = stubOctokit({
      paginate: async () => [
        { name: 'pipenzo:queued', color: 'AABBCC', description: 'Accepted, not started' },
        { name: 'pipenzo:working' },
      ],
    });
    const labels = await OctokitGitHubClient.withOctokit(octokit).listLabels(REF);
    expect(labels).toEqual([
      { name: 'pipenzo:queued', color: 'aabbcc', description: 'Accepted, not started' },
      { name: 'pipenzo:working', color: '000000', description: '' },
    ]);
    expect(calls[0]?.params).toMatchObject({ per_page: 100 });
  });

  it('treats an already-existing label as success by reading it back', async () => {
    const { octokit, calls } = stubOctokit({
      request: async (route) => {
        if (route.startsWith('POST')) throw httpError(422, 'already_exists');
        return { headers: {}, data: { name: 'pipenzo:working', color: 'ededed', description: 'A phase is running' } };
      },
    });
    const label = await OctokitGitHubClient.withOctokit(octokit).createLabel(REF, {
      name: 'pipenzo:working',
      color: 'ededed',
      description: 'A phase is running',
    });
    expect(label.name).toBe('pipenzo:working');
    expect(calls.map((call) => call.route)).toEqual([
      'POST /repos/{owner}/{repo}/labels',
      'GET /repos/{owner}/{repo}/labels/{name}',
    ]);
  });

  it('rejects a label whose color is not six lowercase hex digits', async () => {
    const { octokit, calls } = stubOctokit({});
    const error = await catchAsync(() =>
      OctokitGitHubClient.withOctokit(octokit).createLabel(REF, {
        name: 'pipenzo:queued',
        color: '#AABBCC',
        description: '',
      }),
    );
    expect((error as GitHubClientError).code).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });

  it('reads a pull request as a real unified diff plus its numbers', async () => {
    const unified = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n';
    const { octokit } = stubOctokit({
      request: async (_route, params) =>
        (params.mediaType as { format?: string } | undefined)?.format === 'diff'
          ? { headers: {}, data: unified }
          : {
              headers: {},
              data: {
                number: 42,
                base: { ref: 'main' },
                head: { ref: 'issue-177', sha: 'a'.repeat(40) },
                changed_files: 1,
                additions: 1,
                deletions: 1,
              },
            },
    });
    const diff = await OctokitGitHubClient.withOctokit(octokit).getPullRequestDiff(REF, 42);
    expect(diff).toEqual({
      number: 42,
      baseRef: 'main',
      headRef: 'issue-177',
      headSha: 'a'.repeat(40),
      diff: unified,
      changedFiles: 1,
      additions: 1,
      deletions: 1,
    });
  });

  it('resolves check runs through the head sha and normalizes unknown values', async () => {
    const { octokit, calls } = stubOctokit({
      request: async () => ({ headers: {}, data: { head: { sha: 'b'.repeat(40) } } }),
      paginate: async () => [
        { name: 'build', status: 'completed', conclusion: 'success', details_url: 'https://ci' },
        { name: 'flaky', status: 'weird', conclusion: 'exploded' },
        { name: 'pending', status: 'queued', conclusion: null },
      ],
    });
    const runs = await OctokitGitHubClient.withOctokit(octokit).listPullRequestChecks(REF, 42);
    expect(runs).toEqual([
      { name: 'build', status: 'completed', conclusion: 'success', detailsUrl: 'https://ci' },
      { name: 'flaky', status: 'unknown', conclusion: 'unknown', detailsUrl: undefined },
      { name: 'pending', status: 'queued', conclusion: undefined, detailsUrl: undefined },
    ]);
    expect(calls[1]?.params).toMatchObject({ ref: 'b'.repeat(40) });
  });

  /**
   * The property issue #177 is explicit about: this client is not a publishing surface. If someone
   * later adds a push or a PR-open here, this fails and points them at `publish-service.ts`.
   */
  it('exposes no publishing operation of any kind', () => {
    const surface = Object.getOwnPropertyNames(OctokitGitHubClient.prototype);
    for (const forbidden of ['push', 'createPullRequest', 'openPullRequest', 'merge', 'createRef']) {
      expect(surface).not.toContain(forbidden);
    }
    expect(surface.some((name) => /push|pull.?request.?create|create.?pull|merge/i.test(name))).toBe(
      false,
    );
  });
});

describe('FakeGitHubClient', () => {
  it('satisfies the same interface the octokit client does', async () => {
    const fake: GitHubClient = new FakeGitHubClient()
      .seedIssue({
        owner: REF.owner,
        repo: REF.repo,
        number: 177,
        title: 'Backend: GitHub API client',
        body: 'body',
        state: 'open',
        labels: ['pipenzo:queued'],
        assignees: [],
        htmlUrl: 'https://github.com/jortega0033/pipenzo/issues/177',
        updatedAt: '2026-09-06T00:00:00Z',
        etag: undefined,
      })
      .seedLabels(REF, [{ name: 'pipenzo:queued', color: 'ededed', description: '' }]);

    expect((await fake.getIssue(REF, 177)).title).toBe('Backend: GitHub API client');
    expect(await fake.listLabels(REF)).toHaveLength(1);
    expect(await fake.createLabel(REF, { name: 'pipenzo:working', color: 'ededed', description: '' })).toMatchObject(
      { name: 'pipenzo:working' },
    );
    expect(await fake.listLabels(REF)).toHaveLength(2);
    // Idempotent, exactly like the real client's 422 path.
    await fake.createLabel(REF, { name: 'pipenzo:working', color: 'ededed', description: '' });
    expect(await fake.listLabels(REF)).toHaveLength(2);
  });

  it('records calls and can be driven into the typed error paths', async () => {
    const fake = new FakeGitHubClient();
    fake.failNext('getIssue', new GitHubClientError('rate_limited', 'slow down'));
    const error = await catchAsync(() => fake.getIssue(REF, 1));
    expect((error as GitHubClientError).code).toBe('rate_limited');

    const missing = await catchAsync(() => fake.getIssue(REF, 1));
    expect((missing as GitHubClientError).code).toBe('not_found');
    expect(fake.calls.map((call) => call.method)).toEqual(['getIssue', 'getIssue']);
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

async function catchAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/**
 * The two write operations issue #184 added, and the reasons each is shaped the way it is.
 */
describe('GitHub issue write operations', () => {
  const ISSUE_DATA = {
    number: 184,
    title: 'Expose the phases as routes',
    body: 'body',
    state: 'open',
    labels: [],
    html_url: 'https://github.com/jortega0033/pipenzo/issues/184',
    updated_at: '2026-09-06T00:00:00Z',
  };

  it('adds an assignee rather than replacing the assignee list', async () => {
    const { octokit, calls } = stubOctokit({
      request: async () => ({
        headers: {},
        data: { ...ISSUE_DATA, assignees: [{ login: 'someone-else' }, { login: 'jortega0033' }] },
      }),
    });
    const issue = await OctokitGitHubClient.withOctokit(octokit).assignIssue(
      REF,
      184,
      'jortega0033',
    );
    expect(calls[0]?.route).toBe('POST /repos/{owner}/{repo}/issues/{issue_number}/assignees');
    expect(calls[0]?.params).toMatchObject({ issue_number: 184, assignees: ['jortega0033'] });
    // The write cannot evict a human already on the ticket, and the echo shows both.
    expect(issue.assignees).toEqual(['someone-else', 'jortega0033']);
  });

  it('sends no-cache on the assignment so nothing can answer the follow-up read from a copy', async () => {
    const { octokit, calls } = stubOctokit({
      request: async () => ({ headers: {}, data: { ...ISSUE_DATA, assignees: [] } }),
    });
    await OctokitGitHubClient.withOctokit(octokit).assignIssue(REF, 184, 'jortega0033');
    expect(calls[0]?.params).toMatchObject({ headers: { 'cache-control': 'no-cache' } });
  });

  it('refuses a login that is not one, before any request goes out', async () => {
    const { octokit, calls } = stubOctokit({});
    const error = await catchAsync(() =>
      OctokitGitHubClient.withOctokit(octokit).assignIssue(REF, 184, 'not a login'),
    );
    expect((error as GitHubClientError).code).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });

  it('creates an issue and never carries an assignee or a milestone with it', async () => {
    const { octokit, calls } = stubOctokit({
      request: async () => ({ headers: {}, data: { ...ISSUE_DATA, number: 901, assignees: [] } }),
    });
    const created = await OctokitGitHubClient.withOctokit(octokit).createIssue(REF, {
      title: 'Drafted from an idea',
      body: 'Acceptance criteria...',
      labels: ['enhancement'],
    });
    expect(created.number).toBe(901);
    expect(calls[0]?.route).toBe('POST /repos/{owner}/{repo}/issues');
    expect(calls[0]?.params).toMatchObject({ title: 'Drafted from an idea', labels: ['enhancement'] });
    // Creating and claiming stay two operator actions with two audit trails.
    expect(calls[0]?.params).not.toHaveProperty('assignees');
    expect(calls[0]?.params).not.toHaveProperty('milestone');
  });

  it('refuses an empty or oversized title without issuing a request', async () => {
    const { octokit, calls } = stubOctokit({});
    for (const title of ['   ', 'x'.repeat(257)]) {
      const error = await catchAsync(() =>
        OctokitGitHubClient.withOctokit(octokit).createIssue(REF, { title, body: '' }),
      );
      expect((error as GitHubClientError).code).toBe('invalid_request');
    }
    expect(calls).toHaveLength(0);
  });

  it('is mirrored by the fake, including the additive assignment', async () => {
    const fake: GitHubClient = new FakeGitHubClient()
      .seedIssue({
        owner: REF.owner,
        repo: REF.repo,
        number: 184,
        title: 'Expose the phases as routes',
        body: 'body',
        state: 'open',
        labels: [],
        assignees: ['someone-else'],
        htmlUrl: 'https://github.com/jortega0033/pipenzo/issues/184',
        updatedAt: '2026-09-06T00:00:00Z',
        etag: undefined,
      });
    expect((await fake.assignIssue(REF, 184, 'jortega0033')).assignees).toEqual([
      'someone-else',
      'jortega0033',
    ]);
    // Re-assigning the same login is a no-op, matching GitHub's own behaviour.
    expect((await fake.assignIssue(REF, 184, 'jortega0033')).assignees).toHaveLength(2);

    const created = await fake.createIssue(REF, { title: 'New from idea', body: '' });
    expect(created.assignees).toEqual([]);
    expect((await fake.getIssue(REF, created.number)).title).toBe('New from idea');
  });
});
