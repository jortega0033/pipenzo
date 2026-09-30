import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { ActivityFilterBar } from '../../src/pipenzo/ActivityFilterBar.js';
import { ActivityScreen } from '../../src/pipenzo/ActivityScreen.js';
import { useActivityFilter } from '../../src/pipenzo/use-activity-filter.js';

const REPO = 'jortega0033/pipenzo';
const NOW = new Date('2026-09-06T18:00:00.000Z');

function makeTicket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: '00000000-0000-4000-8000-000000000001',
    repo: REPO,
    issueNumber: 1,
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

describe('useActivityFilter', () => {
  it('starts on "all" and passes every ticket through unfiltered', () => {
    const tickets = [makeTicket({ ticketId: 'a' }), makeTicket({ ticketId: 'b', labels: [] })];
    const { result } = renderHook(() => useActivityFilter(tickets));

    expect(result.current.active).toBe('all');
    expect(result.current.filteredTickets).toEqual(tickets);
  });

  it('narrows filteredTickets to the real predicate once setActive is called', () => {
    const gateTicket = makeTicket({ ticketId: 'gate', lane: 'ready-for-review', labels: [] });
    const plainTicket = makeTicket({ ticketId: 'plain', lane: 'queued' });
    const { result } = renderHook(() => useActivityFilter([gateTicket, plainTicket]));

    act(() => {
      result.current.setActive('gate');
    });

    expect(result.current.active).toBe('gate');
    expect(result.current.filteredTickets).toEqual([gateTicket]);
  });

  it('re-derives filteredTickets when the underlying ticket list changes', () => {
    const riskyTicket = makeTicket({
      ticketId: 'risky',
      risk: { score: 5, lastResetAt: '2026-01-01T00:00:00.000Z' },
    });
    const { result, rerender } = renderHook(
      ({ tickets }: { tickets: readonly PipenzoTicketViewV1[] }) => useActivityFilter(tickets),
      { initialProps: { tickets: [] as readonly PipenzoTicketViewV1[] } },
    );

    act(() => {
      result.current.setActive('risk');
    });
    expect(result.current.filteredTickets).toEqual([]);

    rerender({ tickets: [riskyTicket] });
    expect(result.current.filteredTickets).toEqual([riskyTicket]);
  });
});

/** A minimal real caller, wiring `useActivityFilter` + `ActivityFilterBar` into `ActivityScreen`'s
 *  `filterBar`/`tickets` slots exactly as `use-activity-filter.ts`'s own doc comment describes --
 *  proves the three pieces actually filter what's on screen together, not just in isolation. */
function ActivityScreenWithFilters({ tickets }: { tickets: readonly PipenzoTicketViewV1[] }) {
  const { active, setActive, filteredTickets } = useActivityFilter(tickets);
  return (
    <ActivityScreen
      tickets={filteredTickets}
      now={NOW}
      filterBar={<ActivityFilterBar tickets={tickets} active={active} onChange={setActive} />}
      renderEntry={(entry) => <span>issue #{entry.ticket.issueNumber}</span>}
    />
  );
}

describe('ActivityScreen + ActivityFilterBar, wired through useActivityFilter', () => {
  it('shows every ticket under "All", with a count equal to the true total', () => {
    const tickets = [
      makeTicket({ ticketId: 'a', issueNumber: 1, updatedAt: '2026-09-06T14:00:00.000Z' }),
      makeTicket({
        ticketId: 'b',
        issueNumber: 2,
        lane: 'ready-for-review',
        labels: [],
        updatedAt: '2026-09-06T15:00:00.000Z',
      }),
    ];
    render(<ActivityScreenWithFilters tickets={tickets} />);

    expect(screen.getByRole('button', { name: 'All 2/2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('issue #1')).toBeInTheDocument();
    expect(screen.getByText('issue #2')).toBeInTheDocument();
  });

  it('clicking a tab actually filters the rendered rows down to that category', () => {
    const gateTicket = makeTicket({
      ticketId: 'gate',
      issueNumber: 10,
      lane: 'ready-for-review',
      labels: [],
      updatedAt: '2026-09-06T14:00:00.000Z',
    });
    const plainTicket = makeTicket({
      ticketId: 'plain',
      issueNumber: 20,
      lane: 'queued',
      updatedAt: '2026-09-06T15:00:00.000Z',
    });
    render(<ActivityScreenWithFilters tickets={[gateTicket, plainTicket]} />);

    expect(screen.getByText('issue #10')).toBeInTheDocument();
    expect(screen.getByText('issue #20')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Gates 1/2' }));

    expect(screen.getByText('issue #10')).toBeInTheDocument();
    expect(screen.queryByText('issue #20')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gates 1/2' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('switching back to "All" restores every ticket', () => {
    const gateTicket = makeTicket({
      ticketId: 'gate',
      issueNumber: 10,
      lane: 'ready-for-review',
      labels: [],
      updatedAt: '2026-09-06T14:00:00.000Z',
    });
    const plainTicket = makeTicket({
      ticketId: 'plain',
      issueNumber: 20,
      lane: 'queued',
      updatedAt: '2026-09-06T15:00:00.000Z',
    });
    render(<ActivityScreenWithFilters tickets={[gateTicket, plainTicket]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Gates 1/2' }));
    expect(screen.queryByText('issue #20')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All 2/2' }));
    expect(screen.getByText('issue #10')).toBeInTheDocument();
    expect(screen.getByText('issue #20')).toBeInTheDocument();
  });
});
