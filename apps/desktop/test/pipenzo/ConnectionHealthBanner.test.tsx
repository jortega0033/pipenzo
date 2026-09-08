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
});
