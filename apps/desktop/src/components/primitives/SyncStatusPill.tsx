import { Icon, type IconName } from './Icon.js';
import { IconButton } from './IconButton.js';

export type SyncStatus = 'synced' | 'syncing' | 'slow';

const STATUS_ICON: Record<SyncStatus, IconName> = {
  synced: 'clock',
  syncing: 'spinner',
  slow: 'hourglass',
};

/**
 * The board header's polling indicator from Foundations.dc.html's "Primitives" section: one
 * control, three renderings -- synced (neutral), syncing (the notch spins, refresh disabled
 * while the poll is in flight), syncing slowly (amber, once the GitHub rate limit drops below
 * ~15% remaining -- a degradation, not a failure). GitHub state polls every 30-60s; there is no
 * push channel between two people's desktop apps.
 *
 * `status` is entirely caller-controlled: it is set by the rate-limit check on each poll, never
 * by clicking the refresh button here. Clicking refresh only requests an immediate poll via
 * `onRefresh` -- it has no way to flip `status` itself, matching the canvas's own note that this
 * pill is set by the poll, not by a click.
 */
export function SyncStatusPill({
  status,
  label,
  title,
  onRefresh,
}: {
  status: SyncStatus;
  /** e.g. "Synced 38s ago" / "Syncing…" / "Syncing slowly · next poll in 4m" */
  label: string;
  title?: string;
  onRefresh: () => void;
}) {
  return (
    <span className={status === 'slow' ? 'sync-status slow' : 'sync-status'} title={title}>
      <Icon
        name={STATUS_ICON[status]}
        size="sm"
        className={status === 'syncing' ? 'spin' : undefined}
      />
      {label}
      <IconButton
        icon="refresh"
        variant="ghost"
        aria-label="Refresh now"
        title="Refresh now"
        onClick={onRefresh}
        disabled={status === 'syncing'}
      />
    </span>
  );
}
