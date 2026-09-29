import type { FastifyInstance } from 'fastify';
import {
  pipenzoRepoCheckoutRequestV1Schema,
  pipenzoRepoCheckoutResultV1Schema,
} from '@agent-dock/shared';
import { parseRepoRef, type RepoRef } from '../github-client.js';
import type { ConnectedReposStore } from '../connected-repos-store.js';
import { RepoCheckoutError, type RepoCheckoutErrorCode } from '../repo-checkout.js';

/** Closed over the resolver's own union, so a new code is a compile error here until mapped. */
const CHECKOUT_ERROR_STATUS: Record<RepoCheckoutErrorCode, number> = {
  // A connected name the clone root refuses to map (`repo.`, `repo.git`, a device name, ...).
  invalid_repository: 400,
  // The local disk refusing: something is already at the path, or it is a link.
  path_conflict: 409,
  // git or GitHub refusing.
  clone_failed: 502,
};

/** The slice of `RepoCheckouts` this route needs; a test passes a fake. */
export interface RepoCheckoutResolver {
  resolve(ref: RepoRef): Promise<string>;
}

/**
 * `POST /v2/pipenzo/repos/checkout` (issues #342/#344): a connected `owner/name` in, the local
 * checkout Refine and Implement run against out -- cloned into Pipenzo's managed directory the first
 * time it is asked for (`repo-checkout.ts`), reused every time after.
 *
 * It sits on the same guarded surface as every other `/v2/pipenzo/*` route: the startup bearer
 * token, the reject-any-Origin browser guard, and an agent session's environment carrying neither
 * the daemon's port nor its token. The caller is the desktop main process, acting for a human who
 * just clicked a Queued card.
 *
 * ## Connected repositories only
 *
 * The repository has to be on the list a human chose in the picker (#115). Without that check this
 * route would be "clone any repository on GitHub into the managed directory, using the operator's
 * own git credential helper" -- a much wider thing than resolving a repo the operator already
 * decided Pipenzo manages. The connected entry's own spelling is what gets cloned, so a request
 * that differs only in case resolves to the same directory the picker's choice would.
 *
 * ## Errors
 *
 * `repo-checkout.ts` owns every message it throws (paths and `redactSecrets`-treated git output,
 * never a credential), so a `RepoCheckoutError` is surfaced as-is: `invalid_repository` is a name
 * the clone root will not map (400), `path_conflict` is the local disk refusing (409),
 * `clone_failed` is git or GitHub refusing (502). Anything else -- git missing,
 * or a clone killed by its timeout -- is flattened to a fixed sentence, the same reason
 * `toPhaseError` never forwards an unrecognized error's text.
 *
 * ## Rate limit
 *
 * Higher than the phase routes' ten a minute: the board resolves this each time a Queued card's
 * dialog opens, and after the first clone it is a directory check plus two local git reads. The
 * clone itself cannot be multiplied by calling this more often -- `RepoCheckouts` joins concurrent
 * requests for one repository onto one resolution.
 */
export function registerPipenzoCheckoutRoutes(
  app: FastifyInstance,
  connectedRepos: Pick<ConnectedReposStore, 'read'>,
  checkouts: RepoCheckoutResolver,
): void {
  app.post(
    '/v2/pipenzo/repos/checkout',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = pipenzoRepoCheckoutRequestV1Schema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ code: 'invalid_request', error: 'invalid checkout request' });
        return;
      }
      const wanted = parsed.data.repo.toLowerCase();
      const connected = (await connectedRepos.read()).repositories.find(
        (repo) => repo.toLowerCase() === wanted,
      );
      if (!connected) {
        reply.code(409).send({
          code: 'repository_not_connected',
          error: `${parsed.data.repo} is not one of your connected repositories`,
        });
        return;
      }

      let ref: RepoRef;
      try {
        // The wire schema admits `owner/.` and `owner/..`; `parseRepoRef` does not, and it is the
        // thing standing between a repository name and a `join()` onto the clone root.
        ref = parseRepoRef(connected);
      } catch {
        reply.code(400).send({ code: 'invalid_request', error: 'invalid checkout request' });
        return;
      }

      let repositoryPath: string;
      try {
        repositoryPath = await checkouts.resolve(ref);
      } catch (error) {
        if (error instanceof RepoCheckoutError) {
          reply
            .code(CHECKOUT_ERROR_STATUS[error.code])
            .send({ code: error.code, error: error.message });
          return;
        }
        reply.code(502).send({
          code: 'clone_failed',
          error:
            'git could not run to prepare a local checkout (is git installed, or did the clone time out?)',
        });
        return;
      }
      reply.send(pipenzoRepoCheckoutResultV1Schema.parse({ repo: connected, repositoryPath }));
    },
  );
}
