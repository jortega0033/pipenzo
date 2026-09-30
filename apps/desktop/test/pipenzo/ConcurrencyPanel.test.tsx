import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoConcurrencySettingsV1, PipenzoTicketViewV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { ConcurrencyPanel } from '../../src/pipenzo/ConcurrencyPanel.js';

const settings = (
  overrides: Partial<PipenzoConcurrencySettingsV1> = {},
): PipenzoConcurrencySettingsV1 => ({
  schemaVersion: 1,
  executionLimit: 2,
  runBudget: 'unlimited',
  ...overrides,
});

function installBridge(
  options: {
    settings?: PipenzoConcurrencySettingsV1;
    readRejects?: boolean;
    updateConcurrencySettings?: ReturnType<typeof vi.fn>;
    tickets?: readonly PipenzoTicketViewV1[];
    workingLaneCapacity?: number;
  } = {},
) {
  const pipenzoUpdateConcurrencySettings =
    options.updateConcurrencySettings ??
    vi.fn(async (input: Partial<PipenzoConcurrencySettingsV1>) => ({
      ...(options.settings ?? settings()),
      ...input,
    }));
  const bridge = {
    pipenzoConcurrencySettings: options.readRejects
      ? vi.fn().mockRejectedValue(new Error('daemon is not ready yet'))
      : vi.fn().mockResolvedValue(options.settings ?? settings()),
    pipenzoUpdateConcurrencySettings,
    pipenzoListTickets: vi.fn().mockResolvedValue({
      tickets: options.tickets ?? [],
      workingLaneCapacity: options.workingLaneCapacity ?? 2,
    }),
    onDaemonStatus: () => () => {},
    onPipenzoPhaseEvent: () => () => {},
  };
  setBridgeOverride(bridge as never);
  return bridge;
}

afterEach(() => {
  cleanup();
  clearBridgeOverride();
});

const loaded = () => screen.findByText('Execution limit');

describe('ConcurrencyPanel', () => {
  it('shows the current execution limit and run budget once loaded', async () => {
    installBridge({ settings: settings({ executionLimit: 3, runBudget: 'three_runs' }) });
    render(<ConcurrencyPanel />);
    await loaded();

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /workspace default run budget/i })).toHaveValue(
      'three_runs',
    );
  });

  it('reports a failed read as unread, and offers a retry', async () => {
    const bridge = installBridge({ readRejects: true });
    render(<ConcurrencyPanel />);

    expect(await screen.findByText(/could not read your concurrency settings/i)).toBeVisible();

    bridge.pipenzoConcurrencySettings.mockResolvedValue(settings());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await loaded();
    expect(bridge.pipenzoConcurrencySettings).toHaveBeenCalledTimes(2);
  });

  it('increasing the stepper saves the new execution limit', async () => {
    const bridge = installBridge({ settings: settings({ executionLimit: 2 }) });
    render(<ConcurrencyPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: 'Increase' }));

    await waitFor(() =>
      expect(bridge.pipenzoUpdateConcurrencySettings).toHaveBeenCalledWith({ executionLimit: 3 }),
    );
    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
  });

  it('disables the decrease control at the hard floor of 1, never going below it', async () => {
    installBridge({ settings: settings({ executionLimit: 1 }) });
    render(<ConcurrencyPanel />);
    await loaded();

    expect(screen.getByRole('button', { name: 'Decrease' })).toBeDisabled();
  });

  it('disables the increase control at the hard cap of 4, never exceeding it', async () => {
    installBridge({ settings: settings({ executionLimit: 4 }) });
    render(<ConcurrencyPanel />);
    await loaded();

    expect(screen.getByRole('button', { name: 'Increase' })).toBeDisabled();
  });

  it('changing the run-budget select saves the new choice', async () => {
    const bridge = installBridge({ settings: settings({ runBudget: 'unlimited' }) });
    render(<ConcurrencyPanel />);
    await loaded();

    fireEvent.change(screen.getByRole('combobox', { name: /workspace default run budget/i }), {
      target: { value: 'cap_200k_tokens' },
    });

    await waitFor(() =>
      expect(bridge.pipenzoUpdateConcurrencySettings).toHaveBeenCalledWith({
        runBudget: 'cap_200k_tokens',
      }),
    );
  });

  it('reverts the stepper and reports the failure when a save is refused', async () => {
    const updateConcurrencySettings = vi
      .fn()
      .mockRejectedValue(new Error('workspace execution limit reached'));
    installBridge({ settings: settings({ executionLimit: 2 }), updateConcurrencySettings });
    render(<ConcurrencyPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: 'Increase' }));

    expect(await screen.findByText(/could not save that setting/i)).toBeVisible();
    // Reverted to the last confirmed value -- never left showing a number the daemon refused.
    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());
  });

  it('will not start a second save while one is already in flight', async () => {
    let release: ((value: PipenzoConcurrencySettingsV1) => void) | undefined;
    const updateConcurrencySettings = vi.fn(
      () =>
        new Promise<PipenzoConcurrencySettingsV1>((resolve) => {
          release = resolve;
        }),
    );
    installBridge({ settings: settings({ executionLimit: 2 }), updateConcurrencySettings });
    render(<ConcurrencyPanel />);
    await loaded();

    const increase = screen.getByRole('button', { name: 'Increase' });
    act(() => {
      fireEvent.click(increase);
      fireEvent.click(increase);
    });

    expect(updateConcurrencySettings).toHaveBeenCalledTimes(1);
    release?.(settings({ executionLimit: 3 }));
    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
  });

  it('reads the live capacity readout off the same ticket data the board uses', async () => {
    const running = (id: string, issueNumber: number): PipenzoTicketViewV1 =>
      ({
        schemaVersion: 1,
        ticketId: id,
        issueNumber,
        lane: 'working',
        concurrency: { state: 'running' },
      }) as unknown as PipenzoTicketViewV1;
    const held = (id: string, issueNumber: number): PipenzoTicketViewV1 =>
      ({
        schemaVersion: 1,
        ticketId: id,
        issueNumber,
        lane: 'working',
        concurrency: {
          state: 'held',
          overlapTicketId: 'ticket-a',
          overlapIssueNumber: 1,
          overlapFile: 'src/shared.ts',
        },
      }) as unknown as PipenzoTicketViewV1;

    installBridge({
      settings: settings({ executionLimit: 2 }),
      workingLaneCapacity: 2,
      tickets: [running('ticket-a', 1), running('ticket-b', 2), held('ticket-c', 3)],
    });
    render(<ConcurrencyPanel />);
    await loaded();

    expect(await screen.findByText(/2 of 2 running/i)).toBeInTheDocument();
    expect(await screen.findByText(/1 held/i)).toBeInTheDocument();
  });

  it('never lets the two run-budget copies apart -- the panel names issue #143 rather than promising enforcement', async () => {
    installBridge({ settings: settings() });
    render(<ConcurrencyPanel />);
    await loaded();

    expect(screen.getByText(/not enforced yet/i)).toBeInTheDocument();
  });
});
