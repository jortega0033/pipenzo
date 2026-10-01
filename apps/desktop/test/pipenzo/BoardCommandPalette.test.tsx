import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { BoardCommandPalette } from '../../src/pipenzo/BoardCommandPalette.js';

function makeTicket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: '00000000-0000-4000-8000-000000000001',
    repo: 'jortega0033/pipenzo',
    issueNumber: 85,
    lane: 'queued',
    phase: 'refine',
    labels: ['pipenzo:queued'],
    estimate: { lines: 0, files: 0, layered: false },
    taskType: 'chore',
    stack: { parentId: null, childIds: [], index: null },
    attempts: [],
    budget: { tokensUsed: 0, limit: 0 },
    risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
    precommits: [],
    etags: {},
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

const TICKETS = [
  makeTicket({ ticketId: 'a', issueNumber: 85, lane: 'queued', title: 'Batch tray badge updates' }),
  makeTicket({ ticketId: 'b', issueNumber: 94, lane: 'working', title: 'Sanitize environment' }),
];

function renderPalette(
  overrides: Partial<{
    tickets: readonly PipenzoTicketViewV1[];
    repositories: readonly string[];
    onOpenBoard: () => void;
    onOpenSettings: () => void;
    onSelectRepo: (repoFullName: string) => void;
    onNewFromIdea: () => void;
  }> = {},
) {
  const props = {
    tickets: TICKETS,
    repositories: ['jortega0033/pipenzo'],
    onOpenBoard: vi.fn(),
    onOpenSettings: vi.fn(),
    onSelectRepo: vi.fn(),
    onNewFromIdea: vi.fn(),
    ...overrides,
  };
  render(<BoardCommandPalette {...props} />);
  return props;
}

describe('BoardCommandPalette', () => {
  it('renders a closed trigger by default', () => {
    renderPalette();

    expect(screen.getByRole('button', { name: /Jump to ticket/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on Ctrl+K from anywhere in the document, and closes again on a second press', () => {
    renderPalette();

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on Cmd+K (metaKey) too', () => {
    renderPalette();

    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('shows real tickets from the store, grouped under "Tickets · recent" with their lane chip', () => {
    renderPalette();
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));

    expect(screen.getByText('Tickets · recent')).toBeInTheDocument();
    expect(screen.getByText('#85')).toBeInTheDocument();
    expect(screen.getByText('Batch tray badge updates')).toBeInTheDocument();
    expect(screen.getByText('#94')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('filters tickets as the search field is typed into, by title', () => {
    renderPalette();
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));

    fireEvent.change(screen.getByLabelText('Search tickets, repos and actions'), {
      target: { value: 'sanitize' },
    });

    expect(screen.queryByText('#85')).not.toBeInTheDocument();
    expect(screen.getByText('#94')).toBeInTheDocument();
  });

  it('filters tickets as the search field is typed into, by issue number', () => {
    renderPalette();
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));

    fireEvent.change(screen.getByLabelText('Search tickets, repos and actions'), {
      target: { value: '#85' },
    });

    expect(screen.getByText('#85')).toBeInTheDocument();
    expect(screen.queryByText('#94')).not.toBeInTheDocument();
  });

  it('lists the real connected-repos list handed down as a prop, under "Repos"', () => {
    renderPalette({ tickets: [], repositories: ['jortega0033/pipenzo', 'jortega0033/agentdock'] });
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));

    expect(screen.getByText('jortega0033/pipenzo')).toBeInTheDocument();
    expect(screen.getByText('jortega0033/agentdock')).toBeInTheDocument();
  });

  it('filters the connected-repos list as the search field is typed into', () => {
    renderPalette({ tickets: [], repositories: ['jortega0033/pipenzo', 'jortega0033/agentdock'] });
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));

    fireEvent.change(screen.getByLabelText('Search tickets, repos and actions'), {
      target: { value: 'agentdock' },
    });

    expect(screen.queryByText('jortega0033/pipenzo')).not.toBeInTheDocument();
    expect(screen.getByText('jortega0033/agentdock')).toBeInTheDocument();
  });

  it('renders no Repos group when nothing is connected', () => {
    renderPalette({ repositories: [] });
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));

    expect(screen.queryByText('Repos')).not.toBeInTheDocument();
  });

  it('moves the keyboard-active row with ArrowDown across groups, and Enter selects it', () => {
    const props = renderPalette();
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));
    const search = screen.getByLabelText('Search tickets, repos and actions');

    // #85 (active by default) -> #94 -> the repo row -> New from idea -> Open Board -> Open Settings.
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: /Open Settings/ }).className).toContain('active');

    fireEvent.keyDown(search, { key: 'Enter' });
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(props.onOpenBoard).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('selecting a ticket row navigates to Board and closes the palette', () => {
    const props = renderPalette();
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));

    fireEvent.click(screen.getByRole('button', { name: /Batch tray badge updates/ }));

    expect(props.onOpenBoard).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('selecting a repo row switches to it and navigates to Board, closing the palette', () => {
    const props = renderPalette({
      tickets: [],
      repositories: ['jortega0033/pipenzo', 'jortega0033/agentdock'],
    });
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));

    fireEvent.click(screen.getByRole('button', { name: 'jortega0033/agentdock' }));

    expect(props.onSelectRepo).toHaveBeenCalledWith('jortega0033/agentdock');
    expect(props.onOpenBoard).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('"Open Board" fires the real onOpenBoard handler and closes the palette', () => {
    const props = renderPalette({ tickets: [] });
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));

    fireEvent.click(screen.getByRole('button', { name: /Open Board/ }));

    expect(props.onOpenBoard).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('"Open Settings" fires the real onOpenSettings handler and closes the palette', () => {
    const props = renderPalette({ tickets: [] });
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));

    fireEvent.click(screen.getByRole('button', { name: /Open Settings/ }));

    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('"New from idea" fires the real onNewFromIdea handler and closes the palette', () => {
    const props = renderPalette({ tickets: [] });
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));

    fireEvent.click(screen.getByRole('button', { name: /New from idea/ }));

    expect(props.onNewFromIdea).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('hides "New from idea" when no repo is connected -- a drafter needs one to read', () => {
    renderPalette({ tickets: [], repositories: [] });
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));

    expect(screen.queryByText('New from idea')).not.toBeInTheDocument();
  });

  it('the "N" shortcut fires New from idea from anywhere the palette is closed', () => {
    const props = renderPalette({ tickets: [] });

    fireEvent.keyDown(document, { key: 'n' });

    expect(props.onNewFromIdea).toHaveBeenCalledTimes(1);
  });

  it('does not fire the "N" shortcut when no repo is connected', () => {
    const props = renderPalette({ tickets: [], repositories: [] });

    fireEvent.keyDown(document, { key: 'n' });

    expect(props.onNewFromIdea).not.toHaveBeenCalled();
  });

  it('the "B" shortcut fires Open Board from anywhere the palette is closed', () => {
    const props = renderPalette({ tickets: [] });

    fireEvent.keyDown(document, { key: 'b' });

    expect(props.onOpenBoard).toHaveBeenCalledTimes(1);
  });

  it('the "," shortcut fires Open Settings from anywhere the palette is closed', () => {
    const props = renderPalette({ tickets: [] });

    fireEvent.keyDown(document, { key: ',' });

    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('does not fire the "B" shortcut while typing into an unrelated text field', () => {
    const onOpenBoard = vi.fn();
    render(
      <>
        <input aria-label="Ticket title" />
        <BoardCommandPalette
          tickets={[]}
          repositories={[]}
          onOpenBoard={onOpenBoard}
          onOpenSettings={vi.fn()}
          onSelectRepo={vi.fn()}
          onNewFromIdea={vi.fn()}
        />
      </>,
    );

    const input = screen.getByLabelText('Ticket title');
    input.focus();
    fireEvent.keyDown(input, { key: 'b' });

    expect(onOpenBoard).not.toHaveBeenCalled();
  });

  it('does not fire nav shortcuts while the palette itself is open (so typing "b" in search just searches)', () => {
    const props = renderPalette();
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));

    const search = screen.getByLabelText('Search tickets, repos and actions');
    fireEvent.keyDown(search, { key: 'b' });

    expect(props.onOpenBoard).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes on Escape, matching every other overlay in this app', () => {
    renderPalette({ tickets: [] });
    fireEvent.click(screen.getByRole('button', { name: /Jump to ticket/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
