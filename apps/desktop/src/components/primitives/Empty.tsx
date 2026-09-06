import type { ReactNode } from 'react';
import { Button, type ButtonVariant } from './Button.js';
import { Icon, type IconName } from './Icon.js';

export interface EmptyAction {
  label: string;
  onClick?: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
}

/**
 * The empty-state primitive from Foundations.dc.html's "Loading, error and empty" section. Not a
 * failure state -- copy says why, not sorry -- so it carries the way forward instead of an apology.
 *
 * Two variants:
 * - `hero` (default): the first-run board state (no repo connected yet). A 40px icon well around
 *   a 20px icon, a title, an optional sub line, and up to two actions -- the only variant that
 *   renders any of the three.
 * - `lane`: one lane on an already-connected board that has simply run dry. Transparent
 *   background, smaller type, no icon and no buttons -- an empty Needs-human lane is the goal
 *   state and should read as one, not as a call to action. `icon` and `actions` are ignored here.
 */
export function Empty({
  variant = 'hero',
  icon,
  title,
  children,
  actions,
}: {
  variant?: 'hero' | 'lane';
  /** Hero only. Rendered at 20px (icon-lg) inside the 40px tone circle. */
  icon?: IconName;
  title: string;
  /** The `.e-sub` description, rendered under the title. */
  children?: ReactNode;
  /** Hero only, up to two. The first action defaults to `primary`. */
  actions?: EmptyAction[];
}) {
  const isHero = variant === 'hero';

  return (
    <div className={isHero ? 'empty' : 'empty lane'}>
      {isHero && icon && (
        <span className="e-ic">
          <Icon name={icon} size="lg" />
        </span>
      )}
      <span className="e-title">{title}</span>
      {children && <span className="e-sub">{children}</span>}
      {isHero && actions && actions.length > 0 && (
        <span className="e-act">
          {actions.map((action, index) => (
            <Button
              key={action.label}
              variant={action.variant ?? (index === 0 ? 'primary' : 'default')}
              icon={action.icon}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        </span>
      )}
    </div>
  );
}
