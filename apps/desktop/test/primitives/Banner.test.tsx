import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Banner, BannerStack } from '../../src/components/primitives/Banner.js';

describe('Banner', () => {
  it('renders neutral tone with no tone class', () => {
    const { container } = render(
      <Banner icon="info">
        Signed in as <b>jortega0033</b>
      </Banner>,
    );
    expect(container.querySelector('.banner')?.className).toBe('banner');
  });

  it.each(['ok', 'warn', 'danger'] as const)('applies the %s tone class', (tone) => {
    const { container } = render(
      <Banner icon="info" tone={tone}>
        Message
      </Banner>,
    );
    expect(container.querySelector('.banner')?.className).toBe(`banner ${tone}`);
  });

  it('renders no action row when neither action nor onDismiss is given', () => {
    const { container } = render(<Banner icon="info">Message</Banner>);
    expect(container.querySelector('.b-act')).not.toBeInTheDocument();
  });

  it('renders a single action', () => {
    render(
      <Banner icon="warning" tone="warn" action={<button className="btn sm ghost">Poll now</button>}>
        Below <b>15%</b> of rate limit.
      </Banner>,
    );
    expect(screen.getByRole('button', { name: 'Poll now' })).toBeInTheDocument();
  });

  it('renders a dismiss control only when onDismiss is given, and calls it on click', () => {
    const onDismiss = vi.fn();
    render(
      <Banner icon="warning" onDismiss={onDismiss}>
        Reconnected.
      </Banner>,
    );
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('omits the dismiss control for a system-state banner (no onDismiss passed)', () => {
    render(
      <Banner icon="x-circle" tone="danger" action={<button className="btn sm">Reconnect</button>}>
        Daemon unreachable since 14:02.
      </Banner>,
    );
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });
});

describe('BannerStack', () => {
  it('wraps its banners in the .stack grouping container', () => {
    const { container } = render(
      <BannerStack>
        <Banner icon="info">First</Banner>
        <Banner icon="warning" tone="warn">
          Second
        </Banner>
      </BannerStack>,
    );
    const stack = container.querySelector('.stack');
    expect(stack).toBeInTheDocument();
    expect(stack?.querySelectorAll('.banner')).toHaveLength(2);
  });
});
