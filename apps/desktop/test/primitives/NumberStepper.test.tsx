import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NumberStepper } from '../../src/components/primitives/NumberStepper.js';

describe('NumberStepper', () => {
  it('shows the value over the max', () => {
    render(<NumberStepper value={2} min={1} max={4} onChange={vi.fn()} aria-label="Tickets in flight" />);
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('/ 4')).toBeInTheDocument();
  });

  it('increments and decrements', () => {
    const onChange = vi.fn();
    render(<NumberStepper value={2} min={1} max={4} onChange={onChange} aria-label="Tickets in flight" />);
    fireEvent.click(screen.getByRole('button', { name: 'Increase' }));
    expect(onChange).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole('button', { name: 'Decrease' }));
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('disables the increase arrow at the cap ("At the cap" example)', () => {
    render(<NumberStepper value={4} min={1} max={4} onChange={vi.fn()} aria-label="Tickets in flight" />);
    expect(screen.getByRole('button', { name: 'Increase' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decrease' })).not.toBeDisabled();
  });

  it('disables the decrease arrow at the floor', () => {
    render(<NumberStepper value={1} min={1} max={4} onChange={vi.fn()} aria-label="Tickets in flight" />);
    expect(screen.getByRole('button', { name: 'Decrease' })).toBeDisabled();
  });
});
