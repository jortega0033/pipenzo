import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon.js';

export type IconButtonVariant = 'default' | 'ghost';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> {
  icon: IconName;
  variant?: IconButtonVariant;
  /**
   * Required, not optional: an icon-only button has no visible text, so this is the only
   * accessible name it gets -- matches the canvas's own icon-btn examples (e.g. the sync
   * status's refresh control), which always carry both `title` and `aria-label`.
   */
  'aria-label': string;
}

/**
 * The circular icon-only button from Foundations.dc.html's "Primitives" section: default
 * (filled surface-3) or ghost (transparent until hover). One size -- 32px -- the canvas doesn't
 * show an sm/lg icon-btn the way .btn has sizes.
 */
export function IconButton({
  icon,
  variant = 'default',
  type = 'button',
  title,
  ...rest
}: IconButtonProps) {
  const classes = ['icon-btn'];
  if (variant === 'ghost') classes.push('ghost');

  return (
    <button type={type} className={classes.join(' ')} title={title ?? rest['aria-label']} {...rest}>
      <Icon name={icon} />
    </button>
  );
}
