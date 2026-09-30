import type { FastifyInstance } from 'fastify';
import {
  pipenzoLessonCreateV1Schema,
  pipenzoLessonDeleteRequestV1Schema,
  pipenzoLessonListV1Schema,
} from '@agent-dock/shared';
import { LessonStoreError, type LessonStore } from '../pipenzo-lesson-store.js';

/**
 * Local, human-gated lesson memory: list every saved lesson (issue #128), save one (issue #104),
 * and delete one (issue #128).
 *
 * Same guarded surface every other `/v2/pipenzo/*` route sits on — the startup bearer token, the
 * reject-any-Origin browser guard, and the fact that an agent session's environment carries neither
 * the daemon's port nor its token (see `pipenzo-tickets.ts`'s module comment, which states this once
 * for the whole family). The caller is the desktop main process, acting for a human looking at
 * Settings or `LessonPrompt` (`TicketDetail.dc.html`'s `.lesson` prompt).
 *
 * **`POST /v2/pipenzo/lessons` is the only write a person did not ask this surface to gate further**
 * — `LessonPrompt`'s "Save lesson" is only ever rendered after a person typed or accepted the
 * pre-filled text and clicked it themselves (CLAUDE.md hard rule: nothing here is reachable from an
 * agent session), so there is no separate approval step for this route the way there is for the
 * publish gate. It answers with the daemon's own list afterward, matching the delete route below,
 * so a caller renders what actually landed rather than a locally assembled guess.
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
    '/v2/pipenzo/lessons',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = pipenzoLessonCreateV1Schema.safeParse(req.body);
      if (!parsed.success) {
        // Never echoes the Zod issue list, matching every other Pipenzo route.
        reply.code(400).send({ code: 'invalid_request', error: 'invalid lesson create request' });
        return;
      }
      try {
        await store.add(parsed.data);
        // The daemon's own list afterward, not the just-created record alone -- `LessonPrompt`
        // needs the per-repo count for its "Saved locally -- N lesson(s) on {repo}" line, and
        // computing that from a full list is the same shape `pipenzoDeleteLesson` already answers.
        reply.send(pipenzoLessonListV1Schema.parse(await store.list()));
      } catch (error) {
        if (error instanceof LessonStoreError) {
          reply.code(400).send({ code: error.code, error: error.message });
          return;
        }
        reply.code(500).send({ code: 'write_failed', error: 'could not save that lesson' });
      }
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
