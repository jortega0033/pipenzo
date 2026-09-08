import type { PipenzoGitHubHealthV1 } from '@agent-dock/shared';
import { formatDurationShort } from './connection-health-format.js';
import type { SyncStatus } from '../components/primitives/SyncStatusPill.js';

/**
 * Derives `SyncStatusPill`'s `status`/`label` from `PipenzoGitHubHealthV1` (#230), for #75's
 * "syncing slowly" wiring.
 *
 * `SyncStatusPill.tsx`'s own doc comment is explicit that `status` is set "by the rate-limit check
 * on each poll, never by clicking the refresh button" -- so `syncing` (the third of its three
 * states, in-flight) is deliberately never returned here. Nothing in `PipenzoGitHubHealthV1`
 * reports "a poll is currently in progress"; the wire only ever carries the *result* of a
 * completed tick (`pipenzo-reconciler.ts`'s `#tick` publishes after `#pollAll` resolves, never
 * before it starts). Inventing an optimistic "syncing" the instant "Poll now" is clicked would be
 * exactly the thing that doc comment rules out, and a stale spinner that never turns off if the
 * click's own tick answers `304` faster than a human notices is a worse UI than simply not
 * claiming a state this data cannot support. `syncing` stays available on the primitive for
 * whichever future ticket adds a real in-flight signal.
 *
 * `slow` requires both `state === 'healthy'` and `quota.degraded === true` -- the reconciler is the
 * one thing that decided the poll interval widened (`pipenzo-reconciler.ts`'s `#baseDelay`), and
 * `PipenzoGitHubQuotaV1.degraded` is that decision reported, not re-derived from the fraction here
 * (the same reason `pipenzo-health-v1.ts` carries the flag instead of leaving consumers to compare
 * against `DEGRADED_QUOTA_FRACTION` themselves, which they cannot reach from `packages/shared`
 * anyway). A degraded reading that arrives alongside a *failing* state (`retrying`, `unreachable`,
 * `credential_rejected`) does not flip the pill to `slow` -- that health already owns
 * `ConnectionHealthBanner`'s slot with a more urgent banner, and a "syncing slowly" pill sitting
 * next to "GitHub is unreachable" would read as two different severities for one problem.
 */
export function deriveSyncStatus(
  health: PipenzoGitHubHealthV1 | undefined,
  now: number = Date.now(),
): { status: SyncStatus; label: string } {
  if (health === undefined) {
    return { status: 'synced', label: 'Not synced yet' };
  }

  if (health.state === 'healthy' && health.quota?.degraded === true) {
    return { status: 'slow', label: 'Syncing slowly' };
  }

  const lastCleanPollAt = health.lastCleanPollAt;
  if (lastCleanPollAt === undefined) {
    return { status: 'synced', label: 'Not synced yet' };
  }
  return { status: 'synced', label: `Synced ${formatDurationShort(now - lastCleanPollAt)} ago` };
}
