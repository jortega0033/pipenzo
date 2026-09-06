import type { CSSProperties } from 'react';
import { Icon, type IconSize } from './Icon.js';

export type SkeletonShape = 'block' | 'pill' | 'dot';

/**
 * The one shimmer primitive from Foundations.dc.html's "Loading, error and empty" section (.sk):
 * a placeholder block sized inline by the consumer to match the shape it stands in for -- never
 * a spinner over a blank panel. `strong` is the higher-contrast surface-3/surface-4 variant for a
 * placeholder that needs to read as "the important line" (e.g. a card title) against plainer
 * surrounding placeholders; `shape` picks between a rounded rect (`block`, the default), a pill
 * (a chip/button placeholder) and a dot (a circular icon-well placeholder). Both the shimmer and
 * `Spinner` below are flattened to a still shape by the existing reduced-motion rule in this same
 * theme file rather than removed -- the placeholder still reads as "loading", it just stops
 * animating.
 *
 * Always `aria-hidden` and never focusable: a skeleton is never announced as if it were the real
 * content it stands in for.
 */
export function Skeleton({
  width,
  height,
  strong = false,
  shape = 'block',
  style,
}: {
  width: CSSProperties['width'];
  height: CSSProperties['height'];
  strong?: boolean;
  shape?: SkeletonShape;
  style?: CSSProperties;
}) {
  const classes = ['sk'];
  if (strong) classes.push('strong');
  if (shape === 'pill') classes.push('pill');
  if (shape === 'dot') classes.push('dot');

  return (
    <span className={classes.join(' ')} style={{ width, height, ...style }} aria-hidden="true" />
  );
}

/**
 * Turns any Phosphor icon into a spinner via the canvas's `.spin` class -- the pending-button and
 * sync-status "Syncing…" glyph. Decorative by default (`aria-hidden`, matching Icon's own
 * default): the surrounding control is what should carry `aria-busy` or its own accessible name
 * (e.g. Button's pending state, SyncStatusPill's "Syncing…" label), not the spinner glyph itself.
 */
export function Spinner({ size = 'md' }: { size?: IconSize }) {
  return <Icon name="spinner" size={size} className="spin" />;
}

/**
 * The kanban-card loading shape (.sk-card): id and chip row, two title lines, foot row. Same 16px
 * padding, 12px gaps and foot layout as the real ticket card, so nothing jumps when the poll
 * returns.
 */
export function SkeletonCard() {
  return (
    <div className="sk-card" aria-hidden="true">
      <div className="sk-row">
        <Skeleton width={32} height={12} />
        <Skeleton width={76} height={18} shape="pill" />
      </div>
      <Skeleton width="100%" height={14} strong />
      <Skeleton width="62%" height={14} strong />
      <div className="sk-row">
        <Skeleton width={52} height={12} />
        <Skeleton width={88} height={28} shape="pill" />
      </div>
    </div>
  );
}

/**
 * The activity-stream row loading shape (.sk-evt): a 28px icon well, a head line (timestamp +
 * actor), then one or two title lines. `last` drops the row's bottom padding (the canvas's own
 * last-of-three-or-four example) since there's no next row to separate from.
 */
export function SkeletonEvent({
  headWidths = [76, 52],
  bodyWidths = ['100%', '54%'],
  last = false,
}: {
  headWidths?: [CSSProperties['width'], CSSProperties['width']];
  bodyWidths?: CSSProperties['width'][];
  last?: boolean;
}) {
  return (
    <div className="sk-evt" style={last ? { paddingBottom: 0 } : undefined} aria-hidden="true">
      <Skeleton width={28} height={28} shape="dot" />
      <div className="sk-evt-body">
        <div style={{ display: 'flex', gap: 8 }}>
          <Skeleton width={headWidths[0]} height={10} />
          <Skeleton width={headWidths[1]} height={10} />
        </div>
        {bodyWidths.map((width, index) => (
          <Skeleton key={index} width={width} height={12} strong />
        ))}
      </div>
    </div>
  );
}

export interface SkeletonLaneSpec {
  /** The lane's real name and dot color -- fixed by the label set, so they render immediately
   * rather than waiting on the poll like the cards underneath them do. */
  name: string;
  dotColor: CSSProperties['background'];
  cardCount?: number;
}

/**
 * One lane of the page-level board loading state: a real header (name + dot, matching the canvas
 * note that "the four lanes are fixed by the label set, so they render immediately with their
 * names and dots; only the card counts and the cards themselves wait") plus `cardCount`
 * SkeletonCards. The header's own count placeholder is the one skeleton piece in the row -- the
 * name and dot are real content, not `aria-hidden`, since they're already known.
 */
export function SkeletonLane({ name, dotColor, cardCount = 2 }: SkeletonLaneSpec) {
  return (
    <div className="sk-lane">
      <div className="sk-row" style={{ height: 40, padding: '0 12px' }}>
        <span
          className="label"
          style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-text-soft)' }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              display: 'inline-block',
              background: dotColor,
            }}
          />
          {name}
        </span>
        <Skeleton width={14} height={10} />
      </div>
      {Array.from({ length: cardCount }, (_, index) => (
        <SkeletonCard key={index} />
      ))}
    </div>
  );
}

/**
 * The board-before-first-poll loading state (.sk-board): one SkeletonLane per connected lane.
 * Roughly the first second of a cold start -- once the first poll returns, the board renders from
 * the ticket store in place and this state isn't seen again in the session.
 */
export function SkeletonBoard({ lanes }: { lanes: SkeletonLaneSpec[] }) {
  return (
    <div className="sk-board">
      {lanes.map((lane) => (
        <SkeletonLane key={lane.name} {...lane} />
      ))}
    </div>
  );
}
