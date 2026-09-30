import type { PipenzoTicketAttemptV1, PipenzoTicketViewV1 } from '@agent-dock/shared';
import type { IconName } from '../components/primitives/Icon.js';
import type { ChipTone } from '../components/primitives/Chip.js';
import { activityStreamAttemptTitle } from './activity-stream.js';
import type { ActivityRowEntry } from './activity-grouping.js';
import { paletteTicketLabel } from './command-palette-data.js';
import { RISK_SCORE_THRESHOLD, summarizeCumulativeRisk } from './cumulative-risk.js';

/**
 * `Activity.dc.html`'s `.act` row content (issue #118, the last split of epic #3) -- a pure
 * mapping from a ticket's real record onto the tone-coded icon, id/title/state chip, detail
 * paragraph, and mono meta line the row renders. `ActivityRow.tsx` is the presentational half;
 * this module is the "which of this ticket's own real fields matters most right now" decision,
 * kept separate for the same reason `activity-stream.ts`/`cumulative-risk.ts` keep their own
 * mapping logic out of JSX.
 *
 * ## One row, one class -- not the canvas's several-events-per-ticket mock
 *
 * `Activity.dc.html`'s own `ALL` array shows several rows for a single ticket (a risk crossing, a
 * pre-commitment mismatch, a worktree hold, all for #94/#97/#105). `activity-grouping.ts`'s own
 * doc comment is explicit that this codebase renders one row per *ticket*, not per mocked event --
 * `pipenzoTicketRecordV1Schema` carries no per-event audit log (README's build-step-6 Polish item,
 * not built yet). So `classifyActivityRow` below picks the *one* real signal a ticket's record
 * carries that matters most right now, in a fixed priority order, rather than fabricating a
 * flattened event list this codebase has no data to back.
 *
 * ## The priority order, and why it matches `ticket-phase-steps.ts`'s own precedence
 *
 * `ticket-phase-steps.ts`'s `isGenericNeedsHuman` already draws the line this module reuses: a
 * ticket in the needs-human lane is "generic parked" only when it carries *none* of the four more
 * specific labels (`ci-failed`, `merge-conflict`, `needs-pre-scoping`, `awaiting-stack-approval`,
 * `interrupted`). This module checks those five specific labels first, for the same reason -- a
 * ticket carrying `pipenzo:ci-failed` is a CI failure first, not a generic park, even though both
 * live in the same lane. After the label-specific branches: a ticket with no `pipenzo:` label at
 * all is the merged/closed case (`activity-filters.ts`'s own `isPublishTicket` reasoning), then
 * `ready-for-review` (gates passed), then real risk signals (`risk.pendingPromotion`, a
 * pre-commitment mismatch, `risk.score > 0` -- in that order, most severe first), then a
 * provisioned worktree, then plain in-progress (`working`/`queued`), each of which the canvas's own
 * mock data never shows a specimen for at all -- there is no real signal more specific to fall back
 * on for those two, so they get the plainest treatment.
 */

export type ActivityRowTone = 'ok' | 'warn' | 'bad' | 'neutral';

export interface ActivityRowClassification {
  readonly icon: IconName;
  readonly tone: ActivityRowTone;
  readonly chipLabel: string;
  readonly chipTone: ChipTone;
  /** The row's `.act-detail` paragraph -- always built from a real field on `ticket`, never the
   *  canvas's own invented prose. */
  readonly detail: string;
  /** The row's mono `.act-meta` line. */
  readonly meta: string;
}

function lastAttempt(ticket: PipenzoTicketViewV1): PipenzoTicketAttemptV1 | undefined {
  return ticket.attempts[ticket.attempts.length - 1];
}

/** `"N attempts · last <tier> · <model>"`, or the honest zero-case -- the same real fields
 *  `activity-stream.ts` reads off `ticket.attempts`, never a fabricated count. */
function attemptsMeta(ticket: PipenzoTicketViewV1): string {
  const count = ticket.attempts.length;
  if (count === 0) return 'no attempts recorded';
  const last = lastAttempt(ticket)!;
  return `${count} attempt${count === 1 ? '' : 's'} · last ${last.tier} · ${last.model}`;
}

/** The Refine-time size prediction, `pipenzoTicketEstimateV1Schema`'s own field names. */
function estimateMeta(ticket: PipenzoTicketViewV1): string {
  const { lines, files, layered } = ticket.estimate;
  return `${lines} changed lines · ${files} file${files === 1 ? '' : 's'}${
    layered ? ' · layered' : ''
  }`;
}

/** `cumulative-risk.ts`'s own `countText` ("3.5 / 10"), reused rather than re-deriving the same
 *  clamp-and-format logic a second time. */
function riskMeta(ticket: PipenzoTicketViewV1): string {
  return `${summarizeCumulativeRisk(ticket.risk).countText} risk`;
}

/** The one real, honest label for a row's `.act-title` -- the cached issue title, or `Issue #N`
 *  when this record has not cached one yet. Reuses `command-palette-data.ts`'s own fallback
 *  rather than a second copy of the same rule. */
export function activityRowTitle(ticket: PipenzoTicketViewV1): string {
  return paletteTicketLabel(ticket);
}

/** `HH:MM` in the viewer's local clock, or an honest placeholder for `activity-grouping.ts`'s own
 *  `undated` case -- this module never invents a timestamp a ticket does not have. */
export function activityRowTime(entry: ActivityRowEntry): string {
  if (!entry.timestamp) return '—';
  const hours = String(entry.timestamp.getHours()).padStart(2, '0');
  const minutes = String(entry.timestamp.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** The one real signal this ticket's record carries that matters most right now -- see this
 *  module's own doc comment for the full priority order and why it matches
 *  `ticket-phase-steps.ts`'s own `isGenericNeedsHuman` precedence. */
export function classifyActivityRow(ticket: PipenzoTicketViewV1): ActivityRowClassification {
  if (ticket.labels.includes('pipenzo:ci-failed')) {
    const last = lastAttempt(ticket);
    return {
      icon: 'x-circle',
      tone: 'bad',
      chipLabel: 'pipenzo:ci-failed',
      chipTone: 'ci',
      detail: last
        ? `A post-merge-request check failed. A fix attempt has been recorded (${last.tier} tier, outcome "${last.outcome}") — it re-enters the same human push gate once ready.`
        : 'A post-merge-request check failed on this ticket. No fix attempt has been recorded yet.',
      meta: attemptsMeta(ticket),
    };
  }

  if (ticket.labels.includes('pipenzo:merge-conflict')) {
    return {
      icon: 'warning',
      tone: 'warn',
      chipLabel: 'pipenzo:merge-conflict',
      chipTone: 'warn',
      detail:
        'The approved branch no longer merges cleanly with main. Nothing failed and no commit is lost — a rebase re-enters the same human push gate.',
      meta: attemptsMeta(ticket),
    };
  }

  if (ticket.labels.includes('pipenzo:needs-pre-scoping')) {
    const { lines, files, layered } = ticket.estimate;
    return {
      icon: 'hand',
      tone: 'neutral',
      chipLabel: 'pipenzo:needs-pre-scoping',
      chipTone: 'neutral',
      detail: `Refused at the diff-size gate before any code was written: the estimate is ${lines} changed lines across ${files} file${
        files === 1 ? '' : 's'
      }${layered ? ', with a clean layering,' : ' with no clean layering'} — too large for a single PR.`,
      meta: estimateMeta(ticket),
    };
  }

  if (ticket.labels.includes('pipenzo:awaiting-stack-approval')) {
    const childCount = ticket.stack.childIds.length;
    return {
      icon: 'pr-stack',
      tone: 'warn',
      chipLabel: 'pipenzo:awaiting-stack-approval',
      chipTone: 'warn',
      detail:
        childCount > 0
          ? `Refine wrote a ${childCount}-ticket dependency-ordered stack and is waiting for a human to accept, reorder, or reject it before anything starts.`
          : 'The estimate needs a human decision on how to split or proceed before Implement starts.',
      meta: estimateMeta(ticket),
    };
  }

  if (ticket.labels.includes('pipenzo:interrupted')) {
    return {
      icon: 'warning',
      tone: 'warn',
      chipLabel: 'pipenzo:interrupted',
      chipTone: 'warn',
      detail:
        'The daemon died mid-run on this ticket. It never auto-resumes — a human resumes or discards the incomplete attempt.',
      meta: attemptsMeta(ticket),
    };
  }

  if (ticket.labels.includes('pipenzo:needs-human')) {
    const last = lastAttempt(ticket);
    return {
      icon: 'x-circle',
      tone: 'bad',
      chipLabel: 'pipenzo:needs-human',
      chipTone: 'danger',
      detail: last
        ? `Parked for a human to look at — ${ticket.attempts.length} attempt${
            ticket.attempts.length === 1 ? '' : 's'
          } recorded, most recent: ${activityStreamAttemptTitle(last)}.`
        : 'Parked for a human to look at — no attempts recorded yet.',
      meta: attemptsMeta(ticket),
    };
  }

  if (ticket.labels.length === 0) {
    return {
      icon: 'check-circle',
      tone: 'ok',
      chipLabel: 'merged',
      chipTone: 'ok',
      detail:
        'This ticket carries no open pipenzo: label — the reconciler only queries open issues, so its card already left the board. The full record stays here.',
      meta: `${attemptsMeta(ticket)} · ${ticket.budget.tokensUsed} tokens`,
    };
  }

  if (ticket.lane === 'ready-for-review') {
    return {
      icon: 'gates',
      tone: 'ok',
      chipLabel: 'ready for review',
      chipTone: 'ok',
      detail:
        'Deterministic gates and review have run for this ticket; it is waiting at the human push gate — nothing is pushed without an explicit approval.',
      meta: attemptsMeta(ticket),
    };
  }

  if (ticket.risk.pendingPromotion) {
    const summary = summarizeCumulativeRisk(ticket.risk);
    return {
      icon: 'risk',
      tone: 'bad',
      chipLabel: 'risk threshold crossed',
      chipTone: 'danger',
      detail: summary.promoText,
      meta: riskMeta(ticket),
    };
  }

  const mismatches = ticket.precommits.filter((precommit) => precommit.verdict === 'mismatch');
  if (mismatches.length > 0) {
    const mismatch = mismatches[mismatches.length - 1]!;
    return {
      icon: 'risk',
      tone: 'warn',
      chipLabel: 'pre-commitment mismatch',
      chipTone: 'warn',
      detail: `Predicted "${mismatch.expect}"; got "${mismatch.outcome}". Counted and diffed against the prediction, never auto-collapsed.`,
      meta: riskMeta(ticket),
    };
  }

  if (ticket.risk.score > 0) {
    const summary = summarizeCumulativeRisk(ticket.risk);
    return {
      icon: 'risk',
      tone: 'warn',
      chipLabel: 'risk elevated',
      chipTone: 'warn',
      detail: summary.text,
      meta: riskMeta(ticket),
    };
  }

  if (ticket.worktree) {
    return {
      icon: 'hand',
      tone: 'neutral',
      chipLabel: 'worktree active',
      chipTone: 'neutral',
      detail: `Implement has provisioned a worktree for this ticket on branch ${ticket.worktree.branch}.`,
      meta: `branch ${ticket.worktree.branch}`,
    };
  }

  if (ticket.lane === 'working') {
    const isRefine = ticket.phase === 'refine';
    const isReview = ticket.phase === 'review';
    const chipLabel = isRefine ? 'refining' : isReview ? 'reviewing' : 'implementing';
    const phaseTitle = isRefine ? 'Refine' : isReview ? 'Review' : 'Implement';
    return {
      icon: 'clock',
      tone: 'neutral',
      chipLabel,
      chipTone: 'warn',
      detail: `${phaseTitle} is currently running for this ticket.`,
      meta: attemptsMeta(ticket),
    };
  }

  return {
    icon: 'clock',
    tone: 'neutral',
    chipLabel: 'queued',
    chipTone: 'neutral',
    detail: 'Accepted and queued — not started yet.',
    meta: estimateMeta(ticket),
  };
}

/** Re-exported so a caller that wants the raw threshold (e.g. a test asserting the boundary
 *  between "risk elevated" and "risk threshold crossed") does not need its own import of
 *  `cumulative-risk.ts`. */
export { RISK_SCORE_THRESHOLD };
