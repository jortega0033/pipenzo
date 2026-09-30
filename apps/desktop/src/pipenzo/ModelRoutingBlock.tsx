import type { LlmReviewPassV1, PipenzoTicketAttemptV1, VerifierPassV1 } from '@agent-dock/shared';
import { RailBlock } from '../components/primitives/RailBlock.js';
import { KvRow } from '../components/primitives/KvRow.js';
import { modelRoutingRows } from './model-routing.js';

/**
 * `TicketDetail.dc.html`'s "Model routing" rail block (issue #96) -- the third of the rail's four
 * fixed blocks (`TicketDetailScreen.tsx`'s `modelRoutingBlock` slot). One `KvRow` per phase
 * `modelRoutingRows()` has real data for; see that function's own doc comment for why a Refine row
 * never appears. An empty result (no Implement attempt and no review pass yet) renders one honest
 * sentence rather than three empty rows or three fabricated ones.
 */
export function ModelRoutingBlock({
  attempts,
  reviewer,
  verifier,
}: {
  attempts: readonly PipenzoTicketAttemptV1[];
  reviewer?: LlmReviewPassV1;
  verifier?: VerifierPassV1;
}) {
  const rows = modelRoutingRows(attempts, reviewer, verifier);
  return (
    <RailBlock label="Model routing">
      {rows.length === 0 ? (
        <span className="f-help">No session has run against this ticket yet.</span>
      ) : (
        rows.map((row) => <KvRow key={row.phase} k={row.phase} v={row.value} tone={row.tone} />)
      )}
    </RailBlock>
  );
}
