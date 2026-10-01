import { useState } from 'react';
import {
  PIPENZO_NEEDS_HUMAN_FAILED_ATTEMPT_THRESHOLD,
  type PipenzoTicketViewV1,
} from '@agent-dock/shared';
import { useTicketRetry } from './use-ticket-retry.js';

type RetryActionState = { status: 'idle' } | { status: 'retrying' } | { status: 'error'; message: string };

/**
 * `TicketDetailScreen`'s header, alongside `RunControlsPanel` (issue #105, CLAUDE.md hard rule 4):
 * `TicketDetail.dc.html`'s "Retry phase" header action. Renders nothing at all -- the same
 * "no absent state" rule `RunControls.tsx`'s own doc comment already established for live run
 * controls -- unless every one of this ticket's own real fields says a retry genuinely applies:
 *
 * - **Parked on `pipenzo:needs-human`.** The canvas's own "visible for a ticket in a state where
 *   retry makes sense" condition -- there is nothing to retry from any other lane.
 * - **No `lastApprovalRejection` on file.** CLAUDE.md hard rule 4's own words: "a denied approval is
 *   never auto-retried." This button does not even offer the choice.
 * - **Fewer than `PIPENZO_NEEDS_HUMAN_FAILED_ATTEMPT_THRESHOLD` (3) attempts made**, and at least
 *   one -- a ticket with none has nothing dispatched yet to retry, and one that has already made
 *   three is parked for that reason, not an approval denial, and is past this action's own limit.
 *
 * None of this is the only enforcement: `PipenzoPhaseService.retryImplement()` re-checks every one
 * of these fields itself, server-side, and refuses with a real error for each — a UI-hidden button
 * is never, on its own, what CLAUDE.md hard rule 4 depends on. This component's own job is only to
 * not offer a human a button that the daemon would refuse anyway.
 */
export function RetryActionButton({ ticket }: { ticket: PipenzoTicketViewV1 }) {
  const { retry } = useTicketRetry(ticket.ticketId);
  const [state, setState] = useState<RetryActionState>({ status: 'idle' });

  const eligible =
    ticket.labels.includes('pipenzo:needs-human') &&
    !ticket.lastApprovalRejection &&
    ticket.attempts.length > 0 &&
    ticket.attempts.length < PIPENZO_NEEDS_HUMAN_FAILED_ATTEMPT_THRESHOLD;

  if (!eligible) return null;

  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={state.status === 'retrying'}
        onClick={() => {
          setState({ status: 'retrying' });
          void retry()
            .then(() => setState({ status: 'idle' }))
            .catch((error: unknown) => {
              setState({
                status: 'error',
                message: error instanceof Error ? error.message : 'the retry could not be started',
              });
            });
        }}
      >
        Retry phase
      </button>
      {state.status === 'error' && <span className="f-help">{state.message}</span>}
    </>
  );
}
