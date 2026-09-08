import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PipenzoPhaseEventV1,
  PipenzoTicketListV1,
  PipenzoTicketViewV1,
} from '@agent-dock/shared';
import type { DaemonStatus } from '../../src/window.js';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { usePipenzoTickets } from '../../src/pipenzo/use-pipenzo-tickets.js';

function Probe() {
  const { ticketList, refresh } = usePipenzoTickets();
  return (
    <>
      <span data-testid="status">{ticketList.status}</span>
      <span data-testid="count">
        {ticketList.status === 'ready' ? ticketList.tickets.length : '-'}
      </span>
      <button type="button" onClick={() => refresh()}>
        refresh
      </button>
    </>
  );
}

function installBridge(listTickets: () => Promise<PipenzoTicketListV1>) {
  let statusListener: ((status: DaemonStatus) => void) | undefined;
  let phaseListener: ((event: PipenzoPhaseEventV1) => void) | undefined;
  const unsubscribeStatus = vi.fn();
  const unsubscribeEvents = vi.fn();
  setBridgeOverride({
    pipenzoListTickets: listTickets,
    onDaemonStatus: (callback: (status: DaemonStatus) => void) => {
      statusListener = callback;
      return unsubscribeStatus;
    },
    onPipenzoPhaseEvent: (callback: (event: PipenzoPhaseEventV1) => void) => {
      phaseListener = callback;
      return unsubscribeEvents;
    },
  } as never);
  return {
    emitStatus: (status: DaemonStatus) => statusListener?.(status),
    emitPhaseEvent: (event: PipenzoPhaseEventV1) => phaseListener?.(event),
    unsubscribeStatus,
    unsubscribeEvents,
  };
}

const status = () => screen.getByTestId('status').textContent;
const count = () => screen.getByTestId('count').textContent;

afterEach(() => {
  clearBridgeOverride();
});

const TICKET: PipenzoTicketViewV1 = {
  schemaVersion: 1,
  ticketId: '00000000-0000-4000-8000-000000000001',
  repo: 'jortega0033/pipenzo',
  issueNumber: 78,
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

describe('usePipenzoTickets', () => {
  it('starts loading, then reports a ready list', async () => {
    installBridge(vi.fn().mockResolvedValue({ tickets: [TICKET] }));
    render(<Probe />);

    expect(status()).toBe('loading');
    await waitFor(() => expect(status()).toBe('ready'));
    expect(count()).toBe('1');
  });

  it('reports a real empty list once it genuinely knows', async () => {
    installBridge(vi.fn().mockResolvedValue({ tickets: [] }));
    render(<Probe />);

    await waitFor(() => expect(status()).toBe('ready'));
    expect(count()).toBe('0');
  });

  it('reports error rather than a silent empty list when the daemon refuses the call', async () => {
    installBridge(vi.fn().mockRejectedValue(new Error('daemon is not ready yet')));
    render(<Probe />);

    await waitFor(() => expect(status()).toBe('error'));
  });

  it('re-reads when the daemon comes back ready', async () => {
    const listTickets = vi
      .fn()
      .mockResolvedValueOnce({ tickets: [] })
      .mockResolvedValue({ tickets: [TICKET] });
    const { emitStatus } = installBridge(listTickets);
    render(<Probe />);

    await waitFor(() => expect(count()).toBe('0'));
    emitStatus({ state: 'ready' } as DaemonStatus);
    await waitFor(() => expect(count()).toBe('1'));
    expect(listTickets).toHaveBeenCalledTimes(2);
  });

  it('re-reads on a live phase event, so a lane move reaches the board without a manual refresh', async () => {
    const listTickets = vi
      .fn()
      .mockResolvedValueOnce({ tickets: [TICKET] })
      .mockResolvedValue({ tickets: [TICKET, { ...TICKET, ticketId: '00000000-0000-4000-8000-000000000002' }] });
    const { emitPhaseEvent } = installBridge(listTickets);
    render(<Probe />);

    await waitFor(() => expect(count()).toBe('1'));
    emitPhaseEvent({
      sequence: 0,
      ticketId: TICKET.ticketId,
      fromLane: 'queued',
      toLane: 'working',
      phase: 'implement',
      labels: ['pipenzo:working'],
    } as PipenzoPhaseEventV1);
    // The event-triggered read is debounced (issue #255 finding 2); waitFor's default 1000ms
    // window comfortably clears the debounce plus the mocked fetch settling.
    await waitFor(() => expect(count()).toBe('2'));
  });

  it('debounces a burst of phase events into a single refetch, not one per event', async () => {
    const listTickets = vi.fn().mockResolvedValue({ tickets: [TICKET] });
    const { emitPhaseEvent } = installBridge(listTickets);
    render(<Probe />);
    await waitFor(() => expect(status()).toBe('ready'));
    listTickets.mockClear();

    const event = {
      sequence: 0,
      ticketId: TICKET.ticketId,
      fromLane: 'queued',
      toLane: 'working',
      phase: 'implement',
      labels: ['pipenzo:working'],
    } as PipenzoPhaseEventV1;

    // A reconciler tick that touched five tickets fires five near-simultaneous events.
    for (let index = 0; index < 5; index += 1) {
      emitPhaseEvent(event);
    }

    // Still inside the debounce window: nothing has been refetched yet.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(listTickets).not.toHaveBeenCalled();

    // Once the burst quiets down, the whole burst collapses into exactly one refetch.
    await waitFor(() => expect(listTickets).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(listTickets).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale read that settles after a newer one', async () => {
    const settle: ((value: PipenzoTicketListV1) => void)[] = [];
    const listTickets = vi.fn(() => new Promise<PipenzoTicketListV1>((resolve) => settle.push(resolve)));
    const { emitStatus } = installBridge(listTickets);
    render(<Probe />);

    emitStatus({ state: 'ready' } as DaemonStatus);
    expect(settle).toHaveLength(2);

    settle[1]?.({ tickets: [TICKET] });
    await waitFor(() => expect(count()).toBe('1'));
    settle[0]?.({ tickets: [] });

    await waitFor(() => expect(listTickets).toHaveBeenCalledTimes(2));
    expect(count()).toBe('1');
  });

  it('the manual refresh re-asks the daemon', async () => {
    const listTickets = vi.fn().mockResolvedValue({ tickets: [] });
    installBridge(listTickets);
    render(<Probe />);
    await waitFor(() => expect(status()).toBe('ready'));

    screen.getByRole('button', { name: 'refresh' }).click();
    await waitFor(() => expect(listTickets).toHaveBeenCalledTimes(2));
  });

  it('unsubscribes both listeners on unmount', async () => {
    const { unsubscribeStatus, unsubscribeEvents } = installBridge(
      vi.fn().mockResolvedValue({ tickets: [] }),
    );
    const { unmount } = render(<Probe />);
    await waitFor(() => expect(status()).toBe('ready'));

    unmount();
    expect(unsubscribeStatus).toHaveBeenCalled();
    expect(unsubscribeEvents).toHaveBeenCalled();
  });
});
