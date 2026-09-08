import { useCallback, useEffect, useState } from 'react';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';

/**
 * The board's ticket list (issue #255), exposed to a screen the same shape
 * `use-connected-repos.ts` exposes the connected-repos count in.
 *
 * `'loading'` is the answer until the first read settles, exactly once, on mount — there is no
 * three-state "unknown vs not-tracked" split here the way `useConnectedRepos` needs one, because
 * nothing downstream of this hook routes a pre-app gate on the answer; `BoardScreen` already has an
 * `Empty` state for "zero tickets" and does not need to tell that apart from "still loading" the
 * way the gate has to tell "zero repos" apart from "no answer yet".
 *
 * `'error'` is reported rather than silently falling back to an empty list, because an empty list
 * and "the daemon refused this call" render as the same board otherwise -- a caller that wants to
 * distinguish "no tickets" from "could not ask" needs the state to say so.
 */
export type PipenzoTicketListState =
  | { status: 'loading' }
  | { status: 'ready'; tickets: readonly PipenzoTicketViewV1[] }
  | { status: 'error' };

export function usePipenzoTickets(): {
  ticketList: PipenzoTicketListState;
  refresh: () => void;
} {
  const [state, setState] = useState<PipenzoTicketListState>({ status: 'loading' });
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
        .pipenzoListTickets()
        .then((list) => {
          // The same generation guard `useConnectedRepos`/`useGitHubConnection` carry: two reads can
          // overlap when a phase event or a `ready` status arrives before the first settles, and
          // promises have no ordering between them, so the older answer can land last and win.
          if (cancelled || generation !== latest) return;
          setState({ status: 'ready', tickets: list.tickets });
        })
        .catch(() => {
          if (cancelled || generation !== latest) return;
          // A daemon that is not ready yet rejects this the same way it rejects
          // `pipenzoConnectedRepos` -- keep showing the last good list rather than replacing a real
          // board with an error screen over a transient daemon restart.
          setState((current) => (current.status === 'ready' ? current : { status: 'error' }));
        });
    };

    read();
    const unsubscribeStatus = getBridge().onDaemonStatus((status) => {
      if (status.state === 'ready') read();
    });
    // Live lane moves (issue #189) should reach the board without waiting for a manual refresh.
    // `pipenzo-phase-machine.ts`'s `read()` keeps a ticket's cached title in sync on every
    // reconciling read too, so re-fetching the whole list on each event picks up both the lane move
    // and whatever title changed alongside it -- there is no separate title-only push channel.
    const unsubscribeEvents = getBridge().onPipenzoPhaseEvent(() => read());

    return () => {
      cancelled = true;
      unsubscribeStatus();
      unsubscribeEvents();
    };
  }, [revision]);

  return { ticketList: state, refresh };
}
