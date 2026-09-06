import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar } from '../../src/components/primitives/Avatar.js';

describe('Avatar', () => {
  it('renders human initials, decorative by default', () => {
    const { container } = render(<Avatar initials="JO" />);
    expect(screen.getByText('JO')).toHaveClass('avatar');
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('renders the accent-filled agent variant with the agent icon', () => {
    const { container } = render(<Avatar variant="agent" />);
    const avatar = container.querySelector('.avatar');
    expect(avatar).toBeInTheDocument();
    expect(avatar?.querySelector('svg')).toBeInTheDocument();
  });

  it('exposes an accessible name when given a label instead of being decorative', () => {
    render(<Avatar initials="JO" label="Jake Ortega" />);
    expect(screen.getByRole('img', { name: 'Jake Ortega' })).toBeInTheDocument();
  });
});
