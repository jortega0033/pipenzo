import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Notice } from '../../src/components/primitives/Notice.js';

describe('Notice', () => {
  it('renders neutral tone with title and body, no tone class', () => {
    const { container } = render(
      <Notice icon="info" title="Refine is read-only">
        No files change until you start implement.
      </Notice>,
    );
    expect(container.querySelector('.notice')?.className).toBe('notice');
    expect(screen.getByText('Refine is read-only')).toBeInTheDocument();
    expect(screen.getByText('No files change until you start implement.')).toBeInTheDocument();
  });

  it.each(['ok', 'warn', 'danger'] as const)('applies the %s tone class', (tone) => {
    const { container } = render(
      <Notice icon="info" tone={tone} title="T">
        body
      </Notice>,
    );
    expect(container.querySelector('.notice')?.className).toBe(`notice ${tone}`);
  });

  it('renders the quiet modifier alongside a tone class', () => {
    const { container } = render(
      <Notice icon="info" quiet title="Worktree cleanup skipped">
        Uncommitted changes were left in place.
      </Notice>,
    );
    expect(container.querySelector('.notice')?.className).toBe('notice quiet');
  });

  it('renders zero, one or two inline-link actions as real buttons', () => {
    const onSplit = vi.fn();
    const onReject = vi.fn();
    render(
      <Notice
        icon="warning"
        tone="warn"
        title="Diff is over budget"
        actions={[
          { label: 'See proposed split', onClick: onSplit },
          { label: 'Reject the split', onClick: onReject },
        ]}
      >
        +212 −40 across 9 files.
      </Notice>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'See proposed split' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject the split' }));
    expect(onSplit).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('renders no dismiss control unless onDismiss is given, and calls it on click', () => {
    const { rerender } = render(
      <Notice icon="warning" tone="warn" title="No dismiss here">
        body
      </Notice>,
    );
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();

    const onDismiss = vi.fn();
    rerender(
      <Notice icon="check-circle" tone="ok" title="Spec approved" onDismiss={onDismiss}>
        3 acceptance criteria.
      </Notice>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
