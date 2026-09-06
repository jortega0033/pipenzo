import type { CSSProperties, ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

export type ApprovalTone = 'danger' | 'warn' | 'quiet' | 'ok';
export type ApprovalActionsJustify = 'stretch' | 'start' | 'end' | 'between';

const JUSTIFY_CSS: Record<Exclude<ApprovalActionsJustify, 'stretch'>, CSSProperties['justifyContent']> = {
  start: 'flex-start',
  end: 'flex-end',
  between: 'space-between',
};

/**
 * `.approval-card` -- the shell TicketDetail.dc.html reuses across the plan-review gate
 * (rejected), stack approval (proposal / accepted / rejected), the refusal outcome, and the
 * inline HIGH approval card in that same panel (a different shell from HighApprovalCard.tsx's
 * `.dialog`, which ports the Foundations.dc.html "Risk-graded approval" sample -- the canvas
 * genuinely draws HIGH two ways depending on where it appears, and this ticket only covers the
 * TicketDetail shell). Four `.approval-ic` tones: `danger` (the default -- rejected/declined
 * outcomes), `warn` (a proposal awaiting sign-off), `quiet` (an informational, no-verdict
 * outcome), `ok` (accepted). `children` carries whatever the state's body needs -- an
 * `ApprovalP` paragraph, a `RefGrid`, a `.stack-list`/`.kids`, a reason field -- between the head
 * and the actions row, so the shell itself stays state-agnostic.
 */
export function ApprovalCard({
  tone = 'danger',
  icon,
  title,
  sub,
  chip,
  children,
  actions,
  actionsJustify = 'stretch',
  foot,
}: {
  tone?: ApprovalTone;
  icon: IconName;
  title: ReactNode;
  sub?: ReactNode;
  /** A trailing chip in the head, e.g. a risk chip or a "finished" status chip. */
  chip?: ReactNode;
  children?: ReactNode;
  /** `.approval-actions` content -- one or two `.btn`s, an `RLink`, or both. Omitted entirely
   * for a state with no actions. */
  actions?: ReactNode;
  /** `stretch` (default) makes every `.btn` child flex equally, matching the canvas's own
   * unmodified rule; the others match the inline `justify-content` overrides the canvas applies
   * per state. */
  actionsJustify?: ApprovalActionsJustify;
  /** `.approval-foot` -- typically the OS-notification note. */
  foot?: ReactNode;
}) {
  return (
    <div className="approval-card">
      <div className="approval-head">
        <div className={tone === 'danger' ? 'approval-ic' : `approval-ic ${tone}`}>
          <Icon name={icon} size="sm" />
        </div>
        <div className="grow">
          <span className="approval-title">{title}</span>
          {sub && <span className="approval-sub">{sub}</span>}
        </div>
        {chip}
      </div>
      {children}
      {actions && (
        <div
          className="approval-actions"
          style={actionsJustify !== 'stretch' ? { justifyContent: JUSTIFY_CSS[actionsJustify] } : undefined}
        >
          {actions}
        </div>
      )}
      {foot && <div className="approval-foot">{foot}</div>}
    </div>
  );
}

/** `.approval-p` -- the one prose paragraph a state needs, e.g. what accepting a stack does. */
export function ApprovalP({ children }: { children: ReactNode }) {
  return <p className="approval-p">{children}</p>;
}

/** `.r-link` -- the text-only action inside `.approval-actions` (e.g. "Back to the spec"),
 * distinct from a `.btn`. `faint` is the lower-emphasis variant used for a secondary "go back"
 * link sitting next to a primary `.btn` action. */
export function RLink({
  faint = false,
  onClick,
  children,
}: {
  faint?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <span
      className={faint ? 'r-link faint' : 'r-link'}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick?.();
        }
      }}
    >
      {children}
    </span>
  );
}

/** `.ref-grid` -- the three-cell metric strip used by the refusal outcome (estimate / what
 * tripped / the one-PR budget it compares against). */
export function RefGrid({ children }: { children: ReactNode }) {
  return <div className="ref-grid">{children}</div>;
}

/** One `.ref-cell`: a `.label` eyebrow, the value (`mono` for a diff-stat-shaped value), and an
 * optional `.ref-s` caption. */
export function RefCell({
  label,
  value,
  mono = false,
  sub,
}: {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  sub?: ReactNode;
}) {
  return (
    <div className="ref-cell">
      <span className="label">{label}</span>
      <span className={mono ? 'ref-v mono' : 'ref-v'}>{value}</span>
      {sub && <span className="ref-s">{sub}</span>}
    </div>
  );
}

/** `.stack-list` -- the 2px-gap column of `StackRow`s inside the stack-approval panel. */
export function StackList({ children }: { children: ReactNode }) {
  return <div className="stack-list">{children}</div>;
}

/** `.stack-note` -- the info line under a stack's read-only `Kids` in the accepted state:
 * maintenance (restack, rebase) is read-only in pipenzo and lives on GitHub's native stacked
 * PRs. */
export function StackNote({ children }: { children: ReactNode }) {
  return (
    <div className="stack-note">
      <Icon name="info" size="sm" />
      <span>{children}</span>
    </div>
  );
}
