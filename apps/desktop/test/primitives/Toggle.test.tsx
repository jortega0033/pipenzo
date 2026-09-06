import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Toggle } from '../../src/components/primitives/Toggle.js';

describe('Toggle', () => {
  it('renders off by default', () => {
    render(<Toggle checked={false} onChange={vi.fn()} aria-label="Sound" />);
    const toggle = screen.getByRole('switch', { name: 'Sound' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveClass('toggle');
    expect(toggle).not.toHaveClass('on');
  });

  it('renders on', () => {
    render(<Toggle checked onChange={vi.fn()} aria-label="Tray badge" />);
    const toggle = screen.getByRole('switch', { name: 'Tray badge' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveClass('toggle', 'on');
  });

  it('calls onChange with the flipped value on click', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} aria-label="Sound" />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('locked forces it on and disabled, regardless of the checked prop', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} locked aria-label="Required alerts" />);
    const toggle = screen.getByRole('switch', { name: 'Required alerts' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toBeDisabled();
  });
});
