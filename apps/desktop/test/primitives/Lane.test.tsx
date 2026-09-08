import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Board,
  Lane,
  LaneCards,
  LaneCount,
  LaneHead,
  LaneTitle,
} from '../../src/components/primitives/Lane.js';

describe('Board/Lane', () => {
  it('renders the four-column board grid around its lanes', () => {
    const { container } = render(
      <Board>
        <Lane>lane one</Lane>
        <Lane>lane two</Lane>
      </Board>,
    );
    expect(container.querySelector('.board')).toBeInTheDocument();
    const lanes = container.querySelectorAll('.board > .lane');
    expect(lanes).toHaveLength(2);
  });
});

describe('LaneHead/LaneTitle/LaneCount', () => {
  it('renders the dot, title and count in one head row', () => {
    const { container } = render(
      <LaneHead>
        <LaneTitle dotColor="var(--color-warn)">Working</LaneTitle>
        <LaneCount>3</LaneCount>
      </LaneHead>,
    );
    expect(container.querySelector('.lane-head')).toBeInTheDocument();
    const dot = container.querySelector('.lane-title .lane-dot');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveStyle({ background: 'var(--color-warn)' });
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(container.querySelector('.lane-count')).toHaveTextContent('3');
  });

  it('renders a zero count rather than omitting it', () => {
    const { container } = render(<LaneCount>0</LaneCount>);
    expect(container.querySelector('.lane-count')).toHaveTextContent('0');
  });
});

describe('LaneCards', () => {
  it('wraps every child in the scrollable cards well, in order', () => {
    const { container } = render(
      <LaneCards>
        <div key="a">first</div>
        <div key="b">second</div>
        <div key="c">third</div>
      </LaneCards>,
    );
    const well = container.querySelector('.lane-cards');
    expect(well).toBeInTheDocument();
    expect(well?.children).toHaveLength(3);
    expect(well?.children[0]).toHaveTextContent('first');
    expect(well?.children[2]).toHaveTextContent('third');
  });

  it('renders an empty well with no children when the lane has nothing in it', () => {
    const { container } = render(<LaneCards>{[]}</LaneCards>);
    expect(container.querySelector('.lane-cards')?.children).toHaveLength(0);
  });
});
