import { Fragment, type ReactNode } from 'react';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import {
  Board,
  Lane,
  LaneCards,
  LaneCount,
  LaneHead,
  LaneTitle,
} from '../components/primitives/Lane.js';
import { Empty } from '../components/primitives/Empty.js';
import { BOARD_LANES, ticketsByLane } from './board-lanes.js';

/**
 * The Board screen's own content (issue #81): `Main.dc.html`'s `.board` grid of four lanes, with
 * lane heads (dot + title + count) and a scrolling well per lane, wired to the label set through
 * `board-lanes.ts`'s `BOARD_LANES` rather than a second mapping guessed at here.
 *
 * Slots into `AppShell`'s `.main`, under its own `MainHead` — neither is built here, for the same
 * reason `SettingsPage.tsx` builds neither: the nav that mounts a screen and the header above it
 * belong to the shell-wiring ticket, not to the screen itself. That ticket does not exist yet
 * either — `Board` is production code ready to be dropped in, the same position `SettingsPage` has
 * sat in since #125.
 *
 * ## What a ticket looks like is deliberately not this file's decision
 *
 * `renderTicket` is required rather than defaulted, because guessing at card content here would be
 * exactly the frame-guessing `SettingsPage.tsx`'s own doc comment warns against: #85 (Working
 * lane's capacity pill and held cards), #86 (Needs-human's seven variants) and #87
 * (Ready-for-review plus the ci-failed card) each own a real card body, and a placeholder built
 * here would be a card body this file guessed wrong on all three fronts before any of them land.
 *
 * ## Where `tickets` comes from is a known gap, not an oversight
 *
 * There is no route yet that hands the desktop a board's worth of tickets —
 * `apps/daemon/src/routes/pipenzo-tickets.ts` says so directly, and building one was out of scope
 * for #81 (see the PR). `tickets` defaults to empty so every lane renders its own `Empty` "run
 * dry" state until a caller has something real to pass, exactly like a freshly connected repo with
 * no tickets yet would.
 */
export function BoardScreen({
  tickets = [],
  renderTicket,
}: {
  tickets?: readonly PipenzoTicketViewV1[];
  renderTicket: (ticket: PipenzoTicketViewV1) => ReactNode;
}) {
  const grouped = ticketsByLane(tickets);

  return (
    <Board>
      {BOARD_LANES.map((laneConfig) => {
        const laneTickets = grouped[laneConfig.lane];
        return (
          <Lane key={laneConfig.lane}>
            <LaneHead>
              <LaneTitle dotColor={laneConfig.dotColor}>{laneConfig.title}</LaneTitle>
              <LaneCount>{laneTickets.length}</LaneCount>
            </LaneHead>
            <LaneCards>
              {laneTickets.length === 0 ? (
                <Empty variant="lane" title={laneConfig.emptyTitle}>
                  {laneConfig.emptySub}
                </Empty>
              ) : (
                laneTickets.map((ticket) => (
                  <Fragment key={ticket.ticketId}>{renderTicket(ticket)}</Fragment>
                ))
              )}
            </LaneCards>
          </Lane>
        );
      })}
    </Board>
  );
}
