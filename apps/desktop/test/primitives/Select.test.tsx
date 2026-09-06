import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Select } from '../../src/components/primitives/Select.js';

const OPTIONS = [
  { value: 'unlimited', label: 'Unlimited' },
  { value: '1', label: '1 run' },
  { value: '3', label: '3 runs' },
] as const;

describe('Select', () => {
  it('links the label to a native <select> with the given options and a caret icon', () => {
    const { container } = render(
      <Select label="Run budget" options={OPTIONS} defaultValue="unlimited" />,
    );
    const select = screen.getByLabelText('Run budget');
    expect(select.tagName).toBe('SELECT');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(container.querySelector('.select-wrap svg')).toBeInTheDocument();
  });

  it('shows help text describing the field', () => {
    render(
      <Select
        label="Run budget"
        options={OPTIONS}
        help="Applies to this ticket only."
      />,
    );
    expect(screen.getByText('Applies to this ticket only.')).toBeInTheDocument();
  });

  it('marks invalid and swaps in the error', () => {
    render(<Select label="Run budget" options={OPTIONS} error="Pick a budget" />);
    const select = screen.getByLabelText('Run budget');
    expect(select).toHaveClass('field', 'invalid');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Pick a budget')).toBeInTheDocument();
  });
});
