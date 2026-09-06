import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

/**
 * `.stat` from Foundations.dc.html's stat-grid sample -- four board-health readouts (PRs opened,
 * median diff, gates first-pass rate, headroom). `stat-k` is the label row (bold, a trailing
 * icon); `stat-v` is the 24px mono bold figure, free-form so it can carry a secondary part in a
 * lighter weight/color the way "median diff" ("+41 −9") and "headroom" ("7 sessions") both do;
 * `stat-d` is the delta line, optionally tinted `up` (ok) or `down` (danger) with a leading
 * arrow -- "across 2.1 files" and the headroom note carry neither, since they're not a trend.
 *
 * `estimateTag` is the headroom-specific `.self-tag` ("estimate") appended right after the label:
 * neither Claude nor Codex hands the daemon a quota number, so this stat is the one with no
 * percentage to put in `barPercent` and no reset countdown -- just the two things this machine can
 * actually count (session count, token estimate). `barPercent`, when given, renders the shared
 * `.bar`/`.bar-fill` progress track under the value (`.stat .bar`'s only rule is its 2px top
 * margin) for a stat the canvas represents as a fraction of a whole.
 */
export function StatCard({
  label,
  icon,
  estimateTag = false,
  value,
  delta,
  trend,
  barPercent,
}: {
  label: ReactNode;
  icon?: IconName;
  /** Appends the `.self-tag` "estimate" chip after the label -- the headroom variant. */
  estimateTag?: boolean;
  /** The `.stat-v` figure -- free-form so a secondary unit/part can ride along in its own span. */
  value: ReactNode;
  delta?: ReactNode;
  /** Tints `.stat-d` and adds a leading arrow icon. Omit for a delta that isn't a trend. */
  trend?: 'up' | 'down';
  /** 0-100, clamped -- renders the shared progress bar under the value. */
  barPercent?: number;
}) {
  return (
    <div className="stat">
      <span className="stat-k">
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
          {label}
          {estimateTag && <span className="self-tag">estimate</span>}
        </span>
        {icon && <Icon name={icon} />}
      </span>
      <span className="stat-v">{value}</span>
      {delta !== undefined && (
        <span className={trend ? `stat-d ${trend}` : 'stat-d'}>
          {trend && <Icon name={trend === 'up' ? 'arrow-up' : 'arrow-down'} size="sm" />}
          {delta}
        </span>
      )}
      {barPercent !== undefined && (
        <div className="bar">
          <div className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, barPercent))}%` }} />
        </div>
      )}
    </div>
  );
}
