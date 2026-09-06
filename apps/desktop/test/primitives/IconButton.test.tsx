import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IconButton } from '../../src/components/primitives/IconButton.js';

describe('IconButton', () => {
  it('is a real button with the required aria-label as its accessible name', () => {
    render(<IconButton icon="refresh" aria-label="Refresh now" />);
    const btn = screen.getByRole('button', { name: 'Refresh now' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn.className).toBe('icon-btn');
    expect(btn.querySelector('svg')).toBeInTheDocument();
  });

  it('falls back to the aria-label for its title when none is given', () => {
    render(<IconButton icon="refresh" aria-label="Refresh now" />);
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Refresh now');
  });

  it('applies the ghost variant class', () => {
    render(<IconButton icon="x" aria-label="Close" variant="ghost" />);
    expect(screen.getByRole('button', { name: 'Close' }).className).toBe('icon-btn ghost');
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    render(<IconButton icon="plus" aria-label="New" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('supports disabled', () => {
    render(<IconButton icon="refresh" aria-label="Refresh now" disabled />);
    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeDisabled();
  });
});
