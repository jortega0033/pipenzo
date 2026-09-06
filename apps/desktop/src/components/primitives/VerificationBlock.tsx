import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

/**
 * `.v-block` -- the two-zone verification evidence layout from Foundations.dc.html's
 * "Verification evidence" section: `Machine-verified` (plain surface, green check icons -- one
 * row per deterministic gate that ran on this machine) and `Agent-captured` (`agent`, one surface
 * darker with an inset ring, grey icons, the "self-reported — not verified by a human" `.self-tag`
 * in its head). Structurally impossible to merge into one list: the two zones never share a
 * component beyond this shell, on purpose -- a machine-verified pass and an agent's own account of
 * its work are not the same kind of claim, and nothing in the agent-captured zone can ever satisfy
 * a gate.
 */
export function VerificationBlock({
  agent = false,
  headLabel,
  headSub,
  children,
}: {
  /** The darker, grey-icon, self-reported zone. */
  agent?: boolean;
  headLabel: ReactNode;
  headSub: ReactNode;
  /** One `VRow` per piece of evidence -- plus, in the agent zone, the screenshot pair
   * (Screenshot.tsx, ticket #59). */
  children: ReactNode;
}) {
  return (
    <div className={agent ? 'v-block agent' : 'v-block'}>
      <div className="v-head">
        <span className="label">
          {headLabel}
          {agent && <span className="self-tag">self-reported — not verified by a human</span>}
        </span>
        <span className="sub">{headSub}</span>
      </div>
      {children}
    </div>
  );
}

export type VRowTone = 'ok' | 'warn' | 'danger';

const TONE_ICON: Record<VRowTone, IconName> = { ok: 'check', warn: 'warning', danger: 'x-circle' };

/** One `.v-row`: an icon well plus the claim text -- a trailing `<span className="m">` for a mono
 * detail (a command and duration, a diff-scope figure) is the caller's job, same as every other
 * free-form row shape in this codebase.
 *
 * `self` (the agent-captured zone's grey, always-check icon) takes precedence over `tone`: a
 * self-reported claim is never colored as a gate result, whatever it's about. `tone` -- issue
 * #109's own addition, needed the first time a rail was assembled from a real `ReviewReportV1`
 * rather than the canvas's own always-green sample -- lets a machine-verified row honestly
 * represent a gate that did not simply pass: `warn` for `skipped` (an absent tool must never read
 * as a passed check) and `danger` for `failed`/`errored`. Defaults to `ok`, so every existing
 * caller keeps the original green check unchanged.
 */
export function VRow({
  self = false,
  tone = 'ok',
  children,
}: {
  self?: boolean;
  tone?: VRowTone;
  children: ReactNode;
}) {
  const className = self ? 'v-ic self' : tone === 'ok' ? 'v-ic' : `v-ic ${tone}`;
  return (
    <div className="v-row">
      <span className={className}>
        <Icon name={self ? 'check' : TONE_ICON[tone]} size="sm" />
      </span>
      <span>{children}</span>
    </div>
  );
}
