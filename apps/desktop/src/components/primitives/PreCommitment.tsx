import { useState, type ReactNode } from 'react';
import { Chip, type ChipTone } from './Chip.js';

export type PreCommitmentStatus = 'pending' | 'match' | 'mismatch' | 'partial';

const STATUS_CHIP: Record<PreCommitmentStatus, { tone: ChipTone; label: string }> = {
  pending: { tone: 'wait', label: 'pending' },
  match: { tone: 'ok', label: 'match' },
  mismatch: { tone: 'danger', label: 'mismatch' },
  partial: { tone: 'warn', label: 'partial' },
};

/**
 * The pre-commitment record from Foundations.dc.html's "Pre-commitment records" section, posted
 * before every MEDIUM or HIGH action (action / expect / if_wrong) with the real outcome appended
 * and diffed against it. Backs both the compact MEDIUM inline card and the full HIGH card
 * (HighApprovalCard below) as well as its own dedicated states:
 * - `pending`: posted before the action, no toggle.
 * - `match`: collapsible, default collapsed to one head line -- "the thing happened as
 *   promised" is exactly the case that doesn't need to stay open. `defaultCollapsed={false}` to
 *   start expanded.
 * - `mismatch` / `partial`: never auto-collapse. A static "stays open" replaces the toggle (in
 *   the danger or warn tone respectively) rather than offering a control that would do nothing.
 *
 * Rows are free-form children (`PreCommitment.Row` for action/expect/if_wrong,
 * `PreCommitment.Outcome` for the appended real-outcome row) rather than a fixed three-row shape,
 * since a partial outcome in the canvas's own example shows only the outcome row with no plan
 * rows at all -- the caller decides what to include, this component only decides whether the
 * result is visible. For a mismatch, the caller passes the original action/expect/if_wrong rows
 * *and* the outcome row together (see PreCommitment.test.tsx) -- the real result is meant to read
 * as a diff against the prediction sitting right above it, not to replace it.
 */
export function PreCommitment({
  status,
  headLabel = 'Pre-commitment',
  headDetail,
  defaultCollapsed = true,
  children,
}: {
  status: PreCommitmentStatus;
  headLabel?: ReactNode;
  /** The rest of the head line, e.g. `<b>· pnpm vitest run mcp-stdio-client</b>` or
   * `<b>· posted before this action</b>`. */
  headDetail?: ReactNode;
  /** `match` only -- whether it starts collapsed. Ignored for every other status. */
  defaultCollapsed?: boolean;
  children?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(status === 'match' && defaultCollapsed);
  const chipSpec = STATUS_CHIP[status];
  const showRows = status !== 'match' || !collapsed;

  return (
    <div className="precommit">
      <div className="pc-head">
        <span className="grow">
          {headLabel}
          {headDetail && <> {headDetail}</>}
        </span>
        <Chip tone={chipSpec.tone}>{chipSpec.label}</Chip>
        {status === 'match' && (
          <span
            className="pc-toggle"
            role="button"
            tabIndex={0}
            onClick={() => setCollapsed((value) => !value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setCollapsed((value) => !value);
              }
            }}
          >
            {collapsed ? 'show' : 'hide'}
          </span>
        )}
        {(status === 'mismatch' || status === 'partial') && (
          <span
            className="pc-toggle"
            style={{
              cursor: 'default',
              color: status === 'mismatch' ? 'var(--color-danger)' : 'var(--color-warn)',
            }}
          >
            stays open
          </span>
        )}
      </div>
      {showRows && children}
    </div>
  );
}

/** One action/expect/if_wrong plan row. */
function PreCommitmentRow({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="pc-row">
      <span className="pc-k">{k}</span>
      <span>{children}</span>
    </div>
  );
}

/** The real-outcome row appended once the action lands, diffed against the plan above it. */
function PreCommitmentOutcome({
  tone,
  k,
  children,
}: {
  tone: 'ok' | 'mismatch' | 'partial';
  k: ReactNode;
  children: ReactNode;
}) {
  const toneClass = tone === 'ok' ? 'got ok' : tone === 'partial' ? 'got part' : 'got';
  return (
    <div className={`pc-row ${toneClass}`}>
      <span className="pc-k">{k}</span>
      <span>{children}</span>
    </div>
  );
}

PreCommitment.Row = PreCommitmentRow;
PreCommitment.Outcome = PreCommitmentOutcome;
