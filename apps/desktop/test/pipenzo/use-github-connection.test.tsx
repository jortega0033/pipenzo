import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoGitHubConnectionV1 } from '@agent-dock/shared';
import type { DaemonStatus } from '../../src/window.js';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { useGitHubConnection } from '../../src/pipenzo/use-github-connection.js';

const CONNECTED: PipenzoGitHubConnectionV1 = {
  state: 'connected',
  login: 'octocat',
  storedAt: '2026-01-01T00:00:00.000Z',
  source: 'vault',
};
const DISCONNECTED: PipenzoGitHubConnectionV1 = { state: 'disconnected', source: 'none' };
/** The ambiguous window from issue #286: a vault credential exists but the daemon has not
 * confirmed it yet, so `source` still reads `'none'` (honest as of #209). */
const UNCONFIRMED: PipenzoGitHubConnectionV1 = { state: 'connected', source: 'none' };

function Probe() {
  const { connection, daemonState } = useGitHubConnection();
  return (
    <>
      <span data-testid="state">{connection ? connection.state : 'unread'}</span>
      <span data-testid="daemon-state">{daemonState ?? 'unread'}</span>
    </>
  );
}

/** Only the three methods the hook touches; the rest of the bridge is irrelevant to it. Daemon
 * status defaults to a one-shot `'connecting'` unless a test overrides it -- most of these tests
 * only care about the connection side, same as before issue #286 added the daemon-state half. */
function installBridge(
  pipenzoGitHubConnection: () => Promise<PipenzoGitHubConnectionV1>,
  getDaemonStatus: () => Promise<DaemonStatus> = () =>
    Promise.resolve({ state: 'connecting' } as DaemonStatus),
): {
  emitStatus: (status: DaemonStatus) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let listener: ((status: DaemonStatus) => void) | undefined;
  const unsubscribe = vi.fn();
  setBridgeOverride({
    pipenzoGitHubConnection,
    getDaemonStatus,
    onDaemonStatus: (callback: (status: DaemonStatus) => void) => {
      listener = callback;
      return unsubscribe;
    },
  } as never);
  return {
    emitStatus: (status) => listener?.(status),
    unsubscribe,
  };
}

afterEach(() => {
  clearBridgeOverride();
});

describe('useGitHubConnection', () => {
  it('reports `unread` until the first read resolves', async () => {
    installBridge(vi.fn().mockResolvedValue(CONNECTED));
    render(<Probe />);

    expect(screen.getByTestId('state').textContent).toBe('unread');
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('connected'));
  });

  /**
   * A credential change is a daemon respawn -- the daemon is handed its token once, at spawn -- so
   * the moment the change actually takes effect is the moment the new daemon reports `ready`. That
   * edge is already on the wire, which is why there is no push channel for the credential itself.
   */
  it('re-reads when the daemon comes back ready, and not on the states in between', async () => {
    const read = vi.fn().mockResolvedValueOnce(CONNECTED).mockResolvedValue(DISCONNECTED);
    const { emitStatus } = installBridge(read);
    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('connected'));
    expect(read).toHaveBeenCalledTimes(1);

    emitStatus({ state: 'connecting' } as DaemonStatus);
    expect(read).toHaveBeenCalledTimes(1);

    emitStatus({ state: 'ready' } as DaemonStatus);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('disconnected'));
  });

  /**
   * A failed read is not a disconnected vault. Reporting it as one would send a correctly-connected
   * user to a Connect screen that cannot help them, and the recovery -- another `ready` -- is
   * already coming.
   */
  it('keeps the last known answer when a read fails', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(CONNECTED)
      .mockRejectedValueOnce(new Error('daemon is not ready yet'));
    const { emitStatus } = installBridge(read);
    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('connected'));
    emitStatus({ state: 'ready' } as DaemonStatus);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('state').textContent).toBe('connected');
  });

  /**
   * Two reads can overlap: main sends `ready` both after a credential restart and from
   * `did-finish-load` when a client already exists, so a reload landing near a restart starts a
   * second read before the first settles. Promises give no ordering between them, so without a
   * generation counter the *older* answer can land last and win -- producing a stale state that
   * looks entirely plausible and persists until the next `ready` happens to correct it.
   *
   * The unmount flag does not cover this; it only guards resolutions arriving after teardown.
   */
  it('ignores a stale read that settles after a newer one', async () => {
    const settle: ((value: PipenzoGitHubConnectionV1) => void)[] = [];
    const read = vi.fn(
      () =>
        new Promise<PipenzoGitHubConnectionV1>((resolve) => {
          settle.push(resolve);
        }),
    );
    const { emitStatus } = installBridge(read);
    render(<Probe />);

    // Two reads in flight: the mount read, then one started by a `ready` before it answered.
    emitStatus({ state: 'ready' } as DaemonStatus);
    expect(settle).toHaveLength(2);

    // The newer one answers first, then the older one answers with a different, stale value.
    settle[1]?.(DISCONNECTED);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('disconnected'));
    settle[0]?.(CONNECTED);

    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('state').textContent).toBe('disconnected');
  });

  /**
   * The race the combined hook exists to close (issue #286). A pushed `ready` and the credential
   * re-read it triggers are two independent async operations with no ordering between them; a
   * daemon-status subscriber that applied `ready` the instant it arrived could render a frame where
   * `daemonState` was already `'ready'` while `connection` was still the stale, unconfirmed read --
   * exactly the flash this ticket exists to remove, reintroduced for one IPC round trip. Pinning
   * that `daemonState` never reports `'ready'` on its own, only alongside the settled connection.
   */
  it('does not report the daemon ready until the credential re-read it triggers has settled', async () => {
    let settleRead: ((value: PipenzoGitHubConnectionV1) => void) | undefined;
    const read = vi
      .fn()
      .mockResolvedValueOnce(UNCONFIRMED)
      .mockImplementationOnce(
        () =>
          new Promise<PipenzoGitHubConnectionV1>((resolve) => {
            settleRead = resolve;
          }),
      );
    const { emitStatus } = installBridge(read);
    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('daemon-state').textContent).toBe('connecting'));
    expect(screen.getByTestId('state').textContent).toBe('connected');

    emitStatus({ state: 'ready' } as DaemonStatus);
    // The re-read this triggers is still in flight -- `daemonState` must not jump to `ready` yet,
    // or a caller gating on it (routePipenzoStartup) would trust a `connection` that hasn't caught
    // up.
    expect(screen.getByTestId('daemon-state').textContent).toBe('connecting');

    settleRead?.(CONNECTED);
    await waitFor(() => expect(screen.getByTestId('daemon-state').textContent).toBe('ready'));
    expect(screen.getByTestId('state').textContent).toBe('connected');
  });

  /** Unlike `ready`, nothing else needs to catch up for `connecting`/`unavailable` -- both apply the
   * instant they arrive, with no read to wait for. */
  it('applies `connecting` and `unavailable` immediately, without waiting on a read', async () => {
    const { emitStatus } = installBridge(vi.fn().mockResolvedValue(CONNECTED));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('daemon-state').textContent).toBe('connecting'));

    emitStatus({ state: 'unavailable', error: 'daemon failed to start: boom' } as DaemonStatus);
    await waitFor(() => expect(screen.getByTestId('daemon-state').textContent).toBe('unavailable'));
  });

  it('unsubscribes on unmount', async () => {
    const { unsubscribe } = installBridge(vi.fn().mockResolvedValue(CONNECTED));
    const { unmount } = render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('connected'));

    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
