import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StackRow } from '../../src/components/primitives/StackRow.js';

describe('StackRow', () => {
  it('renders index, title and meta', () => {
    render(
      <StackRow
        index="2/3"
        title="Negotiate over stdio and http"
        meta="≈ 110 lines · 4 files · base PR 1"
      />,
    );
    expect(screen.getByText('2/3')).toBeInTheDocument();
    expect(screen.getByText('Negotiate over stdio and http')).toBeInTheDocument();
    expect(screen.getByText('≈ 110 lines · 4 files · base PR 1')).toBeInTheDocument();
  });

  it('calls onMoveUp/onMoveDown from the reorder controls', () => {
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    render(
      <StackRow index="2/3" title="t" meta="m" onMoveUp={onMoveUp} onMoveDown={onMoveDown} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move down' }));
    expect(onMoveUp).toHaveBeenCalledTimes(1);
    expect(onMoveDown).toHaveBeenCalledTimes(1);
  });

  it('disables the up control on the top row and the down control on the bottom row', () => {
    render(<StackRow index="1/3" title="t" meta="m" canMoveUp={false} />);
    expect(screen.getByRole('button', { name: 'Move up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move down' })).not.toBeDisabled();
  });
});
