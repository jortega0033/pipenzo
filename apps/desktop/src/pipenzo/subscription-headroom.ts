import type { PipenzoTicketAttemptV1, PipenzoTicketBudgetV1 } from '@agent-dock/shared';

/**
 * The Subscription headroom rail block's numbers (`TicketDetail.dc.html`'s "Subscription
 * headroom" block, issue #96) -- pure math over issue #143's real per-ticket budget tracking
 * (`PipenzoTicketRecordV1.budget`, written by `PipenzoPhaseMachine.recordTokenUsage()`), never a
 * separate accounting scheme invented for this rail block.
 *
 * **Scoped to this ticket, not to the whole app.** The canvas's own build note (right above the
 * block in `TicketDetail.dc.html`) describes "how many sessions this app has run in the window,
 * and the tokens they cost" -- an app-wide, time-windowed figure. No such aggregation exists
 * anywhere in this codebase today: `PipenzoTicketBudgetV1` and `PipenzoTicketRecordV1.attempts[]`
 * are both per-ticket, `attempts[]` carries no timestamp to window by, and building a cross-ticket,
 * time-windowed usage store would be daemon-side infrastructure well past what a single rail-block
 * ticket can honestly claim. Reporting *this ticket's* real sessions and real token spend against
 * *this ticket's* real budget is what issue #143 actually gives us to reuse -- so that is what this
 * reports, worded as the ticket's own headroom rather than a windowed figure this data cannot back.
 */

export interface HeadroomSummary {
  /** `attempts.length` -- every Implement dispatch recorded against this ticket. Refine and Review
   *  passes also spend from the same budget (see `tokensUsed` below) but record no attempt of
   *  their own, so this count is a floor on "sessions", not a total -- see `estimateText`'s own
   *  caveat about the same gap. */
  readonly sessions: number;
  readonly tokensUsed: number;
  /** `0` means "no limit configured" (`pipenzoTicketBudgetV1Schema`'s own documented meaning),
   *  never "zero tokens allowed". */
  readonly limit: number;
  /** `"~N sessions remaining"`, or `undefined` when there is nothing honest to divide by: no limit
   *  configured, or no attempt yet to measure an average session's cost from. Never a guess -- see
   *  `computeHeadroom()`. */
  readonly estimateText?: string;
}

/** `1,234` under 10,000; `~12k` / `~3.4M` above it -- the same rounding the canvas's own "~412k"
 *  sample already accepts, applied to a real number instead of a mock one. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 10_000) return tokens.toLocaleString('en-US');
  if (tokens < 1_000_000) return `~${Math.round(tokens / 1_000)}k`;
  return `~${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * `attempts` and `budget` are `PipenzoTicketRecordV1.attempts`/`.budget` -- real, persisted ticket
 * data (issue #143), not a mock shape.
 *
 * The remaining-sessions estimate divides `budget.tokensUsed` by `attempts.length` for an average
 * cost per Implement dispatch, then divides the remaining headroom (`limit - tokensUsed`) by that
 * average. Both a `limit` of `0` (unconfigured) and an `attempts.length` of `0` (nothing to average
 * from yet -- Refine may have spent tokens with no attempt recorded, per this module's own doc
 * comment) leave `estimateText` `undefined` rather than a division that would print `Infinity` or a
 * number with nothing real behind it.
 */
export function computeHeadroom(
  attempts: readonly PipenzoTicketAttemptV1[],
  budget: PipenzoTicketBudgetV1,
): HeadroomSummary {
  const sessions = attempts.length;
  const { tokensUsed, limit } = budget;
  let estimateText: string | undefined;
  if (limit > 0 && sessions > 0 && tokensUsed > 0) {
    const averagePerSession = tokensUsed / sessions;
    const remaining = Math.max(limit - tokensUsed, 0);
    const sessionsRemaining = Math.floor(remaining / averagePerSession);
    estimateText = `~${sessionsRemaining} session${sessionsRemaining === 1 ? '' : 's'} remaining`;
  }
  return { sessions, tokensUsed, limit, ...(estimateText ? { estimateText } : {}) };
}

/**
 * The honest "no provider reports a quota" line (issue #96), worded to match
 * `TicketDetail.dc.html`'s own `.f-help` sentence under the Subscription headroom block as closely
 * as this codebase's real facts allow. Verified against the provider adapters this rail block would
 * otherwise have to guess at: neither `apps/daemon/src/provider-v2.ts` nor `providers.ts` exposes a
 * rate-limit or quota figure for either provider (`PROVIDER_IDS`: `'claude' | 'codex'`) -- every
 * `quota`/`rateLimit` hit elsewhere in the daemon is GitHub's API quota (issue #229/#161) or the
 * attachment store's own disk quota, neither of which is a subscription figure for an AI provider.
 * A static, checked-true sentence, not a placeholder standing in for data that does not exist.
 */
export const NO_PROVIDER_QUOTA_TEXT =
  "Counted locally from this app's own runs — no provider reports a quota, so there is no percentage and no reset to show.";
