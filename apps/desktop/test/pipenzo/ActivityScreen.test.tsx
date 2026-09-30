import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoTicketRiskResponseV1, PipenzoTicketViewV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
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

function riskResponse(): PipenzoTicketRiskResponseV1 {
  return { risk: { score: 0, lastResetAt: NOW.toISOString() } };
}

// Every test below mounts a real `ActivityScreen`, which now calls the real
// `pipenzoRecordRiskActivityOpened` bridge method on mount (issue #119) -- see that file's own doc
// comment. Stubbed here the same way `LessonPrompt.test.tsx` stubs `pipenzoCreateLesson`, so tests
// that only care about rendering do not have to know about the reset call, and the tests that do
// (below) can inspect the same mock.
let pipenzoRecordRiskActivityOpened: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pipenzoRecordRiskActivityOpened = vi.fn().mockResolvedValue(riskResponse());
  setBridgeOverride({ pipenzoRecordRiskActivityOpened } as never);
});

afterEach(() => {
  clearBridgeOverride();
});

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

  describe('the "I\'ve looked" risk reset (issue #119)', () => {
    it('calls the real recordRiskActivityOpened route exactly once per ticket on mount', () => {
      const tickets = [
        makeTicket({ ticketId: 'a', updatedAt: '2026-09-06T14:12:00.000Z' }),
        makeTicket({ ticketId: 'b', updatedAt: '2026-09-05T09:00:00.000Z' }),
      ];
      render(<ActivityScreen tickets={tickets} renderEntry={() => null} now={NOW} />);

      expect(pipenzoRecordRiskActivityOpened).toHaveBeenCalledTimes(2);
      expect(pipenzoRecordRiskActivityOpened).toHaveBeenCalledWith({ ticketId: 'a' });
      expect(pipenzoRecordRiskActivityOpened).toHaveBeenCalledWith({ ticketId: 'b' });
    });

    it('calls it once even when the same ticket id appears more than once in the feed', () => {
      const tickets = [
        makeTicket({ ticketId: 'dup', updatedAt: '2026-09-06T14:12:00.000Z' }),
        makeTicket({ ticketId: 'dup', updatedAt: '2026-09-05T09:00:00.000Z' }),
      ];
      render(<ActivityScreen tickets={tickets} renderEntry={() => null} now={NOW} />);

      expect(pipenzoRecordRiskActivityOpened).toHaveBeenCalledTimes(1);
      expect(pipenzoRecordRiskActivityOpened).toHaveBeenCalledWith({ ticketId: 'dup' });
    });

    it('calls nothing for an empty ticket store -- there is nothing to have looked at', () => {
      render(<ActivityScreen tickets={[]} renderEntry={() => null} now={NOW} />);
      expect(pipenzoRecordRiskActivityOpened).not.toHaveBeenCalled();
    });

    it('does not fire again on a re-render of the same mounted screen', () => {
      const tickets = [makeTicket({ ticketId: 'a', updatedAt: '2026-09-06T14:12:00.000Z' })];
      const { rerender } = render(
        <ActivityScreen tickets={tickets} renderEntry={() => null} now={NOW} />,
      );
      expect(pipenzoRecordRiskActivityOpened).toHaveBeenCalledTimes(1);

      // A prop-only re-render (e.g. `now` ticking, or the parent re-rendering for an unrelated
      // reason) must not read as a second "I've looked" -- only a genuine new mount does.
      rerender(<ActivityScreen tickets={tickets} renderEntry={() => null} now={new Date(NOW)} />);
      expect(pipenzoRecordRiskActivityOpened).toHaveBeenCalledTimes(1);
    });

    it('does not fire again when the ticket list itself changes under an already-mounted screen', () => {
      const tickets = [makeTicket({ ticketId: 'a', updatedAt: '2026-09-06T14:12:00.000Z' })];
      const { rerender } = render(
        <ActivityScreen tickets={tickets} renderEntry={() => null} now={NOW} />,
      );
      expect(pipenzoRecordRiskActivityOpened).toHaveBeenCalledTimes(1);

      // A live board sync bringing in a new ticket while the screen stays open is background data
      // arriving, not a person opening the screen again -- see this file's own note on why the
      // reset is scoped to the tickets the screen was first mounted with.
      const withNewTicket = [
        ...tickets,
        makeTicket({ ticketId: 'b', updatedAt: '2026-09-06T15:00:00.000Z' }),
      ];
      rerender(<ActivityScreen tickets={withNewTicket} renderEntry={() => null} now={NOW} />);
      expect(pipenzoRecordRiskActivityOpened).toHaveBeenCalledTimes(1);
    });

    it('remounting the screen (a genuine second open) fires the reset again', () => {
      const tickets = [makeTicket({ ticketId: 'a', updatedAt: '2026-09-06T14:12:00.000Z' })];
      const { unmount } = render(
        <ActivityScreen tickets={tickets} renderEntry={() => null} now={NOW} />,
      );
      expect(pipenzoRecordRiskActivityOpened).toHaveBeenCalledTimes(1);
      unmount();

      render(<ActivityScreen tickets={tickets} renderEntry={() => null} now={NOW} />);
      expect(pipenzoRecordRiskActivityOpened).toHaveBeenCalledTimes(2);
    });

    it('a rejected reset call does not stop the screen from rendering the feed', () => {
      pipenzoRecordRiskActivityOpened.mockRejectedValue(new Error('daemon unavailable'));
      const tickets = [makeTicket({ ticketId: 'a', updatedAt: '2026-09-06T14:12:00.000Z' })];

      render(
        <ActivityScreen
          tickets={tickets}
          renderEntry={(entry) => <span>issue #{entry.ticket.issueNumber}</span>}
          now={NOW}
        />,
      );

      expect(pipenzoRecordRiskActivityOpened).toHaveBeenCalledWith({ ticketId: 'a' });
      expect(screen.getByText(`issue #${tickets[0]!.issueNumber}`)).toBeInTheDocument();
    });
  });
});
