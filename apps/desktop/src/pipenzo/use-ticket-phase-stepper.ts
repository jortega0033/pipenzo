import { useCallback, useEffect, useState } from 'react';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';

/**
 * A single ticket's live phase-machine state (issue #91), the per-ticket counterpart to
 * `use-pipenzo-tickets.ts`'s board-wide list. `window.d.ts`'s own doc comment on the phase-event
 * stream says the shape this hook follows directly: "a single-ticket view filters on `ticketId`
 * rather than opening its own connection" -- the daemon serves one phase-change stream for the
 * whole board, and per-ticket screens subscribe to that same stream and ignore events for any other
 * ticket, rather than the desktop opening a second SSE connection per open ticket.
 *
 * `pipenzoTicketRead` (not the cheaper `pipenzoListTickets`) is the right call here: the same
 * `window.d.ts` comment on `pipenzoListTickets` says a caller "that needs one ticket reconciled
 * right now still wants `pipenzoTicketRead`", which is exactly a ticket-detail screen's job.
 *
 * Issue #68 ("Ticket-detail stream replay loading") -- a richer loading state that also replays the
 * activity stream -- has not landed yet (still open at the time this hook was written), so this
 * follows `use-pipenzo-tickets.ts`'s existing loading/ready/error shape rather than that not-yet-
 * real one.
 */
export type TicketPhaseState =
  | { status: 'loading' }
  | { status: 'ready'; ticket: PipenzoTicketViewV1 }
  | { status: 'error' };

/** Same burst-collapsing reasoning as `use-pipenzo-tickets.ts`'s `PHASE_EVENT_DEBOUNCE_MS`: a
 * reconciler tick can announce several tickets at once, and only one of them is this screen's. */
const PHASE_EVENT_DEBOUNCE_MS = 300;

export function useTicketPhaseStepper(ticketId: string): {
  state: TicketPhaseState;
  refresh: () => void;
} {
  const [state, setState] = useState<TicketPhaseState>({ status: 'loading' });
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
        .pipenzoTicketRead({ ticketId })
        .then((reconciliation) => {
          // Same stale-response guard `use-pipenzo-tickets.ts` carries: two reads can overlap when
          // a phase event arrives before the first settles, and the older answer can land last.
          if (cancelled || generation !== latest) return;
          setState({ status: 'ready', ticket: reconciliation.ticket });
        })
        .catch(() => {
          if (cancelled || generation !== latest) return;
          setState((current) => (current.status === 'ready' ? current : { status: 'error' }));
        });
    };

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
    // Live phase changes (issue #189): the board-wide stream, filtered to this ticket -- see this
    // module's own doc comment for why that is the right subscription rather than a second stream.
    const unsubscribeEvents = getBridge().onPipenzoPhaseEvent((event) => {
      if (event.ticketId === ticketId) debouncedRead();
    });

    return () => {
      cancelled = true;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      unsubscribeStatus();
      unsubscribeEvents();
    };
  }, [ticketId, revision]);

  return { state, refresh };
}
