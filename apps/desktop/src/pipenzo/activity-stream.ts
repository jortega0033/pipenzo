import type {
  PipenzoTicketAttemptV1,
  PipenzoTicketPrecommitV1,
  PipenzoTicketViewV1,
  ReviewReportV1,
  RiskGrade,
} from '@agent-dock/shared';
import type { IconName } from '../components/primitives/Icon.js';
import type { EvtIconTone } from '../components/primitives/ActivityEvent.js';

/**
 * `TicketDetail.dc.html`'s `.stream` (issue #93, split of epic #3) -- a pure mapping from the real
 * per-ticket data `PipenzoTicketViewV1` actually carries onto the row shape `ActivityEvent.tsx`'s
 * primitives (`Evt`/`EvtHead`/`EvtTitle`/`SubRow`/`SubLines`, already built and already ported to
 * `pipenzo-theme.css`) render. Same discipline `cumulative-risk.ts` and `ticket-phase-steps.ts`
 * already apply to this same wire type: every row below is built from a real field, and a real
 * field this codebase does not have is a row this module does not invent.
 *
 * ## What the canvas mocks that this module cannot render
 *
 * `TicketDetail.dc.html`'s static specimens show seven event kinds (`ack`, `refine`, `implement`,
 * `gates`, `review`, `publish`, `ci`), each with its own timestamp, plus individual LOW-graded
 * actions logged one row at a time (a grep, a read, an edit). None of that per-action log exists in
 * this codebase yet: `pipenzoTicketRecordV1Schema`'s own doc comments say so directly --
 * `attempts[]`/`precommits[]` are "prose records with no `at` field", and nothing records a LOW
 * action's own occurrence at all (only the aggregate `risk.score` `CumulativeRiskStrip.tsx` already
 * renders). So this module renders exactly three real kinds, in a fixed, documented order rather
 * than a fabricated chronological interleave:
 *
 * 1. **`attempt`** -- one row per `PipenzoTicketAttemptV1` in `ticket.attempts[]`, in array order
 *    (append order, per `pipenzo-phase-machine.ts#recordAttempt`'s own doc comment).
 * 2. **`precommit`** -- one row per `PipenzoTicketPrecommitV1` in `ticket.precommits[]`, in array
 *    order, after every attempt row. There is no field linking a precommit to the attempt it was
 *    posted during (`pipenzoTicketPrecommitV1Schema` carries no `sessionId`), so nesting a
 *    precommit inside "its" attempt row the way the canvas mock does would be a linkage this module
 *    cannot actually verify -- each precommit gets its own row instead.
 * 3. **`review`** / **`review-pending`** -- at most one trailing row, built from a `ReviewReportV1`
 *    a caller supplies (Review is an explicit, on-demand action -- `use-implement-review.ts`'s
 *    `useReviewAction` -- never a ticket-store field, so this module cannot read one off `ticket`
 *    itself). `review-pending` is the live in-flight case: the caller's own async-action state,
 *    never invented here either.
 * 4. **`ci-failed`** -- at most one row, appended last, present exactly when
 *    `ticket.labels.includes('pipenzo:ci-failed')` (issue #102, split of epic #11). This is the one
 *    real condition signal `pipenzo-phase-machine.ts`'s own `PIPENZO_CONDITION_LABELS` already
 *    tracks for this exact label, and the identical real field `classifyActivityRow`
 *    (`activity-row.ts`) and `ciFixReadyDetail` (`PipenzoAppShell.tsx`, issue #87) already key their
 *    own ci-failed treatment off -- never a new signal invented for this row.
 *
 *    The canvas's own `ci` specimen also shows a failing-check name, an actual compiler-error
 *    excerpt, and a `session.fork` row naming a specific forked session plus the fix commit it
 *    produced. None of that exists in this codebase to read: `GitHubClient.listPullRequestChecks`
 *    (`github-client.ts`) can fetch a PR's check runs, but nothing calls it today, so no check name
 *    or conclusion ever reaches the ticket store; `GitHubCheckRun` itself carries no output text, so
 *    even a wired caller could not surface a compiler-error excerpt without a further API shape this
 *    codebase does not have; and `pipenzoTicketAttemptV1Schema` (`pipenzo-ticket-v1.ts`) records only
 *    `sessionId`/`tier`/`model`/`outcome` -- no field marks an attempt as a `session.fork` dispatched
 *    specifically for a CI fix (as opposed to an ordinary retry or tier escalation), and no field
 *    carries the fix commit's SHA. Row 4 below is deliberately a single honest condition row, not
 *    five -- it names the one real fact (a check failed) and, for the fix-attempt half of the
 *    lineage, points at the real `attempt` rows already rendered above it by row 1, exactly the same
 *    restraint `ciFixReadyDetail`/`classifyActivityRow` already apply, rather than a second, bespoke
 *    "fix-committed" row this module has no real commit data to back.
 *
 *    It renders last rather than interleaved with the attempt rows above because `attempts[]` carries
 *    no `at` field (this module's own doc comment above) -- there is no real basis to say the failure
 *    happened "between" two specific attempts, only that the condition is currently true of the
 *    ticket. The existing `evt-line` connector (`activityStreamLineEnds` below) still draws a real
 *    line from the last attempt row down into this one, which is the one honest "lineage line" this
 *    data supports: it connects two real rows, not an invented one.
 *
 * ## Why `review.risk === 'low'` is the one real LOW-compact case
 *
 * The issue asks for "LOW compact rows, keyed off the real `RiskGrade` type"
 * (`packages/shared/src/pipenzo-review-v1.ts`'s `RiskGrade`, `'low' | 'medium' | 'high'`). Neither
 * an attempt nor a precommit carries a grade at all -- a precommit is, by
 * `pipenzoTicketPrecommitV1Schema`'s own doc comment, only ever posted "before every MEDIUM or HIGH
 * action", so it is never LOW by construction. `ReviewReportV1.risk` is the one place in this
 * codebase a `RiskGrade` is both real and available to a ticket-detail view -- `review-gates.ts`
 * derives it from the diff's own touched-file paths -- so a `'low'`-graded review report is the one
 * row this module renders compact, via `isLowRiskActivityEntry` below.
 */

export type ActivityStreamEntryKind = 'attempt' | 'precommit' | 'review' | 'review-pending' | 'ci-failed';

export interface ActivityStreamAttemptEntry {
  readonly kind: 'attempt';
  readonly attempt: PipenzoTicketAttemptV1;
  /** True for the most recent attempt, exactly while it is genuinely still running: the ticket's
   *  own phase machine has it dispatched (`outcome === 'dispatched'`, the one outcome string
   *  recorded at dispatch time -- `pipenzo-phase-service.ts#recordAttempt`) and the ticket's lane
   *  says a phase is actively running. Any later outcome (a crash-recovery marker, or a future
   *  terminal one) means it is no longer live, whatever the lane says. */
  readonly live: boolean;
}

export interface ActivityStreamPrecommitEntry {
  readonly kind: 'precommit';
  readonly precommit: PipenzoTicketPrecommitV1;
}

export interface ActivityStreamReviewEntry {
  readonly kind: 'review';
  readonly report: ReviewReportV1;
}

/** The live in-flight case: a review is running but has not returned a report yet. */
export interface ActivityStreamPendingReviewEntry {
  readonly kind: 'review-pending';
}

/**
 * The ci-failed condition row (issue #102) -- see this module's own doc comment, item 4, for why it
 * carries only `lastAttempt` rather than a failing-check name, an error excerpt, or a fix-commit SHA.
 * `lastAttempt` is `ticket.attempts[ticket.attempts.length - 1]`, the same field
 * `ciFixReadyDetail`/`classifyActivityRow` already read for the identical honest fallback: present
 * once a fix attempt has been dispatched and recorded, `undefined` for the gap between the label
 * landing and the phase machine recording that attempt (should not happen in steady state, but this
 * entry checks rather than assumes it, the same restraint `ciFixReadyDetail`'s own doc comment states).
 */
export interface ActivityStreamCiFailedEntry {
  readonly kind: 'ci-failed';
  readonly lastAttempt: PipenzoTicketAttemptV1 | undefined;
}

export type ActivityStreamEntry =
  | ActivityStreamAttemptEntry
  | ActivityStreamPrecommitEntry
  | ActivityStreamReviewEntry
  | ActivityStreamPendingReviewEntry
  | ActivityStreamCiFailedEntry;

export interface ActivityStreamOptions {
  /** A finished review report for this ticket, when the caller's own `useReviewAction` (or an
   *  equivalent real source) has one. Never read off `ticket` itself -- see this module's own doc
   *  comment for why no ticket-store field carries one. */
  readonly reviewReport?: ReviewReportV1;
  /** True while the caller's own review action is genuinely in flight. Ignored once `reviewReport`
   *  is present -- a finished report always wins over a stale "still running" flag. */
  readonly reviewPending?: boolean;
}

/** The real phase-machine binding: every row below reads only `ticket.attempts`/`ticket.precommits`
 *  (plus `lane`/`phase` for the one live check) and the caller-supplied review state -- no mocked
 *  event data anywhere in this path. */
export function buildActivityStream(
  ticket: PipenzoTicketViewV1,
  options: ActivityStreamOptions = {},
): ActivityStreamEntry[] {
  const entries: ActivityStreamEntry[] = [];
  const lastAttemptIndex = ticket.attempts.length - 1;

  ticket.attempts.forEach((attempt, index) => {
    const live =
      index === lastAttemptIndex &&
      attempt.outcome === 'dispatched' &&
      ticket.phase === 'implement' &&
      ticket.lane === 'working';
    entries.push({ kind: 'attempt', attempt, live });
  });

  for (const precommit of ticket.precommits) {
    entries.push({ kind: 'precommit', precommit });
  }

  if (options.reviewReport) {
    entries.push({ kind: 'review', report: options.reviewReport });
  } else if (options.reviewPending) {
    entries.push({ kind: 'review-pending' });
  }

  if (ticket.labels.includes('pipenzo:ci-failed')) {
    entries.push({ kind: 'ci-failed', lastAttempt: ticket.attempts[ticket.attempts.length - 1] });
  }

  return entries;
}

/** `.evt-ic`'s icon, per real event kind -- `implement` for both an attempt and a precommit (both
 *  arise from the Implement phase; see this module's own doc comment on why they cannot be linked
 *  more precisely than that), `review` for either review row, `x-circle` for the ci-failed condition
 *  row -- the same icon `activity-row.ts`'s own `classifyActivityRow` already uses for this identical
 *  label. Mirrors `TicketDetail.dc.html`'s own `isImplement`/`isReview` icon choices -- the same icon
 *  paths `icons.ts`'s `implement`/`review`/`x-circle` entries already carry. */
export function activityStreamIcon(entry: ActivityStreamEntry): IconName {
  if (entry.kind === 'review' || entry.kind === 'review-pending') return 'review';
  if (entry.kind === 'ci-failed') return 'x-circle';
  return 'implement';
}

/** `.evt-ic`'s tone: `live` for the one genuinely in-flight row (a dispatched attempt still
 *  running, or a review with no report back yet), `bad` for the ci-failed condition row -- the same
 *  danger tone `classifyActivityRow` already uses for this identical label -- `default` otherwise. */
export function activityStreamIconTone(entry: ActivityStreamEntry): EvtIconTone {
  if (entry.kind === 'review-pending') return 'live';
  if (entry.kind === 'attempt' && entry.live) return 'live';
  if (entry.kind === 'ci-failed') return 'bad';
  return 'default';
}

/** The one real `RiskGrade` this module ever has in hand -- see this module's own doc comment on
 *  why an attempt or a precommit never carries one. */
export function activityStreamRiskGrade(entry: ActivityStreamEntry): RiskGrade | undefined {
  return entry.kind === 'review' ? entry.report.risk : undefined;
}

/** True for the one real LOW-compact case this module renders -- see this module's own doc comment. */
export function isLowRiskActivityEntry(entry: ActivityStreamEntry): boolean {
  return activityStreamRiskGrade(entry) === 'low';
}

/**
 * `.evt-line`'s termination rule, mirroring `TicketDetail.dc.html`'s own
 * `lineCls: i === raw.length - 1 && !streamEndsInCard ? 'end' : ''`: the last row's connecting line
 * renders transparent (nothing below it to connect to) unless the caller is about to render more
 * stream content right after this widget -- e.g. a pending MEDIUM/HIGH approval card, none of which
 * are this ticket's own attempts/precommits/review and so never appear in `entries` themselves.
 * `continuesBelow` is that caller's own signal, the same deferral `TicketDetailScreen.tsx`'s
 * `children` slot already draws around this widget.
 */
export function activityStreamLineEnds(
  index: number,
  entries: readonly ActivityStreamEntry[],
  continuesBelow: boolean,
): boolean {
  return index === entries.length - 1 && !continuesBelow;
}

const KNOWN_ATTEMPT_OUTCOME_TITLES: Readonly<Record<string, string>> = {
  // The one outcome string a fresh dispatch is ever recorded with --
  // `pipenzo-phase-service.ts#recordAttempt`'s own literal.
  dispatched: 'Implement session dispatched',
  // `pipenzo-crash-recovery.ts`'s `RECOVERY_OUTCOME_RECOVERED` literal, mirrored here rather than
  // imported -- the desktop renderer cannot import daemon internals (the same boundary
  // `cumulative-risk.ts`'s own `RISK_SCORE_THRESHOLD` comment states).
  interrupted_recovered: 'Recovered after an interrupted run — the daemon restarted mid-session',
};

/** `pipenzo-crash-recovery.ts`'s `RECOVERY_OUTCOME_UNRESOLVED_PREFIX` literal, mirrored for the
 *  same reason as `KNOWN_ATTEMPT_OUTCOME_TITLES` above. */
const INTERRUPTED_UNRESOLVED_PREFIX = 'interrupted_unresolved:';

/**
 * A real, honest title for an attempt row. `pipenzoTicketAttemptV1Schema.outcome`'s own doc comment
 * is explicit that the outcome vocabulary is "a bounded string, not a closed enum" and is still
 * moving -- so an outcome this function doesn't recognize is shown verbatim rather than hidden,
 * mapped to a guess, or dropped.
 */
export function activityStreamAttemptTitle(attempt: PipenzoTicketAttemptV1): string {
  const known = KNOWN_ATTEMPT_OUTCOME_TITLES[attempt.outcome];
  if (known) return known;
  if (attempt.outcome.startsWith(INTERRUPTED_UNRESOLVED_PREFIX)) {
    const lane = attempt.outcome.slice(INTERRUPTED_UNRESOLVED_PREFIX.length) || 'an unknown lane';
    return `The daemon died mid-run — left unresolved in ${lane}`;
  }
  return `Outcome: ${attempt.outcome}`;
}

const REVIEW_OUTCOME_TITLES: Readonly<Record<ReviewReportV1['outcome'], string>> = {
  approved: 'approved',
  deterministic_failed: 'stopped at the deterministic gates',
  awaiting_test_adjudication: 'awaiting spec-test adjudication',
  review_input_incomplete: 'could not complete — the diff was too large for the review input',
  estimate_blown: 'stopped — the diff exceeded its Refine-time estimate',
  verifier_rejected: 'rejected by the adversarial verifier',
};

/** A real, honest title for a review row -- `REVIEW_OUTCOMES` is a closed union
 *  (`pipenzo-review-v1.ts`), so every case is named; the gate count comes straight off
 *  `report.deterministic`, never a fabricated total. */
export function activityStreamReviewTitle(report: ReviewReportV1): string {
  const passed = report.deterministic.filter((gate) => gate.status === 'passed').length;
  const total = report.deterministic.length;
  const gateText = total > 0 ? `${passed}/${total} deterministic gates passed` : 'no deterministic gates ran';
  return `Review ${REVIEW_OUTCOME_TITLES[report.outcome]} — ${gateText}`;
}

/**
 * A real, honest title for the ci-failed condition row (issue #102). Deliberately mirrors
 * `ciFixReadyDetail` (`PipenzoAppShell.tsx`, issue #87) and `classifyActivityRow`'s own
 * `pipenzo:ci-failed` branch (`activity-row.ts`) word for word in spirit -- the third place in this
 * codebase that renders this exact real signal, and the third honest fallback for the same
 * not-yet-recorded-attempt gap, rather than a fourth, differently-worded guess. Only `tier`/`model`
 * are named, same restriction as those two: see this module's own doc comment, item 4, for every
 * field this row does not have (failing-check name, error excerpt, fork marker, fix-commit SHA).
 */
export function activityStreamCiFailedTitle(entry: ActivityStreamCiFailedEntry): string {
  return entry.lastAttempt
    ? `A post-merge-request check failed. A fix attempt has been recorded (${entry.lastAttempt.tier} tier, ${entry.lastAttempt.model}) and is waiting on this same human push gate — it is never resubmitted on its own.`
    : 'A post-merge-request check failed on this ticket. No fix attempt has been recorded yet.';
}
