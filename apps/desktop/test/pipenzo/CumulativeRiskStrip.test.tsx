import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CumulativeRiskStrip } from '../../src/pipenzo/CumulativeRiskStrip.js';

describe('CumulativeRiskStrip', () => {
  it('renders inside a RailBlock labelled "Cumulative risk"', () => {
    const { container } = render(<CumulativeRiskStrip risk={{ score: 0 }} />);
    const block = container.querySelector('.rail-block')!;
    expect(block.querySelector('.label')).toHaveTextContent('Cumulative risk');
  });

  it('renders ten segments, total, regardless of how many are filled', () => {
    const { container } = render(<CumulativeRiskStrip risk={{ score: 3 }} />);
    expect(container.querySelectorAll('.risk-seg')).toHaveLength(10);
  });

  it('renders real score data, not a mocked count', () => {
    render(<CumulativeRiskStrip risk={{ score: 4 }} />);
    expect(screen.getByText('Moderate')).toBeInTheDocument();
    expect(screen.getByText('4.0 / 10')).toBeInTheDocument();
  });

  it('marks exactly the filled segments "on", the rest not', () => {
    const { container } = render(<CumulativeRiskStrip risk={{ score: 4 }} />);
    const segments = Array.from(container.querySelectorAll('.risk-seg'));
    expect(segments.filter((segment) => segment.classList.contains('on'))).toHaveLength(4);
  });

  it('colors filled segments past the fourth "warm", and past the seventh "hot"', () => {
    const { container } = render(<CumulativeRiskStrip risk={{ score: 10 }} />);
    const segments = Array.from(container.querySelectorAll('.risk-seg'));
    expect(segments.slice(0, 4).every((segment) => !segment.classList.contains('warm'))).toBe(true);
    expect(segments.slice(4, 7).every((segment) => segment.classList.contains('warm'))).toBe(true);
    expect(segments.slice(7, 10).every((segment) => segment.classList.contains('hot'))).toBe(true);
  });

  it('shows no promotion banner while no promotion is armed', () => {
    render(<CumulativeRiskStrip risk={{ score: 8, pendingPromotion: false }} />);
    expect(screen.queryByText('Next MEDIUM asks as HIGH.')).not.toBeInTheDocument();
  });

  it('shows the promotion banner once a promotion is armed', () => {
    const { container } = render(
      <CumulativeRiskStrip risk={{ score: 10, pendingPromotion: true }} />,
    );
    expect(container.querySelector('.risk-promo')).not.toBeNull();
    expect(screen.getByText('Next MEDIUM asks as HIGH.')).toBeInTheDocument();
  });

  it('treats a ticket with no pendingPromotion field as having none armed', () => {
    const { container } = render(<CumulativeRiskStrip risk={{ score: 8 }} />);
    expect(container.querySelector('.risk-promo')).toBeNull();
  });
});
