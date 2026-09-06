import type { ReactNode } from 'react';
import { Icon } from './Icon.js';

/**
 * The two card note blocks from Foundations.dc.html's "Cards" section, both `.card-foot`-
 * adjacent siblings rather than dialogs: a parked card names *why* it stopped rather than just
 * that it did.
 *
 * `FailNote`: a red warning icon, for a ticket parked after repeated failures (e.g. "Parked after
 * 3 failures" -- the canvas's own examples read "Last attempt: vitest timed out..." and
 * "typecheck failed on PR #115..."). `WaitNote`: an amber pause icon, for a ticket held by
 * bounded-concurrency file overlap -- naming the overlapping file and the ticket holding it (e.g.
 * "Waiting — file overlap with #94. Both plan to touch `stdio-mcp-connection.ts`.").
 *
 * Neither renders its own action button: in the canvas, the note's card still ends in a normal
 * `CardFoot` with age on the left and one button on the right (a ghost "Run anyway" for a held
 * card, a "Retry with note" for a failed one) -- keeping the button in the foot rather than the
 * note means the note stays reusable as a plain informational block wherever else a "here's what
 * happened, and why" line is needed.
 */
export function FailNote({ children }: { children: ReactNode }) {
  return (
    <div className="fail-note">
      <Icon name="warning" size="sm" />
      <span>{children}</span>
    </div>
  );
}

export function WaitNote({ children }: { children: ReactNode }) {
  return (
    <div className="wait-note">
      <Icon name="pause" size="sm" />
      <span>{children}</span>
    </div>
  );
}
