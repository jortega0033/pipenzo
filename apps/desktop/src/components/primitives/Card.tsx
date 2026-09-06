import type { KeyboardEvent, ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

/**
 * The ticket card base from Foundations.dc.html's "Cards" section (the same anatomy Main.dc.html
 * uses for the kanban board): a plain surface, no border anywhere in this system, that steps up
 * one surface on hover. `.card-top` (id + one status chip), `.card-title`, then whatever body the
 * card's state needs -- a progress bar (CardProgress below), a fail/wait note, a split block or a
 * conflict block (their own primitives), a stack's `.kids` list -- and finally `.card-foot`
 * (CardFoot below).
 *
 * `held` is the bounded-concurrency "waiting on a file-overlap slot" dimming (`.card.held`): the
 * card sits in its lane but is not occupying a concurrency slot.
 *
 * `onClick` is optional -- the claim-conflict variant in the canvas is deliberately the one card
 * with no button in its foot, and some board contexts open the ticket on click while others (a
 * static preview, a stack's read-only `.kid` row) don't. When given, the card exposes itself as a
 * `button` for keyboard and screen-reader users (Enter/Space activate it) on top of the plain
 * `tabIndex=0` every card in the canvas carries.
 */
export function Card({
  id,
  chip,
  title,
  held = false,
  onClick,
  children,
}: {
  /** The `.card-id` mono id, e.g. `#88` or `#103 · stack`. */
  id?: ReactNode;
  /** The one status chip in `.card-top`, e.g. `<Chip tone="warn">implementing</Chip>`. */
  chip?: ReactNode;
  title: ReactNode;
  held?: boolean;
  onClick?: () => void;
  /** Progress bar, notes, split/conflict blocks, `.kids` -- whatever the card's state needs,
   * rendered between the title and the foot. */
  children?: ReactNode;
}) {
  const classes = ['card'];
  if (held) classes.push('held');

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onClick) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <div
      className={classes.join(' ')}
      tabIndex={0}
      role={onClick ? 'button' : undefined}
      onClick={onClick}
      onKeyDown={onClick ? onKeyDown : undefined}
    >
      {(id !== undefined || chip !== undefined) && (
        <div className="card-top">
          {id !== undefined && <span className="card-id">{id}</span>}
          {chip}
        </div>
      )}
      <span className="card-title">{title}</span>
      {children}
    </div>
  );
}

/** `.card-foot`: meta on the left (CardMeta below), a single action button on the right. The
 * claim-conflict card in the canvas passes only a CardMeta child and no action -- `.card-foot`'s
 * `justify-content: space-between` already reads correctly with one child, so there is no
 * separate "no action" mode to opt into. */
export function CardFoot({ children }: { children: ReactNode }) {
  return <div className="card-foot">{children}</div>;
}

/** One `.card-meta` readout: an optional leading icon (age, commit stats, branch) plus mono text. */
export function CardMeta({ icon, children }: { icon?: IconName; children: ReactNode }) {
  return (
    <span className="card-meta">
      {icon && <Icon name={icon} size="sm" />}
      {children}
    </span>
  );
}

/** `.card-progress`: the accent progress bar plus a trailing mono readout -- a percentage
 * ("62%") for a single ticket's Implement progress, or a fraction ("2/3") for a PR-stack card. */
export function CardProgress({ percent, label }: { percent: number; label: ReactNode }) {
  return (
    <div className="card-progress">
      <div className="bar">
        <div className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </div>
      <span className="pct">{label}</span>
    </div>
  );
}
