import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TextField } from '../../src/components/primitives/TextField.js';

describe('TextField', () => {
  it('links the label to the input via htmlFor/id', () => {
    render(<TextField label="Branch name override" defaultValue="issue-94" />);
    expect(screen.getByLabelText('Branch name override')).toHaveValue('issue-94');
  });

  it('shows help text when there is no error', () => {
    render(<TextField label="Branch name override" help="Optional. Defaults to issue-<number>." />);
    const input = screen.getByLabelText('Branch name override');
    expect(screen.getByText('Optional. Defaults to issue-<number>.')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-describedby', expect.stringContaining('help'));
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('replaces help with error rather than showing both, and marks the field invalid', () => {
    render(
      <TextField
        label="Base branch"
        help="Not shown once invalid"
        error='No branch named "release/2.4 " on origin.'
        defaultValue="release/2.4 "
      />,
    );
    const input = screen.getByLabelText('Base branch');
    expect(screen.getByText('No branch named "release/2.4 " on origin.')).toBeInTheDocument();
    expect(screen.queryByText('Not shown once invalid')).not.toBeInTheDocument();
    expect(input).toHaveClass('field', 'invalid');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', expect.stringContaining('err'));
  });

  it('renders the required note next to the label instead of a bare asterisk', () => {
    render(<TextField label="Reason, if rejecting" requiredNote="required at HIGH" />);
    expect(screen.getByText('required at HIGH')).toHaveClass('req');
  });

  it('applies the mono class for id/path-shaped values', () => {
    render(<TextField label="Branch name override" mono defaultValue="issue-94" />);
    expect(screen.getByLabelText('Branch name override')).toHaveClass('field', 'mono');
  });
});
