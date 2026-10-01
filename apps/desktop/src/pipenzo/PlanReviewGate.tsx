import { useState } from 'react';
import { Notice } from '../components/primitives/Notice.js';
import { PlanReviewPanel } from './PlanReview.js';
import { useTicketPlanReview } from './use-plan-review.js';

/**
 * `TicketDetailContainer`'s live plan-review slot (issue #15, UI half #101) -- the
 * `RunControlsPanel`/`PhaseStepperPanel` shape applied to the plan-review gate: a thin component
 * over `useTicketPlanReview`'s real bridge calls, rendered only while the container's own
 * `ticket.planReview` says there is something to decide (see `TicketDetailContainer.tsx`'s own
 * conditional, mirroring `RefusalPanel`'s).
 *
 * Renders nothing while `capturePlanReview` is still loading or failed -- the same "no absent
 * state" restraint `RunControlsPanel`'s own doc comment states, rather than a placeholder card
 * asserting a plan this component does not yet have. A capture failure most often means the ticket
 * was already decided elsewhere between the board listing this ticket and this screen opening it;
 * the next phase event updates `TicketDetailContainer`'s own ticket prop and this component simply
 * stops being rendered, the true state either way.
 *
 * Each action is fire-and-forget from this component's own perspective, the same reasoning
 * `RunControlsPanel`'s `onStop`/`onSteer` already use: a successful decide is observed through the
 * next phase event removing `ticket.planReview`, not through an optimistic local state here. A
 * failure is the one thing this component does keep, as a dismissible `Notice`, since silently
 * swallowing a failed Approve/Request-changes/Reject click would leave a human thinking their
 * decision landed when it did not.
 */
export function PlanReviewGate({ ticketId, repo }: { ticketId: string; repo: string }) {
  const { state, approve, requestChanges, reject } = useTicketPlanReview(ticketId, repo);
  const [failure, setFailure] = useState<string>();

  if (state.status !== 'ready') return null;

  const onFailed = (action: string) => (error: unknown) => {
    setFailure(`${action} failed: ${error instanceof Error ? error.message : 'the request failed'}`);
  };

  return (
    <>
      {failure && (
        <Notice tone="danger" icon="warning" quiet title={failure}>
          Nothing else changed -- this ticket is still awaiting plan review.
        </Notice>
      )}
      <PlanReviewPanel
        spec={state.spec}
        onApprove={() => {
          setFailure(undefined);
          void approve().catch(onFailed('Approve'));
        }}
        onRequestChanges={(feedback) => {
          setFailure(undefined);
          void requestChanges(feedback).catch(onFailed('Request changes'));
        }}
        onReject={(reason) => {
          setFailure(undefined);
          void reject(reason).catch(onFailed('Reject'));
        }}
      />
    </>
  );
}
