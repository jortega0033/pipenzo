import type { FastifyInstance } from 'fastify';
import {
  pipenzoCaptureSettingsUpdateV1Schema,
  pipenzoCaptureSettingsV1Schema,
} from '@agent-dock/shared';
import type { PipenzoCaptureSettingsStore } from '../pipenzo-capture-settings-store.js';

/**
 * The Models & gates screen's agent-captured panel (Pipenzo issue #470): read the workspace's
 * `screenshotEnabled`/`escapeHatchEnabled` preference, and change it.
 *
 * Same guarded surface every other `/v2/pipenzo/*` route sits on -- the startup bearer token, the
 * reject-any-Origin browser guard, and the fact that an agent session's environment carries
 * neither the daemon's port nor its token (see `pipenzo-tickets.ts`'s module comment, which states
 * this once for the whole family). The caller is the desktop main process, acting for a human
 * looking at the Models & gates screen.
 *
 * Unlike `PUT /v2/pipenzo/concurrency`, there is no live enforcement layer for this write to call
 * through to yet -- see `pipenzo-capture-settings-v1.ts`'s own module comment for why wiring this
 * into `ScreenshotVerificationRunner`'s actual dispatch is real, separate scope this route does
 * not take on. This still persists durably and answers with the daemon's own confirmed record,
 * not an echo of the request, matching every other Pipenzo write route.
 */
export function registerPipenzoCaptureSettingsRoutes(
  app: FastifyInstance,
  store: PipenzoCaptureSettingsStore,
): void {
  // Generous, matching `GET /v2/pipenzo/concurrency`: a local file read with no upstream cost, and
  // the Models & gates screen asks for it on every mount.
  app.get(
    '/v2/pipenzo/capture-settings',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      reply.send(pipenzoCaptureSettingsV1Schema.parse(await store.read()));
    },
  );

  app.put(
    '/v2/pipenzo/capture-settings',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = pipenzoCaptureSettingsUpdateV1Schema.safeParse(req.body);
      if (!parsed.success) {
        // Never echoes the Zod issue list, matching every other Pipenzo route: a validation error
        // is a fixed shape, not a description of the daemon's internals.
        reply
          .code(400)
          .send({ code: 'invalid_request', error: 'invalid capture settings request' });
        return;
      }
      try {
        const next = await store.update(parsed.data);
        reply.send(pipenzoCaptureSettingsV1Schema.parse(next));
      } catch {
        // Fixed message, matching every other Pipenzo write route: a 500 here is the daemon's own
        // failure, not something to describe from a caught error's internals.
        reply.code(500).send({ code: 'write_failed', error: 'could not save capture settings' });
      }
    },
  );
}
