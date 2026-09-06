import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAsyncAction } from '../../src/pipenzo/use-async-action.js';

describe('useAsyncAction', () => {
  it('starts idle and transitions to pending for the duration of run()', async () => {
    const { result } = renderHook(() => useAsyncAction<string>());
    expect(result.current.status).toBe('idle');
    expect(result.current.pending).toBe(false);

    let resolveFn: (value: string) => void = () => {};
    const promise = new Promise<string>((resolve) => {
      resolveFn = resolve;
    });

    act(() => {
      void result.current.run(() => promise);
    });
    await waitFor(() => expect(result.current.pending).toBe(true));

    await act(async () => {
      resolveFn('done');
      await promise;
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.result).toBe('done');
  });

  it('moves to the error state with the failure message when the action rejects', async () => {
    const { result } = renderHook(() => useAsyncAction<string>());

    await act(async () => {
      await result.current.run(() => Promise.reject(new Error('push rejected')));
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('push rejected');
    expect(result.current.pending).toBe(false);
  });

  it('retry() re-invokes the exact same function that last ran', async () => {
    const { result } = renderHook(() => useAsyncAction<number>());
    let calls = 0;
    const flaky = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('first attempt failed')) : Promise.resolve(42);
    };

    await act(async () => {
      await result.current.run(flaky);
    });
    expect(result.current.status).toBe('error');

    await act(async () => {
      await result.current.retry();
    });
    expect(calls).toBe(2);
    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBe(42);
  });

  it('retry() is a no-op before anything has run', async () => {
    const { result } = renderHook(() => useAsyncAction<number>());
    await act(async () => {
      await result.current.retry();
    });
    expect(result.current.status).toBe('idle');
  });

  it('reset() clears status, error and result back to idle', async () => {
    const { result } = renderHook(() => useAsyncAction<string>());
    await act(async () => {
      await result.current.run(() => Promise.reject(new Error('boom')));
    });
    expect(result.current.status).toBe('error');

    act(() => result.current.reset());
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeUndefined();
  });

  it('ignores a stale in-flight call once a newer run() has started', async () => {
    const { result } = renderHook(() => useAsyncAction<string>());
    let resolveFirst: (value: string) => void = () => {};
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });

    act(() => {
      void result.current.run(() => first);
    });
    await act(async () => {
      await result.current.run(() => Promise.resolve('second'));
    });
    expect(result.current.result).toBe('second');

    await act(async () => {
      resolveFirst('first');
      await first;
    });
    // The stale first call resolving afterward must not clobber the second call's committed result.
    expect(result.current.result).toBe('second');
    expect(result.current.status).toBe('idle');
  });
});
