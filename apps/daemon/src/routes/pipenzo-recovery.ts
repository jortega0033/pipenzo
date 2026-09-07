import type { FastifyInstance } from 'fastify';
import { pipenzoRecoveryReportV1Schema } from '@agent-dock/shared';
import type { PipenzoCrashRecovery } from '../pipenzo-crash-recovery.js';

/**
 * What this daemon start recovered (Pipenzo issue #190).
 *
 * Sits on exactly the surface `routes/pipenzo-tickets.ts` describes and inherits every one of its
 * properties from `server.ts`: the startup bearer token, the reject-any-Origin browser guard, and
 * the fact that an agent session's environment carries neither the daemon's port nor its token. The
 * caller is the desktop main process, acting for a human.
 *
 * **Read-only, and that is the whole surface.** Recovery's two actions already have routes: Resume
 * is a session start the desktop makes itself, and Discard-and-restart is `POST
 * /v2/worktrees/cleanup` (issue #112). Adding a "recover this ticket" write here would be a second
 * cleanup path competing with the one that already enforces the tracked/untracked split and the two
 * `worktree_dirty` refusals — and a POST on a *recovery* surface is exactly the shape of endpoint
 * that would later grow an auto-resume, which #190 forbids outright.
 *
 * **`GET`, unlike the rest of `/v2/pipenzo/*`.** Those are POSTs because they carry a body and cost
 * a GitHub read. This one takes no arguments and answers from memory computed once at startup, so
 * it is a plain read of daemon state, like `GET /v2/worktrees`.
 *
 * The rate limit is generous for the same reason: no upstream call, no disk read, no quota to spend.
 * It is still limited rather than unlimited, because the board polls it on open and a renderer bug
 * that polls in a loop should be visible rather than free.
 */
export function registerPipenzoRecoveryRoutes(
  app: FastifyInstance,
  recovery: PipenzoCrashRecovery,
): void {
  app.get(
    '/v2/pipenzo/recovery',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      // Parsed on the way out like every other Pipenzo result: the report is assembled from stored
      // ticket records, and the schema is the second line of defence that keeps `worktree.path` --
      // which the parked entries deliberately never carry -- from ever reaching the renderer.
      reply.send(pipenzoRecoveryReportV1Schema.parse(recovery.report()));
    },
  );
}
