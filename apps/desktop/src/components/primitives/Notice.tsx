import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

export type NoticeTone = 'neutral' | 'ok' | 'warn' | 'danger';

export interface NoticeAction {
  label: string;
  onClick: () => void;
}

/**
 * The in-context, dismissible notice altitude from Foundations.dc.html's "Notices" section --
 * lives inside a card, dialog or form (used across Connect, Models, Settings), as opposed to
 * Banner's page-level placement under the header. Same four tones as Banner, color living in the
 * 20px .n-ic circle only, plus an inline-link action row (.n-act) for cases that need one or two
 * short text actions instead of a pill button -- e.g. "See proposed split" / "Reject the split".
 *
 * `actions` renders as real `<button>`s rather than the canvas's plain `<span>`s so the row stays
 * keyboard- and screen-reader-accessible; pipenzo-theme.css extends the shared `.n-act` styling to
 * match both. `quiet` is the smaller, unfilled-icon rendering for an outcome worth recording that
 * needs no action now (e.g. a refused worktree cleanup).
 */
export function Notice({
  tone = 'neutral',
  quiet = false,
  icon,
  title,
  children,
  actions,
  onDismiss,
}: {
  tone?: NoticeTone;
  quiet?: boolean;
  icon: IconName;
  title?: string;
  children?: ReactNode;
  actions?: NoticeAction[];
  onDismiss?: () => void;
}) {
  const classes = ['notice'];
  if (tone !== 'neutral') classes.push(tone);
  if (quiet) classes.push('quiet');

  return (
    <div className={classes.join(' ')}>
      <span className="n-ic">
        <Icon name={icon} size="sm" />
      </span>
      <span className="n-body">
        {title && <span className="n-title">{title}</span>}
        {children && <span>{children}</span>}
        {actions && actions.length > 0 && (
          <span className="n-act">
            {actions.map((action) => (
              <button key={action.label} type="button" onClick={action.onClick}>
                {action.label}
              </button>
            ))}
          </span>
        )}
      </span>
      {onDismiss && (
        <button type="button" className="n-x" aria-label="Dismiss" onClick={onDismiss}>
          <Icon name="x" size="sm" />
        </button>
      )}
    </div>
  );
}
