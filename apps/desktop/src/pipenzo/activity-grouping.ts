import type { PipenzoTicketViewV1 } from '@agent-dock/shared';

/**
 * Turns the ticket store's flat, unordered list into the reverse-chronological, day-grouped read
 * `Activity.dc.html` asks for (Pipenzo issue #116).
 *
 * ## Why one entry per ticket, not one per recorded event
 *
 * The canvas's own mock data (`Activity.dc.html`'s `ALL` array) shows several rows for a single
 * ticket -- a risk-threshold crossing, a pre-commitment mismatch, a merge, each with its own icon,
 * chip and detail line drawn from the ticket's `attempts[]`/`precommits[]`/`risk` fields. Building
 * that flattening is issue #118's job ("Activity row renderer + deep link"), not this shell's -- it
 * needs per-kind icon/copy decisions this file has no business guessing at, the same reason
 * `BoardScreen.tsx` takes `renderTicket` as a required prop instead of inventing card content. This
 * file only owns the two things #116 actually asks for: reading every ticket the store has ever seen
 * (`usePipenzoTickets` already returns the unfiltered list -- see this module's own README, "GitHub
 * labels are authoritative for a ticket's lane; the local JSON ticket store holds everything GitHub
 * can't" -- nothing is ever deleted from it on merge/close, only the *board* stops showing a ticket
 * once it has no lane-bearing label), and grouping *that* by day. `renderEntry` in `ActivityScreen`
 * is where #118 plugs in the real per-event breakdown later; until then, one row per ticket, keyed
 * to the ticket's own last-known activity, is the honest thing to show.
 *
 * ## Why `updatedAt`, and why some tickets have none yet
 *
 * `PipenzoTicketRecordV1` had no timestamp of any kind before this ticket -- `attempts[]` and
 * `precommits[]` are prose records with no `at` field, and README's own build order lists "an audit
 * entry for every publish and gate result" under step 6, Polish, not yet built. `updatedAt` (see
 * `pipenzo-ticket-v1.ts`) is the minimal, additive field `pipenzo-phase-machine.ts` now stamps on
 * every real reconciliation or transition -- deliberately not on a poll that finds nothing to
 * reconcile, so "last activity" means a real change, not "the reconciler happened to look." A ticket
 * can still have no `updatedAt` in the narrow window between being created and its first `read()` --
 * the reconciler (#231) walks every stored ticket on its own cadence, so that window is at most one
 * poll interval. `toActivityEntries` below does not drop those tickets (nothing here ever discards a
 * real ticket); it reports them separately so a caller can render them without claiming a
 * chronological position the store cannot yet back up.
 */
export interface ActivityEntry {
  readonly ticket: PipenzoTicketViewV1;
  /** Parsed from `ticket.updatedAt`. Always a valid date -- an entry with no usable timestamp is
   *  reported through `undated` instead of forcing one here. */
  readonly timestamp: Date;
}

/**
 * What a row renderer actually receives: a dated `ActivityEntry`, or one of `undated`'s tickets with
 * no `timestamp` at all. A row renderer (#118) decides how to render "no timestamp yet" -- this
 * module never fabricates one to force a fit into `ActivityEntry`.
 */
export type ActivityRowEntry = { ticket: PipenzoTicketViewV1; timestamp?: Date };

export interface ActivityFeed {
  /** Every ticket with a usable `updatedAt`, reverse-chronological. */
  readonly entries: readonly ActivityEntry[];
  /** Tickets with no `updatedAt` yet (not yet reconciled even once) or an unparseable one. Real
   *  tickets, never dropped -- just not chronologically placeable today. */
  readonly undated: readonly PipenzoTicketViewV1[];
}

function parsedTimestamp(ticket: PipenzoTicketViewV1): Date | undefined {
  if (!ticket.updatedAt) return undefined;
  const parsed = new Date(ticket.updatedAt);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Splits and sorts the raw ticket list into the shape `ActivityScreen` renders. */
export function toActivityFeed(tickets: readonly PipenzoTicketViewV1[]): ActivityFeed {
  const entries: ActivityEntry[] = [];
  const undated: PipenzoTicketViewV1[] = [];

  for (const ticket of tickets) {
    const timestamp = parsedTimestamp(ticket);
    if (timestamp) {
      entries.push({ ticket, timestamp });
    } else {
      undated.push(ticket);
    }
  }

  // Newest first (README/`Activity.dc.html`'s own count line: "newest first"). Ticket id breaks a
  // tie deterministically rather than leaving same-millisecond entries in whatever order `tickets`
  // happened to arrive in.
  entries.sort((a, b) => {
    const byTime = b.timestamp.getTime() - a.timestamp.getTime();
    return byTime !== 0 ? byTime : a.ticket.ticketId.localeCompare(b.ticket.ticketId);
  });

  return { entries, undated };
}

export interface ActivityDayGroup {
  /** `YYYY-MM-DD` in the viewer's local calendar -- stable and unique per day, usable as a React key
   *  without re-deriving the label. */
  readonly key: string;
  /** "Today · Fri 6 Sep", "Yesterday · Thu 5 Sep", or "Wed 4 Sep" -- `Activity.dc.html`'s own `.day`
   *  divider copy, extended with "Yesterday" for the one other day people actually name in speech. */
  readonly label: string;
  readonly entries: readonly ActivityEntry[];
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function dayLabel(date: Date, now: Date): string {
  const dateOnly = `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
  const key = dayKey(date);
  if (key === dayKey(now)) return `Today · ${dateOnly}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === dayKey(yesterday)) return `Yesterday · ${dateOnly}`;
  return dateOnly;
}

/**
 * Buckets already-sorted entries into calendar-day groups, in the same reverse-chronological order.
 * `now` defaults to the real clock and exists only so a caller (or a test) can fix what "Today" means
 * without mocking global time.
 */
export function groupActivityEntriesByDay(
  entries: readonly ActivityEntry[],
  now: Date = new Date(),
): ActivityDayGroup[] {
  const groups: ActivityDayGroup[] = [];
  let current: { key: string; entries: ActivityEntry[] } | undefined;

  for (const entry of entries) {
    const key = dayKey(entry.timestamp);
    if (!current || current.key !== key) {
      current = { key, entries: [] };
      groups.push({ key, label: dayLabel(entry.timestamp, now), entries: current.entries });
    }
    current.entries.push(entry);
  }

  return groups;
}
