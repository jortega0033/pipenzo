import {
  PIPENZO_NEEDS_HUMAN_FAILED_ATTEMPT_THRESHOLD,
  type PipenzoTicketAttemptV1,
  type PipenzoTicketViewV1,
  type RefineProposedSplitPartV1,
} from '@agent-dock/shared';

/**
 * The Needs-human lane's card-variant router (issue #86, `Main.dc.html`'s Board screen). A pure
 * "which of this ticket's own real fields matters most right now" classification, the same split
 * `activity-row.ts`'s `classifyActivityRow` already keeps out of JSX -- this module decides *which*
 * card body a parked ticket gets; `PipenzoAppShell.tsx`'s `renderTicket` is the presentational half
 * that turns the answer into `Split`/`Resume`/`Conflict`/`FailNote`/`Chip`.
 *
 * ## Seven variants asked for, five built
 *
 * The issue body names seven: `awaiting-stack-approval`, `needs-pre-scoping`, `3-failed`,
 * `interrupted`, `merge-conflict`, `claim-conflict` (no CTA), `plan-review`. Investigating each
 * against this codebase's real, already-shipped data (README's label table, the ticket-view schema,
 * and tonight's own #99/#469/#201/#118 work) found real backing for five and none for two:
 *
 * - **`claim-conflict` has no persisted signal.** `PipenzoPhaseService#claimIssue`
 *   (`apps/daemon/src/pipenzo-phase-service.ts`) already returns a real `claimed_elsewhere` outcome
 *   when a claim race is lost, and `ImplementDialog.tsx`'s `claimIssueForTicket` already surfaces it
 *   -- but only as a transient Start-time refusal inside that dialog. Nothing on that path calls the
 *   phase machine's `transition()`, so the ticket's `lane`/`labels` never move; the ticket that lost
 *   the race stays `queued` in the store and the loser's dialog just shows an inline error. There is
 *   also no field on `pipenzoTicketRecordV1Schema`/`pipenzoTicketViewV1Schema` to carry *who* holds a
 *   claim even if a park did happen. `Conflict.tsx` and `Card.tsx`'s `onClick`-optionality were both
 *   built with this variant in mind (see their own doc comments), but wiring a real,
 *   board-observable claim-conflict card needs a daemon-side decision this ticket does not make on
 *   its own: whether a lost claim should write a *new* label (README's label table is already closed
 *   over ten names, and CLAUDE.md's own hard rule #5 is exactly "no bare/invented labels") or persist
 *   an assignee onto the existing generic `pipenzo:needs-human` state. That is a real design
 *   question for whoever owns the claim flow next, not a card-router guess.
 * - **`plan-review` has no gate behind it yet.** #15/#101 (the plan-review gate itself) are open;
 *   `ticket-phase-steps.ts`'s own `planReviewStatus` only ever reports `await`/`fail` for the two
 *   labels that already exist (`awaiting-stack-approval`/`needs-pre-scoping`) and has no third state
 *   for "Refine finished, waiting on a plain plan-review accept" -- because nothing in the daemon
 *   parks a ticket for that reason today.
 *
 * Both are real gaps, not oversights, and are left unrendered here rather than given a card built on
 * invented data -- `classifyNeedsHumanCard` never returns a variant for either.
 *
 * ## The five real variants, and what each one is allowed to assume
 *
 * - `awaiting-stack-approval` / `needs-pre-scoping`: the same restraint
 *   `classifyActivityRow` already applies for these two labels -- `ticket.estimate` (always present)
 *   for the honest lines/files line, never `ticket.refusal`'s richer-but-optional cache treated as if
 *   it were guaranteed. `needs-pre-scoping` layers in `ticket.refusal.proposedSplit` as a bonus only
 *   when it actually survived (`RefusalPanel.tsx`'s own conditional, mirrored here).
 * - `merge-conflict`: the label alone. `PipenzoTicketViewV1` carries no PR number and no per-file
 *   hunk list (`Conflict.tsx`'s own `files` stays optional for exactly this ticket), so this renders
 *   `Conflict` in its file-less mode with README's own real, generic explanation -- never a guessed
 *   PR number.
 * - `interrupted`: `ticket.phase` and `ticket.worktree?.branch`, both real fields every ticket view
 *   already carries. `pipenzoRecoveryReportV1Schema`'s own `resumable` (a `providerSessionId` and a
 *   `continuationScope` both existing) lives on a *separate* recovery-report route this ticket list
 *   never joins in -- so this always classifies as non-resumable rather than guessing a session is
 *   continuable it cannot check, the same "disabled with a real reason, never a guessed capability"
 *   restraint `PipenzoAppShell.tsx`'s own held-card `Run anyway` button already established.
 * - `failed` (README's "3 consecutive failures" reading of the generic `pipenzo:needs-human` label):
 *   `ticket.attempts.length >= 3`. The attempt-outcome vocabulary is still the phase machine's to
 *   close (`pipenzo-ticket-v1.ts`'s own doc comment on `pipenzoTicketAttemptV1Schema.outcome`), so
 *   this cannot verify the three were *consecutive failures* rather than, say, a denial after two
 *   failed tries -- it reads the one real, counted fact the schema does carry (three real dispatched
 *   attempts sit on this parked ticket) rather than pattern-matching `outcome` strings against a
 *   vocabulary that is not closed yet.
 * - `generic`: every other ticket the phase machine actually parks under the bare
 *   `pipenzo:needs-human` label (README's other real cause, "a denied approval", with fewer than
 *   three attempts) -- and, deliberately, a ticket parked under a label this router does not build a
 *   variant for yet (`pipenzo:ci-failed` before its fix commits has its own, separate Ready-for-review
 *   treatment from #87 and is not one of this issue's seven; `pipenzo:schema-v1` is a marker, never a
 *   lane cause). `generic` still renders a real, honest note -- `activity-row.ts`'s own bare
 *   `pipenzo:needs-human` copy, reused rather than re-worded -- so no parked ticket in this lane is
 *   ever left with an empty card body, the same way Working/Ready-for-review never leave one either.
 *
 * `isGenericNeedsHuman` in `ticket-phase-steps.ts` already draws the "four specific labels, else
 * generic" line this module's priority order matches (`needs-pre-scoping` and
 * `awaiting-stack-approval` checked first, matching that function's own order).
 */

export type NeedsHumanCardVariant =
  | 'needs-pre-scoping'
  | 'awaiting-stack-approval'
  | 'interrupted'
  | 'merge-conflict'
  | 'failed'
  | 'generic';

export interface NeedsHumanEstimate {
  readonly lines: number;
  readonly files: number;
  readonly layered: boolean;
}

export type NeedsHumanCardClassification =
  | ({ readonly variant: 'needs-pre-scoping' } & NeedsHumanEstimate & {
        /** Only when Refine's own `#reportRefusal` cache survived -- see this module's own doc
         *  comment on why the base `estimate` above is used regardless of whether it did. */
        readonly proposedSplit?: readonly RefineProposedSplitPartV1[];
      })
  | ({ readonly variant: 'awaiting-stack-approval' } & NeedsHumanEstimate & {
        /** `ticket.stack.childIds.length` -- non-zero only once a stack has actually been
         *  materialized, matching `classifyActivityRow`'s own reading of this field. */
        readonly childCount: number;
      })
  | {
      readonly variant: 'interrupted';
      readonly phase: PipenzoTicketViewV1['phase'];
      readonly branch?: string;
    }
  | { readonly variant: 'merge-conflict' }
  | {
      readonly variant: 'failed';
      readonly attemptCount: number;
      readonly last?: PipenzoTicketAttemptV1;
    }
  | {
      readonly variant: 'generic';
      readonly attemptCount: number;
      readonly last?: PipenzoTicketAttemptV1;
    };

/** README's own threshold for the generic label's "3 consecutive failures" reading -- see this
 *  module's own doc comment on why attempt *count* is the one real signal available for it.
 *  Re-exported from `@agent-dock/shared` (issue #105) rather than redefined here, so the daemon's
 *  own retry classifier parks on exactly this number without reaching across the daemon/desktop
 *  boundary into this module. */
export const NEEDS_HUMAN_FAILED_ATTEMPT_THRESHOLD = PIPENZO_NEEDS_HUMAN_FAILED_ATTEMPT_THRESHOLD;

function lastAttempt(ticket: PipenzoTicketViewV1): PipenzoTicketAttemptV1 | undefined {
  return ticket.attempts[ticket.attempts.length - 1];
}

/** The one real card variant this parked ticket's own labels and fields support -- see this
 *  module's own doc comment for the full priority order and the two variants deliberately left
 *  unclassified (`claim-conflict`, `plan-review`). */
export function classifyNeedsHumanCard(ticket: PipenzoTicketViewV1): NeedsHumanCardClassification {
  if (ticket.labels.includes('pipenzo:needs-pre-scoping')) {
    return {
      variant: 'needs-pre-scoping',
      lines: ticket.estimate.lines,
      files: ticket.estimate.files,
      layered: ticket.estimate.layered,
      proposedSplit:
        ticket.refusal?.proposedSplit && ticket.refusal.proposedSplit.length > 0
          ? ticket.refusal.proposedSplit
          : undefined,
    };
  }

  if (ticket.labels.includes('pipenzo:awaiting-stack-approval')) {
    return {
      variant: 'awaiting-stack-approval',
      lines: ticket.estimate.lines,
      files: ticket.estimate.files,
      layered: ticket.estimate.layered,
      childCount: ticket.stack.childIds.length,
    };
  }

  if (ticket.labels.includes('pipenzo:interrupted')) {
    return {
      variant: 'interrupted',
      phase: ticket.phase,
      branch: ticket.worktree?.branch,
    };
  }

  if (ticket.labels.includes('pipenzo:merge-conflict')) {
    return { variant: 'merge-conflict' };
  }

  const attemptCount = ticket.attempts.length;
  const last = lastAttempt(ticket);
  if (attemptCount >= NEEDS_HUMAN_FAILED_ATTEMPT_THRESHOLD) {
    return { variant: 'failed', attemptCount, last };
  }
  return { variant: 'generic', attemptCount, last };
}
