import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoImplementCommitsV1, PipenzoReviewResultV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import {
  IMPLEMENT_POLL_INTERVAL_MS,
  buildReviewRequest,
  useImplementPoll,
  useReviewAction,
} from '../../src/pipenzo/use-implement-review.js';

const STARTED = {
  worktreeId: '11111111-1111-1111-1111-111111111111',
  branch: 'issue-94',
  baseCommit: 'a'.repeat(40),
};

function commits(overrides: Partial<PipenzoImplementCommitsV1> = {}): PipenzoImplementCommitsV1 {
  return {
    worktreeId: STARTED.worktreeId,
    branch: STARTED.branch,
    baseCommit: STARTED.baseCommit,
    headCommit: 'b'.repeat(40),
    commits: ['b'.repeat(40)],
    sessionState: 'completed',
    ...overrides,
  };
}

afterEach(() => {
  clearBridgeOverride();
});

describe('useImplementPoll', () => {
  it('reports `polling` and calls nothing before a dispatch exists', () => {
    const implementResultPipenzo = vi.fn();
    setBridgeOverride({ implementResultPipenzo } as never);

    const { result } = renderHook(() => useImplementPoll(undefined));
    expect(result.current.status).toBe('polling');
    expect(implementResultPipenzo).not.toHaveBeenCalled();
  });

  it('polls once immediately and reports `ready` once the session reaches a terminal state', async () => {
    const implementResultPipenzo = vi.fn().mockResolvedValue(commits());
    setBridgeOverride({ implementResultPipenzo } as never);

    const { result } = renderHook(() => useImplementPoll(STARTED));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(implementResultPipenzo).toHaveBeenCalledTimes(1);
    expect(implementResultPipenzo).toHaveBeenCalledWith(STARTED);
    expect(result.current.status === 'ready' && result.current.commits).toEqual(commits());
  });

  it('keeps polling on an interval while the session is still `running`', async () => {
    vi.useFakeTimers();
    try {
      const implementResultPipenzo = vi
        .fn()
        .mockResolvedValueOnce(commits({ sessionState: 'running', commits: [] }))
        .mockResolvedValueOnce(commits({ sessionState: 'running', commits: [] }))
        .mockResolvedValueOnce(commits());
      setBridgeOverride({ implementResultPipenzo } as never);

      const { result } = renderHook(() => useImplementPoll(STARTED));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(implementResultPipenzo).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe('polling');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(IMPLEMENT_POLL_INTERVAL_MS);
      });
      expect(implementResultPipenzo).toHaveBeenCalledTimes(2);
      expect(result.current.status).toBe('polling');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(IMPLEMENT_POLL_INTERVAL_MS);
      });
      expect(implementResultPipenzo).toHaveBeenCalledTimes(3);
      expect(result.current.status).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports `error` with the daemon message when the poll rejects', async () => {
    const implementResultPipenzo = vi.fn().mockRejectedValue(new Error('worktree not found'));
    setBridgeOverride({ implementResultPipenzo } as never);

    const { result } = renderHook(() => useImplementPoll(STARTED));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.status === 'error' && result.current.message).toBe('worktree not found');
  });

  it('stops polling and ignores a late response once unmounted', async () => {
    let resolveFirst: (value: PipenzoImplementCommitsV1) => void = () => {};
    const first = new Promise<PipenzoImplementCommitsV1>((resolve) => {
      resolveFirst = resolve;
    });
    const implementResultPipenzo = vi.fn().mockReturnValue(first);
    setBridgeOverride({ implementResultPipenzo } as never);

    const { result, unmount } = renderHook(() => useImplementPoll(STARTED));
    unmount();

    await act(async () => {
      resolveFirst(commits({ sessionState: 'running', commits: [] }));
      await Promise.resolve();
    });
    // No timer was ever scheduled after unmount, and no state update landed on the unmounted hook.
    expect(result.current.status).toBe('polling');
  });
});

describe('buildReviewRequest', () => {
  it('assembles a full review request from a finished poll and an explicit model choice', () => {
    const spec = { issue: { number: 94 } } as never;
    const request = buildReviewRequest({
      spec,
      commits: commits(),
      implementerTier: 'mid',
      implementerProvider: 'claude',
      reviewer: { provider: 'claude', model: 'reviewer-model', tier: 'mid' },
      verifier: { provider: 'claude', model: 'verifier-model', tier: 'mid' },
      ticketId: '22222222-2222-2222-2222-222222222222',
    });

    expect(request).toEqual({
      spec,
      worktreeId: STARTED.worktreeId,
      baseCommit: STARTED.baseCommit,
      headCommit: 'b'.repeat(40),
      implementerTier: 'mid',
      implementerProvider: 'claude',
      reviewer: { provider: 'claude', model: 'reviewer-model', tier: 'mid' },
      verifier: { provider: 'claude', model: 'verifier-model', tier: 'mid' },
      ticketId: '22222222-2222-2222-2222-222222222222',
    });
  });

  it('omits implementerProvider and ticketId when neither was supplied', () => {
    const spec = { issue: { number: 94 } } as never;
    const request = buildReviewRequest({
      spec,
      commits: commits(),
      implementerTier: 'cheap',
      reviewer: { provider: 'claude', model: 'r', tier: 'cheap' },
      verifier: { provider: 'claude', model: 'v', tier: 'cheap' },
    });

    expect(request).not.toHaveProperty('implementerProvider');
    expect(request).not.toHaveProperty('ticketId');
  });
});

describe('useReviewAction', () => {
  it('calls reviewPipenzo with the given request and tracks pending/result', async () => {
    const report = { schemaVersion: 1, outcome: 'approved' } as unknown as PipenzoReviewResultV1;
    const reviewPipenzo = vi.fn().mockResolvedValue(report);
    setBridgeOverride({ reviewPipenzo } as never);

    const { result } = renderHook(() => useReviewAction());
    expect(result.current.status).toBe('idle');

    const request = buildReviewRequest({
      spec: { issue: { number: 94 } } as never,
      commits: commits(),
      implementerTier: 'mid',
      reviewer: { provider: 'claude', model: 'r', tier: 'mid' },
      verifier: { provider: 'claude', model: 'v', tier: 'mid' },
    });

    await act(async () => {
      await result.current.run(request);
    });

    expect(reviewPipenzo).toHaveBeenCalledWith(request);
    expect(result.current.result).toBe(report);
    expect(result.current.status).toBe('idle');
  });

  it('moves to the error state with the daemon message when review fails', async () => {
    const reviewPipenzo = vi.fn().mockRejectedValue(new Error('the reviewer session failed'));
    setBridgeOverride({ reviewPipenzo } as never);

    const { result } = renderHook(() => useReviewAction());
    const request = buildReviewRequest({
      spec: { issue: { number: 94 } } as never,
      commits: commits(),
      implementerTier: 'mid',
      reviewer: { provider: 'claude', model: 'r', tier: 'mid' },
      verifier: { provider: 'claude', model: 'v', tier: 'mid' },
    });

    await act(async () => {
      await result.current.run(request);
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('the reviewer session failed');
  });
});
