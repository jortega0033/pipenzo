import type { ReactNode } from 'react';

/**
 * One `.kv` row from a rail block (`TicketDetail.dc.html`'s `.kv`/`.k`/`.v` rule) -- a label on the
 * left, a right-aligned mono value on the right. Generic on purpose: `TicketDetail.dc.html`'s
 * Status block (#94), Model routing (#96), and Subscription headroom (#96) all render the same
 * shape, and this is the one place that markup is written rather than three copies drifting apart.
 *
 * `tone` mirrors the canvas's own `.v.warn`/`.v.danger`/`.v.faint` modifiers -- CSS already carries
 * all three (`pipenzo-theme.css`'s `.kv .v` rule), so this only ever adds the matching class name.
 */
export function KvRow({
  k,
  v,
  tone,
}: {
  k: ReactNode;
  v: ReactNode;
  tone?: 'warn' | 'danger' | 'faint';
}) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className={tone ? `v ${tone}` : 'v'}>{v}</span>
    </div>
  );
}
