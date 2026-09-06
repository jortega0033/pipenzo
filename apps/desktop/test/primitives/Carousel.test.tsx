import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Carousel, Slide } from '../../src/components/primitives/Carousel.js';

const slides = [
  <Slide key="1" icon="git-pull-request" top="#105 · merged" title="Reclaim orphaned worktrees" metaLeft="+64 −12 · 3 files" metaRight="Thu" />,
  <Slide key="2" icon="git-pull-request" top="#104 · merged" title="Correct 20 stale claims" metaLeft="+61 −58 · 7 files" metaRight="Wed" />,
  <Slide key="3" icon="git-pull-request" top="#102 · merged" title="Log session.failed events" metaLeft="+34 −6 · 2 files" metaRight="Tue" />,
];

beforeEach(() => {
  // jsdom doesn't implement scrollBy -- stub it so the arrow controls don't throw.
  Element.prototype.scrollBy = vi.fn();
});

describe('Carousel', () => {
  it('renders the title, one slide per entry, and a dot per slide with the first active', () => {
    const { container } = render(<Carousel title="Shipped this week" slides={slides} />);
    expect(screen.getByText('Shipped this week')).toBeInTheDocument();
    expect(container.querySelectorAll('.slide')).toHaveLength(3);
    const dots = container.querySelectorAll('.dot');
    expect(dots).toHaveLength(3);
    expect(dots[0]!.className).toBe('dot on');
    expect(dots[1]!.className).toBe('dot');
  });

  it('renders each slide with icon, top text, title and meta', () => {
    render(<Carousel title="Shipped this week" slides={slides} />);
    expect(screen.getByText('#105 · merged')).toBeInTheDocument();
    expect(screen.getByText('Reclaim orphaned worktrees')).toBeInTheDocument();
    expect(screen.getByText('+64 −12 · 3 files')).toBeInTheDocument();
    expect(screen.getByText('Thu')).toBeInTheDocument();
  });

  it('calls scrollBy with one slide-width step from the prev/next controls', () => {
    const { container } = render(<Carousel title="Shipped this week" slides={slides} />);
    const scrollEl = container.querySelector('.carousel') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(scrollEl.scrollBy).toHaveBeenCalledWith({ left: 308, behavior: 'smooth' });
    fireEvent.click(screen.getByRole('button', { name: 'Previous slide' }));
    expect(scrollEl.scrollBy).toHaveBeenCalledWith({ left: -308, behavior: 'smooth' });
  });

  it('updates the active dot from the scroll position, clamped to the slide count', () => {
    const { container } = render(<Carousel title="Shipped this week" slides={slides} />);
    const scrollEl = container.querySelector('.carousel') as HTMLElement;

    Object.defineProperty(scrollEl, 'scrollLeft', { value: 308, configurable: true });
    fireEvent.scroll(scrollEl);
    let dots = container.querySelectorAll('.dot');
    expect(dots[1]!.className).toBe('dot on');

    Object.defineProperty(scrollEl, 'scrollLeft', { value: 9999, configurable: true });
    fireEvent.scroll(scrollEl);
    dots = container.querySelectorAll('.dot');
    expect(dots[2]!.className).toBe('dot on');
  });
});
