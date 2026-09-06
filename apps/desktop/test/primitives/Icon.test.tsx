import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Icon } from '../../src/components/primitives/Icon.js';
import { ICON_PATHS } from '../../src/components/primitives/icons.js';

describe('Icon', () => {
  it('renders the requested icon at the default (md/16px) size, hidden from the AX tree', () => {
    const { container } = render(<Icon name="check" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '16');
    expect(svg).toHaveAttribute('height', '16');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg?.querySelector('path')).toHaveAttribute('d', ICON_PATHS.check);
  });

  it.each([
    ['xs', 12],
    ['sm', 14],
    ['md', 16],
    ['lg', 20],
  ] as const)('renders the %s size at %dpx', (size, px) => {
    const { container } = render(<Icon name="warning" size={size} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', String(px));
    expect(svg).toHaveAttribute('height', String(px));
  });

  it('exposes a label and drops aria-hidden when the icon is not paired with visible text', () => {
    const { container } = render(<Icon name="warning" label="Warning" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('role', 'img');
    expect(svg).toHaveAttribute('aria-label', 'Warning');
    expect(svg).not.toHaveAttribute('aria-hidden');
  });

  it('renders every icon in the curated set without throwing', () => {
    for (const name of Object.keys(ICON_PATHS) as (keyof typeof ICON_PATHS)[]) {
      const { container, unmount } = render(<Icon name={name} />);
      expect(container.querySelector('path')).toHaveAttribute('d', ICON_PATHS[name]);
      unmount();
    }
  });
});
