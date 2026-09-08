import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { BoardScreen } from '../../src/pipenzo/BoardScreen.js';

const REPO = 'jortega0033/pipenzo';

function makeTicket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: '00000000-0000-4000-8000-000000000001',
    repo: REPO,
    issueNumber: 81,
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

describe('BoardScreen', () => {
  it('renders the four lanes, in order, with a dot and title each', () => {
    const { container } = render(<BoardScreen renderTicket={() => null} />);
    const lanes = container.querySelectorAll('.board > .lane');
    expect(lanes).toHaveLength(4);
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(screen.getByText('Ready for review')).toBeInTheDocument();
    expect(screen.getByText('Needs human')).toBeInTheDocument();
  });

  it('defaults to no tickets, so every lane shows its own empty state with a 0 count', () => {
    render(<BoardScreen renderTicket={() => null} />);
    const counts = screen.getAllByText('0');
    expect(counts).toHaveLength(4);
    expect(screen.getByText('Nothing queued')).toBeInTheDocument();
    expect(screen.getByText('Nothing running')).toBeInTheDocument();
    expect(screen.getByText('Nothing to review')).toBeInTheDocument();
    expect(screen.getByText('Nothing needs you')).toBeInTheDocument();
  });

  it("counts tickets per lane and hides that lane's empty state once it has one", () => {
    const tickets = [
      makeTicket({ ticketId: 'a', lane: 'queued', issueNumber: 1 }),
      makeTicket({ ticketId: 'b', lane: 'queued', issueNumber: 2 }),
      makeTicket({ ticketId: 'c', lane: 'working', issueNumber: 3 }),
    ];
    const { container } = render(<BoardScreen tickets={tickets} renderTicket={() => null} />);

    const lanes = container.querySelectorAll('.board > .lane');
    const queuedCount = lanes[0]?.querySelector('.lane-count');
    const workingCount = lanes[1]?.querySelector('.lane-count');
    const readyCount = lanes[2]?.querySelector('.lane-count');
    const parkedCount = lanes[3]?.querySelector('.lane-count');
    expect(queuedCount).toHaveTextContent('2');
    expect(workingCount).toHaveTextContent('1');
    expect(readyCount).toHaveTextContent('0');
    expect(parkedCount).toHaveTextContent('0');

    expect(screen.queryByText('Nothing queued')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing running')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing to review')).toBeInTheDocument();
    expect(screen.getByText('Nothing needs you')).toBeInTheDocument();
  });

  it('renders every ticket in its own lane through the caller-supplied renderTicket', () => {
    const tickets = [
      makeTicket({ ticketId: 'a', lane: 'queued', issueNumber: 1 }),
      makeTicket({ ticketId: 'b', lane: 'needs-human', issueNumber: 2 }),
    ];
    render(
      <BoardScreen
        tickets={tickets}
        renderTicket={(ticket) => <span>ticket #{ticket.issueNumber}</span>}
      />,
    );
    expect(screen.getByText('ticket #1')).toBeInTheDocument();
    expect(screen.getByText('ticket #2')).toBeInTheDocument();
  });

  it("places each lane's cards inside its own scrollable well", () => {
    const tickets = [makeTicket({ ticketId: 'a', lane: 'working', issueNumber: 5 })];
    const { container } = render(
      <BoardScreen
        tickets={tickets}
        renderTicket={(ticket) => <span>#{ticket.issueNumber}</span>}
      />,
    );
    const workingLane = container.querySelectorAll('.board > .lane')[1];
    const well = workingLane?.querySelector('.lane-cards');
    expect(well).toBeInTheDocument();
    expect(well).toHaveTextContent('#5');
  });
});
