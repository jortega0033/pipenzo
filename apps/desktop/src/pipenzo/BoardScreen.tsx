import { Fragment, useCallback, useMemo, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { PipenzoLaneV1, PipenzoTicketViewV1 } from '@agent-dock/shared';
import {
  Board,
  Lane,
  LaneCards,
  LaneCount,
  LaneHead,
  LaneHeadRight,
  LaneTitle,
} from '../components/primitives/Lane.js';
import { LaneCap } from '../components/primitives/LaneCap.js';
import { Empty } from '../components/primitives/Empty.js';
import { SkeletonBoard } from '../components/primitives/Skeleton.js';
import { BOARD_LANES, resolveBoardCardDrop, ticketsByLane } from './board-lanes.js';

/**
 * A lane's `.lane-cards` well, made into a dnd-kit drop target (issue #82). `BoardScreen`'s own
 * "structural only" lanes (`Lane.tsx`'s own doc comment) still render exactly the same markup —
 * this only adds the ref `useDroppable` needs and a class while a drag is hovering, both additive
 * to `LaneCards`' existing contract (see that component's own doc comment on why `ref`/`className`
 * are safe to add there).
 */
function DroppableLaneCards({ lane, children }: { lane: PipenzoLaneV1; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: lane });
  return (
    <LaneCards ref={setNodeRef} className={isOver ? 'drop-active' : undefined}>
      {children}
    </LaneCards>
  );
}

/**
 * One ticket card, made draggable (issue #82). Wraps whatever `renderTicket` returns rather than
 * reaching into `Card.tsx` — that component is owned by #85/#86/#87's own card bodies, not this
 * ticket, and `useDraggable`'s ref/listeners/attributes attach just as well to a wrapper as to the
 * card's own root.
 *
 * `PointerSensor`'s own activation distance (`sensors` below) is what keeps `Card`'s existing
 * `onClick` (open the ticket, or open Implement) working normally for a plain click — a drag only
 * starts once the pointer has actually moved, so a click's own listeners never see a captured
 * pointer they didn't ask for.
 *
 * `attributes` overrides `useDraggable`'s own default `role="button"`/`tabIndex=0` -- `Card.tsx`
 * already renders exactly that (`role={onClick ? 'button' : undefined}`, `tabIndex={0}`) on its own
 * root whenever it takes an `onClick`, which every card `renderTicket` produces does. Leaving dnd-
 * kit's defaults in place would nest one ARIA button-role element inside another, and put two
 * separate tab stops (and two separate Enter/Space handlers -- Card's own `onClick`, dnd-kit's own
 * drag-start) on what is visually one card; `screen.getByRole('button', ...)` in every screen that
 * clicks a card (this repo's own test suite included) would then match two elements instead of one.
 * `role: 'group'`/`tabIndex: -1` make this wrapper a plain, non-interactive grouping node instead —
 * pointer dragging (this ticket's own ask) is unaffected, since `listeners` still carries the
 * pointer activators regardless of `attributes`; the one real cost is that a keyboard user tabbing
 * through the board lands on `Card`'s own tab stop, not this wrapper's, so `KeyboardSensor`'s drag
 * activation is reachable by dispatching a key event at this node directly (as this file's own test
 * does) but not yet by a plain Tab press -- a follow-up, not a regression this ticket introduces.
 */
function DraggableTicketCard({ ticket, children }: { ticket: PipenzoTicketViewV1; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.ticketId,
    attributes: { role: 'group', roleDescription: 'draggable ticket card', tabIndex: -1 },
  });
  return (
    <div
      ref={setNodeRef}
      className={isDragging ? 'dragging' : undefined}
      style={transform ? { transform: CSS.Translate.toString(transform) } : undefined}
      {...listeners}
      {...attributes}
    >
      {children}
    </div>
  );
}

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
 * exactly the frame-guessing `SettingsPage.tsx`'s own doc comment warns against: #86 (Needs-human's
 * seven variants) and #87 (Ready-for-review plus the ci-failed card) each own a real card body, and
 * a placeholder built here would be a card body this file guessed wrong on both fronts before
 * either lands. Working's own held-card body is #85's too, and lands the same way (in whatever
 * `renderTicket` a caller supplies) -- but #85's *lane-header* capacity pill is structural to this
 * file's own `.lane-head`, the same way `LaneCount` already is, so it is built here; see
 * `workingLaneCapacity` below.
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
 *
 * ## The cold-start skeleton is a third signal, not a guess made from an empty `tickets` array (issue #67)
 *
 * `loading` takes the same precedence `hasConnectedRepos` already does over `tickets` being empty,
 * and for the identical reason: an empty `tickets` array means three different things
 * (`usePipenzoTickets`'s own `'loading'` status, a genuinely clean backlog, and -- above -- no repo
 * connected yet), and a caller that has actually confirmed which one it is should never have to
 * fake an empty list to say so. `SkeletonBoard` (`Skeleton.tsx`, ported from `Foundations.dc.html`
 * and unused anywhere until now) is built from `BOARD_LANES` the same way the real board below is --
 * real lane names and dots, since the label set already fixes those before any poll returns, with
 * only the count and the cards themselves standing in as placeholders.
 */
export function BoardScreen({
  tickets = [],
  hasConnectedRepos = true,
  loading = false,
  workingLaneCapacity,
  renderTicket,
  onConnectRepo,
  onNewFromIdea,
  onCardDrop,
}: {
  tickets?: readonly PipenzoTicketViewV1[];
  /** `false` only once a caller has actually confirmed zero repos are connected -- never a guess
   * made from an empty `tickets` array, which means something different (see this file's own
   * "first-run hero" doc section). */
  hasConnectedRepos?: boolean;
  /** True only for the board's one cold-start moment: the first ticket-list poll of the session has
   * not returned yet. Never inferred from `tickets` being empty -- see this file's own doc section
   * on why that would collide with a genuinely clean backlog. */
  loading?: boolean;
  /** The Working lane header's capacity pill denominator (issue #85), straight off
   * `GET /v2/pipenzo/tickets`' own `workingLaneCapacity` (`use-pipenzo-tickets.ts`). Undefined until
   * the first ticket-list read settles, or for any caller (a test, an older cached response) that
   * predates the field -- the pill simply does not render rather than guessing a number, the same
   * "not yet answered" reasoning `title`'s own optionality already uses. */
  workingLaneCapacity?: number;
  renderTicket: (ticket: PipenzoTicketViewV1) => ReactNode;
  /** "Connect a repo", the hero's primary action. Routes to the repo picker (#115). */
  onConnectRepo?: () => void;
  /** "New from idea", the hero's secondary action. Opens `NewFromIdeaDialog` (#84). */
  onNewFromIdea?: () => void;
  /**
   * A card was dropped on a different lane than it started in (issue #82). Optional, the same way
   * `onConnectRepo`/`onNewFromIdea` are: this file owns the drag gesture (`resolveBoardCardDrop`
   * turns it into "this ticket, this lane"), not what happens next -- the optimistic move, the real
   * `pipenzoTicketTransition` call, and reconciling against the next poll are
   * `use-board-drag-drop.ts`'s job, wired in by whoever mounts this screen for real
   * (`PipenzoAppShell.tsx`), the same deferral `renderTicket` already established. A board with no
   * handler still drags and drops visually; it just moves nothing.
   */
  onCardDrop?: (ticket: PipenzoTicketViewV1, targetLane: PipenzoLaneV1) => void;
}) {
  // Issue #82. `PointerSensor`'s distance constraint is what keeps a plain click on a card (open
  // the ticket, or open Implement) working unchanged -- a drag does not start, and the pointer is
  // not captured, until it has actually moved past that threshold. `KeyboardSensor` needs no
  // constraint of its own: it only activates on its own key (Space/Enter on a focused card), never
  // on an arbitrary keypress a click could produce.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const overLane = event.over ? (event.over.id as PipenzoLaneV1) : undefined;
      const resolved = resolveBoardCardDrop(tickets, String(event.active.id), overLane);
      if (resolved) onCardDrop?.(resolved.ticket, resolved.targetLane);
    },
    [tickets, onCardDrop],
  );
  // Computed here, ahead of the early returns below, because `useMemo` -- like every other hook in
  // this component -- has to run on every render regardless of which branch below ends up used.
  const grouped = useMemo(() => ticketsByLane(tickets), [tickets]);

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

  if (loading) {
    return (
      <SkeletonBoard
        lanes={BOARD_LANES.map((laneConfig) => ({
          name: laneConfig.title,
          dotColor: laneConfig.dotColor,
        }))}
      />
    );
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <Board>
        {BOARD_LANES.map((laneConfig) => {
          const laneTickets = grouped[laneConfig.lane];
          // Issue #85: the Working lane's own capacity pill. `running` excludes anything the
          // ticket-list route already reported `held` (a ticket the file-overlap gate serialised
          // against another Working ticket) -- see `working-lane-concurrency.ts` for who computes
          // `concurrency` and why a ticket the route hasn't evaluated (any non-Working ticket) never
          // carries the field at all.
          const capacity = laneConfig.lane === 'working' ? workingLaneCapacity : undefined;
          const runningCount =
            laneConfig.lane === 'working'
              ? laneTickets.filter((ticket) => ticket.concurrency?.state !== 'held').length
              : 0;
          return (
            <Lane key={laneConfig.lane}>
              <LaneHead>
                <LaneTitle dotColor={laneConfig.dotColor}>{laneConfig.title}</LaneTitle>
                {capacity !== undefined ? (
                  <LaneHeadRight>
                    <LaneCap kind={runningCount >= capacity ? 'full' : 'running'}>
                      {runningCount} of {capacity} running
                    </LaneCap>
                    <LaneCount>{laneTickets.length}</LaneCount>
                  </LaneHeadRight>
                ) : (
                  <LaneCount>{laneTickets.length}</LaneCount>
                )}
              </LaneHead>
              <DroppableLaneCards lane={laneConfig.lane}>
                {laneTickets.length === 0 ? (
                  <Empty variant="lane" title={laneConfig.emptyTitle}>
                    {laneConfig.emptySub}
                  </Empty>
                ) : (
                  laneTickets.map((ticket) => (
                    <Fragment key={ticket.ticketId}>
                      <DraggableTicketCard ticket={ticket}>
                        {renderTicket(ticket)}
                      </DraggableTicketCard>
                    </Fragment>
                  ))
                )}
              </DroppableLaneCards>
            </Lane>
          );
        })}
      </Board>
    </DndContext>
  );
}
