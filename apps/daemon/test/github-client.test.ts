import { Octokit } from '@octokit/core';
import { describe, expect, it, vi } from 'vitest';
import {
  FakeGitHubClient,
} from '../src/github-client-fake.js';
import {
  GITHUB_TOKEN_ENV_KEYS,
  GitHubClientError,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RATE_LIMIT_SLEEP_SECONDS,
  OctokitGitHubClient,
  PIPENZO_OCTOKIT_PLUGINS,
  createPipenzoOctokit,
  parseRepoRef,
  redactSecrets,
  registerKnownSecret,
  resolveConfiguredRepo,
  resolveGitHubToken,
  shouldRetryRateLimit,
  toGitHubClientError,
  type GitHubClient,
  type RepoRef,
} from '../src/github-client.js';
import { ConditionalRequestCache } from '../src/github-conditional-cache.js';
import { MAX_ISSUE_BODY_CHARS, MAX_ISSUE_COMMENT_CHARS } from '@agent-dock/shared';

const REF: RepoRef = { owner: 'jortega0033', repo: 'pipenzo' };

/** GitHub's own comment-create payload, trimmed to the fields `normalizeIssueComment` reads. */
const COMMENT_DATA = {
  id: 5_579_054_675,
  body: 'a body',
  html_url: 'https://github.com/jortega0033/pipenzo/issues/161#issuecomment-5579054675',
  created_at: '2026-09-08T06:30:00Z',
};

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
    // be matched *by pattern* without also redacting every commit sha this module puts in a
    // message. `registerKnownSecret` (issue #211) closes this for a token this daemon actually
    // resolved, tested in its own describe block below -- an *unregistered* 40-hex value, which is
    // what every commit sha this module ever interpolates is, must still pass through untouched.
    const sha = 'a'.repeat(40);
    expect(redactSecrets(`pushed ${sha}`)).toBe(`pushed ${sha}`);
  });
});

/**
 * Issue #211: `redactSecrets`'s pattern rules cannot recognize a pre-2021 40-hex classic PAT (see
 * its own doc comment for why a 40-hex pattern rule is not the fix). Once the daemon holds its
 * resolved token in a first-class object rather than re-reading the environment at each call site,
 * registering that exact value closes the gap for the one token this daemon was actually handed --
 * `apps/daemon/src/index.ts` does so once, at startup.
 */
describe('registerKnownSecret', () => {
  // A 40-hex value shaped exactly like a pre-2021 classic PAT, and exactly what no pattern rule
  // above can recognize -- chosen distinct from the commit-sha fixture above (`'a'.repeat(40)`) so
  // registering it cannot be mistaken for accidentally also matching that one.
  const classicPat = '1234567890abcdef1234567890abcdef12345678';

  it('lets redactSecrets scrub a value no pattern rule can recognize, once registered', () => {
    // Deliberately not near the word "token" or "authorization": this must be a string none of
    // the pattern rules above would touch on their own, so the assertion below actually exercises
    // the new exact-match rule rather than an existing one that happens to also fire.
    expect(redactSecrets(`classic pat resolved: ${classicPat}`)).toContain(classicPat);
    registerKnownSecret(classicPat);
    const scrubbed = redactSecrets(`classic pat resolved: ${classicPat}`);
    expect(scrubbed).not.toContain(classicPat);
    expect(scrubbed).toContain('[redacted]');
  });

  it('does not touch a different, unregistered value of the same shape', () => {
    registerKnownSecret(classicPat);
    // A commit sha this module interpolates is exactly this shape and must survive registering a
    // *different* 40-hex value -- an exact-match rule, not a shape rule, is the whole point.
    const otherSha = 'fedcba0987654321fedcba0987654321fedcba09';
    expect(redactSecrets(`pushed ${otherSha}`)).toBe(`pushed ${otherSha}`);
  });

  it('refuses to register a value under the minimum length', () => {
    registerKnownSecret('short');
    // Never redacted as a whole word, and specifically not reduced to matching everything: a
    // no-op registration must not make `redactSecrets` scrub the substring "short" out of
    // unrelated prose that happens to contain it.
    expect(redactSecrets('this run was short on time')).toBe('this run was short on time');
  });

  it('is additive: registering twice is the same as registering once', () => {
    registerKnownSecret(classicPat);
    registerKnownSecret(classicPat);
    expect(redactSecrets(`a ${classicPat} b ${classicPat} c`)).toBe('a [redacted] b [redacted] c');
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

  /**
   * Issue #232: `assertIssueDraft` compared `body.length` (UTF-16 units) against 65,536 with no
   * control-character rule at all -- the same divergence from `assertCommentBody`'s rule that #232
   * found on the wire schema, duplicated here on the client's own floor. Now both call the shared
   * `issueCreateBodyProblem`/`issueCommentBodyProblem` predicates.
   */
  it('refuses a body with control characters, without issuing a request', async () => {
    const { octokit, calls } = stubOctokit({});
    for (const body of ['a\u0000b', 'a\u0007b']) {
      const error = await catchAsync(() =>
        OctokitGitHubClient.withOctokit(octokit).createIssue(REF, { title: 'a title', body }),
      );
      expect((error as GitHubClientError).code).toBe('invalid_request');
    }
    expect(calls).toHaveLength(0);
  });

  // A blank body stays allowed: a created issue with no description is a normal, valid GitHub
  // issue, and #84's shipped route has always permitted one -- unlike a comment.
  it('still creates an issue with a blank body', async () => {
    const { octokit, calls } = stubOctokit({
      request: async () => ({ headers: {}, data: { ...ISSUE_DATA, number: 902, assignees: [] } }),
    });
    const created = await OctokitGitHubClient.withOctokit(octokit).createIssue(REF, {
      title: 'Drafted from an idea',
      body: '',
    });
    expect(created.number).toBe(902);
    expect(calls).toHaveLength(1);
  });

  // Same CRLF exception as the comment body: bodies stitched out of captured command or git
  // output on Windows are the norm, not the exception, for this product's primary platform.
  it('accepts a CRLF body and sends it byte for byte', async () => {
    const { octokit, calls } = stubOctokit({
      request: async () => ({ headers: {}, data: { ...ISSUE_DATA, number: 903, assignees: [] } }),
    });
    const crlf = 'Acceptance criteria:\r\n\r\n- one\r\n- two\r\n';
    await OctokitGitHubClient.withOctokit(octokit).createIssue(REF, {
      title: 'Drafted from an idea',
      body: crlf,
    });
    expect(calls[0]?.params).toMatchObject({ body: crlf });
  });

  /**
   * Issue #232: GitHub counts characters, so the client's own bound has to as well. Measured in
   * UTF-16 units, an emoji-heavy body would be refused at roughly half GitHub's real allowance.
   */
  it('measures the body in code points, not UTF-16 units', async () => {
    const { octokit, calls } = stubOctokit({
      request: async () => ({ headers: {}, data: { ...ISSUE_DATA, number: 904, assignees: [] } }),
    });
    const client = OctokitGitHubClient.withOctokit(octokit);
    // 65,536 code points, 131,072 UTF-16 units: at the limit, and accepted.
    await client.createIssue(REF, {
      title: 'Drafted from an idea',
      body: '🙂'.repeat(MAX_ISSUE_BODY_CHARS),
    });
    expect(calls).toHaveLength(1);
    // One code point over the cap, and deliberately *under* twice the cap in UTF-16 units, so
    // nothing but the code-point comparison can be what rejects it.
    const overLimit = `${'🙂'.repeat(65_000)}${'x'.repeat(537)}`;
    expect([...overLimit]).toHaveLength(MAX_ISSUE_BODY_CHARS + 1);
    const error = await catchAsync(() =>
      client.createIssue(REF, { title: 'Drafted from an idea', body: overLimit }),
    );
    expect((error as GitHubClientError).code).toBe('invalid_request');
    expect(calls).toHaveLength(1);
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

/**
 * Issue #228. Epic #4's diff-size gate ends two of its rows in a comment rather than a lane move,
 * and labels cannot express either — so this is the first write on this client whose payload is
 * prose that becomes public under the operator's GitHub identity.
 */
describe('createIssueComment', () => {
  it('posts the body to the comments endpoint and returns the comment identity', async () => {
    const { octokit, calls } = stubOctokit({
      request: async () => ({ headers: {}, data: COMMENT_DATA }),
    });
    const comment = await OctokitGitHubClient.withOctokit(octokit).createIssueComment(
      REF,
      161,
      'Estimate: 620 changed lines across 26 files. Proposed split: ...',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.route).toBe('POST /repos/{owner}/{repo}/issues/{issue_number}/comments');
    expect(calls[0]?.params).toMatchObject({
      owner: 'jortega0033',
      repo: 'pipenzo',
      issue_number: 161,
      body: 'Estimate: 620 changed lines across 26 files. Proposed split: ...',
    });
    expect(comment).toEqual({
      id: COMMENT_DATA.id,
      body: COMMENT_DATA.body,
      htmlUrl: COMMENT_DATA.html_url,
      createdAt: COMMENT_DATA.created_at,
    });
  });

  it('refuses an empty, blank or oversized body without issuing a request', async () => {
    const { octokit, calls } = stubOctokit({});
    const client = OctokitGitHubClient.withOctokit(octokit);
    for (const body of ['', '   \n\t ', 'x'.repeat(MAX_ISSUE_COMMENT_CHARS + 1)]) {
      const error = await catchAsync(() => client.createIssueComment(REF, 161, body));
      expect((error as GitHubClientError).code).toBe('invalid_request');
    }
    // Refused, never truncated: a half-posted proposed split reads as the whole proposal.
    expect(calls).toHaveLength(0);
  });

  it('sends a body that is exactly at the limit, so the bound is inclusive', async () => {
    const { octokit, calls } = stubOctokit({
      request: async () => ({ headers: {}, data: COMMENT_DATA }),
    });
    await OctokitGitHubClient.withOctokit(octokit).createIssueComment(
      REF,
      161,
      'x'.repeat(MAX_ISSUE_COMMENT_CHARS),
    );
    expect(calls).toHaveLength(1);
  });

  it('refuses an issue number that is not a positive integer, before any request', async () => {
    const { octokit, calls } = stubOctokit({});
    const client = OctokitGitHubClient.withOctokit(octokit);
    for (const number of [0, -1, 1.5, Number.NaN]) {
      const error = await catchAsync(() => client.createIssueComment(REF, number, 'a body'));
      expect((error as GitHubClientError).code).toBe('invalid_request');
    }
    expect(calls).toHaveLength(0);
  });

  /**
   * The claim `assertCommentBody`'s docstring makes, asserted rather than asserted-about: the fake
   * calls the real client's assertion, so the two cannot drift. #100 and #144 are tested against
   * the fake, and a fake that re-derived the rule would let a change here leave those tests green
   * against a client that refused the identical call.
   */
  it('refuses exactly the same bodies through the real client and through the fake', async () => {
    const { octokit } = stubOctokit({});
    const real = OctokitGitHubClient.withOctokit(octokit);
    const fake = new FakeGitHubClient().seedIssue({
      owner: REF.owner,
      repo: REF.repo,
      number: 161,
      title: 'seeded',
      body: '',
      state: 'open',
      labels: [],
      assignees: [],
      htmlUrl: 'https://github.com/jortega0033/pipenzo/issues/161',
      updatedAt: new Date(0).toISOString(),
      etag: undefined,
    });
    const refused = ['', '   \n\t ', 'a\u0000b', 'a\u0007b', 'x'.repeat(MAX_ISSUE_COMMENT_CHARS + 1)];
    for (const body of refused) {
      const fromReal = await catchAsync(() => real.createIssueComment(REF, 161, body));
      const fromFake = await catchAsync(() => fake.createIssueComment(REF, 161, body));
      expect((fromReal as GitHubClientError).code, body.slice(0, 16)).toBe('invalid_request');
      expect((fromFake as GitHubClientError).code, body.slice(0, 16)).toBe('invalid_request');
    }
    // And the same body both accept: CRLF is prose, not a control character, on this one field.
    await expect(fake.createIssueComment(REF, 161, 'line one\r\nline two')).resolves.toMatchObject({
      body: 'line one\r\nline two',
    });
  });

  it('keeps leading and trailing whitespace inside a real body', async () => {
    const { octokit, calls } = stubOctokit({
      request: async () => ({ headers: {}, data: COMMENT_DATA }),
    });
    await OctokitGitHubClient.withOctokit(octokit).createIssueComment(REF, 161, '\n## Split\n\n');
    // Blankness is tested on the trimmed string; what gets published is what the caller wrote.
    expect(calls[0]?.params).toMatchObject({ body: '\n## Split\n\n' });
  });

  it('maps GitHub failures through the same error union as every other write', async () => {
    for (const [status, code] of [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [422, 'invalid_request'],
      [429, 'rate_limited'],
    ] as const) {
      const { octokit } = stubOctokit({
        request: async () => {
          throw httpError(status, 'upstream said no');
        },
      });
      const error = await catchAsync(() =>
        OctokitGitHubClient.withOctokit(octokit).createIssueComment(REF, 161, 'a body'),
      );
      expect((error as GitHubClientError).code).toBe(code);
    }
  });

  it('raises invalid_response rather than inventing an identity for a malformed payload', async () => {
    const { octokit } = stubOctokit({
      request: async () => ({ headers: {}, data: { body: 'a body' } }),
    });
    const error = await catchAsync(() =>
      OctokitGitHubClient.withOctokit(octokit).createIssueComment(REF, 161, 'a body'),
    );
    expect((error as GitHubClientError).code).toBe('invalid_response');
  });

  it('is mirrored by the fake, with the same validation and no deduplication', async () => {
    const fake = new FakeGitHubClient().seedIssue({
      owner: REF.owner,
      repo: REF.repo,
      number: 161,
      title: 'A ticket',
      body: '',
      state: 'open',
      labels: [],
      assignees: [],
      htmlUrl: 'https://github.com/jortega0033/pipenzo/issues/161',
      updatedAt: '2026-09-06T00:00:00Z',
      etag: undefined,
    });
    const first = await fake.createIssueComment(REF, 161, 'same text');
    const second = await fake.createIssueComment(REF, 161, 'same text');
    // GitHub has no idempotency key for a comment, so a fake that collapsed these would certify
    // an idempotency the product does not have.
    expect(second.id).not.toBe(first.id);
    expect(fake.issueComments(REF, 161).map((entry) => entry.body)).toEqual([
      'same text',
      'same text',
    ]);
    expect(fake.calls.filter((call) => call.method === 'createIssueComment')).toHaveLength(2);

    for (const body of ['   ', 'x'.repeat(MAX_ISSUE_COMMENT_CHARS + 1)]) {
      const error = await catchAsync(() => fake.createIssueComment(REF, 161, body));
      expect((error as GitHubClientError).code).toBe('invalid_request');
    }
    const missing = await catchAsync(() => fake.createIssueComment(REF, 999, 'a body'));
    expect((missing as GitHubClientError).code).toBe('not_found');
  });
});

/**
 * Issue #186. The phase machine's states are GitHub labels, so it cannot write a state without
 * these two methods — `createLabel` only ever made a label exist at the *repository* level.
 */
describe('issue label writes', () => {
  it('replaces the pipenzo namespace while carrying a human\'s own labels through', async () => {
    const { octokit, calls } = stubOctokit({
      paginate: async () => [
        { name: 'pipenzo:queued' },
        { name: 'bug' },
        { name: 'good first issue' },
      ],
      // Echoes the labels it was actually sent. A handler returning a fixed list would let an
      // implementation that dropped every foreign label still satisfy the assertions on `result`.
      request: async (_route, params) => ({
        data: (params.labels as string[]).map((name) => ({ name })),
      }),
    });
    const client = OctokitGitHubClient.withOctokit(octokit);
    const result = await client.setIssueLabels(REF, 78, ['pipenzo:working']);

    const put = calls.find((call) => call.route.startsWith('PUT'));
    // The previous lane label is gone (replace, not add) and both foreign labels survived.
    expect(put?.params.labels).toEqual(['bug', 'good first issue', 'pipenzo:working']);
    expect(result).toEqual(['bug', 'good first issue', 'pipenzo:working']);
  });

  /**
   * The read half is a full replace's input, so a label it fails to see is a label the write
   * deletes. One page of a hundred is not the whole issue.
   */
  it('paginates the read, so a foreign label past the first page still survives', async () => {
    const many = Array.from({ length: 150 }, (_, index) => ({ name: `triage-${index}` }));
    const { octokit, calls } = stubOctokit({
      paginate: async () => [...many, { name: 'pipenzo:queued' }],
      request: async (_route, params) => ({
        data: (params.labels as string[]).map((name) => ({ name })),
      }),
    });
    await OctokitGitHubClient.withOctokit(octokit).setIssueLabels(REF, 78, ['pipenzo:working']);
    const sent = calls.find((call) => call.route.startsWith('PUT'))?.params.labels as string[];
    expect(sent).toHaveLength(151);
    expect(sent).toContain('triage-149');
    expect(sent).not.toContain('pipenzo:queued');
  });

  it('clears the namespace on an empty set without touching anything else', async () => {
    const { octokit, calls } = stubOctokit({
      paginate: async () => [{ name: 'pipenzo:working' }, { name: 'bug' }],
      request: async (_route, params) => ({
        data: (params.labels as string[]).map((name) => ({ name })),
      }),
    });
    await OctokitGitHubClient.withOctokit(octokit).setIssueLabels(REF, 78, []);
    expect(calls.find((call) => call.route.startsWith('PUT'))?.params.labels).toEqual(['bug']);
  });

  it('refuses to write a label outside its own namespace, before any request goes out', async () => {
    const { octokit, calls } = stubOctokit({});
    await expect(
      OctokitGitHubClient.withOctokit(octokit).setIssueLabels(REF, 78, ['wontfix']),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });

  it('treats removing a label that is not on the issue as success', async () => {
    const { octokit } = stubOctokit({
      request: async () => {
        throw httpError(404, 'Label does not exist');
      },
    });
    await expect(
      OctokitGitHubClient.withOctokit(octokit).removeIssueLabel(REF, 78, 'pipenzo:queued'),
    ).resolves.toBeUndefined();
  });

  it('still reports a real failure when removing a label', async () => {
    const { octokit } = stubOctokit({
      request: async () => {
        throw httpError(403, 'Resource not accessible');
      },
    });
    await expect(
      OctokitGitHubClient.withOctokit(octokit).removeIssueLabel(REF, 78, 'pipenzo:queued'),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects a non-positive issue number and a foreign label on the remove path too', async () => {
    const { octokit, calls } = stubOctokit({});
    const client = OctokitGitHubClient.withOctokit(octokit);
    await expect(client.removeIssueLabel(REF, 0, 'pipenzo:queued')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(client.removeIssueLabel(REF, 78, 'bug')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(calls).toHaveLength(0);
  });

  /**
   * The fake has to preserve foreign labels for the same reason the real client does: the phase
   * machine is tested against the fake, so a fake that just overwrote the array would certify the
   * opposite of the property this ticket exists to protect.
   */
  it('is mirrored by the fake, including the preservation and the idempotent remove', async () => {
    const fake = new FakeGitHubClient().seedIssue({
      owner: REF.owner,
      repo: REF.repo,
      number: 78,
      title: 'First-run empty',
      body: '',
      state: 'open',
      labels: ['pipenzo:queued', 'bug'],
      assignees: [],
      htmlUrl: 'https://github.com/jortega0033/pipenzo/issues/78',
      updatedAt: '2026-09-07T00:00:00Z',
      etag: undefined,
    });

    expect(await fake.setIssueLabels(REF, 78, ['pipenzo:working'])).toEqual([
      'bug',
      'pipenzo:working',
    ]);
    expect((await fake.getIssue(REF, 78)).labels).toEqual(['bug', 'pipenzo:working']);

    await fake.removeIssueLabel(REF, 78, 'pipenzo:working');
    expect((await fake.getIssue(REF, 78)).labels).toEqual(['bug']);
    // Twice, because the phase machine re-applies transitions on recovery.
    await fake.removeIssueLabel(REF, 78, 'pipenzo:working');
    expect((await fake.getIssue(REF, 78)).labels).toEqual(['bug']);

    await expect(fake.setIssueLabels(REF, 78, ['wontfix'])).rejects.toMatchObject({
      code: 'invalid_request',
    });

    // Namespace before existence, matching the real client, where the guard is synchronous and a
    // missing issue is not discoverable until the request it never gets to make.
    await expect(fake.setIssueLabels(REF, 999, ['wontfix'])).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('getAuthenticatedLogin', () => {
  /**
   * The daemon holds the token, so the daemon is the only thing that knows who "I" is. A caller
   * that could name the assignee could claim a ticket as somebody else, which defeats the point of
   * an assignment race -- the loser has to be able to trust the name on the ticket.
   */
  it('reads the login the configured token authenticates as', async () => {
    const { octokit, calls } = stubOctokit({
      request: async () => ({ headers: {}, data: { login: 'jortega0033' } }),
    });
    await expect(OctokitGitHubClient.withOctokit(octokit).getAuthenticatedLogin()).resolves.toBe(
      'jortega0033',
    );
    expect(calls[0]?.route).toBe('GET /user');
  });

  it('refuses a response whose login is not a usable GitHub login', async () => {
    const { octokit } = stubOctokit({
      request: async () => ({ headers: {}, data: { login: 'not a login' } }),
    });
    const error = await catchAsync(() =>
      OctokitGitHubClient.withOctokit(octokit).getAuthenticatedLogin(),
    );
    expect((error as GitHubClientError).code).toBe('invalid_request');
  });

  it('is mirrored by the fake, which a test can point at either side of a race', async () => {
    const fake: GitHubClient = new FakeGitHubClient().seedAuthenticatedLogin('someone-else');
    await expect(fake.getAuthenticatedLogin()).resolves.toBe('someone-else');
  });
});

/**
 * Issue #161: the conditional-request layer. What is asserted here is the *quota* property, not
 * merely that the right value comes back — a poll that costs a rate-limit point every cycle is the
 * bug this exists to prevent, and only the request headers can show whether it does.
 */
describe('conditional requests (issue #161)', () => {
  const ISSUE_BODY = {
    number: 161,
    title: 'ETag + conditional-request layer',
    body: 'body',
    state: 'open',
    labels: ['pipenzo:queued'],
    assignees: [],
    html_url: 'https://github.com/jortega0033/pipenzo/issues/161',
    updated_at: '2026-09-07T00:00:00Z',
  };

  /** A 304 as `@octokit/request` actually raises it: a thrown error, never a returned response. */
  const notModified = (): Error => httpError(304, 'Not modified');

  const conditionalHeader = (call: StubCall | undefined): string | undefined =>
    (call?.params.headers as Record<string, string> | undefined)?.['if-none-match'];

  it('sends no validator on a cold read, and stores the one it gets back', async () => {
    const cache = new ConditionalRequestCache();
    const { octokit, calls } = stubOctokit({
      request: async () => ({ headers: { etag: 'W/"v1"' }, data: ISSUE_BODY }),
    });

    await OctokitGitHubClient.withOctokit(octokit, { cache }).getIssue(REF, 161);

    expect(conditionalHeader(calls[0])).toBeUndefined();
    expect(cache.get(REF, 'issue:161')?.etag).toBe('W/"v1"');
  });

  it('sends the stored validator next time and serves the stored body on a 304', async () => {
    const cache = new ConditionalRequestCache();
    let responses = 0;
    const { octokit, calls } = stubOctokit({
      request: async () => {
        responses += 1;
        if (responses === 1) return { headers: { etag: 'W/"v1"' }, data: ISSUE_BODY };
        throw notModified();
      },
    });
    const client = OctokitGitHubClient.withOctokit(octokit, { cache });

    const first = await client.getIssue(REF, 161);
    const second = await client.getIssue(REF, 161);

    expect(conditionalHeader(calls[1])).toBe('W/"v1"');
    expect(second).toEqual(first);
    expect(cache.stats.notModified).toBe(1);
  });

  /**
   * The failure mode a per-call-site implementation would have: a 304 with nothing to serve is a
   * transport error, not an empty issue. It must never be swallowed into a synthesized value.
   */
  it('does not swallow a 304 that arrives with nothing cached to serve', async () => {
    const cache = new ConditionalRequestCache();
    const { octokit } = stubOctokit({
      request: async () => {
        throw notModified();
      },
    });
    const error = await catchAsync(() =>
      OctokitGitHubClient.withOctokit(octokit, { cache }).getIssue(REF, 161),
    );
    expect(error).toBeInstanceOf(GitHubClientError);
    expect((error as GitHubClientError).status).toBe(304);
  });

  it('is off entirely when no cache is supplied', async () => {
    const { octokit, calls } = stubOctokit({
      request: async () => ({ headers: { etag: 'W/"v1"' }, data: ISSUE_BODY }),
    });
    const client = OctokitGitHubClient.withOctokit(octokit);
    await client.getIssue(REF, 161);
    await client.getIssue(REF, 161);
    for (const call of calls) expect(conditionalHeader(call)).toBeUndefined();
  });

  it('leaves a response with no ETag uncached rather than storing an unvalidatable entry', async () => {
    const cache = new ConditionalRequestCache();
    const { octokit } = stubOctokit({ request: async () => ({ headers: {}, data: ISSUE_BODY }) });
    await OctokitGitHubClient.withOctokit(octokit, { cache }).getIssue(REF, 161);
    expect(cache.get(REF, 'issue:161')).toBeUndefined();
  });

  /**
   * The race the shared cache makes real: a read captures its validator, awaits GitHub, and a write
   * on the same resource lands meanwhile. GitHub's replicas can still answer the pre-write validator
   * with a 304, and serving the pre-write body would not self-heal — every later poll would get the
   * same agreeing 304.
   */
  it('re-reads unconditionally when the entry is invalidated while the read is in flight', async () => {
    const cache = new ConditionalRequestCache();
    cache.set(REF, 'issue:161', 'W/"v1"', { number: 161, title: 'stale' });

    let call = 0;
    const { octokit, calls } = stubOctokit({
      request: async () => {
        call += 1;
        if (call === 1) {
          // A concurrent write lands while this request is in flight.
          cache.invalidate(REF, 'issue:161');
          throw notModified();
        }
        return { headers: { etag: 'W/"v2"' }, data: ISSUE_BODY };
      },
    });

    const issue = await OctokitGitHubClient.withOctokit(octokit, { cache }).getIssue(REF, 161);

    expect(issue.title).toBe('ETag + conditional-request layer');
    expect(calls).toHaveLength(2);
    // The re-read carries no validator, so it cannot be answered 304 again.
    expect(conditionalHeader(calls[1])).toBeUndefined();
    expect(cache.stats.notModified).toBe(0);
  });

  it('still serves the cached body when an unrelated resource was invalidated meanwhile', async () => {
    const cache = new ConditionalRequestCache();
    cache.set(REF, 'issue:161', 'W/"v1"', { number: 161, title: 'cached' });

    const { octokit, calls } = stubOctokit({
      request: async () => {
        throw notModified();
      },
    });
    const client = OctokitGitHubClient.withOctokit(octokit, { cache });
    // Nothing invalidates during this read; eviction of another key must not count as one either.
    cache.set(REF, 'issue:999', 'W/"other"', { number: 999 });

    const issue = (await client.getIssue(REF, 161)) as unknown as { title: string };
    expect(issue.title).toBe('cached');
    expect(calls).toHaveLength(1);
    expect(cache.stats.notModified).toBe(1);
  });

  describe('writes drop what they may have changed', () => {
    it('setIssueLabels invalidates the issue it wrote to', async () => {
      const cache = new ConditionalRequestCache();
      cache.set(REF, 'issue:161', 'W/"stale"', { number: 161 });
      const { octokit } = stubOctokit({
        request: async () => ({ headers: {}, data: [{ name: 'pipenzo:working' }] }),
        paginate: async () => [],
      });
      await OctokitGitHubClient.withOctokit(octokit, { cache }).setIssueLabels(REF, 161, [
        'pipenzo:working',
      ]);
      expect(cache.get(REF, 'issue:161')).toBeUndefined();
    });

    it('removeIssueLabel invalidates even on the 404-is-success path', async () => {
      const cache = new ConditionalRequestCache();
      cache.set(REF, 'issue:161', 'W/"stale"', { number: 161 });
      const { octokit } = stubOctokit({
        request: async () => {
          throw httpError(404, 'Not Found');
        },
      });
      await OctokitGitHubClient.withOctokit(octokit, { cache }).removeIssueLabel(
        REF,
        161,
        'pipenzo:queued',
      );
      expect(cache.get(REF, 'issue:161')).toBeUndefined();
    });

    /**
     * A write that *failed* is not evidence the resource is unchanged: GitHub may have applied it
     * and then the response may have been lost. Invalidating only on success would leave a
     * validator answering 304 for a state that no longer exists.
     */
    it('assignIssue invalidates even when the write throws', async () => {
      const cache = new ConditionalRequestCache();
      cache.set(REF, 'issue:161', 'W/"stale"', { number: 161 });
      const { octokit } = stubOctokit({
        request: async () => {
          throw httpError(500, 'Internal Server Error');
        },
      });
      await catchAsync(() =>
        OctokitGitHubClient.withOctokit(octokit, { cache }).assignIssue(REF, 161, 'jortega0033'),
      );
      expect(cache.get(REF, 'issue:161')).toBeUndefined();
    });

    /**
     * Issue #228. A comment is not a field of `GitHubIssue`, but posting one bumps the issue's
     * `updated_at`, which is one — so a cached body recorded before the comment is stale, and the
     * same rule applies as to every other write here.
     */
    it('createIssueComment invalidates the issue it commented on, even when the write throws', async () => {
      for (const outcome of ['ok', 'throws'] as const) {
        const cache = new ConditionalRequestCache();
        cache.set(REF, 'issue:161', 'W/"stale"', { number: 161 });
        const { octokit } = stubOctokit({
          request: async () => {
            if (outcome === 'throws') throw httpError(500, 'Internal Server Error');
            return { headers: {}, data: COMMENT_DATA };
          },
        });
        const client = OctokitGitHubClient.withOctokit(octokit, { cache });
        const call = (): Promise<unknown> => client.createIssueComment(REF, 161, 'a body');
        if (outcome === 'throws') await catchAsync(call);
        else await call();
        expect(cache.get(REF, 'issue:161')).toBeUndefined();
      }
    });

    it('createLabel invalidates the repository label list', async () => {
      const cache = new ConditionalRequestCache();
      cache.set(REF, 'labels', 'W/"stale"', []);
      const { octokit } = stubOctokit({
        request: async () => ({ headers: {}, data: { name: 'pipenzo:queued', color: 'aabbcc' } }),
      });
      await OctokitGitHubClient.withOctokit(octokit, { cache }).createLabel(REF, {
        name: 'pipenzo:queued',
        color: 'aabbcc',
        description: '',
      });
      expect(cache.get(REF, 'labels')).toBeUndefined();
    });
  });

  /**
   * The paginated-read rule, which is the part of this layer that could quietly serve a stale list.
   * An ETag validates one page, so the fast path is taken only when the first page is also the last.
   */
  describe('listLabels takes the conditional fast path only when the list is one page', () => {
    const PAGE = [{ name: 'pipenzo:queued', color: 'AABBCC', description: 'Accepted' }];

    it('caches and revalidates a single-page list', async () => {
      const cache = new ConditionalRequestCache();
      let responses = 0;
      const { octokit, calls } = stubOctokit({
        request: async () => {
          responses += 1;
          if (responses === 1) return { headers: { etag: 'W/"labels"' }, data: PAGE };
          throw notModified();
        },
        paginate: async () => {
          throw new Error('a single-page list must not fall through to paginate');
        },
      });
      const client = OctokitGitHubClient.withOctokit(octokit, { cache });

      const first = await client.listLabels(REF);
      const second = await client.listLabels(REF);

      expect(first).toEqual([{ name: 'pipenzo:queued', color: 'aabbcc', description: 'Accepted' }]);
      expect(second).toEqual(first);
      expect(conditionalHeader(calls[1])).toBe('W/"labels"');
    });

    it('falls through to pagination and stores no validator when a next page exists', async () => {
      const cache = new ConditionalRequestCache();
      const { octokit } = stubOctokit({
        request: async () => ({
          headers: { etag: 'W/"page1"', link: '<https://api.github.com/x?page=2>; rel="next"' },
          data: PAGE,
        }),
        paginate: async () => [...PAGE, { name: 'pipenzo:working' }],
      });
      const labels = await OctokitGitHubClient.withOctokit(octokit, { cache }).listLabels(REF);

      expect(labels).toHaveLength(2);
      expect(cache.get(REF, 'labels')).toBeUndefined();
    });

    it('is unconditional, and purely paginated, when no cache is supplied', async () => {
      const { octokit, calls } = stubOctokit({ paginate: async () => PAGE });
      await OctokitGitHubClient.withOctokit(octokit).listLabels(REF);
      expect(calls).toHaveLength(1);
    });

    /**
     * The case that would otherwise return a silently incomplete list forever: page one is
     * byte-identical (so GitHub answers 304) but the list has since grown a second page. GitHub
     * sends `Link` on a 304 as well, and that header is what settles it — the alternative would be
     * trusting GitHub's undocumented label ordering to guarantee that growth always disturbs
     * page one.
     */
    it('refuses a 304 whose own Link header says a second page now exists', async () => {
      const cache = new ConditionalRequestCache();
      cache.set(REF, 'labels', 'W/"labels"', [
        { name: 'pipenzo:queued', color: 'aabbcc', description: 'Accepted' },
      ]);
      const nextLink = '<https://api.github.com/x?page=2>; rel="next"';
      let call = 0;
      const { octokit, calls } = stubOctokit({
        request: async () => {
          call += 1;
          // The conditional first attempt is answered 304 — but with a `Link` that contradicts the
          // single-page assumption the cached entry was stored under. The re-read is unconditional.
          if (call === 1) throw httpError(304, 'Not modified', { link: nextLink });
          return { headers: { etag: 'W/"page1"', link: nextLink }, data: PAGE };
        },
        paginate: async () => [...PAGE, { name: 'pipenzo:working' }],
      });

      const labels = await OctokitGitHubClient.withOctokit(octokit, { cache }).listLabels(REF);

      expect(labels).toHaveLength(2);
      expect(cache.stats.notModified).toBe(0);
      expect(cache.get(REF, 'labels')).toBeUndefined();
      expect(conditionalHeader(calls[0])).toBe('W/"labels"');
    });

    it('accepts a 304 with no Link header, which is the ordinary unchanged single page', async () => {
      const cache = new ConditionalRequestCache();
      const cached = [{ name: 'pipenzo:queued', color: 'aabbcc', description: 'Accepted' }];
      cache.set(REF, 'labels', 'W/"labels"', cached);
      const { octokit } = stubOctokit({
        request: async () => {
          throw notModified();
        },
        paginate: async () => {
          throw new Error('must not fall through to paginate');
        },
      });

      await expect(
        OctokitGitHubClient.withOctokit(octokit, { cache }).listLabels(REF),
      ).resolves.toEqual(cached);
      expect(cache.stats.notModified).toBe(1);
    });
  });

  it('createIssue with labels invalidates the repository label list it may have added to', async () => {
    const cache = new ConditionalRequestCache();
    cache.set(REF, 'labels', 'W/"stale"', []);
    const { octokit } = stubOctokit({
      request: async () => ({ headers: {}, data: ISSUE_BODY }),
    });
    await OctokitGitHubClient.withOctokit(octokit, { cache }).createIssue(REF, {
      title: 'a new ticket',
      body: '',
      labels: ['pipenzo:queued'],
    });
    expect(cache.get(REF, 'labels')).toBeUndefined();
  });
});

/**
 * Issue #161's other half: the throttling/retry ladder. The policy is asserted as a pure decision
 * rather than by driving a real limiter — what matters is *which* limits are waited out and which
 * are surfaced, and that is a rule, not a timing.
 */
describe('rate-limit retry policy (issue #161)', () => {
  it('waits out a short limit', () => {
    expect(shouldRetryRateLimit(1, 0)).toBe(true);
    expect(shouldRetryRateLimit(MAX_RATE_LIMIT_SLEEP_SECONDS, 0)).toBe(true);
  });

  /**
   * A primary-limit reset can be the better part of an hour away. Every call here happens inside a
   * daemon request a renderer is awaiting, so a long sleep is indistinguishable from a hang — the
   * error is surfaced instead, and `toGitHubClientError` turns it into `rate_limited` carrying the
   * reset time, which is what the degradation surface (#75) widens poll intervals from.
   */
  it('refuses to sleep through a long one', () => {
    expect(shouldRetryRateLimit(MAX_RATE_LIMIT_SLEEP_SECONDS + 1, 0)).toBe(false);
    expect(shouldRetryRateLimit(3600, 0)).toBe(false);
  });

  it('gives up after a bounded number of attempts', () => {
    expect(shouldRetryRateLimit(1, MAX_RATE_LIMIT_RETRIES - 1)).toBe(true);
    expect(shouldRetryRateLimit(1, MAX_RATE_LIMIT_RETRIES)).toBe(false);
  });

  /** A malformed `Retry-After` must not become "retry immediately, forever". */
  it('treats a nonsensical retry-after as not retryable', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(shouldRetryRateLimit(bad, 0)).toBe(false);
    }
  });

  /**
   * That the configured client *constructs* proves nothing on its own: an unrecognised `throttle`
   * option is simply ignored, so dropping the plugin would leave this passing. What does prove it
   * is the plugin's own precondition — `@octokit/plugin-throttling` throws unless both handlers are
   * supplied — exercised against the same composed constructor the real client uses.
   */
  it('really has the throttling plugin installed, not just a throttle option', () => {
    const Composed = Octokit.plugin(...PIPENZO_OCTOKIT_PLUGINS);
    expect(() => new Composed({ auth: `${gh('p')}notARealTokenForTests000` })).toThrow(
      /onSecondaryRateLimit and onRateLimit/,
    );
    // And with the handlers this module supplies, the same constructor is satisfied.
    expect(() => createPipenzoOctokit(`${gh('p')}notARealTokenForTests000`)).not.toThrow();
  });

  /** `@octokit/plugin-retry` announces itself on the instance; that is a fingerprint, not a guess. */
  it('really has the retry plugin installed', () => {
    const octokit = createPipenzoOctokit(`${gh('p')}notARealTokenForTests000`) as unknown as {
      retry?: { retryRequest?: unknown };
    };
    expect(typeof octokit.retry?.retryRequest).toBe('function');
  });

  /**
   * The one path in this module that escapes `GitHubClientError`'s redaction: octokit's own logger,
   * which the throttling plugin calls when a rate-limit handler throws. Left at octokit's default
   * it goes straight to `console.warn` unscrubbed.
   */
  it('scrubs credentials out of octokit’s own log output', () => {
    const secret = `${gh('p')}AbCdEfGhIjKlMnOpQrStUvWx`;
    const octokit = createPipenzoOctokit(secret) as unknown as {
      log: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      octokit.log.warn('limit handler failed', new Error(`Authorization: Bearer ${secret}`));
      octokit.log.error(`remote https://x-access-token:${secret}@github.com/o/r.git`);
      const emitted = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
      expect(emitted).not.toContain(secret);
      expect(emitted).toContain('[redacted]');
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
