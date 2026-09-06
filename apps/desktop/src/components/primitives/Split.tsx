import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

export interface SplitRow {
  /** The leading `.split-n` marker: a step number ("1/3"), a plain ordinal ("1"), or an em dash
   * for an unordered note row. */
  n: ReactNode;
  children: ReactNode;
}

/**
 * The numbered-rows card block from Foundations.dc.html's "Cards" section, reused three ways in
 * the canvas without changing shape: a proposed PR stack awaiting approval, a plan declined at
 * Refine for tripping a size guardrail, and (embedded in a dialog) the plan-review gate's compact
 * acceptance-criteria/out-of-scope/files-touched summary. `quiet` is the declined/informational
 * tone (text-soft head instead of warn); `kv` is the optional mono key/value line under the head
 * (estimate, file count, what tripped) that the stack and declined variants use and the compact
 * summary usually skips.
 *
 * Inside a `.dialog` (the plan-review gate), `.split` and `.split-row .mono` already step up to
 * the next surface via the theme's `.dialog .split` rule -- the dialog itself sits on surface-3,
 * so this component never needs a dialog-aware prop of its own.
 */
export function Split({
  icon,
  quiet = false,
  head,
  kv,
  rows,
}: {
  icon?: IconName;
  quiet?: boolean;
  head: ReactNode;
  /** The `.split-kv` mono line, e.g. `est. +1,340 −410 · 31 files`. */
  kv?: ReactNode;
  rows: SplitRow[];
}) {
  return (
    <div className="split">
      <span className={quiet ? 'split-head quiet' : 'split-head'}>
        {icon && <Icon name={icon} size="sm" />}
        {head}
      </span>
      {kv && <span className="split-kv">{kv}</span>}
      {rows.map((row, index) => (
        <span className="split-row" key={index}>
          <span className="split-n">{row.n}</span>
          {row.children}
        </span>
      ))}
    </div>
  );
}
