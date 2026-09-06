import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from '../../src/components/primitives/Checkbox.js';

describe('Checkbox', () => {
  it('renders unchecked with an empty box and role=checkbox', () => {
    render(<Checkbox checked={false} onChange={vi.fn()} label="Include binary files" />);
    const box = screen.getByRole('checkbox', { name: /Include binary files/ });
    expect(box).toHaveAttribute('aria-checked', 'false');
  });

  it('renders checked with a check icon in the box', () => {
    render(<Checkbox checked onChange={vi.fn()} label="Include line numbers" />);
    const box = screen.getByRole('checkbox', { name: /Include line numbers/ });
    expect(box).toHaveAttribute('aria-checked', 'true');
    expect(box.querySelector('svg')).toBeInTheDocument();
  });

  it('renders the caption line separately from the label', () => {
    render(<Checkbox checked onChange={vi.fn()} label="Include timestamps" sub="local time zone" />);
    expect(screen.getByText('local time zone')).toHaveClass('sub');
  });

  it('toggles on click', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Compress output" />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('toggles on Space and Enter', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Compress output" />);
    const box = screen.getByRole('checkbox');
    fireEvent.keyDown(box, { key: ' ' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('is not interactive when disabled', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Compress output" disabled />);
    const box = screen.getByRole('checkbox');
    expect(box).toHaveAttribute('tabIndex', '-1');
    fireEvent.click(box);
    expect(onChange).not.toHaveBeenCalled();
  });
});
