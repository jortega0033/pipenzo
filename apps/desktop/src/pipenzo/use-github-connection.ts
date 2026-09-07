import { useCallback, useEffect, useState } from 'react';
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
 */
export function useGitHubConnection(): {
  connection: PipenzoGitHubConnectionV1 | undefined;
  refresh: () => void;
} {
  const [connection, setConnection] = useState<PipenzoGitHubConnectionV1 | undefined>(undefined);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void getBridge()
        .pipenzoGitHubConnection()
        .then((next) => {
          if (!cancelled) setConnection(next);
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
  }, [revision]);

  return { connection, refresh };
}
