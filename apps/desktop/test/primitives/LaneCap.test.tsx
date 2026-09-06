import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LaneCap } from '../../src/components/primitives/LaneCap.js';

describe('LaneCap', () => {
  it('renders the running rendering with the play icon, no full tint', () => {
    render(<LaneCap kind="running">1 of 2 running</LaneCap>);
    const pill = screen.getByText('1 of 2 running');
    expect(pill.className).toBe('lane-cap');
    expect(pill.querySelector('svg')).toBeInTheDocument();
  });

  it('renders the full rendering with the amber .full class', () => {
    render(<LaneCap kind="full">2 of 2 running</LaneCap>);
    expect(screen.getByText('2 of 2 running').className).toBe('lane-cap full');
  });

  it('renders the held rendering with the pause icon instead of play', () => {
    render(<LaneCap kind="held">1 held</LaneCap>);
    const pill = screen.getByText('1 held');
    expect(pill.className).toBe('lane-cap');
    expect(pill.querySelector('path')).toHaveAttribute(
      'd',
      expect.stringContaining('M200,32H160a16,16,0,0,0-16,16V208'),
    );
  });
});
