import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoGitHubHealthV1 } from '@agent-dock/shared';
import { ConnectionHealthBanner } from '../../src/pipenzo/ConnectionHealthBanner.js';

const NOW = Date.UTC(2026, 0, 1, 14, 2, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectionHealthBanner', () => {
  it('renders nothing when health is undefined (no value has arrived yet)', () => {
    const { container } = render(<ConnectionHealthBanner health={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for states this ticket does not yet handle', () => {
    const { container } = render(
      <ConnectionHealthBanner health={{ state: 'unknown' }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  describe('retrying (#70)', () => {
    const health: PipenzoGitHubHealthV1 = {
      state: 'retrying',
      attempt: 2,
      maxAttempts: 5,
      nextAttemptAt: NOW + 18_000,
      consecutiveFailures: 2,
      firstFailureAt: NOW - 40_000,
      lastCleanPollAt: NOW - 60_000,
    };

    it('renders the retrying banner with the mono attempt count and a countdown to the next attempt', () => {
      const { container } = render(<ConnectionHealthBanner health={health} />);
      const banner = container.querySelector('.banner')!;
      expect(banner.className).toBe('banner retrying');
      expect(screen.getByText('attempt 2 of 5')).toBeInTheDocument();
      expect(screen.getByText('18s')).toBeInTheDocument();
      expect(screen.getByText(/14:01/)).toBeInTheDocument();
    });

    it('counts down live as real time passes', () => {
      render(<ConnectionHealthBanner health={health} />);
      expect(screen.getByText('18s')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.getByText('13s')).toBeInTheDocument();
      expect(screen.queryByText('18s')).not.toBeInTheDocument();
    });

    it('stops ticking once the countdown reaches zero, instead of firing forever at "0s"', () => {
      render(<ConnectionHealthBanner health={health} />);

      act(() => {
        vi.advanceTimersByTime(18_000);
      });
      expect(screen.getByText('0s')).toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(0);

      // Nothing left to clear, and nothing re-renders on every later tick either.
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText('0s')).toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('omits the last-clean-poll sentence when there has never been one', () => {
      render(
        <ConnectionHealthBanner
          health={{ ...health, lastCleanPollAt: undefined }}
        />,
      );
      expect(
        screen.getByText(/has not completed a clean poll since this run of failures began/),
      ).toBeInTheDocument();
    });

    it('renders no action row when onRetryNow is not supplied', () => {
      const { container } = render(<ConnectionHealthBanner health={health} />);
      expect(container.querySelector('.b-act')).not.toBeInTheDocument();
    });

    it('renders "Retry now" and calls onRetryNow on click', () => {
      const onRetryNow = vi.fn();
      render(<ConnectionHealthBanner health={health} onRetryNow={onRetryNow} />);
      const button = screen.getByRole('button', { name: 'Retry now' });
      button.click();
      expect(onRetryNow).toHaveBeenCalledTimes(1);
    });
  });

  describe('unreachable (#71)', () => {
    const health: PipenzoGitHubHealthV1 = {
      state: 'unreachable',
      consecutiveFailures: 5,
      firstFailureAt: NOW - 60_000,
      nextAttemptAt: NOW + 8 * 60_000,
      maxAttempts: 5,
      lastCleanPollAt: NOW - 120_000,
    };

    it('renders the blocking, tinted banner with the failure count and backoff readout', () => {
      const { container } = render(<ConnectionHealthBanner health={health} />);
      const banner = container.querySelector('.banner')!;
      expect(banner.className).toBe('banner danger blocking');
      expect(screen.getByText('GitHub is unreachable.')).toBeInTheDocument();
      expect(screen.getByText(/5 polls failed since/)).toBeInTheDocument();
      expect(screen.getByText(/14:01/)).toBeInTheDocument();
      expect(screen.getByText('backoff 8m')).toBeInTheDocument();
    });

    it('says running agents keep working in their own worktrees', () => {
      render(<ConnectionHealthBanner health={health} />);
      expect(screen.getByText(/running agents keep working in their/)).toBeInTheDocument();
    });

    it('omits the backoff count when nothing is scheduled (the ladder stopped, only a human moves this)', () => {
      const { container } = render(
        <ConnectionHealthBanner health={{ ...health, nextAttemptAt: undefined }} />,
      );
      expect(container.querySelector('.b-count')).not.toBeInTheDocument();
    });

    it('renders "Retry now" as the default (non-ghost) button and calls onRetryNow on click', () => {
      const onRetryNow = vi.fn();
      render(<ConnectionHealthBanner health={health} onRetryNow={onRetryNow} />);
      const button = screen.getByRole('button', { name: 'Retry now' });
      expect(button.className).toBe('btn sm');
      button.click();
      expect(onRetryNow).toHaveBeenCalledTimes(1);
    });
  });

  describe('credential_rejected (#72)', () => {
    const health: PipenzoGitHubHealthV1 = {
      state: 'credential_rejected',
      rejectedAt: NOW - 30_000,
      lastCleanPollAt: NOW - 90_000,
    };

    // Real timers for this block: the confirm-dialog tests below use `waitFor`/`findBy`, which
    // poll via `setTimeout` and would otherwise race the outer `beforeEach`'s fake clock (`#70`'s
    // countdown tests need fake timers; this block's async confirm/error flow needs real ones).
    beforeEach(() => {
      vi.useRealTimers();
    });

    it('renders the blocking banner explaining the expired sign-in', () => {
      const { container } = render(<ConnectionHealthBanner health={health} />);
      const banner = container.querySelector('.banner')!;
      expect(banner.className).toBe('banner danger blocking');
      expect(screen.getByText('Your GitHub sign-in expired.')).toBeInTheDocument();
      expect(
        screen.getByText(/Reading issues, writing labels and opening pull requests/),
      ).toBeInTheDocument();
    });

    it('renders no count -- there is no number this state is waiting on', () => {
      const { container } = render(<ConnectionHealthBanner health={health} />);
      expect(container.querySelector('.b-count')).not.toBeInTheDocument();
    });

    it('renders "Re-authenticate" as the primary action, opening a confirm dialog rather than firing immediately', () => {
      const onReauthenticate = vi.fn();
      render(<ConnectionHealthBanner health={health} onReauthenticate={onReauthenticate} />);
      const button = screen.getByRole('button', { name: 'Re-authenticate' });
      expect(button.className).toBe('btn primary sm');
      fireEvent.click(button);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(onReauthenticate).not.toHaveBeenCalled();
    });

    it('calls onReauthenticate only once the dialog is confirmed', async () => {
      const onReauthenticate = vi.fn().mockResolvedValue(undefined);
      render(<ConnectionHealthBanner health={health} onReauthenticate={onReauthenticate} />);
      fireEvent.click(screen.getByRole('button', { name: 'Re-authenticate' }));
      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Re-authenticate' }));
      await waitFor(() => expect(onReauthenticate).toHaveBeenCalledTimes(1));
    });

    it('"Not now" closes the dialog without calling onReauthenticate', () => {
      const onReauthenticate = vi.fn();
      render(<ConnectionHealthBanner health={health} onReauthenticate={onReauthenticate} />);
      fireEvent.click(screen.getByRole('button', { name: 'Re-authenticate' }));
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(onReauthenticate).not.toHaveBeenCalled();
    });

    it('shows an error notice, and keeps the credential-rejected banner, when the daemon call fails', async () => {
      const onReauthenticate = vi.fn().mockRejectedValue(new Error('daemon unreachable'));
      render(<ConnectionHealthBanner health={health} onReauthenticate={onReauthenticate} />);
      fireEvent.click(screen.getByRole('button', { name: 'Re-authenticate' }));
      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Re-authenticate' }));
      expect(await screen.findByText(/daemon unreachable/)).toBeInTheDocument();
      expect(screen.getByText('Your GitHub sign-in expired.')).toBeInTheDocument();
    });

    /**
     * The guard `AccountPanel.tsx`'s identical channel needs and has (see this component's own
     * doc comment): two clicks dispatched in the same React batch both see `pending === false`
     * before either commits, and `useAsyncAction`'s `callIdRef` only decides which outcome wins,
     * not whether a second call starts. Two re-authenticate attempts is two real daemon restarts.
     */
    it('will not start a second re-authenticate in the same batch as the first', () => {
      let release: (() => void) | undefined;
      const onReauthenticate = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      render(<ConnectionHealthBanner health={health} onReauthenticate={onReauthenticate} />);
      fireEvent.click(screen.getByRole('button', { name: 'Re-authenticate' }));
      const dialog = screen.getByRole('dialog');
      const confirm = within(dialog).getByRole('button', { name: 'Re-authenticate' });

      act(() => {
        fireEvent.click(confirm);
        fireEvent.click(confirm);
      });

      expect(onReauthenticate).toHaveBeenCalledTimes(1);
      release?.();
    });

    it('renders no action row when onReauthenticate is not supplied', () => {
      const { container } = render(<ConnectionHealthBanner health={health} />);
      expect(container.querySelector('.b-act')).not.toBeInTheDocument();
    });

    it('never offers "Retry now" for this state, even when onRetryNow is supplied -- retrying a rejected credential does not fix it', () => {
      render(<ConnectionHealthBanner health={health} onRetryNow={vi.fn()} />);
      expect(screen.queryByRole('button', { name: 'Retry now' })).not.toBeInTheDocument();
    });
  });

  describe('recovery (#73)', () => {
    const retrying: PipenzoGitHubHealthV1 = {
      state: 'retrying',
      attempt: 2,
      maxAttempts: 5,
      nextAttemptAt: NOW + 18_000,
      consecutiveFailures: 2,
      firstFailureAt: NOW - 40_000,
    };
    const healthy: PipenzoGitHubHealthV1 = { state: 'healthy', lastCleanPollAt: NOW };
    const unreachable: PipenzoGitHubHealthV1 = {
      state: 'unreachable',
      consecutiveFailures: 5,
      firstFailureAt: NOW - 60_000,
      maxAttempts: 5,
    };
    const rejected: PipenzoGitHubHealthV1 = { state: 'credential_rejected', rejectedAt: NOW };

    it('renders nothing on a plain healthy value with no prior failure -- this is knowledge, not a recovery', () => {
      const { container } = render(<ConnectionHealthBanner health={healthy} />);
      expect(container).toBeEmptyDOMElement();
    });

    it.each([
      ['retrying', retrying],
      ['unreachable', unreachable],
      ['credential_rejected', rejected],
    ] as const)('shows the recovery banner after healthy follows %s', (_label, failing) => {
      const { rerender } = render(<ConnectionHealthBanner health={failing} />);
      rerender(<ConnectionHealthBanner health={healthy} />);
      expect(screen.getByText(/Signed in again/)).toBeInTheDocument();
      const banner = document.querySelector('.banner')!;
      expect(banner.className).toBe('banner warn');
    });

    it('renders the login and repo count when supplied, and omits the sentence pieces it does not have', () => {
      const { rerender } = render(
        <ConnectionHealthBanner health={retrying} loginName="jortega0033" connectedRepoCount={3} />,
      );
      rerender(
        <ConnectionHealthBanner health={healthy} loginName="jortega0033" connectedRepoCount={3} />,
      );
      expect(screen.getByText('jortega0033')).toBeInTheDocument();
      expect(screen.getByText(/3 repos reconnected/)).toBeInTheDocument();
    });

    it('says "1 repo", not "1 repos"', () => {
      const { rerender } = render(
        <ConnectionHealthBanner health={retrying} connectedRepoCount={1} />,
      );
      rerender(<ConnectionHealthBanner health={healthy} connectedRepoCount={1} />);
      expect(screen.getByText(/1 repo reconnected/)).toBeInTheDocument();
    });

    it('persists across later clean polls (repeated `healthy` pushes) until dismissed', () => {
      const { rerender } = render(<ConnectionHealthBanner health={retrying} />);
      rerender(<ConnectionHealthBanner health={healthy} />);
      expect(screen.getByText(/Signed in again/)).toBeInTheDocument();

      rerender(<ConnectionHealthBanner health={{ ...healthy, lastCleanPollAt: NOW + 60_000 }} />);
      expect(screen.getByText(/Signed in again/)).toBeInTheDocument();
    });

    it('is dismissible, and stays gone', () => {
      const { rerender } = render(<ConnectionHealthBanner health={retrying} />);
      rerender(<ConnectionHealthBanner health={healthy} />);
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByText(/Signed in again/)).not.toBeInTheDocument();

      rerender(<ConnectionHealthBanner health={{ ...healthy, lastCleanPollAt: NOW + 60_000 }} />);
      expect(screen.queryByText(/Signed in again/)).not.toBeInTheDocument();
    });

    it('is cancelled by a fresh failure rather than staying up as stale news', () => {
      const { rerender } = render(<ConnectionHealthBanner health={retrying} />);
      rerender(<ConnectionHealthBanner health={healthy} />);
      expect(screen.getByText(/Signed in again/)).toBeInTheDocument();

      rerender(<ConnectionHealthBanner health={unreachable} />);
      expect(screen.queryByText(/Signed in again/)).not.toBeInTheDocument();
      expect(screen.getByText('GitHub is unreachable.')).toBeInTheDocument();

      rerender(<ConnectionHealthBanner health={healthy} />);
      expect(screen.getByText(/Signed in again/)).toBeInTheDocument();
    });
  });

  describe('degraded quota (#75)', () => {
    const degraded: PipenzoGitHubHealthV1 = {
      state: 'healthy',
      lastCleanPollAt: NOW,
      quota: { remainingFraction: 0.08, resetAt: NOW + 60_000, degraded: true },
    };

    it('renders the warn banner below 15% remaining quota', () => {
      const { container } = render(<ConnectionHealthBanner health={degraded} />);
      const banner = container.querySelector('.banner')!;
      expect(banner.className).toBe('banner warn');
      expect(screen.getByText('15%')).toBeInTheDocument();
      expect(screen.getByText(/degraded, not failed/)).toBeInTheDocument();
    });

    it('renders nothing when healthy but quota is not degraded', () => {
      const { container } = render(
        <ConnectionHealthBanner
          health={{
            state: 'healthy',
            lastCleanPollAt: NOW,
            quota: { remainingFraction: 0.5, resetAt: NOW + 60_000, degraded: false },
          }}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    });

    it('renders "Poll now" as a ghost button and calls onRetryNow on click', () => {
      const onRetryNow = vi.fn();
      render(<ConnectionHealthBanner health={degraded} onRetryNow={onRetryNow} />);
      const button = screen.getByRole('button', { name: 'Poll now' });
      expect(button.className).toBe('btn ghost sm');
      button.click();
      expect(onRetryNow).toHaveBeenCalledTimes(1);
    });

    it('does not compete with a more urgent banner: a failing state with a degraded quota reading still shows its own banner, not this one', () => {
      render(
        <ConnectionHealthBanner
          health={{
            state: 'unreachable',
            consecutiveFailures: 5,
            firstFailureAt: NOW - 60_000,
            maxAttempts: 5,
            quota: { remainingFraction: 0.05, resetAt: NOW + 60_000, degraded: true },
          }}
        />,
      );
      expect(screen.getByText('GitHub is unreachable.')).toBeInTheDocument();
      expect(screen.queryByText(/degraded, not failed/)).not.toBeInTheDocument();
    });

    it('does not pre-empt a shown recovery banner', () => {
      const retrying: PipenzoGitHubHealthV1 = {
        state: 'retrying',
        attempt: 1,
        maxAttempts: 5,
        nextAttemptAt: NOW,
        consecutiveFailures: 1,
        firstFailureAt: NOW,
      };
      const { rerender } = render(<ConnectionHealthBanner health={retrying} />);
      rerender(<ConnectionHealthBanner health={degraded} />);
      expect(screen.getByText(/Signed in again/)).toBeInTheDocument();
      expect(screen.queryByText(/degraded, not failed/)).not.toBeInTheDocument();
    });
  });
});
