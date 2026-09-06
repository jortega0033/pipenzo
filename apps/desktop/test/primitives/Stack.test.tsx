import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Kids } from '../../src/components/primitives/Stack.js';

describe('Kids', () => {
  it('renders one .kid row per item, in order, with index/title/id', () => {
    const { container } = render(
      <Kids
        items={[
          {
            key: '109',
            status: 'done',
            index: '1/3',
            title: 'Extract the label table from the renderer',
            done: true,
            id: '#109',
          },
          {
            key: '110',
            status: 'done',
            index: '2/3',
            title: 'Read labels from the table in the daemon',
            done: true,
            id: '#110',
          },
          {
            key: '111',
            status: 'run',
            index: '3/3',
            title: 'Delete the duplicated renderer strings',
            id: '#111',
          },
        ]}
      />,
    );
    const rows = container.querySelectorAll('.kid');
    expect(rows).toHaveLength(3);
    expect(screen.getByText('Extract the label table from the renderer')).toBeInTheDocument();
    expect(screen.getByText('#111')).toBeInTheDocument();
  });

  it('shows a check icon for done, the play glyph for run, and no icon for pending', () => {
    const { container } = render(
      <Kids
        items={[
          { key: 'a', status: 'done', index: '1/3', title: 'a', id: '#1' },
          { key: 'b', status: 'run', index: '2/3', title: 'b', id: '#2' },
          { key: 'c', status: 'pending', index: '3/3', title: 'c', id: '#3' },
        ]}
      />,
    );
    const wells = container.querySelectorAll('.kid-ic');
    expect(wells[0]!.className).toBe('kid-ic done');
    expect(wells[0]!.querySelector('svg')).toBeInTheDocument();
    expect(wells[1]!.className).toBe('kid-ic run');
    expect(wells[1]!.querySelector('svg')).toBeInTheDocument();
    expect(wells[2]!.className).toBe('kid-ic');
    expect(wells[2]!.querySelector('svg')).not.toBeInTheDocument();
  });

  it('dims the title once done is true', () => {
    const { container } = render(
      <Kids items={[{ key: 'a', status: 'done', index: '1/3', title: 'done row', done: true, id: '#1' }]} />,
    );
    expect(container.querySelector('.t.done')).toBeInTheDocument();
  });

  it('calls onOpen from the external-link button', () => {
    const onOpen = vi.fn();
    render(
      <Kids items={[{ key: 'a', status: 'run', index: '1/1', title: 'a', id: '#1', onOpen }]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open on GitHub' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
