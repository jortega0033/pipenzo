import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PipenzoMascot } from '../../src/pipenzo/PipenzoMascot.js';

describe('PipenzoMascot', () => {
  it('renders a decorative image by default: empty alt, aria-hidden', () => {
    render(<PipenzoMascot role="inspector" pose="focused" />);
    const image = screen.getByRole('presentation', { hidden: true });
    expect(image).toHaveAttribute('alt', '');
    expect(image).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders meaningful alt text and drops aria-hidden when alt is given', () => {
    render(<PipenzoMascot role="ready" pose="waiting" alt="Pipenzo waiting beside the final control" />);
    const image = screen.getByRole('img', { name: 'Pipenzo waiting beside the final control' });
    expect(image).not.toHaveAttribute('aria-hidden');
  });

  it('defaults to md size and lazy loading', () => {
    render(<PipenzoMascot role="inspector" pose="focused" />);
    const image = screen.getByRole('presentation', { hidden: true });
    expect(image).toHaveAttribute('width', '128');
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveClass('pipenzo-mascot-md');
  });

  it('scales width/height together, preserving the source aspect ratio, per size', () => {
    // pipenzo-ready-for-approval-1200x800 is 3:2 -- at size="hero" (640 long edge) that's 640x427.
    render(<PipenzoMascot role="ready" pose="waiting" size="hero" eager />);
    const image = screen.getByRole('presentation', { hidden: true });
    expect(image).toHaveAttribute('width', '640');
    expect(image).toHaveAttribute('height', '427');
    expect(image).toHaveAttribute('loading', 'eager');
    expect(image).toHaveClass('pipenzo-mascot-hero');
  });

  it('scales a square source (1536x1536) proportionally at size="lg"', () => {
    render(<PipenzoMascot role="inspector" pose="focused" size="lg" />);
    const image = screen.getByRole('presentation', { hidden: true });
    expect(image).toHaveAttribute('width', '320');
    expect(image).toHaveAttribute('height', '320');
  });

  it('forwards an extra className alongside the size class', () => {
    render(<PipenzoMascot role="inspector" pose="focused" className="phase-badge" />);
    const image = screen.getByRole('presentation', { hidden: true });
    expect(image).toHaveClass('pipenzo-mascot-md', 'phase-badge');
  });

  it('throws for a role/pose combination with no approved asset', () => {
    expect(() => render(<PipenzoMascot role="inspector" pose="waiting" />)).toThrow(
      /no approved asset for role="inspector" pose="waiting"/,
    );
  });

  it('throws rather than silently falling back for an unmapped role entirely', () => {
    expect(() => render(<PipenzoMascot role="engineer" pose="neutral" />)).toThrow(
      /no approved asset for role="engineer" pose="neutral"/,
    );
  });
});
