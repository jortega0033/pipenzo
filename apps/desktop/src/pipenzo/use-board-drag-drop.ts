import { useCallback, useEffect, useState } from 'react';
import type { PipenzoLaneV1, PipenzoTicketViewV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { LANE_DRAG_LABEL } from './board-lanes.js';

/**
 * Board drag-and-drop's optimistic move (issue #82): a card moves the instant it is dropped, the
 * real `pipenzo:` label write happens in the background through the same `pipenzoTicketTransition`
 * bridge call `use-pipenzo-tickets.ts`'s own poll already reconciles against, and this hook's only
 * job is to keep the board honest in the gap between those two moments.
 *
 * ## Why this holds its own state instead of mutating `tickets` in place
 *
 * `tickets` is `usePipenzoTickets`'s own list -- this hook never owns it, it only overlays a
 * per-ticket *guess* on top for however long the guess is still useful. That is what makes "reconcile
 * against next poll" a property of this hook rather than a race two owners of the same state would
 * have to coordinate: the guess is discarded automatically (see the effect below), never asserted
 * as truth.
 *
 * ## Label-wins, twice
 *
 * README's precedence rule shows up here in two places, both deferring to GitHub rather than to what
 * the drag asked for:
 *
 * 1. The transition response itself may report a different lane than the drag asked for -- a
 *    concurrent label change can race the write -- and the guess is corrected to *that* lane, not
 *    silently kept as what was asked. The daemon's own transition route (`pipenzo-tickets.ts`)
 *    already writes this divergence to the audit store; this hook does not need to know that
 *    happened; it only needs to stop showing a lane GitHub disagrees with.
 * 2. Independently, whenever `tickets` itself next reports this ticket's lane as anything other
 *    than what it was *before* the drag, the poll has caught up and the guess is dropped in favour
 *    of whatever the poll says -- whether or not that matches the guess. This is the "next poll"
 *    reconciliation the issue asks for, and it is what makes (1) not load-bearing on its own: even if
 *    a response is lost or never distinguishes a divergence, the next real poll still wins.
 *
 * ## A refusal snaps back immediately, not on the next poll
 *
 * A transition the daemon rejects (an illegal lane transition, a daemon that is not reachable) never
 * wrote anything -- there is nothing for a future poll to reconcile against, so waiting for one would
 * leave the board lying about a move that never happened. The guess is cleared the moment the
 * rejection is known, and `onTransitionFailed` is the caller's hook for surfacing it (a toast, in
 * `AppRoot.tsx` — see that file's own `onImplementFailed` for the identical shape).
 */
export function useBoardDragDrop(
  tickets: readonly PipenzoTicketViewV1[],
  onTransitionFailed?: (ticket: PipenzoTicketViewV1, message: string) => void,
): {
  tickets: readonly PipenzoTicketViewV1[];
  onCardDrop: (ticket: PipenzoTicketViewV1, targetLane: PipenzoLaneV1) => void;
} {
  const [pending, setPending] = useState<
    ReadonlyMap<string, { previousLane: PipenzoLaneV1; targetLane: PipenzoLaneV1 }>
  >(new Map());

  // "Reconcile against next poll": once a fresher `tickets` array actually shows this ticket's lane
  // having moved off what it held *before* the drag, the poll has caught up and the guess has done
  // its job — dropped whether or not it agrees with the poll, because from here on the poll is the
  // one source of truth. A ticket that drops out of the list entirely (closed, repo disconnected)
  // is treated the same way: nothing left to keep guessing about.
  useEffect(() => {
    setPending((current) => {
      if (current.size === 0) return current;
      let changed = false;
      const next = new Map(current);
      for (const [ticketId, move] of current) {
        const fresh = tickets.find((ticket) => ticket.ticketId === ticketId);
        if (!fresh || fresh.lane !== move.previousLane) {
          next.delete(ticketId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [tickets]);

  const onCardDrop = useCallback(
    (ticket: PipenzoTicketViewV1, targetLane: PipenzoLaneV1) => {
      const previousLane = ticket.lane;
      // Moves the card before the network call even starts — the optimism the issue asks for.
      setPending((current) => new Map(current).set(ticket.ticketId, { previousLane, targetLane }));

      void getBridge()
        .pipenzoTicketTransition({ ticketId: ticket.ticketId, label: LANE_DRAG_LABEL[targetLane] })
        .then((result) => {
          setPending((current) => {
            // A poll already reconciled this ticket while the request was in flight — nothing to
            // correct, and re-adding it here would resurrect a guess the effect above just retired.
            if (!current.has(ticket.ticketId)) return current;
            return new Map(current).set(ticket.ticketId, {
              previousLane,
              // The label wins: shown lane follows what GitHub actually reported, not what was asked.
              targetLane: result.ticket.lane,
            });
          });
        })
        .catch((error: unknown) => {
          // The daemon refused the move (an illegal transition) or could not be reached — nothing
          // was written, so there is nothing to wait on a poll for. Snap back now.
          setPending((current) => {
            if (!current.has(ticket.ticketId)) return current;
            const next = new Map(current);
            next.delete(ticket.ticketId);
            return next;
          });
          onTransitionFailed?.(
            ticket,
            error instanceof Error ? error.message : 'the daemon refused the move',
          );
        });
    },
    [onTransitionFailed],
  );

  const ticketsWithOptimism =
    pending.size === 0
      ? tickets
      : tickets.map((ticket) => {
          const move = pending.get(ticket.ticketId);
          return move && move.targetLane !== ticket.lane ? { ...ticket, lane: move.targetLane } : ticket;
        });

  return { tickets: ticketsWithOptimism, onCardDrop };
}
