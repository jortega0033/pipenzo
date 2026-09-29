import type { ReactNode } from 'react';

/**
 * One `.rail-block` from `TicketDetail.dc.html`'s right rail (issue #90) -- a label plus whatever
 * rows the block's own owner puts under it: Status (#94), Cumulative risk (#95), Model routing and
 * Subscription headroom (#96). This is only the label + surface shell, the same split
 * `VerificationBlock.tsx` draws for DiffReview's own rail -- the shell is real, generic
 * infrastructure; the content inside each block is each of those tickets' own decision, not
 * guessed at here.
 */
export function RailBlock({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="rail-block">
      <span className="label">{label}</span>
      {children}
    </div>
  );
}
