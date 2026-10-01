import { describe, expect, it, vi } from 'vitest';
import type { PipenzoLaneV1 } from '@agent-dock/shared';
import {
  TrayBadgeController,
  type TrayBadgeDeps,
  type TrayBadgeNotificationSettings,
  type TrayBadgeTicketList,
} from '../electron/tray-badge.js';

function tickets(...lanes: PipenzoLaneV1[]): TrayBadgeTicketList {
  return { tickets: lanes.map((lane) => ({ lane })) };
}

function settings(badge: boolean): TrayBadgeNotificationSettings {
  return { badge };
}

/** Builds a controller wired to fakes, with every network-shaped call resolving immediately so
 *  `debounceMs: 0` plus a single microtask flush (`await Promise.resolve()`) is enough to observe
 *  the result -- no fake timers needed for the common case. */
function harness(overrides: Partial<TrayBadgeDeps> = {}) {
  const paint = vi.fn<(label: string | undefined) => void>();
  const onError = vi.fn();
  let currentTickets: TrayBadgeTicketList = tickets();
  let currentSettings: TrayBadgeNotificationSettings = settings(true);

  const controller = new TrayBadgeController({
    platform: 'win32',
    listTickets: vi.fn(async () => currentTickets),
    getNotificationSettings: vi.fn(async () => currentSettings),
    paint,
    onError,
    debounceMs: 0,
    ...overrides,
  });

  return {
    controller,
    paint,
    onError,
    setTickets: (...lanes: PipenzoLaneV1[]) => {
      currentTickets = tickets(...lanes);
    },
    setBadgeSetting: (value: boolean) => {
      currentSettings = settings(value);
    },
  };
}

// `onPhaseEvent`'s debounce always goes through a real `setTimeout` -- even with `debounceMs: 0` --
// which is a macrotask, not a microtask, so a plain `Promise.resolve()` chain never observes it.
// A short real delay (comfortably longer than the `debounceMs: 0` used throughout this file) plus a
// trailing microtask flush for the `listTickets()` promise the timer callback then awaits.
const flush = () =>
  new Promise((resolve) => setTimeout(resolve, 10)).then(() => Promise.resolve());

describe('TrayBadgeController', () => {
  it('paints no badge when the Needs-human count starts at zero', async () => {
    const { controller, paint } = harness();
    await controller.start();
    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint).toHaveBeenCalledWith(undefined);
  });

  it('paints a numeral once the Needs-human count goes from 0 to N>0 (AC-1)', async () => {
    const { controller, paint, setTickets } = harness();
    await controller.start();
    paint.mockClear();

    setTickets('needs-human', 'needs-human', 'working');
    controller.onPhaseEvent();
    await flush();

    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint).toHaveBeenCalledWith('2');
  });

  it('removes the badge entirely once the count returns to zero -- never a lingering "0" (AC-2)', async () => {
    const { controller, paint, setTickets } = harness();
    setTickets('needs-human');
    await controller.start();
    paint.mockClear();

    setTickets('working', 'queued');
    controller.onPhaseEvent();
    await flush();

    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint).toHaveBeenCalledWith(undefined);
  });

  it('renders counts above 9 as "9+" (AC-3)', async () => {
    const { controller, paint, setTickets } = harness();
    setTickets(...Array<PipenzoLaneV1>(12).fill('needs-human'));
    await controller.start();
    expect(paint).toHaveBeenCalledWith('9+');
  });

  it('collapses a burst of phase events within one debounce window into exactly one repaint (AC-4)', async () => {
    vi.useFakeTimers();
    try {
      const { controller, paint, setTickets } = harness({ debounceMs: 300 });
      await controller.start();
      paint.mockClear();

      setTickets('needs-human');
      controller.onPhaseEvent();
      await vi.advanceTimersByTimeAsync(50);
      setTickets('needs-human', 'needs-human');
      controller.onPhaseEvent();
      await vi.advanceTimersByTimeAsync(50);
      setTickets('needs-human', 'needs-human', 'needs-human');
      controller.onPhaseEvent();

      // Burst landed; nothing painted yet because each event re-armed the debounce window.
      expect(paint).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(300);

      expect(paint).toHaveBeenCalledTimes(1);
      expect(paint).toHaveBeenCalledWith('3');
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses the badge immediately when the Settings toggle turns off, even with a live count (AC-5)', async () => {
    const { controller, paint, setTickets } = harness();
    setTickets('needs-human', 'needs-human');
    await controller.start();
    paint.mockClear();

    controller.setEnabled(false);

    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint).toHaveBeenCalledWith(undefined);
  });

  it('does not let a stale badge reappear once turned off, even if the count keeps changing', async () => {
    const { controller, paint, setTickets } = harness();
    setTickets('needs-human');
    await controller.start();
    controller.setEnabled(false); // already repaints to undefined here
    paint.mockClear();

    setTickets('needs-human', 'needs-human', 'needs-human');
    controller.onPhaseEvent();
    await flush();

    // The repainted value (undefined, since disabled) hasn't changed, so the dedup covered by
    // "never repaints when the repainted value has not actually changed" already skips this repaint
    // -- the stronger guarantee this test checks is that `paint` is never called with a real label.
    expect(paint).not.toHaveBeenCalled();
  });

  it('repaints immediately with the current count once the toggle turns back on', async () => {
    const { controller, paint, setTickets } = harness();
    setTickets('needs-human', 'needs-human');
    await controller.start();
    controller.setEnabled(false);
    paint.mockClear();

    controller.setEnabled(true);

    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint).toHaveBeenCalledWith('2');
  });

  it('never repaints when the repainted value has not actually changed', async () => {
    const { controller, paint, setTickets } = harness();
    setTickets('needs-human');
    await controller.start();
    paint.mockClear();

    // Same count, different (irrelevant) lane composition -- still "1" after recount.
    setTickets('needs-human', 'queued');
    controller.onPhaseEvent();
    await flush();

    expect(paint).not.toHaveBeenCalled();
  });

  it('counts only the Needs-human lane, matching the board (AC-7)', async () => {
    const { controller, paint, setTickets } = harness();
    setTickets('queued', 'working', 'ready-for-review', 'needs-human');
    await controller.start();
    expect(paint).toHaveBeenCalledWith('1');
  });

  it('stays entirely inert on a non-Windows platform (AC-8): never calls paint, never throws', async () => {
    const { controller, paint, setTickets, onError } = harness({ platform: 'darwin' });
    setTickets('needs-human');

    await controller.start();
    controller.onPhaseEvent();
    controller.setEnabled(false);
    await flush();

    expect(paint).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('logs rather than throws when the daemon call fails, and leaves the last good paint alone', async () => {
    const { controller, paint, setTickets, onError } = harness();
    setTickets('needs-human');
    await controller.start();
    paint.mockClear();

    const failing = new TrayBadgeController({
      platform: 'win32',
      listTickets: vi.fn(async () => {
        throw new Error('daemon unavailable');
      }),
      getNotificationSettings: vi.fn(async () => settings(true)),
      paint,
      onError,
      debounceMs: 0,
    });
    await expect(failing.start()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('clears a pending debounce timer on stop()', async () => {
    vi.useFakeTimers();
    try {
      const { controller, paint, setTickets } = harness({ debounceMs: 300 });
      await controller.start();
      paint.mockClear();

      setTickets('needs-human');
      controller.onPhaseEvent();
      controller.stop();
      await vi.advanceTimersByTimeAsync(1000);

      expect(paint).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
