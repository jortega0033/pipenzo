import { RailBlock } from '../components/primitives/RailBlock.js';
import { Icon } from '../components/primitives/Icon.js';
import { summarizeCumulativeRisk, type CumulativeRiskInput } from './cumulative-risk.js';

/**
 * `TicketDetail.dc.html`'s "Cumulative risk" rail block (issue #95) -- the second of the rail's
 * four fixed blocks (`TicketDetailScreen.tsx`'s `riskBlock` slot, alongside `ModelRoutingBlock`/
 * `SubscriptionHeadroomBlock` from issue #96 and the status block from #94). Renders
 * `apps/daemon/src/risk-score.ts`'s real, persisted `RiskScoreState` (issue #158) via
 * `PipenzoTicketRiskV1` on the wire -- see `cumulative-risk.ts`'s own doc comment for why the text
 * here is a plain, honest sentence rather than the canvas mock's per-category breakdown, which
 * this codebase has no data to back.
 *
 * The ten segments, the label line, and the promotion banner are exactly
 * `TicketDetail.dc.html`'s own `.risk-strip`/`.risk-segs`/`.risk-lbl`/`.risk-promo` markup and CSS
 * (already ported to `pipenzo-theme.css`) -- this component only supplies the classes and text,
 * the same split `SubscriptionHeadroomBlock.tsx` draws between `RailBlock`'s shell and its own
 * content.
 */
export function CumulativeRiskStrip({ risk }: { risk: CumulativeRiskInput }) {
  const summary = summarizeCumulativeRisk(risk);
  return (
    <RailBlock label="Cumulative risk">
      <div className="risk-strip">
        <div className="risk-segs">
          {summary.segments.map((segment, index) => (
            <span
              key={index}
              className={
                segment.on ? `risk-seg on${segment.tone ? ` ${segment.tone}` : ''}` : 'risk-seg'
              }
            />
          ))}
        </div>
        <div className="risk-lbl">
          <span>
            <b>{summary.level}</b> — {summary.text}
          </span>
          <span className="mono">{summary.countText}</span>
        </div>
        {summary.promoted && (
          <div className="risk-promo">
            <Icon name="warning" size="sm" />
            <span>
              <b>Next MEDIUM asks as HIGH.</b> {summary.promoText}
            </span>
          </div>
        )}
      </div>
    </RailBlock>
  );
}
