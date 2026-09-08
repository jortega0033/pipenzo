import { PIPENZO_LANES, type PipenzoLaneV1 } from '@agent-dock/shared';

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
