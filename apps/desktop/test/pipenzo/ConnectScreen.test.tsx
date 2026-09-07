import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { ConnectScreen } from '../../src/pipenzo/ConnectScreen.js';

/**
 * Step 1's own behaviour lives in `DeviceCodeStep.test.tsx`. What is asserted here is the screen
 * *around* it: which step renders, how the two are navigated, and what the shell hands each one.
 *
 * The bridge is stubbed rather than exercised for the same reason — a device flow only needs to
 * exist here, not run.
 */
function installBridge() {
  setBridgeOverride({
    startGitHubDeviceFlow: vi.fn(),
    openGitHubDeviceVerification: vi.fn().mockResolvedValue(undefined),
    cancelGitHubDeviceFlow: vi.fn().mockResolvedValue(undefined),
    onGitHubDeviceOutcome: vi.fn(() => () => {}),
  } as never);
}

afterEach(() => {
  // Before dropping the bridge: the device step cancels its flow on unmount.
  cleanup();
  clearBridgeOverride();
});

describe('ConnectScreen', () => {
  it('shows the device-code step for a token-less install', () => {
    installBridge();
    render(
      <ConnectScreen route={{ screen: 'pre-app', step: 'device-code', canChooseRepos: false }} />,
    );

    expect(screen.getByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
    // No "cannot store" notice on a healthy machine that simply has not connected yet.
    expect(screen.queryByText('This machine cannot store a token')).not.toBeInTheDocument();
  });

  /**
   * Step 2 is still #115's. `ConnectScreen` is where the two steps meet, so this is the file that
   * notices if the placeholder is ever mistaken for a built screen.
   */
  it('shows the repo step on the route #115 will produce', () => {
    installBridge();
    render(
      <ConnectScreen route={{ screen: 'pre-app', step: 'choose-repos', canChooseRepos: true }} />,
    );

    expect(
      screen.getByRole('heading', { name: 'Choose the repos Pipenzo manages' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/issue #115/)).toBeInTheDocument();
  });

  it('lets the user move between steps once both are reachable', () => {
    installBridge();
    render(
      <ConnectScreen route={{ screen: 'pre-app', step: 'choose-repos', canChooseRepos: true }} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '1 · Device code' }));
    expect(screen.getByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '2 · Choose repos' }));
    expect(
      screen.getByRole('heading', { name: 'Choose the repos Pipenzo manages' }),
    ).toBeInTheDocument();
  });

  /**
   * The user's own navigation must never outrank the route. If a disconnect lands while step 2 is
   * on screen, the next render has `canChooseRepos: false` and the screen has to fall back rather
   * than keep showing a picker with nothing behind it.
   */
  it('drops a held step-2 selection when the credential goes away', () => {
    installBridge();
    const { rerender } = render(
      <ConnectScreen route={{ screen: 'pre-app', step: 'choose-repos', canChooseRepos: true }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '2 · Choose repos' }));

    rerender(
      <ConnectScreen route={{ screen: 'pre-app', step: 'device-code', canChooseRepos: false }} />,
    );
    expect(screen.getByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 · Choose repos' })).toBeDisabled();
  });

  /**
   * "Try a demo" otherwise lives only inside `App`, which the pre-app replaces -- making a
   * token-less install, the entire audience for a demo, the one install that cannot reach it.
   */
  it('passes the demo entry through to the step that offers it', () => {
    installBridge();
    const onEnterDemo = vi.fn();
    const { rerender } = render(
      <ConnectScreen
        route={{ screen: 'pre-app', step: 'device-code', canChooseRepos: false }}
        onEnterDemo={onEnterDemo}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Try a demo' }));
    expect(onEnterDemo).toHaveBeenCalledTimes(1);

    // Already in a demo: no control at all, rather than one that re-enters the demo it is inside.
    rerender(
      <ConnectScreen route={{ screen: 'pre-app', step: 'device-code', canChooseRepos: false }} />,
    );
    expect(screen.queryByRole('button', { name: 'Try a demo' })).not.toBeInTheDocument();
  });

  /**
   * The vault writes a ciphertext file under this app's own data directory -- the OS credential
   * store supplies the key, not the storage, and `github-token-vault.ts`'s own `clear()` comment
   * depends on that file existing. An earlier draft of this copy said "never in a file it wrote",
   * which a user would reasonably read as "nothing in the app's folder carries the credential" and
   * act on when thinking about backups or profile sync.
   */
  it('does not claim the token is absent from disk', () => {
    installBridge();
    render(
      <ConnectScreen route={{ screen: 'pre-app', step: 'device-code', canChooseRepos: false }} />,
    );

    const sub = document.querySelector('.pane-sub')?.textContent ?? '';
    expect(sub).toContain('encrypted by');
    expect(sub).not.toMatch(/never in a file/i);
  });

  /**
   * A machine that cannot store a credential must be told *before* it authorizes: the device flow
   * would otherwise complete on github.com, issue a real `repo` token, and only then fail to save
   * it. The route carries the reason down to the step, which refuses to start at all.
   */
  it('passes the storage failure down so the step can refuse to start', () => {
    installBridge();
    render(
      <ConnectScreen
        route={{
          screen: 'pre-app',
          step: 'device-code',
          canChooseRepos: false,
          unavailableReason: 'os_encryption_unavailable',
        }}
      />,
    );

    expect(screen.getByText(/no OS credential store/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeDisabled();
  });
});
