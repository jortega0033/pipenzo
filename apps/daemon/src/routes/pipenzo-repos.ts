import type { FastifyInstance } from 'fastify';
import {
  pipenzoConnectReposRequestV1Schema,
  pipenzoConnectedReposV1Schema,
  pipenzoRepoListV1Schema,
  type PipenzoRepoV1,
} from '@agent-dock/shared';
import { GitHubClientError, type GitHubClient } from '../github-client.js';
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
 * **Why the listing is a POST-free GET with a tight rate limit.** It takes no arguments and reads
 * nothing local, but unlike `GET /v2/pipenzo/recovery` it *does* cost real GitHub quota — up to
 * fifty paginated requests. So the limit is low enough that a renderer bug polling it in a loop
 * shows up as 429s here rather than as a rate-limited GitHub account, which is the failure the user
 * would not be able to diagnose.
 */

/** Closed mapping, so an unhandled code is a compile error rather than a 500 with a status guess. */
const GITHUB_ERROR_STATUS: Record<string, number> = {
  token_missing: 401,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  invalid_repository: 400,
  invalid_response: 502,
  network_failed: 502,
  unknown: 502,
};

export function registerPipenzoRepoRoutes(
  app: FastifyInstance,
  store: ConnectedReposStore,
  githubClient: () => GitHubClient,
): void {
  app.get(
    '/v2/pipenzo/repos',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      let listing: { repositories: readonly unknown[]; truncated: boolean };
      try {
        listing = await githubClient().listAccessibleRepositories();
      } catch (error) {
        if (error instanceof GitHubClientError) {
          reply
            .code(GITHUB_ERROR_STATUS[error.code] ?? 502)
            .send({ code: error.code, error: error.message });
          return;
        }
        reply.code(502).send({ code: 'unknown', error: 'could not list repositories' });
        return;
      }
      // Parsed on the way out like every other Pipenzo result: the daemon's own `GitHubRepository`
      // is deliberately narrower than GitHub's payload, and this is the second line of defence that
      // keeps a field nobody reviewed from reaching the renderer if that normalization ever slips.
      reply.send(
        pipenzoRepoListV1Schema.parse({
          repositories: listing.repositories as PipenzoRepoV1[],
          truncated: listing.truncated,
        }),
      );
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
