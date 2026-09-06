import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

export type ToastTone = 'neutral' | 'ok' | 'warn' | 'danger';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastData {
  id: string;
  tone?: ToastTone;
  icon: IconName;
  title: string;
  /** The .t-sub line -- a repo/branch/file count, a short reason, etc. */
  description?: ReactNode;
  /** One action max, matching the canvas's own toast row (a single .btn.sm). */
  action?: ToastAction;
}

export type ToastInput = Omit<ToastData, 'id'>;

/**
 * One toast row, from Foundations.dc.html's "Notices" section: the corner, transient altitude,
 * 360px wide, same four tones as Banner/Notice living in the 24px .t-ic circle. Presentational --
 * ToastStack below owns the stack-limit/queueing and auto-dismiss policy.
 */
export function Toast({ tone = 'neutral', icon, title, description, action }: ToastInput) {
  const classes = ['toast'];
  if (tone !== 'neutral') classes.push(tone);

  return (
    <div className={classes.join(' ')} role="status">
      <span className="t-ic">
        <Icon name={icon} size="sm" />
      </span>
      <span className="t-body">
        <span className="t-title">{title}</span>
        {description && <span className="t-sub">{description}</span>}
      </span>
      {action && (
        <button type="button" className="btn sm" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/**
 * The fixed bottom-right stack (.toast-stack), rendering visible toasts oldest-first so the
 * newest one lands lowest on screen, matching "newest at the bottom" without a reversed stacking
 * order. Wraps each toast's action (if any) so clicking it both runs the caller's handler and
 * dismisses that toast -- an actioned toast is meant to go away once its action is taken, not
 * linger for a separate close click the canvas never shows.
 */
export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          tone={toast.tone}
          icon={toast.icon}
          title={toast.title}
          description={toast.description}
          action={
            toast.action && {
              label: toast.action.label,
              onClick: () => {
                toast.action!.onClick();
                onDismiss(toast.id);
              },
            }
          }
        />
      ))}
    </div>
  );
}

/**
 * Stack-limit and queueing policy for the toast system: at most `limit` toasts are visible at
 * once (default 3); a `push` beyond that queues instead of overflowing the stack, and the oldest
 * queued toast is promoted into the freed slot as soon as one dismisses. A toast with no `action`
 * auto-dismisses after `autoDismissMs` (default 6000ms, the canvas's "6s unless it carries an
 * action"); one that does carry an action only leaves via that action (see ToastStack) or an
 * explicit `dismiss` call.
 */
export function useToastStack({
  limit = 3,
  autoDismissMs = 6000,
}: { limit?: number; autoDismissMs?: number } = {}) {
  const [visible, setVisible] = useState<ToastData[]>([]);
  const queueRef = useRef<ToastData[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const nextId = useRef(0);

  const clearTimer = (id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  };

  const dismiss = useCallback((id: string) => {
    clearTimer(id);
    setVisible((current) => {
      if (!current.some((toast) => toast.id === id)) return current;
      const next = current.filter((toast) => toast.id !== id);
      const promoted = queueRef.current.shift();
      return promoted ? [...next, promoted] : next;
    });
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const id = `toast-${nextId.current++}`;
      const toast: ToastData = { ...input, id };
      setVisible((current) => {
        if (current.length >= limit) {
          queueRef.current.push(toast);
          return current;
        }
        return [...current, toast];
      });
      return id;
    },
    [limit],
  );

  // Schedule (or clear) the 6s auto-dismiss for every visible toast that doesn't carry an action.
  useEffect(() => {
    const visibleIds = new Set(visible.map((toast) => toast.id));
    for (const id of Array.from(timers.current.keys())) {
      if (!visibleIds.has(id)) clearTimer(id);
    }
    for (const toast of visible) {
      if (toast.action || timers.current.has(toast.id)) continue;
      const timer = setTimeout(() => dismiss(toast.id), autoDismissMs);
      timers.current.set(toast.id, timer);
    }
  }, [visible, autoDismissMs, dismiss]);

  useEffect(() => {
    const timerMap = timers.current;
    return () => {
      timerMap.forEach((timer) => clearTimeout(timer));
      timerMap.clear();
    };
  }, []);

  return { visible, push, dismiss };
}
