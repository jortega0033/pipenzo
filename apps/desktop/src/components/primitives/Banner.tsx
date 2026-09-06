import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';
import { IconButton } from './IconButton.js';

export type BannerTone = 'neutral' | 'ok' | 'warn' | 'danger';

/**
 * The page-level, persistent notice altitude from Foundations.dc.html's "Notices" section --
 * sits directly under the main header, full width. Tone lives in the 24px .b-ic circle only; the
 * container itself never tints, so a screen full of banners still reads as one surface (ticket
 * #36's `blocking` variant is the one deliberate exception to that rule, layered on top of this
 * same component rather than becoming a second one).
 *
 * `action` is a single node, not a list -- the canvas allows at most one non-primary action per
 * banner. `onDismiss` is opt-in rather than always rendered: a banner reporting a system state
 * (the daemon is unreachable, the sign-in expired, ...) has no dismiss control at all, because
 * dismissing it wouldn't make the underlying condition go away.
 */
export function Banner({
  tone = 'neutral',
  icon,
  children,
  action,
  onDismiss,
}: {
  tone?: BannerTone;
  icon: IconName;
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  const classes = ['banner'];
  if (tone !== 'neutral') classes.push(tone);

  return (
    <div className={classes.join(' ')} role="status">
      <span className="b-ic">
        <Icon name={icon} size="sm" />
      </span>
      <span className="b-text">{children}</span>
      {(action || onDismiss) && (
        <span className="b-act">
          {action}
          {onDismiss && (
            <IconButton
              icon="x"
              variant="ghost"
              aria-label="Dismiss"
              onClick={onDismiss}
              style={{ width: 28, height: 28 }}
            />
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Groups more than one Banner with the canvas's `.stack` rule: a 2px gap, and corner-clipping so
 * the group's first/last banner keep the rounded top/bottom while the seam between banners stays
 * square -- the stack reads as one block, not a pile of separately-rounded rectangles.
 */
export function BannerStack({ children }: { children: ReactNode }) {
  return <div className="stack">{children}</div>;
}
