import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Textarea } from '../../src/components/primitives/Textarea.js';

describe('Textarea', () => {
  it('links the label to the textarea and defaults to 3 rows', () => {
    render(<Textarea label="Extra instructions" defaultValue="Only touch the daemon side." />);
    const field = screen.getByLabelText('Extra instructions');
    expect(field.tagName).toBe('TEXTAREA');
    expect(field).toHaveAttribute('rows', '3');
    expect(field).toHaveValue('Only touch the daemon side.');
  });

  it('marks invalid and shows the error instead of help', () => {
    render(<Textarea label="Extra instructions" help="hidden" error="Too long" />);
    expect(screen.getByText('Too long')).toBeInTheDocument();
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Extra instructions')).toHaveClass('field', 'invalid');
  });
});
