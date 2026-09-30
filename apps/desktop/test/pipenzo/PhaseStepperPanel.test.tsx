import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoPhaseEventV1, PipenzoTicketReconciliationV1, PipenzoTicketViewV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { PhaseStepperPanel } from '../../src/pipenzo/PhaseStepperPanel.js';

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

function installBridge(read: (input: { ticketId: string }) => Promise<PipenzoTicketReconciliationV1>) {
  let phaseListener: ((event: PipenzoPhaseEventV1) => void) | undefined;
  setBridgeOverride({
    pipenzoTicketRead: read,
    onDaemonStatus: () => vi.fn(),
    onPipenzoPhaseEvent: (callback: (event: PipenzoPhaseEventV1) => void) => {
      phaseListener = callback;
      return vi.fn();
    },
  } as never);
  return { emitPhaseEvent: (event: PipenzoPhaseEventV1) => phaseListener?.(event) };
}

describe('PhaseStepperPanel', () => {
  it('renders the real phase-machine steps once the ticket loads, five steps for a clean run', async () => {
    installBridge(vi.fn().mockResolvedValue(reconciliation(ticket())));
    const { container } = render(<PhaseStepperPanel ticketId={TICKET_ID} />);

    expect(screen.getByTestId('phase-stepper-loading')).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll('.step')).toHaveLength(5));
    expect(container.querySelector('.step.active')).not.toBeNull();
  });

  it('shows the awaiting-publish-gate state once gates pass (ready-for-review)', async () => {
    installBridge(
      vi.fn().mockResolvedValue(
        reconciliation(ticket({ lane: 'ready-for-review', phase: 'review', labels: ['pipenzo:ready-for-review'] })),
      ),
    );
    render(<PhaseStepperPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(screen.getByText('Publish').closest('.step')).toHaveClass('await'));
    expect(screen.getByText('Waiting on you — ready to publish')).toBeInTheDocument();
  });

  it('shows the awaiting-plan-review-gate state for a real stack-approval ticket', async () => {
    installBridge(
      vi.fn().mockResolvedValue(
        reconciliation(
          ticket({
            lane: 'needs-human',
            phase: 'refine',
            labels: ['pipenzo:needs-human', 'pipenzo:awaiting-stack-approval'],
          }),
        ),
      ),
    );
    render(<PhaseStepperPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(screen.getByText('Plan review').closest('.step')).toHaveClass('await'));
    expect(screen.getByText('Stack awaiting sign-off')).toBeInTheDocument();
  });

  it('shows a failed step for a ticket parked mid-implement', async () => {
    installBridge(
      vi.fn().mockResolvedValue(
        reconciliation(ticket({ lane: 'needs-human', phase: 'implement', labels: ['pipenzo:needs-human'] })),
      ),
    );
    render(<PhaseStepperPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(screen.getByText('Implement').closest('.step')).toHaveClass('fail'));
  });

  it('appends the CI step only when the ticket actually carries pipenzo:ci-failed', async () => {
    installBridge(
      vi.fn().mockResolvedValue(
        reconciliation(
          ticket({
            lane: 'ready-for-review',
            phase: 'review',
            labels: ['pipenzo:ready-for-review', 'pipenzo:ci-failed'],
          }),
        ),
      ),
    );
    const { container } = render(<PhaseStepperPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(container.querySelectorAll('.step')).toHaveLength(6));
    expect(screen.getByText('CI').closest('.step')).toHaveClass('fail');
  });

  it('omits the CI step for a clean ticket with no CI failure', async () => {
    installBridge(vi.fn().mockResolvedValue(reconciliation(ticket({ lane: 'ready-for-review', phase: 'review', labels: ['pipenzo:ready-for-review'] }))));
    const { container } = render(<PhaseStepperPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(container.querySelectorAll('.step')).toHaveLength(5));
    expect(screen.queryByText('CI')).not.toBeInTheDocument();
  });

  it('calls onSelectSlice with the clicked step id and the real ticket -- click-to-view-slice', async () => {
    const onSelectSlice = vi.fn();
    installBridge(vi.fn().mockResolvedValue(reconciliation(ticket())));
    render(<PhaseStepperPanel ticketId={TICKET_ID} onSelectSlice={onSelectSlice} />);

    await waitFor(() => expect(screen.getByText('Review')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Review/ }));

    expect(onSelectSlice).toHaveBeenCalledWith({ stepId: 'review', ticket: expect.objectContaining({ ticketId: TICKET_ID }) });
  });

  it('re-renders with the new phase on a live stream event, no manual refresh needed', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(reconciliation(ticket({ lane: 'working', phase: 'implement' })))
      .mockResolvedValue(reconciliation(ticket({ lane: 'working', phase: 'review' })));
    const { emitPhaseEvent } = installBridge(read);
    render(<PhaseStepperPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(screen.getByText('Implement').closest('.step')).toHaveClass('active'));

    emitPhaseEvent({
      sequence: 0,
      ticketId: TICKET_ID,
      fromLane: 'working',
      toLane: 'working',
      phase: 'review',
      labels: ['pipenzo:working'],
    } as PipenzoPhaseEventV1);

    await waitFor(() => expect(screen.getByText('Review').closest('.step')).toHaveClass('active'));
    expect(screen.getByText('Implement').closest('.step')).toHaveClass('done');
  });

  it('shows an error notice when the daemon refuses the read', async () => {
    installBridge(vi.fn().mockRejectedValue(new Error('daemon is not ready yet')));
    render(<PhaseStepperPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(screen.getByText("Could not read this ticket's phase")).toBeInTheDocument());
  });
});
