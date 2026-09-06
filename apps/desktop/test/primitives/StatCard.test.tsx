import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatCard } from '../../src/components/primitives/StatCard.js';

describe('StatCard', () => {
  it('renders label, icon and value', () => {
    const { container } = render(<StatCard label="PRs opened · 30d" icon="code" value="23" />);
    expect(screen.getByText('PRs opened · 30d')).toBeInTheDocument();
    expect(screen.getByText('23')).toBeInTheDocument();
    expect(container.querySelector('.stat-k svg')).toBeInTheDocument();
  });

  it('renders an up-trend delta with a leading arrow and the ok tone class', () => {
    const { container } = render(
      <StatCard label="PRs opened · 30d" value="23" delta="+6 vs previous 30d" trend="up" />,
    );
    const d = container.querySelector('.stat-d')!;
    expect(d.className).toBe('stat-d up');
    expect(d.querySelector('svg')).toBeInTheDocument();
    expect(screen.getByText('+6 vs previous 30d')).toBeInTheDocument();
  });

  it('renders a down-trend delta with the danger tone class', () => {
    const { container } = render(
      <StatCard label="Gates first-pass" value="87%" delta="−4 pts · 3 tickets parked" trend="down" />,
    );
    expect(container.querySelector('.stat-d')?.className).toBe('stat-d down');
  });

  it('renders a plain delta with no trend, no icon and no tone class', () => {
    const { container } = render(
      <StatCard label="Median diff" value="+41 −9" delta="across 2.1 files" />,
    );
    const d = container.querySelector('.stat-d')!;
    expect(d.className).toBe('stat-d');
    expect(d.querySelector('svg')).not.toBeInTheDocument();
  });

  it('renders the estimate self-tag and omits it by default', () => {
    const { container, rerender } = render(
      <StatCard
        label="Headroom · this window"
        estimateTag
        value={
          <>
            7 <span>sessions</span>
          </>
        }
        delta="~412k tokens · no provider reports a quota"
      />,
    );
    expect(screen.getByText('estimate')).toBeInTheDocument();
    expect(container.querySelector('.self-tag')).toBeInTheDocument();

    rerender(<StatCard label="PRs opened · 30d" value="23" />);
    expect(container.querySelector('.self-tag')).not.toBeInTheDocument();
  });

  it('renders an optional clamped progress bar under the value', () => {
    const { container, rerender } = render(<StatCard label="l" value="v" barPercent={140} />);
    let fill = container.querySelector('.bar-fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');

    rerender(<StatCard label="l" value="v" barPercent={35} />);
    fill = container.querySelector('.bar-fill') as HTMLElement;
    expect(fill.style.width).toBe('35%');
  });

  it('omits the bar entirely when barPercent is not given', () => {
    const { container } = render(<StatCard label="l" value="v" />);
    expect(container.querySelector('.bar')).not.toBeInTheDocument();
  });
});
