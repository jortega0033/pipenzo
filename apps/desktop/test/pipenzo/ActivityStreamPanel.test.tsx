import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PipenzoPhaseEventV1,
  PipenzoTicketReconciliationV1,
  PipenzoTicketViewV1,
  ReviewReportV1,
} from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { ActivityStreamPanel } from '../../src/pipenzo/ActivityStreamPanel.js';

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

function reviewReport(overrides: Partial<ReviewReportV1> = {}): ReviewReportV1 {
  return {
    schemaVersion: 1,
    outcome: 'approved',
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    implementerTier: 'mid',
    deterministic: [{ id: 'build', status: 'passed', summary: 'ok', durationMs: 10 }],
    risk: 'medium',
    reviewer: { sessionId: 'r1', tier: 'mid', model: 'sonnet', findings: [{ severity: 'info', message: 'looks fine' }] },
    verifier: { sessionId: 'v1', tier: 'mid', model: 'opus', findings: [], verdict: 'approved', vendorDiversityUnavailable: false },
    ...overrides,
  };
}

describe('ActivityStreamPanel', () => {
  it('shows a loading placeholder before the ticket resolves', async () => {
    let resolveRead: (value: PipenzoTicketReconciliationV1) => void = () => {};
    installBridge(() => new Promise((resolve) => (resolveRead = resolve)));
    render(<ActivityStreamPanel ticketId={TICKET_ID} />);

    expect(screen.getByTestId('activity-stream-loading')).toBeInTheDocument();
    resolveRead(reconciliation(ticket()));
    await waitFor(() => expect(screen.queryByTestId('activity-stream-loading')).not.toBeInTheDocument());
  });

  it('shows an error notice when the daemon refuses the read', async () => {
    installBridge(vi.fn().mockRejectedValue(new Error('daemon is not ready yet')));
    render(<ActivityStreamPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(screen.getByText("Could not read this ticket's activity")).toBeInTheDocument());
  });

  it('shows an honest empty state for a ticket with nothing recorded yet', async () => {
    installBridge(vi.fn().mockResolvedValue(reconciliation(ticket())));
    render(<ActivityStreamPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(screen.getByText('No activity recorded yet')).toBeInTheDocument());
  });

  it('renders one row per real attempt and one per real precommit', async () => {
    installBridge(
      vi.fn().mockResolvedValue(
        reconciliation(
          ticket({
            attempts: [{ sessionId: 's1', tier: 'mid', model: 'sonnet', outcome: 'dispatched' }],
            precommits: [
              {
                action: 'Delete the legacy fixture',
                expect: 'vitest count unchanged',
                ifWrong: 'git checkout --',
                outcome: 'vitest count unchanged',
                verdict: 'match',
              },
            ],
          }),
        ),
      ),
    );
    const { container } = render(<ActivityStreamPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(container.querySelectorAll('.evt')).toHaveLength(2));
    expect(screen.getByText('Implement session dispatched')).toBeInTheDocument();
    expect(screen.getByText('Delete the legacy fixture')).toBeInTheDocument();
  });

  it('renders a MEDIUM/HIGH review row with a real risk chip, not compact', async () => {
    installBridge(vi.fn().mockResolvedValue(reconciliation(ticket())));
    const { container } = render(<ActivityStreamPanel ticketId={TICKET_ID} reviewReport={reviewReport({ risk: 'high' })} />);

    await waitFor(() => expect(container.querySelector('.evt')).not.toBeNull());
    expect(container.querySelector('.evt.low')).toBeNull();
    expect(screen.getByText('HIGH')).toBeInTheDocument();
  });

  it('renders a LOW-graded review row compact, keyed off the real RiskGrade', async () => {
    installBridge(vi.fn().mockResolvedValue(reconciliation(ticket())));
    const { container } = render(<ActivityStreamPanel ticketId={TICKET_ID} reviewReport={reviewReport({ risk: 'low' })} />);

    await waitFor(() => expect(container.querySelector('.evt.low')).not.toBeNull());
    expect(container.querySelector('.low-line')).not.toBeNull();
    expect(screen.queryByText('LOW')).not.toBeInTheDocument(); // no RiskChip on the compact row
  });

  it('discloses the real reviewer/verifier transcript on click, and hides it again', async () => {
    installBridge(vi.fn().mockResolvedValue(reconciliation(ticket())));
    render(<ActivityStreamPanel ticketId={TICKET_ID} reviewReport={reviewReport({ risk: 'high' })} />);

    await waitFor(() => expect(screen.getByText(/reviewer · 1 findings/)).toBeInTheDocument());
    expect(screen.queryByText('looks fine')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/reviewer · 1 findings/));
    expect(screen.getByText(/looks fine/)).toBeInTheDocument();
    expect(screen.getByText(/verifier · opus · approved/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/reviewer · 1 findings/));
    expect(screen.queryByText('looks fine')).not.toBeInTheDocument();
  });

  it('shows no transcript disclosure at all when neither reviewer nor verifier data exists', async () => {
    installBridge(vi.fn().mockResolvedValue(reconciliation(ticket())));
    render(
      <ActivityStreamPanel
        ticketId={TICKET_ID}
        reviewReport={reviewReport({ reviewer: undefined, verifier: undefined, outcome: 'review_input_incomplete', inputCompleteness: { complete: false, reason: 'too large', limitChars: 100 } })}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Review could not complete/)).toBeInTheDocument());
    expect(screen.queryByText(/findings/)).not.toBeInTheDocument();
  });

  it('renders a live pending review row while a review action is in flight', async () => {
    installBridge(vi.fn().mockResolvedValue(reconciliation(ticket())));
    const { container } = render(<ActivityStreamPanel ticketId={TICKET_ID} reviewPending />);

    await waitFor(() => expect(screen.getByText(/Review running/)).toBeInTheDocument());
    expect(container.querySelector('.evt-ic.live')).not.toBeNull();
  });

  it('marks the currently dispatched attempt live and un-marks it on a real phase-change stream event', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(
        reconciliation(
          ticket({
            lane: 'working',
            phase: 'implement',
            attempts: [{ sessionId: 's1', tier: 'mid', model: 'sonnet', outcome: 'dispatched' }],
          }),
        ),
      )
      .mockResolvedValue(
        reconciliation(
          ticket({
            lane: 'working',
            phase: 'review',
            attempts: [{ sessionId: 's1', tier: 'mid', model: 'sonnet', outcome: 'dispatched' }],
          }),
        ),
      );
    const { emitPhaseEvent } = installBridge(read);
    const { container } = render(<ActivityStreamPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(container.querySelector('.evt-ic.live')).not.toBeNull());
    expect(screen.getByText(/Implement session dispatched/).closest('.evt')?.querySelector('.evt-meta')).toHaveClass('live');

    emitPhaseEvent({
      sequence: 0,
      ticketId: TICKET_ID,
      fromLane: 'working',
      toLane: 'working',
      phase: 'review',
      labels: ['pipenzo:working'],
    } as PipenzoPhaseEventV1);

    // Once the phase moves past implement, the same attempt is real history, not still running.
    await waitFor(() => expect(container.querySelector('.evt-ic.live')).toBeNull());
  });

  it('terminates the connecting line only on the true last row of N events', async () => {
    installBridge(
      vi.fn().mockResolvedValue(
        reconciliation(
          ticket({
            attempts: [
              { sessionId: 's1', tier: 'mid', model: 'sonnet', outcome: 'dispatched' },
              { sessionId: 's2', tier: 'mid', model: 'sonnet', outcome: 'interrupted_recovered' },
            ],
            precommits: [
              {
                action: 'first',
                expect: 'e',
                ifWrong: 'w',
                outcome: 'o',
                verdict: 'match',
              },
            ],
          }),
        ),
      ),
    );
    const { container } = render(<ActivityStreamPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(container.querySelectorAll('.evt')).toHaveLength(3));
    const rows = Array.from(container.querySelectorAll('.evt'));
    expect(rows[0]?.querySelector('.evt-line')).not.toHaveClass('end');
    expect(rows[1]?.querySelector('.evt-line')).not.toHaveClass('end');
    expect(rows[2]?.querySelector('.evt-line')).toHaveClass('end');
  });

  it('does not terminate the last row when the caller says more stream content follows', async () => {
    installBridge(
      vi.fn().mockResolvedValue(
        reconciliation(ticket({ attempts: [{ sessionId: 's1', tier: 'mid', model: 'sonnet', outcome: 'dispatched' }] })),
      ),
    );
    const { container } = render(<ActivityStreamPanel ticketId={TICKET_ID} continuesBelow />);

    await waitFor(() => expect(container.querySelectorAll('.evt')).toHaveLength(1));
    expect(container.querySelector('.evt-line')).not.toHaveClass('end');
  });

  it('renders a trailing ci-failed row naming the real recorded fix attempt (issue #102)', async () => {
    installBridge(
      vi.fn().mockResolvedValue(
        reconciliation(
          ticket({
            labels: ['pipenzo:ci-failed'],
            attempts: [{ sessionId: 's1', tier: 'frontier', model: 'opus', outcome: 'dispatched' }],
          }),
        ),
      ),
    );
    const { container } = render(<ActivityStreamPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(container.querySelectorAll('.evt')).toHaveLength(2));
    expect(screen.getByText(/A fix attempt has been recorded \(frontier tier, opus\)/)).toBeInTheDocument();
    // the real lineage line: the attempt row's connector continues, only the trailing ci-failed
    // row's connector ends the stream.
    const rows = Array.from(container.querySelectorAll('.evt'));
    expect(rows[0]?.querySelector('.evt-line')).not.toHaveClass('end');
    expect(rows[1]?.querySelector('.evt-line')).toHaveClass('end');
    expect(rows[1]?.querySelector('.evt-ic')).toHaveClass('bad');
  });

  it('renders the honest ci-failed gap when no fix attempt has been recorded yet', async () => {
    installBridge(
      vi.fn().mockResolvedValue(reconciliation(ticket({ labels: ['pipenzo:ci-failed'], attempts: [] }))),
    );
    render(<ActivityStreamPanel ticketId={TICKET_ID} />);

    await waitFor(() =>
      expect(screen.getByText('A post-merge-request check failed on this ticket. No fix attempt has been recorded yet.')).toBeInTheDocument(),
    );
  });

  it('renders no ci-failed row for a ticket that never carried the real label', async () => {
    installBridge(
      vi.fn().mockResolvedValue(
        reconciliation(ticket({ attempts: [{ sessionId: 's1', tier: 'mid', model: 'sonnet', outcome: 'dispatched' }] })),
      ),
    );
    render(<ActivityStreamPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(screen.getByText('Implement session dispatched')).toBeInTheDocument());
    expect(screen.queryByText(/post-merge-request check failed/)).not.toBeInTheDocument();
  });
});
