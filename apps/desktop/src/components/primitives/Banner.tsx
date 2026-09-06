import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';
import { IconButton } from './IconButton.js';

export type BannerTone = 'neutral' | 'ok' | 'warn' | 'danger';

/**
 * The two error variants from Foundations.dc.html's "Loading, error and empty" section, layered
 * on top of the same Banner rather than becoming separate components:
 * - `retrying`: a degraded state -- the plain surface-2 container, an amber-tinted .b-ic circle
 *   (its icon is expected to be the spinning `spinner` glyph), and a `.b-count` mono readout
 *   (e.g. "attempt 2 of 5"). The app still works; this just says what it's doing next.
 * - `blocking`: the one place in this whole notice family a container tints (danger-fg), because
 *   the screen behind it is genuinely stale and nothing behind it works until it clears -- always
 *   paired with `tone="danger"` in the canvas's own examples.
 */
export type BannerVariant = 'default' | 'retrying' | 'blocking';

/**
 * The page-level, persistent notice altitude from Foundations.dc.html's "Notices" section --
 * sits directly under the main header, full width. Tone lives in the 24px .b-ic circle only; the
 * container itself never tints except under the `blocking` variant, which is the one deliberate
 * exception to that rule (see BannerVariant above).
 *
 * `action` is a single node, not a list -- the canvas allows at most one non-primary action per
 * banner. `onDismiss` is opt-in rather than always rendered: a banner reporting a system state
 * (the daemon is unreachable, the sign-in expired, ...) has no dismiss control at all, because
 * dismissing it wouldn't make the underlying condition go away.
 */
export function Banner({
  tone = 'neutral',
  variant = 'default',
  icon,
  count,
  children,
  action,
  onDismiss,
}: {
  tone?: BannerTone;
  variant?: BannerVariant;
  icon: IconName;
  /** The mono `.b-count` readout -- an attempt counter, a backoff timer, a schema marker. */
  count?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  const classes = ['banner'];
  if (tone !== 'neutral') classes.push(tone);
  if (variant !== 'default') classes.push(variant);

  return (
    <div className={classes.join(' ')} role="status">
      <span className="b-ic">
        <Icon name={icon} size="sm" className={variant === 'retrying' ? 'spin' : undefined} />
      </span>
      <span className="b-text">{children}</span>
      {count !== undefined && <span className="b-count">{count}</span>}
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
