import type { ReactNode } from 'react';
import { Icon } from './Icon.js';

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

/** One `.v-row`: a check-icon well (green on machine-verified, grey `self` in the agent-captured
 * zone) plus the claim text -- a trailing `<span className="m">` for a mono detail (a command and
 * duration, a diff-scope figure) is the caller's job, same as every other free-form row shape in
 * this codebase. */
export function VRow({ self = false, children }: { self?: boolean; children: ReactNode }) {
  return (
    <div className="v-row">
      <span className={self ? 'v-ic self' : 'v-ic'}>
        <Icon name="check" size="sm" />
      </span>
      <span>{children}</span>
    </div>
  );
}
