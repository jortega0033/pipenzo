import type { PipenzoTicketViewV1 } from '@agent-dock/shared';

/**
 * `Activity.dc.html`'s `.seg` filter tabs (Pipenzo issue #117, split of epic #3): All / Publishes /
 * Gates / Risk / Worktrees, each with a real, accurate count of how many tickets in the feed fall
 * into it.
 *
 * ## Why a ticket, not a mocked "event", is what gets categorized
 *
 * The canvas's own mock data (`Activity.dc.html`'s `ALL` array) tags each row with a `group` field
 * on a fabricated per-*event* record — a risk crossing, a merge, a gate result — several of which can
 * belong to the same ticket (`#105` shows up under both `worktree` and `publish`, twice). Building
 * that real per-event breakdown is issue #118's job, not this one's — see `ActivityScreen.tsx`'s own
 * doc comment on why `renderEntry` is a required prop rather than something this shell (or a sibling
 * ticket) invents ahead of it. Until #118 lands, `ActivityScreen` renders one row per *ticket*
 * (`activity-grouping.ts`'s `toActivityFeed`), so this module answers the only question a ticket
 * itself can honestly answer: does *this ticket's own record* carry a real signal that belongs in a
 * given group? A ticket can match more than one filter, exactly like the canvas's own `#105` does —
 * these are not a partition, and `all` is not "matches no other filter" but "every ticket, unfiltered
 * and always" (see `ActivityScreen.tsx`'s own "runs whatever `tickets` it is handed").
 *
 * ## What each group is built from, and what it deliberately leaves out
 *
 * `pipenzoTicketRecordV1Schema`'s own doc comments (`packages/shared/src/pipenzo-ticket-v1.ts`) are
 * explicit that a per-publish and per-gate-result audit log is README's build-step-6 Polish item, not
 * built yet — there is no `publishedAt`, no `gateResult`, no field that says "a publish happened" on
 * the ticket record itself. So every predicate below reads a field the schema actually has today,
 * chosen to match the canvas's own grouping of its mocked specimens onto the same five tabs, rather
 * than inventing a field or a timestamp neither the daemon nor the store has ever written:
 *
 * - **`publish`** — the PR lifecycle: `pipenzo:ci-failed` and `pipenzo:merge-conflict` are exactly
 *   the two labels the canvas groups under `publish` (a post-merge-request check failing, an approved
 *   branch that no longer merges cleanly — both post-publish states, per README's label table), and a
 *   ticket with **no** `pipenzo:` label left at all is the merged/closed case `ActivityScreen.test.tsx`
 *   already exercises: the reconciler only queries open issues, so a merged ticket's card leaves the
 *   board the moment it merges, but the record — and its label list — is never rewritten again, so an
 *   empty `labels` array is the honest, real signal for "this ticket's story ended at a publish."
 * - **`gate`** — pre-publish gates: `lane === 'ready-for-review'` is README's own label-table meaning
 *   for `pipenzo:ready-for-review` ("Gates passed, awaiting the human push gate"), and
 *   `pipenzo:needs-pre-scoping` / `pipenzo:awaiting-stack-approval` / `pipenzo:needs-human` are the
 *   diff-size gate refusal, the blown-estimate/stack approval gate, and the repeated-failure park —
 *   the same three gate outcomes the canvas's own `gate`-grouped specimens show ("pipenzo:needs-pre-
 *   scoping", "pipenzo:awaiting-stack-approval", "3 failed · parked").
 * - **`risk`** — `risk.score > 0` and `risk.pendingPromotion` are the cumulative-risk strip's own
 *   persisted state (`pipenzoTicketRiskV1Schema`); a `precommits[]` entry with `verdict === 'mismatch'`
 *   is the one other real risk signal a ticket record carries — README's own pre-commitment mismatch
 *   is exactly the canvas's second `risk`-grouped specimen.
 * - **`worktree`** — `worktree` present is the one real, persisted fact this schema has about a
 *   ticket's on-disk work: Implement has provisioned it. The canvas's `worktree`-grouped specimens
 *   ("held", "worktree retained") describe capacity/retention *events* this record does not carry a
 *   field for, so a ticket with a worktree at all is the honest proxy rather than a fabricated
 *   "retained" or "held" flag.
 */

export const ACTIVITY_FILTER_KEYS = ['all', 'publish', 'gate', 'risk', 'worktree'] as const;

export type ActivityFilterKey = (typeof ACTIVITY_FILTER_KEYS)[number];

export interface ActivityFilterOption {
  readonly key: ActivityFilterKey;
  /** `Activity.dc.html`'s own `t.label` text, verbatim. */
  readonly label: string;
}

/** The five tabs, in the canvas's own left-to-right order. */
export const ACTIVITY_FILTER_OPTIONS: readonly ActivityFilterOption[] = [
  { key: 'all', label: 'All' },
  { key: 'publish', label: 'Publishes' },
  { key: 'gate', label: 'Gates' },
  { key: 'risk', label: 'Risk' },
  { key: 'worktree', label: 'Worktrees' },
];

function isPublishTicket(ticket: PipenzoTicketViewV1): boolean {
  return (
    ticket.labels.length === 0 ||
    ticket.labels.includes('pipenzo:ci-failed') ||
    ticket.labels.includes('pipenzo:merge-conflict')
  );
}

function isGateTicket(ticket: PipenzoTicketViewV1): boolean {
  return (
    ticket.lane === 'ready-for-review' ||
    ticket.labels.includes('pipenzo:needs-pre-scoping') ||
    ticket.labels.includes('pipenzo:awaiting-stack-approval') ||
    ticket.labels.includes('pipenzo:needs-human')
  );
}

function isRiskTicket(ticket: PipenzoTicketViewV1): boolean {
  return (
    ticket.risk.score > 0 ||
    ticket.risk.pendingPromotion === true ||
    ticket.precommits.some((precommit) => precommit.verdict === 'mismatch')
  );
}

function isWorktreeTicket(ticket: PipenzoTicketViewV1): boolean {
  return ticket.worktree !== undefined;
}

/** True when `ticket` belongs in `key`'s group. `all` matches every ticket, unconditionally. */
export function ticketMatchesActivityFilter(
  ticket: PipenzoTicketViewV1,
  key: ActivityFilterKey,
): boolean {
  switch (key) {
    case 'all':
      return true;
    case 'publish':
      return isPublishTicket(ticket);
    case 'gate':
      return isGateTicket(ticket);
    case 'risk':
      return isRiskTicket(ticket);
    case 'worktree':
      return isWorktreeTicket(ticket);
  }
}

/** `tickets`, narrowed to the ones `key`'s group matches — `tickets` unchanged for `all`. */
export function filterActivityTickets(
  tickets: readonly PipenzoTicketViewV1[],
  key: ActivityFilterKey,
): readonly PipenzoTicketViewV1[] {
  if (key === 'all') return tickets;
  return tickets.filter((ticket) => ticketMatchesActivityFilter(ticket, key));
}

/**
 * Every tab's real count against the real total — the "N of M" the issue asks for. `all`'s count is
 * always `tickets.length`, the same total `ActivityScreen`'s own feed-count line reports, so the two
 * numbers can never quietly disagree.
 */
export function countActivityFilters(
  tickets: readonly PipenzoTicketViewV1[],
): Readonly<Record<ActivityFilterKey, number>> {
  const counts = {} as Record<ActivityFilterKey, number>;
  for (const key of ACTIVITY_FILTER_KEYS) {
    counts[key] = filterActivityTickets(tickets, key).length;
  }
  return counts;
}
