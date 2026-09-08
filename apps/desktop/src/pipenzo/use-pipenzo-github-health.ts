import { useEffect, useState } from 'react';
import type { PipenzoGitHubHealthV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';

/**
 * The renderer's live view of Pipenzo's GitHub connection health (issue #257's transport), for
 * `ConnectionHealthBanner` (#70/#71/#72/#73) and #75's `SyncStatusPill` wiring.
 *
 * Push-only, unlike `useGitHubConnection`/`useConnectedRepos`: the daemon holds one connection open
 * per window (`onPipenzoGitHubHealth`, Electron main's `pipenzo-health-stream.ts` relay) and sends
 * the current value the moment it opens, so there is no separate "read once" call to make here —
 * subscribing *is* the read.
 *
 * `undefined` means "no value has arrived yet": the window just opened, or a daemon restart tore
 * the previous connection down and the fresh one has not delivered its first frame. It is not
 * itself a renderable state — `ConnectionHealthBanner` treats it exactly like the wire's own
 * `unknown` state, by rendering nothing.
 */
export function usePipenzoGitHubHealth(): PipenzoGitHubHealthV1 | undefined {
  const [health, setHealth] = useState<PipenzoGitHubHealthV1 | undefined>(undefined);

  useEffect(() => {
    return getBridge().onPipenzoGitHubHealth(setHealth);
  }, []);

  return health;
}
