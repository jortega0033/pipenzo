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

/**
 * How long a live phase event waits for its siblings before triggering a refetch (issue #255
 * finding 2).
 *
 * The reconciler's own `#pollAll()` (`pipenzo-reconciler.ts`) walks every connected ticket in one
 * tick and announces each one that changed lane or labels -- a bulk relabel on GitHub, or the
 * reconciler catching up after downtime, can fan out into a burst of N near-simultaneous events for
 * a single logical moment. Refetching the whole board once per event in that burst would multiply
 * one tick into N full `GET /v2/pipenzo/tickets` calls against a route rate-limited to 60/min, and
 * would still only be re-deriving what the first event in the burst already implied. A trailing
 * debounce collapses the burst into exactly one `read()` once it quiets down, the same way the
 * reconciler's own backoff and the SSE writer's queue bounds treat bursts elsewhere in this
 * codebase.
 */
const PHASE_EVENT_DEBOUNCE_MS = 300;

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
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

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

    // Debounced, not immediate: see `PHASE_EVENT_DEBOUNCE_MS` above for why a burst of events must
    // collapse into a single refetch rather than one per event.
    const debouncedRead = (): void => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        read();
      }, PHASE_EVENT_DEBOUNCE_MS);
    };

    read();
    const unsubscribeStatus = getBridge().onDaemonStatus((status) => {
      if (status.state === 'ready') read();
    });
    // Live lane moves (issue #189) should reach the board without waiting for a manual refresh.
    // `pipenzo-phase-machine.ts`'s `read()` keeps a ticket's cached title in sync on every
    // reconciling read too, so re-fetching the whole list on each event picks up both the lane move
    // and whatever title changed alongside it -- there is no separate title-only push channel.
    const unsubscribeEvents = getBridge().onPipenzoPhaseEvent(() => debouncedRead());

    return () => {
      cancelled = true;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      unsubscribeStatus();
      unsubscribeEvents();
    };
  }, [revision]);

  return { ticketList: state, refresh };
}
