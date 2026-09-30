import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KvRow } from '../../src/components/primitives/KvRow.js';

describe('KvRow', () => {
  it('renders the label and value in one .kv row', () => {
    const { container } = render(<KvRow k="Tokens used" v="~412k" />);
    const row = container.querySelector('.kv')!;
    expect(row.querySelector('.k')).toHaveTextContent('Tokens used');
    expect(row.querySelector('.v')).toHaveTextContent('~412k');
  });

  it('adds no tone class by default', () => {
    const { container } = render(<KvRow k="k" v="v" />);
    expect(container.querySelector('.v')).toHaveClass('v');
    expect(container.querySelector('.v')?.className).toBe('v');
  });

  it('adds the matching tone class when one is given', () => {
    const { container } = render(<KvRow k="k" v="v" tone="warn" />);
    expect(container.querySelector('.v')).toHaveClass('v', 'warn');
  });
});
