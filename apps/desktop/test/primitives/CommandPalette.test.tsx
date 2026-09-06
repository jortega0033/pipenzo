import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  CommandPalette,
  type CommandPaletteGroup,
} from '../../src/components/primitives/CommandPalette.js';

function baseGroups(onSelect: (label: string) => void): CommandPaletteGroup[] {
  return [
    {
      title: 'Tickets · recent',
      items: [
        { key: 't85', id: '#85', label: 'Batch tray badge updates', onSelect: () => onSelect('#85') },
        { key: 't94', id: '#94', label: 'Sanitize environment', onSelect: () => onSelect('#94') },
      ],
    },
    {
      title: 'Actions',
      items: [{ key: 'a1', label: 'New from idea', onSelect: () => onSelect('New from idea') }],
    },
  ];
}

function Harness({ onSelect }: { onSelect: (label: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      groups={baseGroups(onSelect)}
    />
  );
}

describe('CommandPalette', () => {
  it('renders a closed trigger and no panel', () => {
    render(<Harness onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Jump to ticket/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the panel with grouped, fixed-order results on trigger click', () => {
    render(<Harness onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));

    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    const groupTitles = screen.getAllByText(/Tickets · recent|Actions/).map((el) => el.textContent);
    expect(groupTitles).toEqual(['Tickets · recent', 'Actions']);
    expect(screen.getByText('#85')).toBeInTheDocument();
    expect(screen.getByText('New from idea')).toBeInTheDocument();
  });

  it('highlights the first result as active by default', () => {
    render(<Harness onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));
    const first = screen.getByRole('button', { name: /#85/ });
    expect(first.className).toContain('active');
  });

  it('moves the active highlight with ArrowDown/ArrowUp from the search field', () => {
    render(<Harness onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));
    const search = screen.getByLabelText('Search tickets, repos and actions');

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: /#94/ }).className).toContain('active');

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: /New from idea/ }).className).toContain('active');

    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(screen.getByRole('button', { name: /#94/ }).className).toContain('active');
  });

  it('selects the active item and closes on Enter', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));
    const search = screen.getByLabelText('Search tickets, repos and actions');

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('#94');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('selects an item on click and closes', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));
    fireEvent.click(screen.getByRole('button', { name: /New from idea/ }));

    expect(onSelect).toHaveBeenCalledWith('New from idea');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    render(<Harness onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('calls onQueryChange as the search field is typed into', () => {
    render(<Harness onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));
    const search = screen.getByLabelText('Search tickets, repos and actions');
    fireEvent.change(search, { target: { value: 'mcp' } });
    expect(search).toHaveValue('mcp');
  });
});
