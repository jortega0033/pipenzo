import type { KeyboardEvent, ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

export type EvtIconTone = 'default' | 'live' | 'bad';

/**
 * `.evt` -- one row of the activity-stream timeline from TicketDetail.dc.html's `.stream`
 * (despite what ticket #65's own body says about where to look, this lives in
 * TicketDetail.dc.html, not Activity.dc.html or Foundations.dc.html -- the same mismatch ticket
 * #64 found for the phase stepper). The 28px icon well (`evt-ic`, per-kind icon via `icon`;
 * `iconTone` picks `live` -- accent-filled, pulsing, for the run currently in flight -- or `bad`
 * -- danger-filled, for a failed step) sits in a column with the connecting `evt-line` below it;
 * `end` renders that line transparent for the last row in the stream, since there's no next row
 * to connect to.
 *
 * `low` is the compact LOW-risk rendering: an 8px dot instead of the full icon well, tighter
 * spacing throughout. Pair it with a `LowLine` (Risk.tsx) as `children` instead of `EvtHead`/
 * `EvtTitle` -- a LOW action is passive and only logged, so it doesn't earn the full row.
 *
 * `children` is otherwise free-form: `EvtHead` + `EvtTitle`, optionally followed by a `SubRow`
 * disclosure, a `PreCommitment`, a `MediumApprovalInline`/`MediumApprovalDone`, or a CI-retry
 * block -- whatever the specific event actually carries, each already its own primitive from an
 * earlier ticket in this batch.
 */
export function Evt({
  icon,
  iconTone = 'default',
  end = false,
  low = false,
  children,
}: {
  icon: IconName;
  iconTone?: EvtIconTone;
  end?: boolean;
  low?: boolean;
  children: ReactNode;
}) {
  const iconClass = iconTone === 'default' ? 'evt-ic' : `evt-ic ${iconTone}`;

  return (
    <div className={low ? 'evt low' : 'evt'}>
      <div className="evt-col">
        <div className={iconClass}>
          <Icon name={icon} size="sm" />
        </div>
        <div className={end ? 'evt-line end' : 'evt-line'} />
      </div>
      <div className="evt-body">{children}</div>
    </div>
  );
}

/** `.evt-head` -- the mono tool name, an optional risk chip (pass a `<RiskChip>`, or omit for a
 * step with no risk grade), and the mono meta (timestamp, or a status phrase like "waiting on
 * you" -- `metaLive` tints it accent for the run currently in flight). */
export function EvtHead({
  tool,
  risk,
  meta,
  metaLive = false,
}: {
  tool: ReactNode;
  risk?: ReactNode;
  meta: ReactNode;
  metaLive?: boolean;
}) {
  return (
    <div className="evt-head">
      <span className="evt-tool">{tool}</span>
      {risk}
      <span className={metaLive ? 'evt-meta live' : 'evt-meta'}>{meta}</span>
    </div>
  );
}

export function EvtTitle({ children }: { children: ReactNode }) {
  return <span className="evt-title">{children}</span>;
}

/**
 * `.sub-row` -- the disclosure that expands a subagent's transcript inline: a rotating caret
 * (`open` turns it 90°) plus a fixed terminal-window glyph marking what it expands to, and a
 * mono label (e.g. a tool-call/token summary) as `children`. Pair with `SubLines` for the
 * expanded transcript body.
 */
export function SubRow({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onToggle?.();
    }
  };

  return (
    <span
      className={open ? 'sub-row open' : 'sub-row'}
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      <Icon name="caret-right" size="sm" />
      <Icon name="terminal" size="sm" />
      {children}
    </span>
  );
}

/** `.sub-lines` -- the expanded subagent transcript body a `SubRow` discloses, mono and
 * pre-wrapped. `.ok`-classed spans inside `children` render in the ok tone (a passed check, a
 * clean line) -- the same "wrap the part that matters" convention as `.pc-row.got`. */
export function SubLines({ children }: { children: ReactNode }) {
  return <div className="sub-lines">{children}</div>;
}
