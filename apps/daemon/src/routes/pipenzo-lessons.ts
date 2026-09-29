import type { FastifyInstance } from 'fastify';
import { pipenzoLessonDeleteRequestV1Schema, pipenzoLessonListV1Schema } from '@agent-dock/shared';
import { LessonStoreError, type LessonStore } from '../pipenzo-lesson-store.js';

/**
 * Settings' lesson-memory panel (issue #128): list every saved lesson, and delete one.
 *
 * Same guarded surface every other `/v2/pipenzo/*` route sits on — the startup bearer token, the
 * reject-any-Origin browser guard, and the fact that an agent session's environment carries neither
 * the daemon's port nor its token (see `pipenzo-tickets.ts`'s module comment, which states this once
 * for the whole family). The caller is the desktop main process, acting for a human looking at a
 * list in Settings.
 *
 * **No save route here.** `LessonStore.add()` exists and is tested, but nothing on this surface
 * calls it — offering the save prompt at a ticket's resolution and wiring its "Save lesson" button
 * is issue #104's own scope, not this ticket's. Building that route now, ahead of the screen that
 * would call it, is exactly the kind of untested surface this repo's diff-size gate exists to keep
 * out of a PR whose actual job is "list and delete".
 */
export function registerPipenzoLessonRoutes(app: FastifyInstance, store: LessonStore): void {
  // Generous, matching `GET /v2/pipenzo/repos/connected` and `GET /v2/pipenzo/tickets`: a local
  // file read with no upstream (GitHub) cost behind it, and Settings' own panel asks for it on
  // every mount.
  app.get(
    '/v2/pipenzo/lessons',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      reply.send(pipenzoLessonListV1Schema.parse(await store.list()));
    },
  );

  app.post(
    '/v2/pipenzo/lessons/delete',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = pipenzoLessonDeleteRequestV1Schema.safeParse(req.body);
      if (!parsed.success) {
        // Never echoes the Zod issue list, matching every other Pipenzo route.
        reply.code(400).send({ code: 'invalid_request', error: 'invalid lesson delete request' });
        return;
      }
      try {
        reply.send(pipenzoLessonListV1Schema.parse(await store.remove(parsed.data.id)));
      } catch (error) {
        if (error instanceof LessonStoreError) {
          const status = error.code === 'lesson_not_found' ? 404 : 400;
          reply.code(status).send({ code: error.code, error: error.message });
          return;
        }
        reply.code(500).send({ code: 'write_failed', error: 'could not delete that lesson' });
      }
    },
  );
}
