import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Empty } from '../../src/components/primitives/Empty.js';

describe('Empty', () => {
  it('renders the hero variant with an icon, title and sub', () => {
    const { container } = render(
      <Empty variant="hero" icon="board" title="No repo connected yet">
        Connect a repo and pipenzo reads its open issues into Queued.
      </Empty>,
    );
    expect(container.querySelector('.empty')?.className).toBe('empty');
    expect(container.querySelector('.e-ic svg')).toBeInTheDocument();
    expect(screen.getByText('No repo connected yet')).toBeInTheDocument();
    expect(
      screen.getByText('Connect a repo and pipenzo reads its open issues into Queued.'),
    ).toBeInTheDocument();
  });

  it('defaults to the hero variant', () => {
    const { container } = render(<Empty title="No repo connected yet" />);
    expect(container.querySelector('.empty')?.className).toBe('empty');
  });

  it('renders up to two actions, defaulting the first to primary', () => {
    const onConnect = vi.fn();
    const onIdea = vi.fn();
    render(
      <Empty
        title="No repo connected yet"
        actions={[
          { label: 'Connect a repo', onClick: onConnect, icon: 'git-fork' },
          { label: 'New from idea', onClick: onIdea, icon: 'idea' },
        ]}
      />,
    );
    const connect = screen.getByRole('button', { name: 'Connect a repo' });
    const idea = screen.getByRole('button', { name: 'New from idea' });
    expect(connect.className).toContain('primary');
    expect(idea.className).not.toContain('primary');
    fireEvent.click(connect);
    fireEvent.click(idea);
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onIdea).toHaveBeenCalledTimes(1);
  });

  it('renders the lane variant without an icon or actions even when given', () => {
    const { container } = render(
      <Empty
        variant="lane"
        icon="board"
        title="Nothing waiting on you"
        actions={[{ label: 'Connect a repo' }]}
      >
        A quiet Needs-human lane is the goal state.
      </Empty>,
    );
    expect(container.querySelector('.empty')?.className).toBe('empty lane');
    expect(container.querySelector('.e-ic')).not.toBeInTheDocument();
    expect(container.querySelector('.e-act')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing waiting on you')).toBeInTheDocument();
  });

  it('omits the sub line when no children are given', () => {
    const { container } = render(<Empty title="Nothing here" />);
    expect(container.querySelector('.e-sub')).not.toBeInTheDocument();
  });
});
