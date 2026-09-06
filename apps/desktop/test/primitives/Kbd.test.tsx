import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Kbd } from '../../src/components/primitives/Kbd.js';

describe('Kbd', () => {
  it('renders a single key', () => {
    render(<Kbd>K</Kbd>);
    expect(screen.getByText('K')).toHaveClass('kbd');
  });

  it('renders a chord as two adjacent Kbd elements, e.g. cmd+K', () => {
    render(
      <>
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </>,
    );
    expect(screen.getByText('⌘')).toHaveClass('kbd');
    expect(screen.getByText('K')).toHaveClass('kbd');
  });
});
