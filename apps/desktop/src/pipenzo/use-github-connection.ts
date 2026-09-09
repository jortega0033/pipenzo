import { useEffect, useState } from 'react';
import type { PipenzoGitHubConnectionV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';

/** The three states `window.d.ts`'s `DaemonStatus` can report, minus the `unavailable` variant's
 * `error` string -- `routePipenzoStartup` only ever needs the state (issue #286). */
export type DaemonState = 'connecting' | 'ready' | 'unavailable';

export interface GitHubConnectionState {
  /** `undefined` means "not read yet" -- see `routePipenzoStartup`, which turns it into its own
   * screen rather than guessing. */
  readonly connection: PipenzoGitHubConnectionV1 | undefined;
  /** The local daemon's own lifecycle (issue #286), `undefined` until the first read settles. See
   * `startup-route.ts`'s `PipenzoStartupInput.daemonState` doc comment for what this resolves. */
  readonly daemonState: DaemonState | undefined;
}

/**
 * The renderer's view of the GitHub credential (issue #113), re-read whenever it can have changed
 * -- and, since issue #286, of the daemon's own lifecycle alongside it.
 *
 * ## Why this is one hook and not two
 *
 * It used to be: a `useGitHubConnection` re-reading on `ready`, and a separate `useDaemonStatus`
 * applying every pushed `daemon:status` directly. That is wrong for the `ready` transition
 * specifically. `routePipenzoStartup` treats `daemonState === 'ready'` as license to stop waiting
 * and trust `connection.source` at face value -- but a *pushed* `ready` and the credential re-read
 * it triggers are two independent async operations with no ordering between them. A daemon-status
 * subscriber that applies `ready` the instant it arrives can render a frame where `daemonState` is
 * already `'ready'` and `connection` is still the *previous* (unconfirmed) read, which is exactly
 * the flash issue #286 exists to remove -- reintroduced for one IPC round trip instead of the whole
 * daemon-startup window. So `ready` is only ever reported here once the credential re-read it
 * triggers has itself settled; both update in the same `.then()`, which React batches into one
 * render. `'connecting'` and `'unavailable'` have no such coupling -- nothing else needs to catch up
 * for either -- and are applied the instant they arrive.
 *
 * ## Why this doesn't re-read on `connecting`/`unavailable`
 *
 * There is no push channel for the credential itself. The moment a credential change actually takes
 * effect is the moment the *new daemon* is serving, because the daemon is handed its token once at
 * spawn and a change is a respawn -- `main.ts`'s disconnect handler says as much: the reply it sends
 * still describes the daemon on its way out. So `ready` is the one edge worth re-reading on; the
 * states in between describe a daemon whose credential answer, whatever it turns out to be, has not
 * changed yet.
 *
 * A read that never settles would leave the caller on "not read yet" forever, with no timeout here
 * to rescue it. That is accepted rather than overlooked: the channel behind it is a *synchronous*
 * main-process handler (`main.ts`'s `pipenzo:github-connection` returns `gitHubConnectionStatus()`
 * directly), so it cannot be slow on its own -- a hang means main itself is wedged, at which point
 * every other channel this window depends on is gone too and a retry button here would do nothing.
 */
export function useGitHubConnection(): GitHubConnectionState {
  const [connection, setConnection] = useState<PipenzoGitHubConnectionV1 | undefined>(undefined);
  const [daemonState, setDaemonState] = useState<DaemonState | undefined>(undefined);

  useEffect(() => {
    // Two connection reads can be in flight at once -- the mount read, and one started by a `ready`
    // that arrives before it settles (main sends `ready` both after a credential restart and from
    // `did-finish-load` when a client already exists, so a reload landing near a restart produces
    // exactly that overlap). Promises have no ordering guarantee between them, so without a
    // generation counter the *older* answer can land last and win. The result would be a stale
    // `connected`/`disconnected` that looks entirely plausible and persists until the next `ready`
    // happens to correct it. `cancelled` alone does not cover this: it only guards unmount.
    let latest = 0;
    let cancelled = false;

    const readConnection = (onSettled?: () => void): void => {
      latest += 1;
      const generation = latest;
      void getBridge()
        .pipenzoGitHubConnection()
        .then((next) => {
          if (cancelled || generation !== latest) return;
          setConnection(next);
        })
        .catch(() => {
          // A failed read is not a disconnected vault, and reporting it as one would send a
          // correctly-connected user to a screen that cannot help them. Leave the last known
          // answer -- `undefined` on the first read, which routes to `loading` -- and wait for the
          // next `ready`, which is when a real answer becomes possible again.
        })
        .finally(() => {
          if (!cancelled && generation === latest) onSettled?.();
        });
    };

    readConnection();

    // The daemon's own one-shot status, for the initial render. A push received before this
    // resolves must win -- same race as the connection read above, guarded the same way a
    // functional update naturally does here: only apply this answer if nothing has answered yet.
    void getBridge()
      .getDaemonStatus()
      .then((status) => {
        if (cancelled) return;
        setDaemonState((current) => current ?? status.state);
      })
      .catch(() => {});

    const unsubscribe = getBridge().onDaemonStatus((status) => {
      if (cancelled) return;
      if (status.state === 'ready') {
        // See the doc comment above: `daemonState` only becomes `'ready'` once the credential
        // re-read this event triggers has itself landed, so the two never disagree in a rendered
        // frame.
        readConnection(() => setDaemonState('ready'));
        return;
      }
      setDaemonState(status.state);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { connection, daemonState };
}
