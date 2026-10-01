import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoPhaseEventV1, PipenzoRunStatusResultV1, PipenzoStopResultV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { RunControlsPanel } from '../../src/pipenzo/RunControlsPanel.js';

const TICKET_ID = '00000000-0000-4000-8000-000000000001';

function installBridge(options: {
  runStatusPipenzo: ReturnType<typeof vi.fn>;
  steerPipenzo?: ReturnType<typeof vi.fn>;
  stopPipenzo?: ReturnType<typeof vi.fn>;
}) {
  setBridgeOverride({
    runStatusPipenzo: options.runStatusPipenzo,
    steerPipenzo: options.steerPipenzo ?? vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    stopPipenzo:
      options.stopPipenzo ??
      vi.fn().mockResolvedValue({
        worktreeId: '11111111-1111-4111-8111-111111111111',
        branch: 'issue-94',
        commitCount: 3,
        label: 'pipenzo:needs-human',
      } satisfies PipenzoStopResultV1),
    onDaemonStatus: () => vi.fn(),
    onPipenzoPhaseEvent: (_callback: (event: PipenzoPhaseEventV1) => void) => vi.fn(),
  } as never);
}

afterEach(() => {
  clearBridgeOverride();
});

const liveStatus = (overrides: Partial<PipenzoRunStatusResultV1> = {}): PipenzoRunStatusResultV1 =>
  ({
    live: true,
    sessionId: 'session-1',
    tier: 'mid',
    model: 'claude-sonnet',
    branch: 'issue-94',
    commitCount: 2,
    ...overrides,
  }) as PipenzoRunStatusResultV1;

describe('RunControlsPanel', () => {
  it('renders nothing for a ticket with no live session', async () => {
    installBridge({ runStatusPipenzo: vi.fn().mockResolvedValue({ live: false }) });
    const { container } = render(<RunControlsPanel ticketId={TICKET_ID} />);
    await waitFor(() => expect(container).not.toHaveTextContent('loading'));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the live state with real model/tier/commit/branch data once a session is genuinely running', async () => {
    installBridge({ runStatusPipenzo: vi.fn().mockResolvedValue(liveStatus()) });
    render(<RunControlsPanel ticketId={TICKET_ID} />);

    await waitFor(() => expect(screen.getByText('Implement is running')).toBeInTheDocument());
    expect(screen.getByText(/claude-sonnet/)).toBeInTheDocument();
    expect(screen.getByText(/2 commits on issue-94, nothing pushed/)).toBeInTheDocument();
    expect(screen.getByText('Steer')).toBeInTheDocument();
    expect(screen.getByText('Stop')).toBeInTheDocument();
  });

  it('Steer opens the steer panel and Send delivers the instruction without ever calling Stop', async () => {
    const steerPipenzo = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
    installBridge({ runStatusPipenzo: vi.fn().mockResolvedValue(liveStatus()), steerPipenzo });
    render(<RunControlsPanel ticketId={TICKET_ID} />);
    await waitFor(() => expect(screen.getByText('Steer')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Steer'));
    expect(screen.getByText('Steer the run')).toBeInTheDocument();
    const textarea = screen.getByPlaceholderText('e.g. leave the legacy fixture alone for now');
    fireEvent.change(textarea, { target: { value: 'skip the flaky fixture for now' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() =>
      expect(steerPipenzo).toHaveBeenCalledWith({
        ticketId: TICKET_ID,
        instruction: 'skip the flaky fixture for now',
      }),
    );
    // Back to the live view -- Steer is a runtime nudge, never a navigation away from "live".
    expect(screen.getByText('Implement is running')).toBeInTheDocument();
  });

  it('Cancel on the steer panel returns to live without sending anything', async () => {
    const steerPipenzo = vi.fn();
    installBridge({ runStatusPipenzo: vi.fn().mockResolvedValue(liveStatus()), steerPipenzo });
    render(<RunControlsPanel ticketId={TICKET_ID} />);
    await waitFor(() => expect(screen.getByText('Steer')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Steer'));
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.getByText('Implement is running')).toBeInTheDocument();
    expect(steerPipenzo).not.toHaveBeenCalled();
  });

  it('Stop opens the confirm panel naming the real commit count and branch, and Keep running cancels it', async () => {
    const stopPipenzo = vi.fn();
    installBridge({ runStatusPipenzo: vi.fn().mockResolvedValue(liveStatus({ commitCount: 5 })), stopPipenzo });
    render(<RunControlsPanel ticketId={TICKET_ID} />);
    await waitFor(() => expect(screen.getByText('Stop')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Stop'));
    expect(screen.getByText('Stop this run?')).toBeInTheDocument();
    expect(screen.getByText(/The 5 commits already on/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Keep running'));
    expect(screen.getByText('Implement is running')).toBeInTheDocument();
    expect(stopPipenzo).not.toHaveBeenCalled();
  });

  it('confirming Stop calls the bridge once and then shows the stopped banner with the daemon’s own result', async () => {
    const runStatusPipenzo = vi
      .fn()
      .mockResolvedValueOnce(liveStatus({ commitCount: 4, branch: 'issue-94' }))
      .mockResolvedValue({ live: false });
    const stopPipenzo = vi.fn().mockResolvedValue({
      worktreeId: '11111111-1111-4111-8111-111111111111',
      branch: 'issue-94',
      commitCount: 4,
      label: 'pipenzo:needs-human',
    } satisfies PipenzoStopResultV1);
    installBridge({ runStatusPipenzo, stopPipenzo });
    render(<RunControlsPanel ticketId={TICKET_ID} />);
    await waitFor(() => expect(screen.getByText('Stop')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Stop'));
    fireEvent.click(screen.getByText('Stop and keep commits'));

    await waitFor(() => expect(stopPipenzo).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Stopped at/)).toBeInTheDocument());
    expect(screen.getByText(/4 commits kept on issue-94/)).toBeInTheDocument();
    expect(screen.getByText('pipenzo:needs-human')).toBeInTheDocument();
    // Never a second call -- the confirm panel is gone once the daemon's own result is shown.
    expect(stopPipenzo).toHaveBeenCalledTimes(1);
  });
});
