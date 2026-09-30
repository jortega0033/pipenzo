import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoTicketReconciliationV1, PipenzoTicketViewV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { useBoardDragDrop } from '../../src/pipenzo/use-board-drag-drop.js';

const TICKET: PipenzoTicketViewV1 = {
  schemaVersion: 1,
  ticketId: '00000000-0000-4000-8000-000000000001',
  repo: 'jortega0033/pipenzo',
  issueNumber: 82,
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
};

function reconciliation(
  ticket: PipenzoTicketViewV1,
  previousLane: PipenzoTicketViewV1['lane'],
): PipenzoTicketReconciliationV1 {
  return {
    ticket,
    divergence: previousLane === ticket.lane ? 'none' : 'lane_reconciled',
    previousLane,
    observedLabels: ticket.labels,
    changed: true,
  };
}

function installBridge(transitionTicket: (input: unknown) => Promise<PipenzoTicketReconciliationV1>) {
  setBridgeOverride({ pipenzoTicketTransition: transitionTicket } as never);
}

function Probe({
  tickets,
  onFailed,
}: {
  tickets: readonly PipenzoTicketViewV1[];
  onFailed: (ticket: PipenzoTicketViewV1, message: string) => void;
}) {
  const { tickets: withOptimism, onCardDrop } = useBoardDragDrop(tickets, onFailed);
  const ticket = withOptimism[0]!;
  return (
    <>
      <span data-testid="lane">{ticket.lane}</span>
      <button type="button" onClick={() => onCardDrop(tickets[0]!, 'working')}>
        drop on working
      </button>
    </>
  );
}

const lane = () => screen.getByTestId('lane').textContent;

afterEach(() => {
  clearBridgeOverride();
});

describe('useBoardDragDrop', () => {
  it('moves the card immediately, before the transition call settles (optimistic move)', async () => {
    let settle: ((value: PipenzoTicketReconciliationV1) => void) | undefined;
    const transitionTicket = vi.fn(
      () => new Promise<PipenzoTicketReconciliationV1>((resolve) => (settle = resolve)),
    );
    installBridge(transitionTicket);
    render(<Probe tickets={[TICKET]} onFailed={vi.fn()} />);
    expect(lane()).toBe('queued');

    act(() => screen.getByRole('button').click());

    expect(lane()).toBe('working');
    settle!(reconciliation({ ...TICKET, lane: 'working' }, 'queued'));
    await waitFor(() => expect(transitionTicket).toHaveBeenCalledTimes(1));
  });

  it('calls the real transition route with the ticket id and the lane’s own pipenzo: label', async () => {
    const transitionTicket = vi.fn().mockResolvedValue(reconciliation({ ...TICKET, lane: 'working' }, 'queued'));
    installBridge(transitionTicket);
    render(<Probe tickets={[TICKET]} onFailed={vi.fn()} />);

    act(() => screen.getByRole('button').click());

    await waitFor(() =>
      expect(transitionTicket).toHaveBeenCalledWith({
        ticketId: TICKET.ticketId,
        label: 'pipenzo:working',
      }),
    );
  });

  it('reconciles against the next poll: a fresher list that disagrees with the guess wins', async () => {
    const transitionTicket = vi.fn().mockResolvedValue(reconciliation({ ...TICKET, lane: 'working' }, 'queued'));
    installBridge(transitionTicket);
    const { rerender } = render(<Probe tickets={[TICKET]} onFailed={vi.fn()} />);

    act(() => screen.getByRole('button').click());
    expect(lane()).toBe('working');
    await waitFor(() => expect(transitionTicket).toHaveBeenCalledTimes(1));

    // The next real poll reports something the drag did not ask for at all (a teammate moved it to
    // Needs-human in the meantime) -- the label wins, even over this hook's own optimistic guess.
    rerender(<Probe tickets={[{ ...TICKET, lane: 'needs-human' }]} onFailed={vi.fn()} />);
    expect(lane()).toBe('needs-human');
  });

  it('keeps the guess until a poll actually reports a lane change, not before', async () => {
    let settle: ((value: PipenzoTicketReconciliationV1) => void) | undefined;
    const transitionTicket = vi.fn(
      () => new Promise<PipenzoTicketReconciliationV1>((resolve) => (settle = resolve)),
    );
    installBridge(transitionTicket);
    const { rerender } = render(<Probe tickets={[TICKET]} onFailed={vi.fn()} />);

    act(() => screen.getByRole('button').click());
    expect(lane()).toBe('working');

    // A poll lands while the request is still in flight, but still reporting the pre-drag lane
    // (the write has not reached GitHub yet) -- the guess must not be discarded prematurely.
    rerender(<Probe tickets={[{ ...TICKET, lane: 'queued' }]} onFailed={vi.fn()} />);
    expect(lane()).toBe('working');

    settle!(reconciliation({ ...TICKET, lane: 'working' }, 'queued'));
    await waitFor(() => expect(transitionTicket).toHaveBeenCalledTimes(1));
  });

  it('snaps back immediately on a server-rejected transition, and reports the failure', async () => {
    const onFailed = vi.fn();
    const transitionTicket = vi.fn().mockRejectedValue(new Error('cannot move a ticket from queued to ready-for-review'));
    installBridge(transitionTicket);
    render(<Probe tickets={[TICKET]} onFailed={onFailed} />);

    act(() => screen.getByRole('button').click());
    expect(lane()).toBe('working');

    await waitFor(() => expect(lane()).toBe('queued'));
    expect(onFailed).toHaveBeenCalledWith(
      TICKET,
      'cannot move a ticket from queued to ready-for-review',
    );
  });

  it('never claims a move the server refused -- a rejected drag leaves the real lane exactly as it was', async () => {
    const transitionTicket = vi.fn().mockRejectedValue(new Error('refused'));
    installBridge(transitionTicket);
    const { rerender } = render(<Probe tickets={[TICKET]} onFailed={vi.fn()} />);

    act(() => screen.getByRole('button').click());
    await waitFor(() => expect(lane()).toBe('queued'));

    // The real list never moved either -- this was a UI-only guess the whole time.
    rerender(<Probe tickets={[TICKET]} onFailed={vi.fn()} />);
    expect(lane()).toBe('queued');
  });

  it('updates the guess to whatever the write actually reported, when it differs from what was asked', async () => {
    // A concurrent writer raced this transition: it asked for `working`, GitHub reports
    // `needs-human` instead (README's own label-wins precedence, surfaced on the response itself).
    const transitionTicket = vi
      .fn()
      .mockResolvedValue(reconciliation({ ...TICKET, lane: 'needs-human' }, 'queued'));
    installBridge(transitionTicket);
    render(<Probe tickets={[TICKET]} onFailed={vi.fn()} />);

    act(() => screen.getByRole('button').click());
    expect(lane()).toBe('working');

    await waitFor(() => expect(lane()).toBe('needs-human'));
  });
});
