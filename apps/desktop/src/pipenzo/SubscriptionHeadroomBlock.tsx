import type { PipenzoTicketAttemptV1, PipenzoTicketBudgetV1 } from '@agent-dock/shared';
import { RailBlock } from '../components/primitives/RailBlock.js';
import { KvRow } from '../components/primitives/KvRow.js';
import { computeHeadroom, formatTokenCount, NO_PROVIDER_QUOTA_TEXT } from './subscription-headroom.js';

/**
 * `TicketDetail.dc.html`'s "Subscription headroom" rail block (issue #96) -- the fourth and last
 * of the rail's four fixed blocks (`TicketDetailScreen.tsx`'s `headroomBlock` slot). The `estimate`
 * self-tag on the label is the canvas's own: this whole block is a derived approximation, never a
 * real provider-reported quota (see `NO_PROVIDER_QUOTA_TEXT`'s own doc comment for why no such
 * quota exists to show instead).
 *
 * Three rows, not the canvas's two: "Sessions" and "Tokens used" are the canvas's own pair
 * (renamed from "Sessions this window" -- see `subscription-headroom.ts`'s doc comment on why this
 * block is scoped to the ticket rather than a time window nothing here tracks), and "Est.
 * remaining" is the estimate the issue itself asks for ("sessions-and-tokens headroom block *with
 * estimate tag*") that the static canvas mock does not compute a value for. It is omitted, not
 * shown as a guess, when `computeHeadroom()` has nothing honest to divide by.
 */
export function SubscriptionHeadroomBlock({
  attempts,
  budget,
}: {
  attempts: readonly PipenzoTicketAttemptV1[];
  budget: PipenzoTicketBudgetV1;
}) {
  const headroom = computeHeadroom(attempts, budget);
  return (
    <RailBlock
      label={
        <>
          Subscription headroom<span className="self-tag">estimate</span>
        </>
      }
    >
      <KvRow k="Sessions" v={headroom.sessions} />
      <KvRow k="Tokens used" v={formatTokenCount(headroom.tokensUsed)} />
      {headroom.estimateText && <KvRow k="Est. remaining" v={headroom.estimateText} />}
      <span className="f-help" style={{ marginTop: -4 }}>
        {NO_PROVIDER_QUOTA_TEXT}
      </span>
    </RailBlock>
  );
}
