import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoGitHubHealthV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { usePipenzoGitHubHealth } from '../../src/pipenzo/use-pipenzo-github-health.js';

function Probe() {
  const health = usePipenzoGitHubHealth();
  return <span data-testid="state">{health ? health.state : 'unread'}</span>;
}

/** Only the one method the hook touches; the rest of the bridge is irrelevant to it. */
function installBridge(): {
  emit: (health: PipenzoGitHubHealthV1) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let listener: ((health: PipenzoGitHubHealthV1) => void) | undefined;
  const unsubscribe = vi.fn();
  setBridgeOverride({
    onPipenzoGitHubHealth: (callback: (health: PipenzoGitHubHealthV1) => void) => {
      listener = callback;
      return unsubscribe;
    },
  } as never);
  return {
    emit: (health) => listener?.(health),
    unsubscribe,
  };
}

afterEach(() => {
  clearBridgeOverride();
});

describe('usePipenzoGitHubHealth', () => {
  it('reports `unread` until the bridge delivers its first value', () => {
    installBridge();
    render(<Probe />);
    expect(screen.getByTestId('state').textContent).toBe('unread');
  });

  it('subscribes on mount and reflects every value the bridge pushes, without a separate read', () => {
    const bridge = installBridge();
    render(<Probe />);

    act(() => bridge.emit({ state: 'healthy', lastCleanPollAt: 1 }));
    expect(screen.getByTestId('state').textContent).toBe('healthy');

    act(() =>
      bridge.emit({
        state: 'retrying',
        attempt: 2,
        maxAttempts: 5,
        nextAttemptAt: 2,
        consecutiveFailures: 2,
        firstFailureAt: 1,
      }),
    );
    expect(screen.getByTestId('state').textContent).toBe('retrying');
  });

  it('unsubscribes on unmount', () => {
    const bridge = installBridge();
    const { unmount } = render(<Probe />);
    unmount();
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
