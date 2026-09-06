import type { KeyboardEvent, ReactNode } from 'react';
import { Chip, type ChipTone } from './Chip.js';
import { Icon } from './Icon.js';

export type FindingSeverity = 'critical' | 'warning' | 'info';

const SEVERITY_CHIP_TONE: Record<FindingSeverity, ChipTone> = {
  critical: 'danger',
  warning: 'warn',
  info: 'neutral',
};

/** `.f-count` -- the severity tally above a findings list, e.g. "0 critical · 2 warning · 1
 * info". Reviewer findings are advisory: only a critical one holds the push gate closed. */
export function FindingsCount({
  critical,
  warning,
  info,
}: {
  critical: number;
  warning: number;
  info: number;
}) {
  return (
    <div className="f-count">
      <span>
        <b>{critical}</b> critical
      </span>
      <span>
        <b>{warning}</b> warning
      </span>
      <span>
        <b>{info}</b> info
      </span>
    </div>
  );
}

/** `.findings` -- the 2px-gap column of `Finding` rows. */
export function FindingsList({ children }: { children: ReactNode }) {
  return <div className="findings">{children}</div>;
}

/**
 * `.finding` -- one reviewer finding from DiffReview.dc.html's findings sidebar: a severity chip
 * (reusing the same tones as the state chip family -- critical/danger, warning/warn, info/
 * neutral), the finding text, and `.f-loc` (a file icon, the `file:line` reference, a trailing
 * chevron). `active` adds the accent left rail (`box-shadow: inset 2px 0 0 accent`) and a surface
 * bump for the finding currently selected against the diff to its left. Every row is a real
 * `tabIndex=0` target with Enter/Space activation, matching this codebase's existing pattern for
 * a clickable canvas row (Card, ScreenshotThumb) rather than a roving-tabindex listbox the canvas
 * itself doesn't specify.
 */
export function Finding({
  severity,
  active = false,
  loc,
  onClick,
  children,
}: {
  severity: FindingSeverity;
  active?: boolean;
  /** The `file:line` reference, e.g. `"stdio-mcp-connection.ts:76"`. */
  loc: ReactNode;
  onClick?: () => void;
  children: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick?.();
    }
  };

  return (
    <div
      className={active ? 'finding active' : 'finding'}
      tabIndex={0}
      role="button"
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <Chip tone={SEVERITY_CHIP_TONE[severity]}>{severity}</Chip>
      <span className="f-txt">{children}</span>
      <span className="f-loc">
        <Icon name="file" size="xs" />
        <span>{loc}</span>
        <Icon name="caret-right" size="xs" />
      </span>
    </div>
  );
}
