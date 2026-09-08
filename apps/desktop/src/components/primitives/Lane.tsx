import type { CSSProperties, ReactNode } from 'react';

/**
 * The kanban board's own shell (issue #81) — `Main.dc.html`'s `.board` grid of four `.lane`
 * columns, each a `.lane-head` (dot + title + count) over a `.lane-cards` well that scrolls
 * independently of the other three.
 *
 * Structural only. What a lane's cards look like is `Card.tsx`'s job
 * (`Foundations.dc.html`'s "Cards" section), and which state-specific body each one carries is
 * split across #85 (Working's capacity/held cards), #86 (Needs-human's seven variants) and #87
 * (Ready-for-review + ci-failed) — this file renders none of them, only the well they go in. See
 * `board-lanes.ts` for the lane list itself and `BoardScreen.tsx` for how the two combine.
 */

/** `.board` — the four-column grid `AppShell`'s `.main` renders below its own `MainHead`. */
export function Board({ children }: { children: ReactNode }) {
  return <div className="board">{children}</div>;
}

/** `.lane` — one board column: a fixed-height `LaneHead` over a `LaneCards` well that grows to
 * fill the rest of the column. */
export function Lane({ children }: { children: ReactNode }) {
  return <div className="lane">{children}</div>;
}

/** `.lane-head` — 40px tall, `LaneTitle` on the left and whatever a lane wants on its right (a
 * `LaneCount`, and for Working's own header only, its `LaneCap` capacity pill — #85, not built
 * here) laid out `justify-content: space-between`. */
export function LaneHead({ children }: { children: ReactNode }) {
  return <div className="lane-head">{children}</div>;
}

/** `.lane-title` — the `.lane-dot` plus the lane's name, uppercase and mono-tracked per the
 * canvas. `dotColor` is one of the design system's semantic CSS custom properties (see
 * `board-lanes.ts`'s `BOARD_LANES`), set inline exactly as `Main.dc.html`'s own markup does. */
export function LaneTitle({ dotColor, children }: { dotColor: string; children: ReactNode }) {
  const dotStyle: CSSProperties = { background: dotColor };
  return (
    <span className="lane-title">
      <span className="lane-dot" style={dotStyle} />
      {children}
    </span>
  );
}

/** `.lane-count` — the mono ticket count on the lane head's right edge. Always rendered, `0`
 * included: `Foundations.dc.html`'s own empty-state rule is that the count staying put is what
 * keeps an empty lane from reading as one that failed to load. */
export function LaneCount({ children }: { children: ReactNode }) {
  return <span className="lane-count">{children}</span>;
}

/** `.lane-cards` — the scrollable well a lane's cards stack in (`overflow-y: auto`, its own scroll
 * container independent of the other three lanes and of the page itself). Renders whatever a
 * caller gives it per ticket, or an `Empty` `lane`-variant when there is nothing to show — see the
 * module comment for why deciding *what* that is stays out of this file. */
export function LaneCards({ children }: { children: ReactNode }) {
  return <div className="lane-cards">{children}</div>;
}
