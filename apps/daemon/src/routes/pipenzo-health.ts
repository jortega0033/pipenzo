import type { FastifyInstance } from 'fastify';
import type { PipenzoGitHubHealthV1 } from '@agent-dock/shared';
import { BoundedPipenzoHealthSseWriter, toHealthStreamEvent } from '../pipenzo-health-events.js';

/**
 * What this route needs from `PipenzoReconciler` (issue #231), narrowed to exactly the two members
 * it calls. Kept as an interface rather than importing the class so a daemon assembled for a route
 * test can hand in a stub with no scheduler, no GitHub client, and no connected-repos store.
 */
export type PipenzoHealthSource = {
  health(): PipenzoGitHubHealthV1;
  subscribeHealth(listener: (health: PipenzoGitHubHealthV1) => void): () => void;
};

/**
 * The GitHub connection-health stream (issue #257), the transport `pipenzo-reconciler.ts`'s own
 * doc comment left for "the first banner to need it" -- #70/#71/#72/#73/#75.
 *
 * Deliberately not the phase-event stream: see `pipenzo-health-events.ts`'s module comment for why
 * a latest-value snapshot gets its own stream instead of joining the ticket-transition log's
 * gap-free replay contract. There is exactly one route here, and it is a `GET`: this surface never
 * accepts a write, unlike every other Pipenzo route file, because there is nothing for a caller to
 * ask this component to do -- it only ever reports what the reconciler already decided.
 *
 * Not rate-limited, for the same reason the phase-event stream isn't: it costs a socket and no
 * upstream GitHub call, and limiting a stream the desktop reconnects to after every daemon restart
 * would lock a banner out of live data at exactly the moment it most needs it.
 */
export function registerPipenzoHealthRoutes(app: FastifyInstance, source: PipenzoHealthSource): void {
  app.get('/v2/pipenzo/github/health/events', async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    let sequence = 0;
    let unsubscribe: (() => void) | undefined;
    let cleanupRequested = false;
    const cleanup = (): void => {
      if (!unsubscribe) {
        // A synchronous overflow on the very first write (the current-value frame below) can close
        // the writer before `subscribeHealth` below has returned its disposer.
        cleanupRequested = true;
        return;
      }
      const release = unsubscribe;
      unsubscribe = undefined;
      release();
    };

    const writer = new BoundedPipenzoHealthSseWriter(reply.raw, cleanup);
    reply.raw.once('close', () => writer.close());
    writer.start();

    // The current value first, so a subscriber never waits for the reconciler's next tick (which
    // may be minutes away) to learn where the connection already stands.
    writer.write(toHealthStreamEvent(sequence++, source.health()));
    unsubscribe = source.subscribeHealth((health) => {
      writer.write(toHealthStreamEvent(sequence++, health));
    });
    if (cleanupRequested) cleanup();
  });
}
