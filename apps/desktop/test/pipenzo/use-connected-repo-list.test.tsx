import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus } from '../../src/window.js';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { useConnectedRepoList } from '../../src/pipenzo/use-connected-repo-list.js';

function Probe() {
  const { repoList, refresh } = useConnectedRepoList();
  return (
    <>
      <span data-testid="status">{repoList.status}</span>
      <span data-testid="repos">
        {repoList.status === 'ready' ? repoList.repositories.join(',') : '-'}
      </span>
      <button type="button" onClick={() => refresh()}>
        refresh
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

const status = () => screen.getByTestId('status').textContent;
const repos = () => screen.getByTestId('repos').textContent;

afterEach(() => {
  clearBridgeOverride();
});

describe('useConnectedRepoList', () => {
  it('starts loading, then reports the real list', async () => {
    installBridge(vi.fn().mockResolvedValue({ repositories: ['octocat/hello-world'] }));
    render(<Probe />);

    expect(status()).toBe('loading');
    await waitFor(() => expect(status()).toBe('ready'));
    expect(repos()).toBe('octocat/hello-world');
  });

  it('reports a real empty list once it genuinely knows', async () => {
    installBridge(vi.fn().mockResolvedValue({ repositories: [] }));
    render(<Probe />);

    await waitFor(() => expect(status()).toBe('ready'));
    expect(repos()).toBe('');
  });

  /**
   * The distinction the whole point of a separate `'error'` state exists for: a daemon that is not
   * ready yet must never be reported as "zero repos connected", which would render the switcher as
   * if the workspace genuinely had nothing connected.
   */
  it('reports error rather than a silent empty list when the daemon refuses the call', async () => {
    installBridge(vi.fn().mockRejectedValue(new Error('daemon is not ready yet')));
    render(<Probe />);

    await waitFor(() => expect(status()).toBe('error'));
  });

  it('re-reads when the daemon comes back ready', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ repositories: [] })
      .mockResolvedValue({ repositories: ['octocat/a', 'octocat/b'] });
    const { emit } = installBridge(read);
    render(<Probe />);

    await waitFor(() => expect(repos()).toBe(''));
    emit({ state: 'ready' } as DaemonStatus);
    await waitFor(() => expect(repos()).toBe('octocat/a,octocat/b'));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale read that settles after a newer one', async () => {
    const settle: ((value: { repositories: string[] }) => void)[] = [];
    const read = vi.fn(
      () => new Promise<{ repositories: string[] }>((resolve) => settle.push(resolve)),
    );
    const { emit } = installBridge(read);
    render(<Probe />);

    emit({ state: 'ready' } as DaemonStatus);
    expect(settle).toHaveLength(2);

    settle[1]?.({ repositories: ['octocat/a'] });
    await waitFor(() => expect(repos()).toBe('octocat/a'));
    settle[0]?.({ repositories: [] });

    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(repos()).toBe('octocat/a');
  });

  it('the manual refresh re-asks the daemon', async () => {
    const read = vi.fn().mockResolvedValue({ repositories: [] });
    installBridge(read);
    render(<Probe />);
    await waitFor(() => expect(status()).toBe('ready'));

    screen.getByRole('button', { name: 'refresh' }).click();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it('unsubscribes on unmount', async () => {
    const { unsubscribe } = installBridge(vi.fn().mockResolvedValue({ repositories: [] }));
    const { unmount } = render(<Probe />);
    await waitFor(() => expect(status()).toBe('ready'));

    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
