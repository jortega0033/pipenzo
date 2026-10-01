import { useCallback } from 'react';
import type { PipenzoRetryRequestV1, PipenzoRetryResultV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';

/**
 * "Retry phase" (issue #105, CLAUDE.md hard rule 4): the renderer-side caller for
 * `PipenzoPhaseService.retryImplement()`, mirroring `use-ticket-run-controls.ts`'s own thin-hook
 * shape for Steer/Stop. Deliberately carries no local "is this ticket retriable" state of its own --
 * `RetryActionButton.tsx` derives that straight from the ticket's own real fields
 * (`labels`/`attempts`/`lastApprovalRejection`), the same `PipenzoTicketViewV1` the board already
 * holds, rather than this hook polling a second source of truth for it.
 *
 * Rejects with the daemon's own error for every one of CLAUDE.md hard rule 4's structural refusals
 * (`approval_denied`, `max_retries_reached`, `not_parked`, `run_still_active`, `fork_unavailable`)
 * -- a caller shows that rather than assuming success, the same contract `steer()`'s own doc comment
 * states for a session that is not running right now.
 */
export function useTicketRetry(ticketId: string): {
  retry: () => Promise<PipenzoRetryResultV1>;
} {
  const retry = useCallback(async () => {
    const request: PipenzoRetryRequestV1 = { ticketId };
    return getBridge().retryPipenzo(request);
  }, [ticketId]);

  return { retry };
}
