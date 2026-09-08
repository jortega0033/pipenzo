import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus } from '../../src/window.js';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { useConnectedRepos } from '../../src/pipenzo/use-connected-repos.js';

function Probe() {
  const { connectedRepos, refresh } = useConnectedRepos();
  return (
    <>
      <span data-testid="state">{String(connectedRepos)}</span>
      <button type="button" onClick={() => refresh()}>
        refresh
      </button>
      <button type="button" onClick={() => refresh(7)}>
        refresh with 7
      </button>
    </>
  );
}

function installBridge(read: () => Promise<{ repositories: string[] }>) {
  let listener: ((status: DaemonStatus) => void) | undefined;
  const unsubscribe = vi.fn();
  setBridgeOverride({
    pipenzoConnectedRepos: read,
    onDaemonStatus: (callback: (status: DaemonStatus) => void) => {
      listener = callback;
      return unsubscribe;
    },
  } as never);
  return { emit: (status: DaemonStatus) => listener?.(status), unsubscribe };
}

const state = () => screen.getByTestId('state').textContent;

afterEach(() => {
  clearBridgeOverride();
});

describe('useConnectedRepos', () => {
  /**
   * "No answer yet" and "no answer coming" are different states, and collapsing them is what made
   * the gate render the board and then replace it with the picker a moment later. `unknown` routes
   * to `loading`; `not-tracked` routes through.
   */
  it('starts unknown, not not-tracked', async () => {
    installBridge(vi.fn().mockResolvedValue({ repositories: ['octocat/a'] }));
    render(<Probe />);

    expect(state()).toBe('unknown');
    await waitFor(() => expect(state()).toBe('1'));
  });

  /**
   * The daemon rejects this call while it is starting, which is the common case right after a
   * sign-in because connecting restarts it. Reporting `0` there would route a fully-configured
   * install to the repo picker on every launch -- so it settles to the honest `not-tracked`, which
   * the router treats as satisfied.
   */
  it('settles to not-tracked when the daemon cannot be asked, never to zero', async () => {
    installBridge(vi.fn().mockRejectedValue(new Error('daemon is not ready yet')));
    render(<Probe />);

    await waitFor(() => expect(state()).toBe('not-tracked'));
    expect(state()).not.toBe('0');
  });

  it('reports a real zero once it genuinely knows', async () => {
    installBridge(vi.fn().mockResolvedValue({ repositories: [] }));
    render(<Probe />);
    await waitFor(() => expect(state()).toBe('0'));
  });

  it('re-reads when the daemon comes back ready, and not on the states in between', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ repositories: [] })
      .mockResolvedValue({ repositories: ['octocat/a', 'octocat/b'] });
    const { emit } = installBridge(read);
    render(<Probe />);

    await waitFor(() => expect(state()).toBe('0'));
    emit({ state: 'connecting' } as DaemonStatus);
    expect(read).toHaveBeenCalledTimes(1);

    emit({ state: 'ready' } as DaemonStatus);
    await waitFor(() => expect(state()).toBe('2'));
  });

  /**
   * The same generation guard `useGitHubConnection` carries, for the same reason: two reads overlap
   * when a `ready` lands before the first settles, and promises have no ordering between them, so
   * the older answer can land last and win.
   */
  it('ignores a stale read that settles after a newer one', async () => {
    const settle: ((value: { repositories: string[] }) => void)[] = [];
    const read = vi.fn(
      () => new Promise<{ repositories: string[] }>((resolve) => settle.push(resolve)),
    );
    const { emit } = installBridge(read);
    render(<Probe />);

    emit({ state: 'ready' } as DaemonStatus);
    expect(settle).toHaveLength(2);

    settle[1]?.({ repositories: ['octocat/a', 'octocat/b'] });
    await waitFor(() => expect(state()).toBe('2'));
    settle[0]?.({ repositories: [] });

    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(state()).toBe('2');
  });

  /**
   * The picker's own save lands immediately rather than waiting for the next `ready`: it is the
   * moment first-run finishes, and waiting for a poll to notice would leave the user looking at a
   * screen they have already completed.
   */
  it('accepts a count directly, without asking the daemon again', async () => {
    const read = vi.fn().mockResolvedValue({ repositories: [] });
    installBridge(read);
    render(<Probe />);
    await waitFor(() => expect(state()).toBe('0'));

    screen.getByRole('button', { name: 'refresh with 7' }).click();
    await waitFor(() => expect(state()).toBe('7'));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount', async () => {
    const { unsubscribe } = installBridge(vi.fn().mockResolvedValue({ repositories: [] }));
    const { unmount } = render(<Probe />);
    await waitFor(() => expect(state()).toBe('0'));

    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
