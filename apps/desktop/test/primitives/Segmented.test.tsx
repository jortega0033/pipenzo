import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Segmented } from '../../src/components/primitives/Segmented.js';

const OPTIONS = [
  { value: 'simple', label: 'Simple' },
  { value: 'expert', label: 'Expert' },
] as const;

describe('Segmented', () => {
  it('marks the selected option active and aria-pressed', () => {
    render(<Segmented options={OPTIONS} value="simple" onChange={vi.fn()} aria-label="Mode" />);
    expect(screen.getByRole('button', { name: 'Simple' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Simple' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Expert' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Expert' })).not.toHaveClass('active');
  });

  it('calls onChange with the clicked option value', () => {
    const onChange = vi.fn();
    render(<Segmented options={OPTIONS} value="simple" onChange={onChange} aria-label="Mode" />);
    fireEvent.click(screen.getByRole('button', { name: 'Expert' }));
    expect(onChange).toHaveBeenCalledWith('expert');
  });

  it('exposes a group with the given aria-label', () => {
    render(<Segmented options={OPTIONS} value="simple" onChange={vi.fn()} aria-label="Mode" />);
    expect(screen.getByRole('group', { name: 'Mode' })).toBeInTheDocument();
  });
});
