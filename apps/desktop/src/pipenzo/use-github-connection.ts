import { useEffect, useState } from 'react';
import type { PipenzoGitHubConnectionV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';

/**
 * The renderer's view of the GitHub credential (issue #113), re-read whenever it can have changed.
 *
 * ## Why this re-reads on `ready` rather than subscribing
 *
 * There is no push channel for the credential, and adding one would be the wrong shape. The moment
 * a credential change actually takes effect is the moment the *new daemon* is serving, because the
 * daemon is handed its token once at spawn and a change is a respawn — `main.ts`'s disconnect
 * handler says as much: the reply it sends still describes the daemon on its way out. So the
 * signal to re-read is already on the wire. `daemon:status` going `ready` is exactly that edge, and
 * using it means the connection this hook reports and the credential the daemon is running on
 * cannot disagree for a window in which the user might act on the difference.
 *
 * `undefined` means "not read yet", and is distinct from every real state — see
 * `routePipenzoStartup`, which turns it into its own screen rather than guessing.
 *
 * A read that never settles would leave the caller on that "not read yet" state forever, with no
 * timeout here to rescue it. That is accepted rather than overlooked: the channel behind it is a
 * *synchronous* main-process handler (`main.ts`'s `pipenzo:github-connection` returns
 * `gitHubConnectionStatus()` directly), so it cannot be slow on its own — a hang means main itself
 * is wedged, at which point every other channel this window depends on is gone too and a retry
 * button here would be a button that does nothing.
 */
export function useGitHubConnection(): PipenzoGitHubConnectionV1 | undefined {
  const [connection, setConnection] = useState<PipenzoGitHubConnectionV1 | undefined>(undefined);

  useEffect(() => {
    // Two reads can be in flight at once -- the mount read, and one started by a `ready` that
    // arrives before it settles (main sends `ready` both after a credential restart and from
    // `did-finish-load` when a client already exists, so a reload landing near a restart produces
    // exactly that overlap). Promises have no ordering guarantee between them, so without a
    // generation counter the *older* answer can land last and win. The result would be a stale
    // `connected`/`disconnected` that looks entirely plausible and persists until the next `ready`
    // happens to correct it. `cancelled` alone does not cover this: it only guards unmount.
    let latest = 0;
    let cancelled = false;

    const read = (): void => {
      latest += 1;
      const generation = latest;
      void getBridge()
        .pipenzoGitHubConnection()
        .then((next) => {
          if (cancelled || generation !== latest) return;
          setConnection(next);
        })
        .catch(() => {
          // A failed read is not a disconnected vault, and reporting it as one would send a
          // correctly-connected user to a screen that cannot help them. Leave the last known
          // answer — `undefined` on the first read, which routes to `loading` — and wait for the
          // next `ready`, which is when a real answer becomes possible again.
        });
    };

    read();
    const unsubscribe = getBridge().onDaemonStatus((status) => {
      if (status.state === 'ready') read();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return connection;
}
