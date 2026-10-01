import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoPhaseEventV1, PipenzoRunStatusResultV1, PipenzoStopResultV1 } from '@agent-dock/shared';
import type { DaemonStatus } from '../../src/window.js';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { useTicketRunControls } from '../../src/pipenzo/use-ticket-run-controls.js';

const TICKET_ID = '00000000-0000-4000-8000-000000000001';

function Probe({ ticketId }: { ticketId: string }) {
  const { state, steer, stop } = useTicketRunControls(ticketId);
  return (
    <>
      <span data-testid="status">{state.status}</span>
      <span data-testid="live">{state.status === 'ready' ? String(state.run.live) : '-'}</span>
      <button onClick={() => void steer('leave the fixture alone')}>steer</button>
      <button onClick={() => void stop()}>stop</button>
    </>
  );
}

function installBridge(options: {
  runStatusPipenzo: (input: { ticketId: string }) => Promise<PipenzoRunStatusResultV1>;
  steerPipenzo?: ReturnType<typeof vi.fn>;
  stopPipenzo?: ReturnType<typeof vi.fn>;
}) {
  let statusListener: ((status: DaemonStatus) => void) | undefined;
  let phaseListener: ((event: PipenzoPhaseEventV1) => void) | undefined;
  setBridgeOverride({
    runStatusPipenzo: options.runStatusPipenzo,
    steerPipenzo: options.steerPipenzo ?? vi.fn(),
    stopPipenzo: options.stopPipenzo ?? vi.fn().mockResolvedValue({} as PipenzoStopResultV1),
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

function phaseEvent(overrides: Partial<PipenzoPhaseEventV1> = {}): PipenzoPhaseEventV1 {
  return {
    sequence: 0,
    ticketId: TICKET_ID,
    fromLane: 'working',
    toLane: 'working',
    phase: 'implement',
    labels: ['pipenzo:working'],
    ...overrides,
  } as PipenzoPhaseEventV1;
}

const status = () => screen.getByTestId('status').textContent;
const live = () => screen.getByTestId('live').textContent;

afterEach(() => {
  clearBridgeOverride();
});

describe('useTicketRunControls', () => {
  it('starts loading, then reports a live run', async () => {
    installBridge({
      runStatusPipenzo: vi.fn().mockResolvedValue({
        live: true,
        sessionId: 'session-1',
        tier: 'mid',
        model: 'claude-sonnet',
        branch: 'issue-94',
        commitCount: 2,
      } satisfies PipenzoRunStatusResultV1),
    });
    render(<Probe ticketId={TICKET_ID} />);

    expect(status()).toBe('loading');
    await waitFor(() => expect(status()).toBe('ready'));
    expect(live()).toBe('true');
  });

  it('reports live: false for a ticket with no running session', async () => {
    installBridge({ runStatusPipenzo: vi.fn().mockResolvedValue({ live: false }) });
    render(<Probe ticketId={TICKET_ID} />);
    await waitFor(() => expect(status()).toBe('ready'));
    expect(live()).toBe('false');
  });

  it('reports error rather than a stale answer when the daemon refuses the call', async () => {
    installBridge({ runStatusPipenzo: vi.fn().mockRejectedValue(new Error('daemon is not ready yet')) });
    render(<Probe ticketId={TICKET_ID} />);
    await waitFor(() => expect(status()).toBe('error'));
  });

  it('re-reads on a live phase event for this ticket', async () => {
    const runStatusPipenzo = vi
      .fn()
      .mockResolvedValueOnce({ live: false })
      .mockResolvedValue({
        live: true,
        sessionId: 'session-1',
        tier: 'mid',
        model: 'claude-sonnet',
        branch: 'issue-94',
        commitCount: 0,
      } satisfies PipenzoRunStatusResultV1);
    const { emitPhaseEvent } = installBridge({ runStatusPipenzo });
    render(<Probe ticketId={TICKET_ID} />);

    await waitFor(() => expect(live()).toBe('false'));
    emitPhaseEvent(phaseEvent());
    await waitFor(() => expect(live()).toBe('true'));
  });

  it('ignores a live phase event for a different ticket', async () => {
    const runStatusPipenzo = vi.fn().mockResolvedValue({ live: false });
    const { emitPhaseEvent } = installBridge({ runStatusPipenzo });
    render(<Probe ticketId={TICKET_ID} />);
    await waitFor(() => expect(status()).toBe('ready'));
    runStatusPipenzo.mockClear();

    emitPhaseEvent(phaseEvent({ ticketId: '00000000-0000-4000-8000-000000000002' }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(runStatusPipenzo).not.toHaveBeenCalled();
  });

  it('steer() delivers the instruction through the bridge, addressed by ticket id', async () => {
    const steerPipenzo = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
    installBridge({ runStatusPipenzo: vi.fn().mockResolvedValue({ live: false }), steerPipenzo });
    render(<Probe ticketId={TICKET_ID} />);
    await waitFor(() => expect(status()).toBe('ready'));

    screen.getByText('steer').click();

    await waitFor(() =>
      expect(steerPipenzo).toHaveBeenCalledWith({
        ticketId: TICKET_ID,
        instruction: 'leave the fixture alone',
      }),
    );
  });

  it('stop() calls the bridge and refreshes this ticket’s own status afterward', async () => {
    const runStatusPipenzo = vi
      .fn()
      .mockResolvedValueOnce({
        live: true,
        sessionId: 'session-1',
        tier: 'mid',
        model: 'claude-sonnet',
        branch: 'issue-94',
        commitCount: 1,
      } satisfies PipenzoRunStatusResultV1)
      .mockResolvedValue({ live: false });
    const stopPipenzo = vi.fn().mockResolvedValue({
      worktreeId: '11111111-1111-4111-8111-111111111111',
      branch: 'issue-94',
      commitCount: 1,
      label: 'pipenzo:needs-human',
    } satisfies PipenzoStopResultV1);
    installBridge({ runStatusPipenzo, stopPipenzo });
    render(<Probe ticketId={TICKET_ID} />);
    await waitFor(() => expect(live()).toBe('true'));

    screen.getByText('stop').click();

    await waitFor(() => expect(stopPipenzo).toHaveBeenCalledWith({ ticketId: TICKET_ID }));
    await waitFor(() => expect(live()).toBe('false'));
  });
});
