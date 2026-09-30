import type { FastifyInstance } from 'fastify';
import {
  pipenzoConcurrencySettingsUpdateV1Schema,
  pipenzoConcurrencySettingsV1Schema,
} from '@agent-dock/shared';
import type { PipenzoConcurrencyStore } from '../pipenzo-concurrency-store.js';
import type { PipenzoExecutionLimiter } from '../pipenzo-execution-limiter.js';

/**
 * Settings' Concurrency panel (Pipenzo issue #126): read the workspace's execution-limit / run-
 * budget settings, and change them.
 *
 * Same guarded surface every other `/v2/pipenzo/*` route sits on -- the startup bearer token, the
 * reject-any-Origin browser guard, and the fact that an agent session's environment carries neither
 * the daemon's port nor its token (see `pipenzo-tickets.ts`'s module comment, which states this once
 * for the whole family). The caller is the desktop main process, acting for a human looking at
 * Settings.
 *
 * **Why `PUT` also updates the live limiter, not just the store.** A value that only reached disk
 * would take effect on the *next* daemon launch -- exactly the "UI-only stepper that changes a
 * number nothing reads" this ticket's own brief rules out. `limiter.setLimit()` is called only after
 * `store.update()` has durably persisted the new value, so a limiter update that somehow raced a
 * crash never leaves the in-memory ceiling ahead of what a restart would actually load back.
 */
export function registerPipenzoConcurrencyRoutes(
  app: FastifyInstance,
  store: PipenzoConcurrencyStore,
  limiter: PipenzoExecutionLimiter,
): void {
  // Generous, matching `GET /v2/pipenzo/repos/connected` and `GET /v2/pipenzo/lessons`: a local
  // file read with no upstream cost, and Settings' own panel asks for it on every mount.
  app.get(
    '/v2/pipenzo/concurrency',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      reply.send(pipenzoConcurrencySettingsV1Schema.parse(await store.read()));
    },
  );

  app.put(
    '/v2/pipenzo/concurrency',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = pipenzoConcurrencySettingsUpdateV1Schema.safeParse(req.body);
      if (!parsed.success) {
        // Never echoes the Zod issue list, matching every other Pipenzo route: a validation error
        // is a fixed shape, not a description of the daemon's internals.
        reply.code(400).send({ code: 'invalid_request', error: 'invalid concurrency settings request' });
        return;
      }
      try {
        const next = await store.update(parsed.data);
        // Only reached once the write above has actually landed -- see the module comment.
        limiter.setLimit(next.executionLimit);
        reply.send(pipenzoConcurrencySettingsV1Schema.parse(next));
      } catch {
        // Fixed message, matching every other Pipenzo write route: a 500 here is the daemon's own
        // failure, not something to describe from a caught error's internals.
        reply.code(500).send({ code: 'write_failed', error: 'could not save concurrency settings' });
      }
    },
  );
}
