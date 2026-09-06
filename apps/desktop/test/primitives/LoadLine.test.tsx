import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoadLine } from '../../src/components/primitives/LoadLine.js';

describe('LoadLine', () => {
  it('renders a spinning icon alongside the given text', () => {
    const { container } = render(
      <LoadLine>
        Reading open issues from <span className="mono">jortega0033/agentdock</span> — first poll
        of this session
      </LoadLine>,
    );
    expect(container.querySelector('.load-line')).toBeInTheDocument();
    const icon = container.querySelector('.load-line > svg');
    expect(icon?.getAttribute('class')).toContain('spin');
    expect(screen.getByText(/first poll of this session/)).toBeInTheDocument();
  });

  it('renders different content sources without changing the shell', () => {
    const { container, rerender } = render(<LoadLine>Reading open issues</LoadLine>);
    expect(screen.getByText('Reading open issues')).toBeInTheDocument();
    rerender(<LoadLine>Reading the diff for PR #94</LoadLine>);
    expect(screen.getByText('Reading the diff for PR #94')).toBeInTheDocument();
    expect(container.querySelectorAll('.load-line')).toHaveLength(1);
  });
});
