import type { ReactNode } from 'react';
import { Icon } from './Icon.js';

/**
 * The passive LOW-risk activity-stream line from Foundations.dc.html's "Risk-graded approval"
 * section: 12px, text-faint throughout, an 8px timestamp instead of the 28px event icon every
 * other stream row carries. No chip, no card, no notification -- a LOW action proceeds and is
 * only logged, but it still counts +0.5 on the cumulative risk strip below.
 */
export function LowLine({
  time,
  tag,
  children,
}: {
  time: ReactNode;
  /** The trailing mono tag, e.g. "LOW · auto". */
  tag: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="low-line">
      <span className="mono">{time}</span>
      <span className="lt">{children}</span>
      <span className="mono">{tag}</span>
    </div>
  );
}

const SEGMENT_COUNT = 10;

/**
 * The cumulative-risk strip from Foundations.dc.html's "Risk-graded approval" section: 10
 * segments, one per point of the promotion threshold, filled green (index 0-3) → amber (4-6) →
 * red (7-9) purely by position -- not by how "bad" the score is, since the fill count is what
 * carries severity. `score` is fractional (LOW +0.5, MEDIUM +1, a pre-commitment mismatch +3,
 * HIGH +0) and is rounded to the nearest whole segment; only a HIGH approval or opening the
 * ticket's Activity view resets it to zero. `children` is the `.risk-lbl` sentence ("Calm — 2
 * low-risk actions (1.0) since your last look"); the trailing "`score` / 10" mono readout is
 * derived automatically rather than repeated by every caller. `promo` is the optional
 * `.risk-promo` note shown once the strip reaches the threshold ("Next MEDIUM asks as HIGH.").
 */
export function RiskStrip({
  score,
  children,
  promo,
}: {
  score: number;
  children: ReactNode;
  promo?: ReactNode;
}) {
  const filled = Math.max(0, Math.min(SEGMENT_COUNT, Math.round(score)));

  return (
    <div className="risk-strip">
      <div className="risk-segs">
        {Array.from({ length: SEGMENT_COUNT }, (_, index) => {
          const on = index < filled;
          const tier = index < 4 ? '' : index < 7 ? ' warm' : ' hot';
          return <span key={index} className={on ? `risk-seg on${tier}` : 'risk-seg'} />;
        })}
      </div>
      <div className="risk-lbl">
        <span>{children}</span>
        <span className="mono">{score.toFixed(1)} / {SEGMENT_COUNT}</span>
      </div>
      {promo && (
        <div className="risk-promo">
          <Icon name="warning" size="sm" />
          <span>{promo}</span>
        </div>
      )}
    </div>
  );
}
