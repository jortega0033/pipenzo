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
 *
 * ## The first-run hero (issue #78)
 *
 * `hasConnectedRepos` is a separate signal from `tickets` being empty, and the distinction is the
 * whole point: an established install between polls, or a connected repo with a genuinely clean
 * backlog, has an empty `tickets` array too, and that is four *lane*-level `Empty`s -- "run dry" is
 * the goal state for Needs-human and a normal Tuesday for Queued. First run is different: there is
 * nothing to poll yet because nothing is connected, and `Main.dc.html`'s own note is that this is
 * why every lane goes empty *at once*. `hasConnectedRepos` defaults to `true` so every existing
 * caller (and every earlier test) keeps getting the four-lane board unchanged; a caller that has
 * genuinely read zero connected repos (not "unknown", not "still loading" -- see
 * `use-connected-repos.ts`'s three-state `ConnectedRepoState`) passes `false`.
 *
 * `onConnectRepo`/`onNewFromIdea` are optional callbacks, not built-in navigation, for the same
 * reason `renderTicket` is a required prop instead of a guess: this file does not own the repo
 * picker (#115) or `NewFromIdeaDialog.tsx` (#84, itself still without a real mount point), only the
 * board's own content. Whoever mounts `BoardScreen` for real wires both to the real screens, the
 * same deferral `renderTicket` already established.
 */
export function BoardScreen({
  tickets = [],
  hasConnectedRepos = true,
  renderTicket,
  onConnectRepo,
  onNewFromIdea,
}: {
  tickets?: readonly PipenzoTicketViewV1[];
  /** `false` only once a caller has actually confirmed zero repos are connected -- never a guess
   * made from an empty `tickets` array, which means something different (see this file's own
   * "first-run hero" doc section). */
  hasConnectedRepos?: boolean;
  renderTicket: (ticket: PipenzoTicketViewV1) => ReactNode;
  /** "Connect a repo", the hero's primary action. Routes to the repo picker (#115). */
  onConnectRepo?: () => void;
  /** "New from idea", the hero's secondary action. Opens `NewFromIdeaDialog` (#84). */
  onNewFromIdea?: () => void;
}) {
  if (!hasConnectedRepos) {
    return (
      <Empty
        icon="board"
        title="No repo connected yet"
        actions={[
          ...(onConnectRepo
            ? [{ label: 'Connect a repo', icon: 'git-pull-request' as const, onClick: onConnectRepo }]
            : []),
          ...(onNewFromIdea
            ? [{ label: 'New from idea', icon: 'idea' as const, onClick: onNewFromIdea }]
            : []),
        ]}
      >
        Connect a repo and pipenzo reads its open issues into Queued. Nothing starts on connect —
        every ticket still needs an explicit Implement, and nothing is ever pushed without you. No
        issue for the thing you have in mind? Describe it and pipenzo drafts one.
      </Empty>
    );
  }

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
