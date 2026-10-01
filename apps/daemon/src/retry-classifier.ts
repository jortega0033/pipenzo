import {
  MODEL_TIERS,
  PIPENZO_NEEDS_HUMAN_FAILED_ATTEMPT_THRESHOLD,
  modelTierRank,
  type ModelTier,
  type PipenzoTicketApprovalRejectionV1,
  type PipenzoTicketAttemptV1,
} from '@agent-dock/shared';

/**
 * The "Retry phase" classifier (Pipenzo issue #105): a pure, synchronous read of a ticket's own
 * real fields, deciding exactly one of four things a retry can be -- same-tier fork, tier-escalation
 * fresh session, or one of two structural refusals. This module makes no dispatch, no GitHub call,
 * and no filesystem read; `PipenzoPhaseService.retryImplement()` is the effectful half that acts on
 * what this returns, the same split `risk-score.ts`'s pure engine and `PipenzoPhaseMachine`'s own
 * wiring already keep.
 *
 * This is CLAUDE.md hard rule 4's entire spec, read literally:
 *
 * > A denied approval is never auto-retried. Classified retry escalates model tier, not human
 * > judgment. Tier escalation uses a fresh session, not `session.fork` -- agentdock freezes
 * > `selectedModel` into a fork's continuation scope, so a fork *cannot* change model.
 *
 * ## Why "denied approval" is checked before attempt count
 *
 * A ticket could in principle carry both signals at once -- rejected on its first attempt, so it
 * has not yet reached the 3-attempt park threshold. Checking `lastApprovalRejection` first means a
 * human's explicit "no" refuses a retry immediately, rather than a caller seeing "eligible, 1 of 3
 * attempts used" and inferring a rejected ticket is still fair game until it racks up two more
 * failures it will never be allowed to make.
 *
 * ## Why tier escalation, not a flat "always fork" or "always fresh"
 *
 * README's *Model routing* section: "retries escalate tier before they escalate to a human, with a
 * capped number of attempts throughout." `MODEL_TIERS` (`cheap` < `mid` < `frontier`) is already the
 * codebase's own ascending-strength ladder (`modelTierRank`, built for the reviewer/verifier
 * same-or-higher rule in `pipenzo-review-v1.ts`); this reuses it rather than inventing a second
 * escalation ordering. A retry whose last attempt has not yet reached `frontier` bumps one rung up
 * that ladder and dispatches a fresh session there -- there is a higher tier to escalate to, so it
 * does. A retry whose last attempt is already at `frontier` has nowhere higher left to go: forking
 * keeps it at the same (already-highest) tier, which is the one case a fork is honest about, because
 * a fork cannot change model in the first place (the hard rule's own reasoning) and this path never
 * asks it to.
 */

/** The ticket fields `classifyRetry()` actually reads -- narrower than `PipenzoTicketRecordV1`
 *  (or `PipenzoTicketViewV1`) so a caller on either side of the daemon/desktop boundary can classify
 *  from whichever shape it already has, without this module importing either. */
export interface RetryClassifierTicket {
  readonly attempts: readonly PipenzoTicketAttemptV1[];
  readonly lastApprovalRejection?: PipenzoTicketApprovalRejectionV1;
}

/** Why `classifyRetry()` refused -- a closed union, unlike `attempt.outcome`'s own still-moving
 *  bounded string, because these two refusal reasons are this module's own vocabulary, not
 *  something a provider or a future phase-machine outcome could add a third member to later. */
export const RETRY_REFUSAL_REASONS = ['no_attempts', 'denied_approval', 'max_retries_reached'] as const;
export type RetryRefusalReason = (typeof RETRY_REFUSAL_REASONS)[number];

export type RetryClassification =
  | {
      readonly eligible: true;
      /** `'fork'`: same tier, `session.fork`-eligible. `'fresh'`: a tier escalation, which must
       *  never be dispatched through a fork -- see this module's own doc comment. */
      readonly mode: 'fork' | 'fresh';
      readonly tier: ModelTier;
    }
  | {
      readonly eligible: false;
      readonly reason: RetryRefusalReason;
    };

/**
 * Classifies a retry against a ticket's own real `attempts[]`/`lastApprovalRejection`. Never
 * throws, never performs I/O -- the full contract is in this module's own doc comment.
 */
export function classifyRetry(ticket: RetryClassifierTicket): RetryClassification {
  // CLAUDE.md hard rule 4, checked first and unconditionally: a denied approval refuses a retry
  // regardless of how few attempts the ticket has made.
  if (ticket.lastApprovalRejection) {
    return { eligible: false, reason: 'denied_approval' };
  }

  const last = ticket.attempts.at(-1);
  if (!last) {
    return { eligible: false, reason: 'no_attempts' };
  }

  // README's "park after 3 failures": the needs-human lane's own threshold (issue #86), reused
  // verbatim rather than a second magic number -- see `PIPENZO_NEEDS_HUMAN_FAILED_ATTEMPT_THRESHOLD`'s
  // own doc comment for why this constant lives in `@agent-dock/shared` rather than being redefined
  // here or imported from the desktop-only `needs-human-card.ts`.
  if (ticket.attempts.length >= PIPENZO_NEEDS_HUMAN_FAILED_ATTEMPT_THRESHOLD) {
    return { eligible: false, reason: 'max_retries_reached' };
  }

  const rank = modelTierRank(last.tier);
  const atHighestTier = rank >= MODEL_TIERS.length - 1;
  if (atHighestTier) {
    return { eligible: true, mode: 'fork', tier: last.tier };
  }
  const nextTier = MODEL_TIERS[rank + 1];
  if (!nextTier) {
    // Unreachable given `atHighestTier` above, but keeps this function total rather than asserting
    // a non-null index into a table this module does not own the length of.
    return { eligible: true, mode: 'fork', tier: last.tier };
  }
  return { eligible: true, mode: 'fresh', tier: nextTier };
}
