import { PIPENZO_LANES, type PipenzoLabelV1, type PipenzoLaneV1 } from '@agent-dock/shared';

/**
 * The board's lane list and its presentation (issue #81). `BOARD_LANES` is built on
 * `PIPENZO_LANES` — the same lane order the daemon's phase machine already resolves against via
 * `PIPENZO_LABEL_LANES`, verified in this file's test rather than re-imported here.
 *
 * ## Why this file defines no lane <-> label mapping of its own
 *
 * `@agent-dock/shared`'s `PIPENZO_LANES` (`packages/shared/src/pipenzo-ticket-v1.ts`) is already
 * README's own four-lane list, and `PIPENZO_LABEL_LANES` next to it is the static label-to-lane
 * table the daemon's phase machine (`apps/daemon/src/pipenzo-phase-machine.ts`) uses to decide
 * which lane a ticket's `pipenzo:` labels put it in — five different labels collapsing onto
 * Needs-human, `pipenzo:ci-failed`'s lane-vs-condition split, and the whole label-wins
 * reconciliation this module has no business re-deriving. A second table here repeating any of
 * that would be exactly the drift #81 asks this module to prevent: two places free to disagree the
 * moment either one is edited, and README's own table is the loser. `BOARD_LANES` below only adds
 * what the shared contract has no reason to carry — display order, header text, dot tone and the
 * per-lane empty-state copy — layered on the lane the reconciled ticket record already names.
 *
 * `PIPENZO_LANES`' own order (`queued`, `working`, `ready-for-review`, `needs-human`) already
 * matches `Main.dc.html`'s left-to-right column order, so `BOARD_LANES` inherits it instead of
 * re-stating it — a fifth lane added to the shared contract shows up here in the right place with
 * no reordering step to remember.
 */

export interface BoardLaneConfig {
  readonly lane: PipenzoLaneV1;
  /** The `.lane-title` text, verbatim from `Main.dc.html`'s Board screen. */
  readonly title: string;
  /** The `.lane-dot` fill — one of the design system's semantic CSS custom properties. */
  readonly dotColor: string;
  /** `Empty`'s `lane`-variant `title` when this lane has nothing in it. */
  readonly emptyTitle: string;
  /** `Empty`'s `lane`-variant sub line. Says why, not sorry — `Foundations.dc.html`'s own rule for
   * this state, and doubly true for Needs-human: an empty one is the goal, not a gap. */
  readonly emptySub: string;
}

const BOARD_LANE_TITLES: Readonly<Record<PipenzoLaneV1, string>> = Object.freeze({
  queued: 'Queued',
  working: 'Working',
  'ready-for-review': 'Ready for review',
  'needs-human': 'Needs human',
});

const BOARD_LANE_DOT_COLORS: Readonly<Record<PipenzoLaneV1, string>> = Object.freeze({
  queued: 'var(--color-text-faint)',
  working: 'var(--color-warn)',
  'ready-for-review': 'var(--color-ok)',
  'needs-human': 'var(--color-danger)',
});

const BOARD_LANE_EMPTY_TITLES: Readonly<Record<PipenzoLaneV1, string>> = Object.freeze({
  queued: 'Nothing queued',
  working: 'Nothing running',
  'ready-for-review': 'Nothing to review',
  'needs-human': 'Nothing needs you',
});

const BOARD_LANE_EMPTY_SUBS: Readonly<Record<PipenzoLaneV1, string>> = Object.freeze({
  queued: "Open issues from your connected repos land here once there's something to work.",
  working: 'Queued tickets start here the moment you hit Implement.',
  'ready-for-review': 'Finished work waiting on a decision shows up here.',
  'needs-human': 'A quiet Needs-human lane is the goal state, not a gap.',
});

/** The board's four lanes, in display order — `PIPENZO_LANES`' own order, which already matches
 * the canvas. The single source of truth for "what lanes exist and in what order"; nothing else in
 * the desktop app should list lanes independently. */
export const BOARD_LANES: readonly BoardLaneConfig[] = PIPENZO_LANES.map((lane) => ({
  lane,
  title: BOARD_LANE_TITLES[lane],
  dotColor: BOARD_LANE_DOT_COLORS[lane],
  emptyTitle: BOARD_LANE_EMPTY_TITLES[lane],
  emptySub: BOARD_LANE_EMPTY_SUBS[lane],
}));

/**
 * Groups tickets by the lane each one's own `lane` field already names.
 *
 * Generic over `T` rather than pinned to `PipenzoTicketViewV1` so a caller can group a lighter
 * shape (a test fixture, a future summary type) without importing the full wire contract. Never
 * re-derives a lane from labels — that reconciliation already happened, once, in the phase
 * machine's `read()`; a ticket handed to this function is trusted to already carry the lane it
 * belongs in.
 */
export function ticketsByLane<T extends { readonly lane: PipenzoLaneV1 }>(
  tickets: readonly T[],
): Readonly<Record<PipenzoLaneV1, readonly T[]>> {
  const grouped: Record<PipenzoLaneV1, T[]> = {
    queued: [],
    working: [],
    'ready-for-review': [],
    'needs-human': [],
  };
  for (const ticket of tickets) grouped[ticket.lane].push(ticket);
  return grouped;
}

/**
 * Board drag-and-drop (issue #82): the one `pipenzo:` label a manual drag onto a lane writes.
 *
 * This is deliberately *not* a second copy of `PIPENZO_LABEL_LANES` -- that table answers "which
 * lane does this label put a ticket in," a many(label)-to-one(lane) map the phase machine owns and
 * this module already refuses to re-derive (see the module comment above). This answers a different
 * question `PIPENZO_LABEL_LANES` cannot: dropped a card on *this* lane, which single label should a
 * human's drag write? That question only has one honest answer for three of the four lanes
 * (`pipenzo:queued`, `pipenzo:working`, `pipenzo:ready-for-review` are each the only state label
 * their lane has), but Needs-human has five (`needs-human`, `needs-pre-scoping`,
 * `awaiting-stack-approval`, `ci-failed`, `interrupted`) -- and a drag is not automation reporting
 * *why* it stopped, it is a person saying "look at this." `pipenzo:needs-human` is README's own
 * generic "a human flagged this" label, the one member of that set that carries no claim about
 * which specific automated condition applies, which is exactly what a manual drag can honestly
 * assert and nothing more.
 *
 * The daemon's `isLegalLaneTransition` still gets the final word -- this map only decides *what to
 * ask for*, never *whether the ask is legal*; see `use-board-drag-drop.ts` for why this module does
 * not also duplicate that legality table to pre-filter drop targets client-side.
 */
export const LANE_DRAG_LABEL: Readonly<Record<PipenzoLaneV1, PipenzoLabelV1>> = Object.freeze({
  queued: 'pipenzo:queued',
  working: 'pipenzo:working',
  'ready-for-review': 'pipenzo:ready-for-review',
  'needs-human': 'pipenzo:needs-human',
});

/**
 * Turns a dnd-kit drag gesture into "move this ticket to this lane," or `undefined` when there is
 * nothing to do -- a pure function so `BoardScreen.tsx`'s own `onDragEnd` has no branching logic of
 * its own to get wrong, and so this ticket's test suite can exercise every case without simulating a
 * real pointer/keyboard drag (see that file's own test for why dnd-kit's own gesture-to-event
 * translation is trusted rather than re-proven here).
 *
 * `undefined` covers three cases a caller should silently no-op on: the drag ended outside any
 * droppable lane (`overLane` absent), the ticket named by `activeTicketId` is not one this board
 * currently knows about (a stale drag that outlived a list refresh), or the card was dropped back on
 * the lane it already occupies (nothing to transition).
 */
export function resolveBoardCardDrop<T extends { readonly ticketId: string; readonly lane: PipenzoLaneV1 }>(
  tickets: readonly T[],
  activeTicketId: string,
  overLane: PipenzoLaneV1 | undefined,
): { ticket: T; targetLane: PipenzoLaneV1 } | undefined {
  if (!overLane) return undefined;
  const ticket = tickets.find((candidate) => candidate.ticketId === activeTicketId);
  if (!ticket || ticket.lane === overLane) return undefined;
  return { ticket, targetLane: overLane };
}
