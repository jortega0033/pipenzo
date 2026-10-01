import type { FastifyInstance } from 'fastify';
import {
  pipenzoNotificationSettingsUpdateV1Schema,
  pipenzoNotificationSettingsV1Schema,
} from '@agent-dock/shared';
import type { PipenzoNotificationSettingsStore } from '../pipenzo-notification-settings-store.js';

/**
 * Settings' Notifications panel (Pipenzo issue #129): read the workspace's
 * `refusal`/`medium`/`badge`/`sound` preferences, and change them.
 *
 * Same guarded surface every other `/v2/pipenzo/*` route sits on -- the startup bearer token, the
 * reject-any-Origin browser guard, and the fact that an agent session's environment carries neither
 * the daemon's port nor its token (see `pipenzo-tickets.ts`'s module comment, which states this once
 * for the whole family). The caller is the desktop main process, acting for a human looking at
 * Settings.
 *
 * `pipenzoNotificationSettingsUpdateV1Schema` has no `high` field, so there is no request shape --
 * malformed or otherwise -- this route could accept that would persist a HIGH preference. That is
 * CLAUDE.md hard rule #3 enforced at the wire boundary, not just in `NotificationsPanel`'s rendering.
 *
 * Unlike `PUT /v2/pipenzo/concurrency`, there is no live enforcement layer for this write to call
 * through to yet -- see `pipenzo-notification-settings-v1.ts`'s own module comment for why wiring
 * these preferences into `sendOsNotification`'s actual call sites is real, separate scope this route
 * does not take on. This still persists durably and answers with the daemon's own confirmed record,
 * not an echo of the request, matching every other Pipenzo write route.
 */
export function registerPipenzoNotificationSettingsRoutes(
  app: FastifyInstance,
  store: PipenzoNotificationSettingsStore,
): void {
  // Generous, matching `GET /v2/pipenzo/capture-settings`: a local file read with no upstream cost,
  // and Settings' own panel asks for it on every mount.
  app.get(
    '/v2/pipenzo/notification-settings',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      reply.send(pipenzoNotificationSettingsV1Schema.parse(await store.read()));
    },
  );

  app.put(
    '/v2/pipenzo/notification-settings',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = pipenzoNotificationSettingsUpdateV1Schema.safeParse(req.body);
      if (!parsed.success) {
        // Never echoes the Zod issue list, matching every other Pipenzo route: a validation error
        // is a fixed shape, not a description of the daemon's internals.
        reply
          .code(400)
          .send({ code: 'invalid_request', error: 'invalid notification settings request' });
        return;
      }
      try {
        const next = await store.update(parsed.data);
        reply.send(pipenzoNotificationSettingsV1Schema.parse(next));
      } catch {
        // Fixed message, matching every other Pipenzo write route: a 500 here is the daemon's own
        // failure, not something to describe from a caught error's internals.
        reply
          .code(500)
          .send({ code: 'write_failed', error: 'could not save notification settings' });
      }
    },
  );
}
