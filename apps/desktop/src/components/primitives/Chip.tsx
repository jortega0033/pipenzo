import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

/**
 * The filled status chip's six tones, from Foundations.dc.html's "status chips · one per agent
 * state" sample: Queued (neutral), Refining/Implementing/Reviewing/Interrupted/merge-conflict/
 * Awaiting stack approval (warn), Awaiting input/Needs human (danger), Ready for review (ok),
 * ci-failed (ci), Declined (neutral). `wait` exists in the shared CSS for a state that needs its
 * own amber-on-surface treatment distinct from a filled warn chip.
 *
 * There is deliberately no 'done' tone and no Done lane on the board: a merged PR closes its
 * issue on GitHub, the polling reconciler only ever queries *open* issues, and the card simply
 * stops appearing on the next poll -- the full record stays in the ticket store for Activity to
 * read, closed off the board rather than deleted. Do not add 'done' here to represent a merged
 * ticket; there is no card left to put a chip on.
 */
export type ChipTone = 'ok' | 'warn' | 'danger' | 'neutral' | 'ci' | 'wait';

export function Chip({
  tone,
  icon,
  children,
}: {
  tone: ChipTone;
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <span className={`chip chip-${tone}`}>
      {icon && <Icon name={icon} size="sm" />}
      {children}
    </span>
  );
}

/**
 * The risk grade chip -- LOW / MEDIUM / HIGH. A grade, not a state: tinted (never filled) and
 * mono with a leading dot specifically so it can never be mistaken for one of the filled status
 * chips above, even at a glance or in a busy list.
 */
export type RiskLevel = 'low' | 'medium' | 'high';

export function RiskChip({ level, children }: { level: RiskLevel; children: ReactNode }) {
  return <span className={`chip chip-risk ${level}`}>{children}</span>;
}

/** The small "self" marker appended after a label (e.g. next to your own username in a list). */
export function SelfTag({ children }: { children: ReactNode }) {
  return <span className="self-tag">{children}</span>;
}
