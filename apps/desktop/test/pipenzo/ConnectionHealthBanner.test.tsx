import { act, render, screen } from '@testing-library/react';
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

    it('renders "Re-authenticate" as the primary action and calls onReauthenticate on click', () => {
      const onReauthenticate = vi.fn();
      render(<ConnectionHealthBanner health={health} onReauthenticate={onReauthenticate} />);
      const button = screen.getByRole('button', { name: 'Re-authenticate' });
      expect(button.className).toBe('btn primary sm');
      button.click();
      expect(onReauthenticate).toHaveBeenCalledTimes(1);
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
});
