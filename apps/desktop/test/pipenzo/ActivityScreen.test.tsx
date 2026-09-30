import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { ActivityScreen } from '../../src/pipenzo/ActivityScreen.js';

process.env.TZ = 'UTC';

const REPO = 'jortega0033/pipenzo';
const NOW = new Date('2026-09-06T18:00:00.000Z');

function makeTicket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: '00000000-0000-4000-8000-000000000001',
    repo: REPO,
    issueNumber: 116,
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

describe('ActivityScreen', () => {
  it("renders the board/Activity explainer banner with the canvas's own copy", () => {
    render(<ActivityScreen tickets={[]} renderEntry={() => null} now={NOW} />);
    expect(
      screen.getByText(/The board is a picture of/),
    ).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing is deleted: the full record/),
    ).toBeInTheDocument();
  });

  it('states the real retention note -- retained for the life of the ticket store, not an invented window', () => {
    const tickets = [makeTicket({ updatedAt: '2026-09-06T14:12:00.000Z' })];
    render(<ActivityScreen tickets={tickets} renderEntry={() => null} now={NOW} />);
    expect(screen.getByText(/retained for the life of the ticket store/)).toBeInTheDocument();
  });

  it('shows an honest empty state when the ticket store has never recorded anything', () => {
    render(<ActivityScreen tickets={[]} renderEntry={() => null} now={NOW} />);
    expect(screen.getByText('No activity recorded yet')).toBeInTheDocument();
  });

  it('groups tickets under a day header per calendar day, reverse-chronological', () => {
    const tickets = [
      makeTicket({ ticketId: 'a', issueNumber: 1, updatedAt: '2026-09-05T20:00:00.000Z' }),
      makeTicket({ ticketId: 'b', issueNumber: 2, updatedAt: '2026-09-06T14:12:00.000Z' }),
      makeTicket({ ticketId: 'c', issueNumber: 3, updatedAt: '2026-09-06T09:00:00.000Z' }),
    ];
    const { container } = render(
      <ActivityScreen
        tickets={tickets}
        renderEntry={(entry) => <span data-testid="row">#{entry.ticket.issueNumber}</span>}
        now={NOW}
      />,
    );

    const feed = container.querySelector('.feed')!;
    const rendered = Array.from(feed.children).map((node) => node.textContent);
    expect(rendered).toEqual(['Today · Sun 6 Sep', '#2', '#3', 'Yesterday · Sat 5 Sep', '#1']);
  });

  it('includes a merged/closed ticket in the feed -- the merged-ticket case (#116)', () => {
    const merged = makeTicket({
      ticketId: 'merged',
      issueNumber: 105,
      lane: 'ready-for-review',
      labels: [],
      updatedAt: '2026-09-06T09:12:00.000Z',
    });
    render(
      <ActivityScreen
        tickets={[merged]}
        renderEntry={(entry) => <span>issue #{entry.ticket.issueNumber}</span>}
        now={NOW}
      />,
    );
    expect(screen.getByText('issue #105')).toBeInTheDocument();
  });

  it('renders a supplied filterBar in the feed header slot, and nothing there when absent', () => {
    const tickets = [makeTicket({ updatedAt: '2026-09-06T14:12:00.000Z' })];
    const { container, rerender } = render(
      <ActivityScreen
        tickets={tickets}
        renderEntry={() => null}
        now={NOW}
        filterBar={<div data-testid="filter-bar">tabs go here</div>}
      />,
    );
    expect(screen.getByTestId('filter-bar')).toBeInTheDocument();

    rerender(<ActivityScreen tickets={tickets} renderEntry={() => null} now={NOW} />);
    expect(container.querySelector('[data-testid="filter-bar"]')).not.toBeInTheDocument();
  });

  it('counts every ticket in the feed-count line', () => {
    const tickets = [
      makeTicket({ ticketId: 'a', updatedAt: '2026-09-06T14:12:00.000Z' }),
      makeTicket({ ticketId: 'b', updatedAt: '2026-09-05T09:00:00.000Z' }),
    ];
    render(<ActivityScreen tickets={tickets} renderEntry={() => null} now={NOW} />);
    expect(screen.getByText(/2 tickets/)).toBeInTheDocument();
  });

  it('renders a ticket with no updatedAt yet under its own group, rather than dropping it', () => {
    const fresh = makeTicket({ ticketId: 'fresh', issueNumber: 200 });
    render(
      <ActivityScreen
        tickets={[fresh]}
        renderEntry={(entry) => <span>issue #{entry.ticket.issueNumber}</span>}
        now={NOW}
      />,
    );
    expect(screen.getByText('Not yet recorded')).toBeInTheDocument();
    expect(screen.getByText('issue #200')).toBeInTheDocument();
  });
});
