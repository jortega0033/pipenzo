import { useCallback, useEffect, useState } from 'react';
import type { PipenzoPlanReviewDecideResultV1, PipenzoPlanReviewSpecV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { BOARD_IMPLEMENT_PROVIDER } from './BoardImplementDialog.js';

/**
 * A single ticket's live plan-review state (issue #15, UI half #101), the `PlanReview.tsx`
 * counterpart to `use-ticket-run-controls.ts`'s run state — same shape, same reasoning: `loading`
 * before the first `capturePlanReview` call lands, `ready` with the real frozen plan and the
 * `approvalId` `decide` will need, `error` when the daemon could not be asked (including the
 * ordinary case where the ticket was decided elsewhere between this screen opening and the capture
 * call landing — the panel simply stops rendering once the next phase event refreshes this
 * container's own ticket list, the same way `RunControlsPanel` lets its own `run.live` go false
 * rather than second-guessing it here).
 */
export type TicketPlanReviewState =
  | { status: 'loading' }
  | { status: 'ready'; spec: PipenzoPlanReviewSpecV1 }
  | { status: 'error' };

/**
 * Captures once per `ticketId` (never re-captured on a phase event -- unlike `useTicketRunControls`,
 * there is no "this ticket's own state changed, refresh" case that matters here: `decide()` either
 * succeeds, after which this ticket no longer carries `planReview` on the next board/phase-event
 * refresh and `TicketDetailContainer` stops rendering this hook's caller at all, or it fails, in
 * which case the same captured `approvalId` is still exactly as valid as it was).
 *
 * ## `approve`'s repository checkout, resolved the same way the board already does
 *
 * `BoardImplementDialog.tsx` already resolves `repositoryPath` from nothing but `ticket.repo` via
 * `resolvePipenzoCheckout` (the daemon clones a connected repo into its own managed directory on
 * first need, issue #342/#344) and runs on the same fixed `BOARD_IMPLEMENT_PROVIDER` -- this reuses
 * both rather than asking `TicketDetailContainer` for a `cwd`/provider it is not given either,
 * closing the gap `RefusalPanel`'s own `onRetryRefine` is still left unwired for in that same
 * container. An untrusted workspace is not pre-checked here the way `BoardImplementDialog`'s own
 * richer flow does (no "Trust this checkout" prompt) -- `approve()` simply surfaces the daemon's own
 * `workspace_untrusted` failure like any other decide error, which is honest, if less polished, and
 * does not grant trust on anyone's behalf.
 */
export function useTicketPlanReview(
  ticketId: string,
  repo: string,
): {
  state: TicketPlanReviewState;
  /** Dispatches Implement with the frozen plan. Rejects with the daemon's own error (e.g. a
   *  `plan_review_pending`-adjacent `approval_not_found`, or `workspace_untrusted`) when it cannot
   *  — a caller surfaces that rather than assuming success. */
  approve: () => Promise<PipenzoPlanReviewDecideResultV1>;
  /** Sends the plan back to Refine with `feedback`, which the next `refine()` call for this ticket
   *  reads back. */
  requestChanges: (feedback: string) => Promise<void>;
  /** Parks the ticket under the bare `pipenzo:needs-human` label with `reason` posted to the
   *  issue. */
  reject: (reason: string) => Promise<void>;
} {
  const [state, setState] = useState<TicketPlanReviewState>({ status: 'loading' });
  const [approvalId, setApprovalId] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    setApprovalId(undefined);
    void getBridge()
      .capturePlanReview({ ticketId })
      .then((result) => {
        if (cancelled) return;
        setApprovalId(result.approvalId);
        setState({ status: 'ready', spec: result.spec });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  const approve = useCallback(async (): Promise<PipenzoPlanReviewDecideResultV1> => {
    if (!approvalId) throw new Error('no pending plan review to approve');
    const { repositoryPath } = await getBridge().resolvePipenzoCheckout({ repo });
    return getBridge().decidePlanReview({
      ticketId,
      approvalId,
      decision: 'approve',
      implement: { repositoryPath, provider: BOARD_IMPLEMENT_PROVIDER },
    });
  }, [ticketId, approvalId, repo]);

  const requestChanges = useCallback(
    async (feedback: string): Promise<void> => {
      if (!approvalId) throw new Error('no pending plan review to send back');
      await getBridge().decidePlanReview({
        ticketId,
        approvalId,
        decision: 'request_changes',
        feedback,
      });
    },
    [ticketId, approvalId],
  );

  const reject = useCallback(
    async (reason: string): Promise<void> => {
      if (!approvalId) throw new Error('no pending plan review to reject');
      await getBridge().decidePlanReview({ ticketId, approvalId, decision: 'reject', reason });
    },
    [ticketId, approvalId],
  );

  return { state, approve, requestChanges, reject };
}
