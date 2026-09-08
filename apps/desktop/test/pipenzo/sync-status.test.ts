import { describe, expect, it } from 'vitest';
import type { PipenzoGitHubHealthV1 } from '@agent-dock/shared';
import { deriveSyncStatus } from '../../src/pipenzo/sync-status.js';

const NOW = Date.UTC(2026, 0, 1, 14, 2, 0);

describe('deriveSyncStatus', () => {
  it('reports "Not synced yet" when no health value has arrived', () => {
    expect(deriveSyncStatus(undefined, NOW)).toEqual({ status: 'synced', label: 'Not synced yet' });
  });

  it('reports "Not synced yet" for unknown with no prior clean poll', () => {
    expect(deriveSyncStatus({ state: 'unknown' }, NOW)).toEqual({
      status: 'synced',
      label: 'Not synced yet',
    });
  });

  it('reports how long ago the last clean poll was', () => {
    const health: PipenzoGitHubHealthV1 = { state: 'healthy', lastCleanPollAt: NOW - 38_000 };
    expect(deriveSyncStatus(health, NOW)).toEqual({ status: 'synced', label: 'Synced 38s ago' });
  });

  it('reports "slow" only when healthy AND quota.degraded is true', () => {
    const health: PipenzoGitHubHealthV1 = {
      state: 'healthy',
      lastCleanPollAt: NOW,
      quota: { remainingFraction: 0.1, resetAt: NOW + 60_000, degraded: true },
    };
    expect(deriveSyncStatus(health, NOW)).toEqual({ status: 'slow', label: 'Syncing slowly' });
  });

  it('does not report "slow" when quota is present but not degraded', () => {
    const health: PipenzoGitHubHealthV1 = {
      state: 'healthy',
      lastCleanPollAt: NOW - 5_000,
      quota: { remainingFraction: 0.8, resetAt: NOW + 60_000, degraded: false },
    };
    expect(deriveSyncStatus(health, NOW)).toEqual({ status: 'synced', label: 'Synced 5s ago' });
  });

  it('does not report "slow" for a failing state even if its quota reading is degraded -- that state already owns a more urgent banner', () => {
    const health: PipenzoGitHubHealthV1 = {
      state: 'retrying',
      attempt: 1,
      maxAttempts: 5,
      nextAttemptAt: NOW + 10_000,
      consecutiveFailures: 1,
      firstFailureAt: NOW,
      quota: { remainingFraction: 0.05, resetAt: NOW + 60_000, degraded: true },
    };
    expect(deriveSyncStatus(health, NOW).status).not.toBe('slow');
  });

  it('never returns "syncing" -- there is no real in-flight signal on the wire to derive it from', () => {
    const allHealthValues: PipenzoGitHubHealthV1[] = [
      { state: 'unknown' },
      { state: 'healthy', lastCleanPollAt: NOW },
      {
        state: 'retrying',
        attempt: 1,
        maxAttempts: 5,
        nextAttemptAt: NOW,
        consecutiveFailures: 1,
        firstFailureAt: NOW,
      },
      { state: 'unreachable', consecutiveFailures: 5, firstFailureAt: NOW, maxAttempts: 5 },
      { state: 'credential_rejected', rejectedAt: NOW },
    ];
    for (const health of allHealthValues) {
      expect(deriveSyncStatus(health, NOW).status).not.toBe('syncing');
    }
  });
});
