import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RailBlock } from '../../src/components/primitives/RailBlock.js';

describe('RailBlock', () => {
  it('renders the label and its own rows inside a single rail-block surface', () => {
    const { container } = render(
      <RailBlock label="Status">
        <span>row one</span>
      </RailBlock>,
    );
    const block = container.querySelector('.rail-block');
    expect(block).toBeInTheDocument();
    expect(block?.querySelector('.label')).toHaveTextContent('Status');
    expect(screen.getByText('row one')).toBeInTheDocument();
  });
});
