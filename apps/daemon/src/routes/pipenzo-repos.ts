import type { FastifyInstance } from 'fastify';
import {
  pipenzoConnectReposRequestV1Schema,
  pipenzoConnectedReposV1Schema,
  pipenzoRepoListV1Schema,
  type PipenzoRepoListV1,
  type PipenzoRepoV1,
} from '@agent-dock/shared';
import {
  GitHubClientError,
  type GitHubClient,
  type GitHubClientErrorCode,
} from '../github-client.js';
import { ConnectedReposStoreError, type ConnectedReposStore } from '../connected-repos-store.js';

/**
 * The repo picker's two surfaces (issue #115): what this credential can reach, and what a human
 * chose out of it.
 *
 * Both sit on the same guarded surface every other `/v2/pipenzo/*` route does — the startup bearer
 * token, the reject-any-Origin browser guard, and the fact that an agent session's environment
 * carries neither the daemon's port nor its token. The caller is the desktop main process, acting
 * for a human who is looking at a list of checkboxes.
 *
 * **Why the listing is cached rather than merely rate-limited.** It takes no arguments and reads
 * nothing local, but unlike `GET /v2/pipenzo/recovery` it *does* cost real GitHub quota — up to
 * fifty paginated requests per call. A rate limit alone does not bound that: ten calls a minute is
 * five hundred upstream requests a minute, which spends an account's whole hourly quota in ten
 * minutes. So the fan-out is bounded by a TTL and an in-flight join, and the rate limit is left to
 * do what rate limits are good at — keeping a loop from making the *daemon* work.
 */

/**
 * Closed mapping, and this time actually closed.
 *
 * The first draft typed this `Record<string, number>`, which accepts any key and requires none — so
 * the comment promising a compile error was worth nothing, and it hid four defects at once: two
 * keys that are not `GitHubClientErrorCode` values at all (`network_failed`, `unknown`) and two
 * real codes that were missing and silently fell to a 502 (`network`, and `invalid_request`, which
 * is a 400 wearing a gateway error's clothes). Typed against the union, adding a code to
 * `github-client.ts` is a compile error here until somebody chooses its status.
 */
const GITHUB_ERROR_STATUS: Record<GitHubClientErrorCode, number> = {
  token_missing: 401,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  invalid_repository: 400,
  invalid_request: 400,
  invalid_response: 502,
  network: 502,
};

/**
 * How long a listing is reused before GitHub is asked again.
 *
 * This is the control that actually bounds the quota, and the rate limit is not. One request here
 * fans out to as many as `GITHUB_REPO_PAGE_CAP` upstream requests, so at the first draft's ten per
 * minute a renderer looping the channel sustained 500 GitHub requests a minute — the account's
 * whole hourly quota in ten minutes, which is exactly the failure the limit was supposed to
 * prevent and the one a user cannot diagnose. A TTL caps the fan-out at one walk per window no
 * matter how often the channel is called.
 *
 * Sixty seconds is chosen against what this screen is for: first-run and Settings, where a
 * repository created in the last minute not appearing is a mild surprise, and a burned quota is a
 * day's work lost.
 */
const LISTING_TTL_MS = 60_000;

export function registerPipenzoRepoRoutes(
  app: FastifyInstance,
  store: ConnectedReposStore,
  githubClient: () => GitHubClient,
  now: () => number = Date.now,
): void {
  /**
   * The cached listing, and the walk currently producing one.
   *
   * `inFlight` is the half that matters under a loop: without it, ten concurrent requests each
   * start their own independent fifty-page walk of the same data before any of them can populate
   * the cache. With it they share one.
   */
  let cached: { at: number; value: PipenzoRepoListV1 } | undefined;
  let inFlight: Promise<PipenzoRepoListV1> | undefined;

  async function listRepositories(): Promise<PipenzoRepoListV1> {
    if (cached && now() - cached.at < LISTING_TTL_MS) return cached.value;
    if (inFlight) return inFlight;
    const pending = (async () => {
      const listing = await githubClient().listAccessibleRepositories();
      // Parsed here like every other Pipenzo result: the daemon's own `GitHubRepository` is
      // deliberately narrower than GitHub's payload, and this is the second line of defence that
      // keeps a field nobody reviewed from reaching the renderer if that normalization slips.
      const value = pipenzoRepoListV1Schema.parse({
        repositories: listing.repositories as PipenzoRepoV1[],
        truncated: listing.truncated,
      });
      cached = { at: now(), value };
      return value;
    })();
    inFlight = pending;
    try {
      return await pending;
    } finally {
      // Released whether it resolved or threw, or every later call would join a dead promise.
      if (inFlight === pending) inFlight = undefined;
    }
  }

  app.get(
    '/v2/pipenzo/repos',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      try {
        reply.send(await listRepositories());
      } catch (error) {
        if (error instanceof GitHubClientError) {
          reply
            .code(GITHUB_ERROR_STATUS[error.code] ?? 502)
            .send({ code: error.code, error: error.message });
          return;
        }
        // Inside the `catch` deliberately: the outbound schema parse lives in here too, and in the
        // first draft it sat outside, so a listing the schema rejected escaped as a bare 500 that
        // the picker could only offer to retry forever.
        reply.code(502).send({ code: 'invalid_response', error: 'could not list repositories' });
      }
    },
  );

  app.get(
    '/v2/pipenzo/repos/connected',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      // Generous, because this one is a local file read with no upstream cost, and the pre-app gate
      // asks for it on every launch.
      reply.send(pipenzoConnectedReposV1Schema.parse(await store.read()));
    },
  );

  app.put(
    '/v2/pipenzo/repos/connected',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = pipenzoConnectReposRequestV1Schema.safeParse(req.body);
      if (!parsed.success) {
        // Never echoes the Zod issue list, matching every other Pipenzo route: a validation error
        // is a fixed shape, not a description of the daemon's internals.
        reply.code(400).send({ code: 'invalid_request', error: 'invalid connected-repos request' });
        return;
      }
      try {
        reply.send(
          pipenzoConnectedReposV1Schema.parse(await store.replace(parsed.data.repositories)),
        );
      } catch (error) {
        if (error instanceof ConnectedReposStoreError) {
          reply.code(400).send({ code: error.code, error: error.message });
          return;
        }
        reply.code(500).send({ code: 'write_failed', error: 'could not save the connected repos' });
      }
    },
  );
}
