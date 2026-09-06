import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Skeleton,
  SkeletonBoard,
  SkeletonCard,
  SkeletonEvent,
  SkeletonLane,
  Spinner,
} from '../../src/components/primitives/Skeleton.js';

describe('Skeleton', () => {
  it('renders a plain block sized inline and aria-hidden', () => {
    const { container } = render(<Skeleton width={100} height={14} />);
    const el = container.querySelector('.sk')!;
    expect(el.className).toBe('sk');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect((el as HTMLElement).style.width).toBe('100px');
    expect((el as HTMLElement).style.height).toBe('14px');
  });

  it('applies the strong variant', () => {
    const { container } = render(<Skeleton width={10} height={10} strong />);
    expect(container.querySelector('.sk')?.className).toBe('sk strong');
  });

  it.each(['pill', 'dot'] as const)('applies the %s shape', (shape) => {
    const { container } = render(<Skeleton width={10} height={10} shape={shape} />);
    expect(container.querySelector('.sk')?.className).toBe(`sk ${shape}`);
  });

  it('is never focusable', () => {
    const { container } = render(<Skeleton width={10} height={10} />);
    expect(container.querySelector('.sk')?.hasAttribute('tabindex')).toBe(false);
  });
});

describe('Spinner', () => {
  it('renders the spinner icon with the spin class, aria-hidden by default', () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('class')).toContain('spin');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('SkeletonCard', () => {
  it('matches the real card padding/gap shape and is aria-hidden as a whole', () => {
    const { container } = render(<SkeletonCard />);
    const card = container.querySelector('.sk-card')!;
    expect(card.getAttribute('aria-hidden')).toBe('true');
    expect(card.querySelectorAll('.sk-row')).toHaveLength(2);
    expect(card.querySelectorAll('.sk')).toHaveLength(6);
  });
});

describe('SkeletonEvent', () => {
  it('renders the icon well, head row and body lines', () => {
    const { container } = render(<SkeletonEvent />);
    const evt = container.querySelector('.sk-evt')!;
    expect(evt.getAttribute('aria-hidden')).toBe('true');
    expect(evt.querySelector('.sk.dot')).toBeInTheDocument();
    expect(evt.querySelectorAll('.sk-evt-body .sk')).toHaveLength(4); // 2 head + 2 body by default
  });

  it('drops bottom padding for the last row', () => {
    const { container } = render(<SkeletonEvent last bodyWidths={['82%']} />);
    const evt = container.querySelector('.sk-evt') as HTMLElement;
    expect(evt.style.paddingBottom).toBe('0px');
    expect(evt.querySelectorAll('.sk-evt-body .sk')).toHaveLength(3); // 2 head + 1 body
  });
});

describe('SkeletonLane and SkeletonBoard', () => {
  it('renders the lane name and dot as real (non-hidden) content, with skeleton cards under it', () => {
    const { container, getByText } = render(
      <SkeletonLane name="Refining" dotColor="var(--color-warn)" cardCount={2} />,
    );
    expect(getByText('Refining')).toBeInTheDocument();
    expect(container.querySelector('.sk-lane')?.getAttribute('aria-hidden')).toBeNull();
    expect(container.querySelectorAll('.sk-card')).toHaveLength(2);
  });

  it('renders one lane per entry, in order', () => {
    const { getAllByText, container } = render(
      <SkeletonBoard
        lanes={[
          { name: 'Queued', dotColor: '#888' },
          { name: 'Refining', dotColor: 'var(--color-warn)' },
          { name: 'Implementing', dotColor: 'var(--color-warn)' },
          { name: 'Needs human', dotColor: 'var(--color-danger)' },
        ]}
      />,
    );
    expect(container.querySelectorAll('.sk-lane')).toHaveLength(4);
    expect(getAllByText(/Queued|Refining|Implementing|Needs human/)).toHaveLength(4);
  });
});
