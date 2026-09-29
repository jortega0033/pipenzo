import { useCallback, useEffect, useState } from 'react';
import { getBridge } from '../bridge.js';

/**
 * The workspace's connected-repos list itself (issue #89), not just the count
 * `use-connected-repos.ts` exposes for the startup gate.
 *
 * The sidebar's workspace switcher needs the actual `owner/name` rows to render -- a count cannot
 * build a menu -- so this is a sibling hook rather than an extension of `useConnectedRepos`: that
 * one's three-state `'unknown' | 'not-tracked' | number` answer is shaped for a startup gate
 * deciding whether to route to the repo picker, and bolting a second, differently-shaped answer
 * onto it would make every existing caller (the gate itself) carry a case it never asks for.
 *
 * Same two-state shape `usePipenzoTickets` already uses for the same reason: nothing downstream of
 * this hook needs the loading/not-tracked distinction the startup gate cares about, and `'error'`
 * has to be its own state rather than falling back to an empty list -- an empty connected-repos
 * list here would render the switcher as if the workspace had zero repos connected, which is a
 * different, false statement from "could not ask the daemon right now".
 */
export type ConnectedRepoListState =
  | { status: 'loading' }
  | { status: 'ready'; repositories: readonly string[] }
  | { status: 'error' };

export function useConnectedRepoList(): {
  repoList: ConnectedRepoListState;
  refresh: () => void;
} {
  const [state, setState] = useState<ConnectedRepoListState>({ status: 'loading' });
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => {
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
          // The same generation guard `useConnectedRepos`/`usePipenzoTickets` carry: two reads can
          // overlap when a `ready` status arrives before the first settles, and promises have no
          // ordering between them, so the older answer can land last and win.
          if (cancelled || generation !== latest) return;
          setState({ status: 'ready', repositories: connected.repositories });
        })
        .catch(() => {
          if (cancelled || generation !== latest) return;
          // A daemon that is not ready yet rejects this the same way it rejects
          // `pipenzoListTickets` -- keep showing the last good list rather than replacing a real
          // switcher with an error state over a transient daemon restart.
          setState((current) => (current.status === 'ready' ? current : { status: 'error' }));
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

  return { repoList: state, refresh };
}
