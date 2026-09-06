import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RadioGroup } from '../../src/components/primitives/RadioGroup.js';

const OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'alpha', label: 'Alphabetical' },
] as const;

describe('RadioGroup', () => {
  it('exposes a radiogroup with the given label', () => {
    render(<RadioGroup label="Radio group" options={OPTIONS} value="newest" onChange={vi.fn()} />);
    expect(screen.getByRole('radiogroup', { name: 'Radio group' })).toBeInTheDocument();
  });

  it('marks only the selected option checked, and only it is in the tab order', () => {
    render(<RadioGroup options={OPTIONS} value="oldest" onChange={vi.fn()} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(radios.map((r) => r.getAttribute('tabIndex'))).toEqual(['-1', '0', '-1']);
  });

  it('calls onChange when a different option is clicked', () => {
    const onChange = vi.fn();
    render(<RadioGroup options={OPTIONS} value="newest" onChange={onChange} />);
    fireEvent.click(screen.getAllByRole('radio').at(2)!);
    expect(onChange).toHaveBeenCalledWith('alpha');
  });

  it('moves selection with arrow keys, wrapping around', () => {
    const onChange = vi.fn();
    render(<RadioGroup options={OPTIONS} value="alpha" onChange={onChange} />);
    const selected = screen.getAllByRole('radio').at(2)!;
    fireEvent.keyDown(selected, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith('newest');
  });
});
