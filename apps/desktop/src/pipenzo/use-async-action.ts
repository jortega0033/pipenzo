import { useCallback, useRef, useState } from 'react';

/**
 * The pending-button state machine (issue #69) -- generic over any real daemon round trip.
 *
 * README's walking-skeleton screens (the Implement dialog's Start, DiffReview's Push branch/Push
 * & open PR) all share one shape the canvas already names: a button holds `.btn.pending` from the
 * click until the daemon has confirmed the thing actually happened -- never a fixed-duration
 * spinner, never optimistic. This hook is that shape, decoupled from which daemon call it wraps:
 * `run()` takes the actual async work (one `await` or several chained ones -- see
 * `ImplementDialog.tsx`'s Start handler, which chains a worktree preview and a worktree create as
 * two real round trips under one pending state) and the hook tracks `status`/`error` around it.
 *
 * `retry()` re-invokes the last `run()` call with the same arguments -- the canvas's Push/Retry
 * pattern: a failed publish leaves the branch exactly as it was (publish-service.ts never leaves
 * partial state on a thrown error), so the correct recovery is "try the identical action again",
 * not a form reset.
 */
export type AsyncActionStatus = 'idle' | 'pending' | 'error';

export interface AsyncActionState<T> {
  readonly status: AsyncActionStatus;
  readonly error?: string;
  readonly result?: T;
  readonly pending: boolean;
  /** Runs `fn`, tracking pending/error state around it. Rejects are swallowed into `error` --
   * callers read `error`/`status` rather than wrapping every call site in try/catch. */
  run: (fn: () => Promise<T>) => Promise<T | undefined>;
  /** Re-runs the most recent `run()` call. A no-op if nothing has run yet. */
  retry: () => Promise<T | undefined>;
  reset: () => void;
}

export function useAsyncAction<T>(): AsyncActionState<T> {
  const [status, setStatus] = useState<AsyncActionStatus>('idle');
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<T>();
  const lastFnRef = useRef<(() => Promise<T>) | undefined>(undefined);
  // Guards against a stale response landing after a newer `run()` call already started (or after
  // unmount): only the most recently started call is allowed to commit its outcome to state.
  const callIdRef = useRef(0);

  const run = useCallback(async (fn: () => Promise<T>): Promise<T | undefined> => {
    lastFnRef.current = fn;
    const callId = (callIdRef.current += 1);
    setStatus('pending');
    setError(undefined);
    try {
      const value = await fn();
      if (callIdRef.current !== callId) return undefined;
      setResult(value);
      setStatus('idle');
      return value;
    } catch (caught) {
      if (callIdRef.current !== callId) return undefined;
      setStatus('error');
      setError(caught instanceof Error ? caught.message : 'the request failed');
      return undefined;
    }
  }, []);

  const retry = useCallback((): Promise<T | undefined> => {
    const fn = lastFnRef.current;
    if (!fn) return Promise.resolve(undefined);
    return run(fn);
  }, [run]);

  const reset = useCallback(() => {
    callIdRef.current += 1;
    setStatus('idle');
    setError(undefined);
    setResult(undefined);
  }, []);

  return { status, error, result, pending: status === 'pending', run, retry, reset };
}
