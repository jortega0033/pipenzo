import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Card, CardFoot, CardMeta, CardProgress } from '../../src/components/primitives/Card.js';
import { Chip } from '../../src/components/primitives/Chip.js';

describe('Card', () => {
  it('renders id, chip and title', () => {
    render(
      <Card id="#88" chip={<Chip tone="ok">≤ 40 lines</Chip>} title="Offer a CLI install link" />,
    );
    expect(screen.getByText('#88')).toBeInTheDocument();
    expect(screen.getByText('≤ 40 lines')).toBeInTheDocument();
    expect(screen.getByText('Offer a CLI install link')).toBeInTheDocument();
  });

  it('is focusable by default even without an onClick', () => {
    const { container } = render(<Card title="Read-only preview" />);
    const card = container.querySelector('.card')!;
    expect(card.getAttribute('tabindex')).toBe('0');
    expect(card).not.toHaveAttribute('role');
  });

  it('exposes a button role and responds to click/Enter/Space when onClick is given', () => {
    const onClick = vi.fn();
    const { container } = render(<Card title="Sanitize environment" onClick={onClick} />);
    const card = container.querySelector('.card')!;
    expect(card.getAttribute('role')).toBe('button');
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    fireEvent.keyDown(card, { key: 'a' });
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it('applies the held class for a card waiting on a file-overlap slot', () => {
    const { container } = render(<Card title="Retry the MCP stdio handshake" held />);
    expect(container.querySelector('.card')?.className).toBe('card held');
  });

  it('renders card-foot with only a meta and no action for the claim-conflict no-CTA case', () => {
    const { container } = render(
      <Card title="Widen the poll interval">
        <CardFoot>
          <CardMeta icon="clock">claimed 8m</CardMeta>
        </CardFoot>
      </Card>,
    );
    const foot = container.querySelector('.card-foot')!;
    expect(foot).toBeInTheDocument();
    expect(foot.querySelectorAll('button')).toHaveLength(0);
    expect(screen.getByText('claimed 8m')).toBeInTheDocument();
  });

  it('renders card-foot with meta and an action button', () => {
    render(
      <Card title="Sanitize environment">
        <CardFoot>
          <CardMeta icon="clock">2d</CardMeta>
          <button className="btn sm primary">Implement</button>
        </CardFoot>
      </Card>,
    );
    expect(screen.getByText('2d')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Implement' })).toBeInTheDocument();
  });
});

describe('CardProgress', () => {
  it('renders a clamped-width bar fill and a trailing label', () => {
    const { container } = render(<CardProgress percent={62} label="62%" />);
    const fill = container.querySelector('.bar-fill') as HTMLElement;
    expect(fill.style.width).toBe('62%');
    expect(screen.getByText('62%')).toBeInTheDocument();
  });

  it('clamps percent to the 0-100 range', () => {
    const { container, rerender } = render(<CardProgress percent={140} label="2/3" />);
    let fill = container.querySelector('.bar-fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');
    rerender(<CardProgress percent={-10} label="0/3" />);
    fill = container.querySelector('.bar-fill') as HTMLElement;
    expect(fill.style.width).toBe('0%');
  });

  it('accepts a fraction label for a PR-stack card', () => {
    render(<CardProgress percent={67} label="2/3" />);
    expect(screen.getByText('2/3')).toBeInTheDocument();
  });
});
