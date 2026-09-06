import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'default' | 'lg';

const ICON_SIZE_FOR_BUTTON_SIZE = {
  sm: 'sm',
  default: 'md',
  lg: 'md',
} as const;

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon. Swapped out for a spinner automatically while `pending` is true. */
  icon?: IconName;
  /**
   * The button is mid-action: a spinner replaces the leading icon (or is added, if the button
   * had none) and hover/active no longer react. Pass the in-progress label as `children` --
   * e.g. `<Button pending>Pushing…</Button>` -- the width is allowed to grow or shrink with it;
   * this never collapses to a bare spinner, so `children` stays required either way.
   */
  pending?: boolean;
  children: ReactNode;
}

/**
 * The pill button family from Foundations.dc.html's "Primitives" section: default/primary/
 * ghost/danger, each in sm/default/lg. `type="button"` by default since every button in the
 * canvas drives an app action rather than submitting a form -- pass `type="submit"` explicitly
 * for the rare form that needs it.
 */
export function Button({
  variant = 'default',
  size = 'default',
  icon,
  pending = false,
  disabled,
  type = 'button',
  onClick,
  children,
  ...rest
}: ButtonProps) {
  const classes = ['btn'];
  if (variant !== 'default') classes.push(variant);
  if (size !== 'default') classes.push(size);
  if (pending) classes.push('pending');

  const iconSize = ICON_SIZE_FOR_BUTTON_SIZE[size];

  return (
    <button
      type={type}
      className={classes.join(' ')}
      // Deliberately not the `disabled` attribute while merely pending (only `disabled` itself
      // sets that) -- the canvas's pending examples keep the button focusable and drop the
      // interaction purely through `.btn.pending`'s cursor/hover/active rules plus aria-busy, so
      // a screen reader still has something to land on and announce as busy. A pending click is
      // still a no-op, just via the handler below instead of the DOM disabled state.
      disabled={disabled}
      aria-busy={pending || undefined}
      onClick={pending ? undefined : onClick}
      {...rest}
    >
      {pending ? (
        <Icon name="spinner" size={iconSize} className="spin" />
      ) : (
        icon && <Icon name={icon} size={iconSize} />
      )}
      {children}
    </button>
  );
}
