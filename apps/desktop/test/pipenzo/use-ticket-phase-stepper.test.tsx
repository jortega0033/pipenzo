import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PipenzoPhaseEventV1,
  PipenzoTicketReconciliationV1,
  PipenzoTicketViewV1,
} from '@agent-dock/shared';
import type { DaemonStatus } from '../../src/window.js';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { useTicketPhaseStepper } from '../../src/pipenzo/use-ticket-phase-stepper.js';

function Probe({ ticketId }: { ticketId: string }) {
  const { state } = useTicketPhaseStepper(ticketId);
  return (
    <>
      <span data-testid="status">{state.status}</span>
      <span data-testid="lane">{state.status === 'ready' ? state.ticket.lane : '-'}</span>
    </>
  );
}

function installBridge(ticketRead: (input: { ticketId: string }) => Promise<PipenzoTicketReconciliationV1>) {
  let statusListener: ((status: DaemonStatus) => void) | undefined;
  let phaseListener: ((event: PipenzoPhaseEventV1) => void) | undefined;
  setBridgeOverride({
    pipenzoTicketRead: ticketRead,
    onDaemonStatus: (callback: (status: DaemonStatus) => void) => {
      statusListener = callback;
      return vi.fn();
    },
    onPipenzoPhaseEvent: (callback: (event: PipenzoPhaseEventV1) => void) => {
      phaseListener = callback;
      return vi.fn();
    },
  } as never);
  return {
    emitStatus: (status: DaemonStatus) => statusListener?.(status),
    emitPhaseEvent: (event: PipenzoPhaseEventV1) => phaseListener?.(event),
  };
}

const status = () => screen.getByTestId('status').textContent;
const lane = () => screen.getByTestId('lane').textContent;

afterEach(() => {
  clearBridgeOverride();
});

const TICKET_ID = '00000000-0000-4000-8000-000000000001';

function ticket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: TICKET_ID,
    repo: 'jortega0033/pipenzo',
    issueNumber: 94,
    lane: 'working',
    phase: 'implement',
    labels: ['pipenzo:working'],
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

function reconciliation(t: PipenzoTicketViewV1): PipenzoTicketReconciliationV1 {
  return { ticket: t, divergence: 'none', previousLane: t.lane, observedLabels: [], changed: false };
}

describe('useTicketPhaseStepper', () => {
  it('starts loading, then reports the reconciled ticket', async () => {
    installBridge(vi.fn().mockResolvedValue(reconciliation(ticket())));
    render(<Probe ticketId={TICKET_ID} />);

    expect(status()).toBe('loading');
    await waitFor(() => expect(status()).toBe('ready'));
    expect(lane()).toBe('working');
  });

  it('reports error rather than a stale ticket when the daemon refuses the call', async () => {
    installBridge(vi.fn().mockRejectedValue(new Error('daemon is not ready yet')));
    render(<Probe ticketId={TICKET_ID} />);
    await waitFor(() => expect(status()).toBe('error'));
  });

  it('re-reads on a live phase event for this ticket, so a lane move reaches the screen live', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(reconciliation(ticket({ lane: 'working' })))
      .mockResolvedValue(reconciliation(ticket({ lane: 'ready-for-review', phase: 'review' })));
    const { emitPhaseEvent } = installBridge(read);
    render(<Probe ticketId={TICKET_ID} />);

    await waitFor(() => expect(lane()).toBe('working'));
    emitPhaseEvent({
      sequence: 0,
      ticketId: TICKET_ID,
      fromLane: 'working',
      toLane: 'ready-for-review',
      phase: 'review',
      labels: ['pipenzo:ready-for-review'],
    } as PipenzoPhaseEventV1);

    await waitFor(() => expect(lane()).toBe('ready-for-review'));
  });

  it('ignores a live phase event for a different ticket', async () => {
    const read = vi.fn().mockResolvedValue(reconciliation(ticket({ lane: 'working' })));
    const { emitPhaseEvent } = installBridge(read);
    render(<Probe ticketId={TICKET_ID} />);
    await waitFor(() => expect(status()).toBe('ready'));
    read.mockClear();

    emitPhaseEvent({
      sequence: 0,
      ticketId: '00000000-0000-4000-8000-000000000002',
      fromLane: 'working',
      toLane: 'ready-for-review',
      phase: 'review',
      labels: ['pipenzo:ready-for-review'],
    } as PipenzoPhaseEventV1);

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(read).not.toHaveBeenCalled();
  });

  it('re-reads when the daemon comes back ready', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(reconciliation(ticket({ lane: 'queued', phase: 'refine' })))
      .mockResolvedValue(reconciliation(ticket({ lane: 'working' })));
    const { emitStatus } = installBridge(read);
    render(<Probe ticketId={TICKET_ID} />);

    await waitFor(() => expect(lane()).toBe('queued'));
    emitStatus({ state: 'ready' } as DaemonStatus);
    await waitFor(() => expect(lane()).toBe('working'));
    expect(read).toHaveBeenCalledTimes(2);
  });
});
