import type { ReactNode } from 'react';
import { IconButton } from './IconButton.js';

/**
 * `.stack-row` -- one editable entry in a proposed PR stack, from Foundations.dc.html's "Cards"
 * section and TicketDetail.dc.html's stack-approval panel (identical markup; TicketDetail wires
 * `onMoveUp`/`onMoveDown` to reorder the whole list before Accept). `index` is the `x/n` position
 * (shared `.split-n` styling with the split block); `meta` is the mono estimate/base-PR line
 * (`"≈ 110 lines · 4 files · base PR 1"` on the board, `"{{est}} · base {{base}}"` in the gate).
 *
 * Once a stack is accepted, this row disappears -- Stack.tsx's `Kids`/`Kid` read-only rows take
 * over, per the canvas's own note: "After accept, rows become read-only kid rows that link out."
 * There is no shared component between the two states because the shapes genuinely differ (a
 * reorderable title+meta pair vs. a status-icon+title+id+external-link row); this ticket only
 * covers the editable-before-accept row.
 */
export function StackRow({
  index,
  title,
  meta,
  canMoveUp = true,
  canMoveDown = true,
  onMoveUp,
  onMoveDown,
}: {
  /** The `x/n` position, e.g. `"2/3"`. */
  index: ReactNode;
  title: ReactNode;
  /** The mono estimate/base-PR line. */
  meta: ReactNode;
  /** Disables the up control -- the top row can't move further up. */
  canMoveUp?: boolean;
  /** Disables the down control -- the bottom row can't move further down. */
  canMoveDown?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  return (
    <div className="stack-row">
      <span className="split-n">{index}</span>
      <span className="s-body">
        <span className="s-title">{title}</span>
        <span className="s-meta">{meta}</span>
      </span>
      <span className="s-ctl">
        <IconButton icon="arrow-up" aria-label="Move up" disabled={!canMoveUp} onClick={onMoveUp} />
        <IconButton
          icon="arrow-down"
          aria-label="Move down"
          disabled={!canMoveDown}
          onClick={onMoveDown}
        />
      </span>
    </div>
  );
}
