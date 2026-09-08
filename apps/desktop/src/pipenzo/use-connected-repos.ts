import { useCallback, useEffect, useState } from 'react';
import { getBridge } from '../bridge.js';
import type { ConnectedRepoState } from './startup-route.js';

/**
 * How many repositories this installation has connected (issue #115), for the startup gate.
 *
 * ## Why `'not-tracked'` is the answer for longer than it looks
 *
 * The count lives in the daemon, so it is unknowable while the daemon is starting — and the daemon
 * restarts *as part of connecting GitHub*, since it is handed its credential once at spawn. So the
 * window in which this cannot be answered is exactly the window right after a sign-in, which is
 * precisely when the gate is deciding whether to show the repo picker.
 *
 * Answering `0` during that window would route a fully-configured install to "choose your repos"
 * on every launch, for as long as the daemon took to come up. So a failed read is reported as
 * `'not-tracked'`, which `routePipenzoStartup` treats as satisfied — the same honest default the
 * router shipped with in #113. The gate only ever *adds* a step once it knows for certain that
 * nothing has been chosen.
 *
 * But "no answer yet" and "no answer coming" are not the same state, and collapsing them produced
 * the symmetric bug: an install with a credential and *zero* repositories chosen rendered the
 * board, then had it replaced by the picker the moment the first real answer arrived. So the first
 * read is `'unknown'`, which routes to `loading`, and it degrades to `'not-tracked'` the instant
 * that read settles either way — a window measured in one IPC round trip, not in daemon startup.
 *
 * Re-read on `daemon:status` going `ready`, for the same reason `useGitHubConnection` is: that edge
 * is already on the wire, and it is the moment the answer becomes knowable again.
 */
export function useConnectedRepos(): {
  connectedRepos: ConnectedRepoState;
  refresh: (count?: number) => void;
} {
  const [count, setCount] = useState<ConnectedRepoState>('unknown');
  const [revision, setRevision] = useState(0);

  /**
   * Takes an optional count so the picker's own save can land immediately, rather than leaving the
   * user on a finished screen until the next `ready`. Called with nothing, it re-asks the daemon.
   */
  const refresh = useCallback((next?: number) => {
    if (next !== undefined) {
      setCount(next);
      return;
    }
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let latest = 0;

    const read = (): void => {
      latest += 1;
      const generation = latest;
      void getBridge()
        .pipenzoConnectedRepos()
        .then((connected) => {
          // The same generation guard as `useGitHubConnection`, for the same reason: two reads can
          // overlap when a `ready` arrives before the first settles, and promises have no ordering
          // between them, so the older answer can land last and win.
          if (cancelled || generation !== latest) return;
          setCount(connected.repositories.length);
        })
        .catch(() => {
          // A daemon that is not ready rejects this call, and that is the common case rather than
          // an error -- it is what happens on every launch before the daemon finishes starting.
          // Reporting `0` here is the bug this whole module exists to avoid. But the gate must not
          // wait forever either, so this settles to `'not-tracked'`: unknown, and not coming.
          if (cancelled || generation !== latest) return;
          setCount((current) => (current === 'unknown' ? 'not-tracked' : current));
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

  return { connectedRepos: count, refresh };
}
