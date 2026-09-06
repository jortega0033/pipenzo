import type { BrowserWindow, Notification as ElectronNotification } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { sendOsNotification, type OsNotificationAction } from '../electron/os-notification.js';

/** A minimal fake standing in for Electron's Notification -- constructor options captured,
 * `on`/`show` recorded, and `emit` lets a test simulate the OS delivering a click or an action. */
class FakeNotification {
  static instances: FakeNotification[] = [];

  options: unknown;
  shown = false;
  listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  constructor(options: unknown) {
    this.options = options;
    FakeNotification.instances.push(this);
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  show() {
    this.shown = true;
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function fakeWindow(overrides: Partial<BrowserWindow> = {}): BrowserWindow {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    ...overrides,
  } as unknown as BrowserWindow;
}

function deps(window: BrowserWindow | undefined) {
  return {
    NotificationCtor: FakeNotification as unknown as typeof ElectronNotification,
    getMainWindow: () => window,
  };
}

describe('sendOsNotification', () => {
  it('creates a Notification with the given title, body and action labels, then shows it', () => {
    FakeNotification.instances = [];
    const actions: OsNotificationAction[] = [
      { text: 'Open pipenzo', onClick: vi.fn() },
      { text: 'Dismiss', onClick: vi.fn() },
    ];
    sendOsNotification(
      { kind: 'high-approval', title: '#94 needs your approval', body: 'Push and open a PR.', actions },
      deps(fakeWindow()),
    );

    const notification = FakeNotification.instances[0]!;
    expect(notification.options).toEqual({
      title: '#94 needs your approval',
      body: 'Push and open a PR.',
      actions: [
        { type: 'button', text: 'Open pipenzo' },
        { type: 'button', text: 'Dismiss' },
      ],
    });
    expect(notification.shown).toBe(true);
  });

  it('rejects more than two actions', () => {
    expect(() =>
      sendOsNotification(
        {
          kind: 'refusal',
          title: 'T',
          body: 'B',
          actions: [
            { text: 'One', onClick: vi.fn() },
            { text: 'Two', onClick: vi.fn() },
            { text: 'Three', onClick: vi.fn() },
          ],
        },
        deps(fakeWindow()),
      ),
    ).toThrow(/at most two actions/);
  });

  it('focuses and shows the main window when the notification body is clicked', () => {
    FakeNotification.instances = [];
    const window = fakeWindow();
    sendOsNotification({ kind: 'refusal', title: 'T', body: 'B', actions: [] }, deps(window));

    FakeNotification.instances[0]!.emit('click', {});

    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.restore).not.toHaveBeenCalled();
  });

  it('restores a minimized window before focusing it', () => {
    FakeNotification.instances = [];
    const window = fakeWindow({ isMinimized: () => true });
    sendOsNotification({ kind: 'stack-signoff', title: 'T', body: 'B', actions: [] }, deps(window));

    FakeNotification.instances[0]!.emit('click', {});

    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the main window is gone or destroyed', () => {
    FakeNotification.instances = [];
    sendOsNotification({ kind: 'medium-late', title: 'T', body: 'B', actions: [] }, deps(undefined));
    expect(() => FakeNotification.instances[0]!.emit('click', {})).not.toThrow();

    const destroyed = fakeWindow({ isDestroyed: () => true });
    sendOsNotification({ kind: 'medium-late', title: 'T', body: 'B', actions: [] }, deps(destroyed));
    FakeNotification.instances[1]!.emit('click', {});
    expect(destroyed.show).not.toHaveBeenCalled();
  });

  it('runs the clicked action handler and then focuses the window', () => {
    FakeNotification.instances = [];
    const onClick = vi.fn();
    const window = fakeWindow();
    sendOsNotification(
      {
        kind: 'high-approval',
        title: 'T',
        body: 'B',
        actions: [
          { text: 'Open pipenzo', onClick },
          { text: 'Dismiss', onClick: vi.fn() },
        ],
      },
      deps(window),
    );

    FakeNotification.instances[0]!.emit('action', {}, 0);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });
});
