import { Fragment, useEffect, type ReactNode } from 'react';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Banner } from '../components/primitives/Banner.js';
import { Empty } from '../components/primitives/Empty.js';
import {
  groupActivityEntriesByDay,
  toActivityFeed,
  type ActivityRowEntry,
} from './activity-grouping.js';

/**
 * The Activity screen's own content (issue #116, split off epic #3): `Activity.dc.html`'s reverse-
 * chronological, day-grouped read of the *whole* ticket store -- every ticket the store has ever
 * seen, not just the ones still occupying a board lane.
 *
 * This is the shell only, the same division `BoardScreen.tsx` drew for its own screen: the container,
 * the data (already unfiltered -- see `activity-grouping.ts`'s own doc comment for why
 * `usePipenzoTickets` is the right source here with no new route needed), the day-grouping, and the
 * explainer banner. Two sibling tickets plug into the slots below rather than this file guessing at
 * either:
 *
 * - **#117, filter tabs** — `Activity.dc.html`'s `.seg` (All / Publishes / Gates / Risk / Worktrees)
 *   needs to own which key is active and how a ticket maps to a group, neither of which this shell
 *   can answer today (a ticket doesn't carry a single "kind" the way the canvas's mocked *events* do
 *   -- see `activity-grouping.ts`). `filterBar` is an optional slot for that finished control; this
 *   shell renders whatever `tickets` it is handed, unfiltered, exactly like `BoardScreen` renders
 *   whatever `tickets` it is handed unsorted-by-lane.
 * - **#118, the row renderer** — the canvas's `.act` row (time, kind icon, id, title, a status chip,
 *   a detail line, meta) reads fields no `PipenzoTicketViewV1` exposes today (icon/chip/detail are
 *   per-*event* -- a risk crossing, a merge, a gate result -- derived from `attempts[]`/
 *   `precommits[]`/`risk`, which #118 owns). `renderEntry` is required, not defaulted, for the same
 *   reason `BoardScreen`'s `renderTicket` is: a placeholder row built here would be a design #118
 *   gets to guess wrong before it exists.
 *
 * ## The "I've looked" reset (issue #119)
 *
 * `risk-score.ts`'s asymmetric reset rule names exactly two events that zero a ticket's cumulative
 * risk score: a HIGH approval, or opening the ticket's Activity view. This screen is that view --
 * the unfiltered, every-ticket trail `Activity.dc.html` draws -- so mounting it is the "I've looked"
 * signal for every ticket it is handed at that moment, not just whichever one a person scrolls to.
 * The reset fires once, on mount, over the `tickets` this component was first given -- deliberately
 * not re-run when `tickets` changes later (a live update arriving while the screen stays open is
 * background sync, not a second "I've looked"), which is what keeps this to exactly one
 * `pipenzoRecordRiskActivityOpened` call per ticket per genuine open rather than one per render. The
 * call is fire-and-forget: a failed reset must never block this shell from rendering the trail it
 * exists to show, the same reasoning `pipenzo-tickets.ts`'s own best-effort worktree-cleanup call
 * uses for not letting a side effect's failure fail the response it rides along with.
 */
export function ActivityScreen({
  tickets = [],
  renderEntry,
  filterBar,
  now,
}: {
  /** Every ticket the store has ever recorded -- merged and closed ones included. Pass
   *  `usePipenzoTickets()`'s list straight through; nothing here filters it. */
  tickets?: readonly PipenzoTicketViewV1[];
  /** One row's content. Required rather than guessed -- see this file's own doc comment. */
  renderEntry: (entry: ActivityRowEntry) => ReactNode;
  /** #117's finished filter control, dropped in above the feed. Absent renders nothing in that slot,
   *  the same deferral `onConnectRepo`/`onNewFromIdea` get in `BoardScreen`. */
  filterBar?: ReactNode;
  /** Fixes what "Today"/"Yesterday" mean. Defaults to the real clock; a caller (or a test) can pin
   *  it without mocking global time. */
  now?: Date;
}) {
  useEffect(() => {
    const ticketIds = new Set(tickets.map((ticket) => ticket.ticketId));
    for (const ticketId of ticketIds) {
      void getBridge()
        .pipenzoRecordRiskActivityOpened({ ticketId })
        .catch(() => {
          // Best-effort -- see this file's own doc comment on why a failed reset must not block
          // the screen.
        });
    }
    // Mount-once, deliberately: see this file's own doc comment for why re-running this on every
    // `tickets` update would turn a live board sync into a second, spurious "I've looked".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { entries, undated } = toActivityFeed(tickets);

  if (entries.length === 0 && undated.length === 0) {
    return (
      <div className="page">
        <ExplainerBanner />
        <Empty icon="activity" title="No activity recorded yet">
          Nothing has moved through the ticket store yet. Once a ticket is queued, implemented, or
          reviewed, it shows up here — and stays here, even after it merges and leaves the board.
        </Empty>
      </div>
    );
  }

  const groups = groupActivityEntriesByDay(entries, now);
  const total = entries.length + undated.length;

  return (
    <div className="page">
      <ExplainerBanner />

      <div className="feed-head">
        {filterBar}
        <span className="feed-count">
          {total} {total === 1 ? 'ticket' : 'tickets'} · newest first · retained for the life of the
          ticket store
        </span>
      </div>

      <div className="feed">
        {groups.map((group) => (
          <Fragment key={group.key}>
            <span className="day">{group.label}</span>
            {group.entries.map((entry) => (
              <Fragment key={entry.ticket.ticketId}>{renderEntry(entry)}</Fragment>
            ))}
          </Fragment>
        ))}
        {undated.length > 0 && (
          <Fragment>
            <span className="day">Not yet recorded</span>
            {undated.map((ticket) => (
              <Fragment key={ticket.ticketId}>{renderEntry({ ticket })}</Fragment>
            ))}
          </Fragment>
        )}
      </div>
    </div>
  );
}

/**
 * `Activity.dc.html`'s own banner copy, verbatim: the board/Activity distinction the issue body asks
 * for, plus the honest retention note (there is no separate retention window anywhere in this
 * codebase today -- README has no expiry policy for the ticket store, and nothing calls
 * `FileTicketStore.delete()` on a terminal state yet, so "stays in the ticket store" is a true
 * statement of current behavior, not a promise about a policy that doesn't exist).
 */
function ExplainerBanner() {
  return (
    <Banner icon="info">
      The board is a picture of <b>active</b> work — the reconciler only ever queries open issues, so
      a merged ticket's card leaves it on the next poll. Nothing is deleted: the full record —
      attempts, gate results, pre-commitments, risk score, worktree cleanup outcome — stays in the
      ticket store, and this is what reads from it.
    </Banner>
  );
}
