import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  pipenzoPublishRequestV1Schema,
  pipenzoPublishResultV1Schema,
  type PipenzoPublishErrorCodeV1,
} from '@agent-dock/shared';
import { PublishService, PublishServiceError } from '../publish-service.js';

/**
 * The publish gate's only entry point (Pipenzo issue #178).
 *
 * This route exists on the daemon's authenticated local HTTP surface — the same surface
 * `/v2/worktrees` and `/v2/sessions` sit on, behind the startup bearer token and the
 * reject-any-Origin browser guard in `server.ts`. Its caller is the desktop main process, after a
 * human clicks "Push branch" or "Push & open PR".
 *
 * It is deliberately *not*: an agent tool, an MCP server, a skill, a provider capability, or
 * anything an agent session can name. Agent sessions are spawned with a reviewed-key environment
 * that carries no daemon port and no daemon token, so a session cannot address this route even if
 * a model decided to try. See `publish-service.ts`'s module comment and
 * `test/publish-token-boundary.test.ts`.
 *
 * A low rate limit is attached because the failure mode this protects against is a loop, not a
 * flood: publishing is a human-paced action, and nothing legitimate pushes ten branches a minute.
 */
const PUBLISH_ERROR_STATUS: Record<PipenzoPublishErrorCodeV1, number> = {
  invalid_request: 400,
  worktree_not_found: 404,
  worktree_not_a_git_repository: 409,
  uncommitted_changes: 409,
  branch_not_found: 404,
  remote_not_found: 409,
  push_rejected: 409,
  push_failed: 502,
  publish_busy: 409,
  token_missing: 412,
  repository_not_configured: 412,
  pull_request_failed: 502,
};

function fail(reply: FastifyReply, code: PipenzoPublishErrorCodeV1, error: string): void {
  reply.code(PUBLISH_ERROR_STATUS[code]).send({ code, error });
}

export function registerPipenzoPublishRoutes(
  app: FastifyInstance,
  publishService: PublishService,
): void {
  app.post(
    '/v2/pipenzo/publish',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = pipenzoPublishRequestV1Schema.safeParse(req.body);
      if (!parsed.success) {
        // Deliberately does not echo the Zod issue list. This body carries a branch name, a PR
        // title and a PR body; reflecting a rejected payload back is how a validation error turns
        // into an accidental echo surface.
        return fail(reply, 'invalid_request', 'invalid publish request');
      }
      let result;
      try {
        result = await publishService.publish(parsed.data);
      } catch (error) {
        if (error instanceof PublishServiceError) return fail(reply, error.code, error.message);
        // Anything unexpected is flattened rather than surfaced: an unmapped error from deep in
        // the git or octokit stack is exactly the kind of string that can carry a credential.
        return fail(reply, 'push_failed', 'publish failed');
      }
      // Deliberately outside the try. A branch is on the remote and a pull request may be open by
      // now, so a response-shape mismatch must not be reported as a publish failure — the
      // operator's natural retry would push again and open a duplicate.
      reply.send(pipenzoPublishResultV1Schema.parse(result));
    },
  );
}
