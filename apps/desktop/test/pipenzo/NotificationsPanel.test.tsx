import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoNotificationSettingsV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { NotificationsPanel } from '../../src/pipenzo/NotificationsPanel.js';

const settings = (
  overrides: Partial<PipenzoNotificationSettingsV1> = {},
): PipenzoNotificationSettingsV1 => ({
  schemaVersion: 1,
  refusal: true,
  medium: true,
  badge: true,
  sound: false,
  ...overrides,
});

function installBridge(
  options: {
    settings?: PipenzoNotificationSettingsV1;
    readRejects?: boolean;
    updateNotificationSettings?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const pipenzoUpdateNotificationSettings =
    options.updateNotificationSettings ??
    vi.fn(async (input: Partial<PipenzoNotificationSettingsV1>) => ({
      ...(options.settings ?? settings()),
      ...input,
    }));
  const bridge = {
    pipenzoNotificationSettings: options.readRejects
      ? vi.fn().mockRejectedValue(new Error('daemon is not ready yet'))
      : vi.fn().mockResolvedValue(options.settings ?? settings()),
    pipenzoUpdateNotificationSettings,
  };
  setBridgeOverride(bridge as never);
  return bridge;
}

afterEach(() => {
  cleanup();
  clearBridgeOverride();
});

const loaded = () => screen.findByText('HIGH-risk approvals');

describe('NotificationsPanel', () => {
  it('shows all five rows once loaded', async () => {
    installBridge();
    render(<NotificationsPanel />);
    await loaded();

    expect(screen.getByText('HIGH-risk approvals')).toBeInTheDocument();
    expect(screen.getByText('A refusal, or a stack awaiting sign-off')).toBeInTheDocument();
    expect(screen.getByText('A MEDIUM still blocking after 60 seconds')).toBeInTheDocument();
    expect(screen.getByText('Tray badge when a ticket needs me')).toBeInTheDocument();
    expect(screen.getByText('Sound')).toBeInTheDocument();
  });

  it('states the two non-configurable invariants as fixed informational text, not toggles', async () => {
    installBridge();
    render(<NotificationsPanel />);
    await loaded();

    const notice = await screen.findByText('Two things here are not settings');
    expect(notice).toBeInTheDocument();
    expect(
      screen.getByText(/LOW actions never notify/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/nothing that leaves the machine can be auto-allowed at any risk level/i),
    ).toBeInTheDocument();
    // The notice renders as text, with no switch inside it anywhere.
    const noticeContainer = notice.closest('.notice');
    expect(noticeContainer?.querySelector('[role="switch"]')).toBeNull();
  });

  describe('the HIGH row', () => {
    it('renders always on, locked, and disabled', async () => {
      installBridge();
      render(<NotificationsPanel />);
      await loaded();

      const toggle = screen.getByRole('switch', { name: /HIGH-risk approvals/i });
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(toggle).toBeDisabled();
      expect(toggle).toHaveClass('toggle', 'on');
      expect(screen.getByText('always on')).toBeInTheDocument();
    });

    it('cannot be switched off by a click -- a disabled button fires no onClick at all', async () => {
      const bridge = installBridge();
      render(<NotificationsPanel />);
      await loaded();

      const toggle = screen.getByRole('switch', { name: /HIGH-risk approvals/i });
      fireEvent.click(toggle);
      fireEvent.click(toggle);

      // Still on, and no write of any kind was ever attempted for it.
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(bridge.pipenzoUpdateNotificationSettings).not.toHaveBeenCalled();
    });

    it('cannot be switched off by a keyboard activation either', async () => {
      const bridge = installBridge();
      render(<NotificationsPanel />);
      await loaded();

      const toggle = screen.getByRole('switch', { name: /HIGH-risk approvals/i });
      toggle.focus();
      fireEvent.keyDown(toggle, { key: 'Enter', code: 'Enter' });
      fireEvent.keyUp(toggle, { key: ' ', code: 'Space' });

      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(bridge.pipenzoUpdateNotificationSettings).not.toHaveBeenCalled();
    });

    it('stays locked on even if a daemon read somehow answered with refusal/medium/badge/sound all false', async () => {
      // The wire schema has no `high` field at all, so there is no value this panel could read for
      // it even from a malformed response -- the row is rendered from a literal `locked` prop, never
      // from `settings.high`. This confirms that holds regardless of what the *other* four fields
      // say.
      installBridge({ settings: settings({ refusal: false, medium: false, badge: false, sound: false }) });
      render(<NotificationsPanel />);
      await loaded();

      const toggle = screen.getByRole('switch', { name: /HIGH-risk approvals/i });
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(toggle).toBeDisabled();
    });
  });

  it('toggling the refusal row saves exactly that field', async () => {
    const bridge = installBridge({ settings: settings({ refusal: true }) });
    render(<NotificationsPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('switch', { name: /A refusal, or a stack awaiting sign-off/i }));

    await waitFor(() =>
      expect(bridge.pipenzoUpdateNotificationSettings).toHaveBeenCalledWith({ refusal: false }),
    );
  });

  it('toggling the medium row saves exactly that field', async () => {
    const bridge = installBridge({ settings: settings({ medium: true }) });
    render(<NotificationsPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('switch', { name: /A MEDIUM still blocking after 60 seconds/i }));

    await waitFor(() =>
      expect(bridge.pipenzoUpdateNotificationSettings).toHaveBeenCalledWith({ medium: false }),
    );
  });

  it('toggling the badge row saves exactly that field', async () => {
    const bridge = installBridge({ settings: settings({ badge: true }) });
    render(<NotificationsPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('switch', { name: /Tray badge when a ticket needs me/i }));

    await waitFor(() =>
      expect(bridge.pipenzoUpdateNotificationSettings).toHaveBeenCalledWith({ badge: false }),
    );
  });

  it('toggling the sound row saves exactly that field', async () => {
    const bridge = installBridge({ settings: settings({ sound: false }) });
    render(<NotificationsPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('switch', { name: 'Sound' }));

    await waitFor(() =>
      expect(bridge.pipenzoUpdateNotificationSettings).toHaveBeenCalledWith({ sound: true }),
    );
  });

  it('reports a failed read as unread, and offers a retry', async () => {
    const bridge = installBridge({ readRejects: true });
    render(<NotificationsPanel />);

    expect(await screen.findByText(/could not read your notification settings/i)).toBeVisible();

    bridge.pipenzoNotificationSettings.mockResolvedValue(settings());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await loaded();
    expect(bridge.pipenzoNotificationSettings).toHaveBeenCalledTimes(2);
  });

  it('reverts the toggle and reports the failure when a save is refused', async () => {
    const updateNotificationSettings = vi
      .fn()
      .mockRejectedValue(new Error('could not reach the daemon'));
    installBridge({ settings: settings({ sound: false }), updateNotificationSettings });
    render(<NotificationsPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('switch', { name: 'Sound' }));

    expect(await screen.findByText('Could not save that setting')).toBeVisible();
    expect(screen.getByText('could not reach the daemon')).toBeVisible();
    // Reverted to the last confirmed value -- never left showing a preference the daemon refused.
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Sound' })).toHaveAttribute('aria-checked', 'false'),
    );
  });

  it('will not start a second save while one is already in flight', async () => {
    let release: ((value: PipenzoNotificationSettingsV1) => void) | undefined;
    const updateNotificationSettings = vi.fn(
      () =>
        new Promise<PipenzoNotificationSettingsV1>((resolve) => {
          release = resolve;
        }),
    );
    installBridge({ settings: settings({ sound: false }), updateNotificationSettings });
    render(<NotificationsPanel />);
    await loaded();

    const sound = screen.getByRole('switch', { name: 'Sound' });
    act(() => {
      fireEvent.click(sound);
      fireEvent.click(sound);
    });

    expect(updateNotificationSettings).toHaveBeenCalledTimes(1);
    release?.(settings({ sound: true }));
    await waitFor(() => expect(sound).toHaveAttribute('aria-checked', 'true'));
  });
});
