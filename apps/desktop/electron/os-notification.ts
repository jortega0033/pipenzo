import type { BrowserWindow, Notification as ElectronNotification } from 'electron';

/**
 * The four -- and only four -- moments the canvas's "native OS notification" specimen
 * (Foundations.dc.html, "Notices" section) allows to reach the operating system: a HIGH-risk
 * approval, a refusal, a multi-PR stack awaiting sign-off, and one late arrival -- a MEDIUM still
 * blocking after 60 seconds. That list is the whole definition of "awaiting input" the canvas
 * gives: nothing is running, and nothing will run, until a person answers. LOW never notifies at
 * all -- there is deliberately no member of this union for it, so there is no way to call
 * `sendOsNotification` for a LOW action short of widening this type.
 *
 * *When* a MEDIUM has been pending 60 seconds, or when cumulative risk promotes an action to
 * HIGH, is a decision this module does not make -- that belongs to the risk classifier
 * (tracked separately, issues #157/#158, not yet built). This module is the adapter: given that a
 * caller has already decided one of these four things is true, it is the one and only path by
 * which that reaches the OS, and it enforces the shape of what leaves (title, body, at most two
 * actions, neither of which approves anything) rather than the policy of when to call it.
 */
export type OsNotificationKind = 'high-approval' | 'refusal' | 'stack-signoff' | 'medium-late';

export interface OsNotificationAction {
  /** The button's label, e.g. "Open pipenzo" / "Dismiss" -- the canvas's own two actions. */
  text: string;
  /**
   * Never approves or refuses anything by itself -- every action the canvas shows on the
   * specimen (Open pipenzo, Dismiss) only focuses the app or discards the notification. The
   * actual approve/refuse decision happens back on the card, once a person is looking at it,
   * which is exactly why this adapter has no concept of an "approve" action at all.
   */
  onClick: () => void;
}

export interface OsNotificationInput {
  kind: OsNotificationKind;
  /** The ticket number and what is wanted, in that order -- often the only line read from a lock screen. */
  title: string;
  /** Enough to decide whether to switch, never a repeat of the title. */
  body: string;
  /** At most two, matching the canvas's own osn-acts sample. */
  actions: OsNotificationAction[];
}

export interface OsNotificationDeps {
  /** Injected so a test can supply a fake without touching the real OS notification center. */
  NotificationCtor: typeof ElectronNotification;
  /** Resolved lazily -- the main window may not exist yet, or may since have been destroyed. */
  getMainWindow: () => BrowserWindow | undefined;
}

/**
 * Sends one native OS notification via Electron's `Notification` API and wires click-to-focus
 * routing: clicking the notification body, or one of its action buttons, brings the main window
 * to the front (restoring it first if minimized) in addition to running that action's own
 * `onClick`. The app has a title, a body and up to two actions, and no control over anything
 * else the OS surface does -- see the canvas's own note that this is "not a fourth notice
 * altitude" but the operating system's own surface.
 *
 * Electron's per-notification action *buttons* (as opposed to the notification itself being
 * clickable) are macOS-only (https://www.electronjs.org/docs/latest/api/notification); on other
 * platforms the actions array still documents intent but only the notification-level click
 * reaches `getMainWindow()`. That's a platform limitation of Electron's Notification API, not a
 * gap in this adapter.
 */
export function sendOsNotification(input: OsNotificationInput, deps: OsNotificationDeps): void {
  if (input.actions.length > 2) {
    throw new Error(
      `sendOsNotification: at most two actions are allowed, got ${input.actions.length} for "${input.title}"`,
    );
  }

  const notification = new deps.NotificationCtor({
    title: input.title,
    body: input.body,
    actions: input.actions.map((action) => ({ type: 'button' as const, text: action.text })),
  });

  const focus = () => focusMainWindow(deps.getMainWindow());

  notification.on('click', focus);
  notification.on('action', (_event, index) => {
    input.actions[index]?.onClick();
    focus();
  });

  notification.show();
}

function focusMainWindow(window: BrowserWindow | undefined): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
