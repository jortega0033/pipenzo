import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoDeviceCodeV1, PipenzoDeviceOutcomeV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { DeviceCodeStep, formatCountdown, verifyLabel } from '../../src/pipenzo/DeviceCodeStep.js';

const CODE: PipenzoDeviceCodeV1 = {
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://github.com/login/device',
  expiresAt: 0, // replaced per test, relative to the faked clock
};

function installBridge(
  overrides: {
    start?: () => Promise<PipenzoDeviceCodeV1>;
  } = {},
) {
  let emit: ((outcome: PipenzoDeviceOutcomeV1) => void) | undefined;
  const bridge = {
    startGitHubDeviceFlow: vi.fn(
      overrides.start ?? (async () => ({ ...CODE, expiresAt: Date.now() + 900_000 })),
    ),
    openGitHubDeviceVerification: vi.fn().mockResolvedValue(undefined),
    cancelGitHubDeviceFlow: vi.fn().mockResolvedValue(undefined),
    onGitHubDeviceOutcome: vi.fn((callback: (outcome: PipenzoDeviceOutcomeV1) => void) => {
      emit = callback;
      return () => {
        emit = undefined;
      };
    }),
  };
  setBridgeOverride(bridge as never);
  return { bridge, emit: (outcome: PipenzoDeviceOutcomeV1) => act(() => emit?.(outcome)) };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

afterEach(() => {
  // Unmount *before* dropping the bridge. The step cancels the flow on unmount, so a teardown that
  // cleared the override first would leave that cleanup calling through to a `window.agentDock`
  // this file never defines -- a test-harness artefact that would read as a component bug.
  cleanup();
  clearBridgeOverride();
  vi.useRealTimers();
});

/** Drives the step from idle to a code on screen, which most cases below start from. */
async function startFlow() {
  fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
  return screen.findByText('WDJB-MJHT');
}

describe('formatCountdown', () => {
  it('renders mm:ss and never goes negative', () => {
    expect(formatCountdown(878_000)).toBe('14:38');
    // The round-up claim specifically: this is 14:59 under `floor`, and the whole point of ceiling
    // is that a fifteen-minute code reads 15:00 the instant it appears.
    expect(formatCountdown(899_500)).toBe('15:00');
    expect(formatCountdown(1)).toBe('0:01');
    expect(formatCountdown(61_000)).toBe('1:01');
    expect(formatCountdown(0)).toBe('0:00');
    // An expired code that is still on screen for a frame must not render "-0:01".
    expect(formatCountdown(-5_000)).toBe('0:00');
  });
});

describe('DeviceCodeStep', () => {
  it('discloses the scope and the three steps before a code is ever requested', () => {
    installBridge();
    render(<DeviceCodeStep />);

    // The point of disclosing the scope is that it is read *before* authorizing, so it cannot be
    // gated behind having already started.
    expect(screen.getByText(/no narrower scope that grants one without the other/)).toBeInTheDocument();
    expect(screen.getByText(/You authorize on github\.com\./)).toBeInTheDocument();
    expect(screen.getByText(/The token goes to the Electron-main token vault\./)).toBeInTheDocument();
    expect(screen.getByText(/You pick the repos Pipenzo manages\./)).toBeInTheDocument();
    expect(screen.queryByText('WDJB-MJHT')).not.toBeInTheDocument();
  });

  it('shows the code, its single-use expiry, and the waiting line', async () => {
    installBridge();
    render(<DeviceCodeStep />);
    await startFlow();

    // Read off the element rather than via getByText: the line is an icon plus two text nodes, so
    // the sentence exists only as the container's combined text.
    expect(document.querySelector('.code-meta')?.textContent).toContain('expires in 15:00 · single use');
    expect(screen.getByText('Waiting for you to authorize on GitHub…')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Verify at github\.com\/login\/device/ }),
    ).toBeInTheDocument();
  });

  /**
   * A screen reader reading `WDJB-MJHT` as a word is exactly the case where the individual letters
   * are the whole point -- this is a string the user has to retype in another application.
   */
  it('spells the code out for a screen reader', async () => {
    installBridge();
    render(<DeviceCodeStep />);
    await startFlow();

    expect(screen.getByLabelText('W D J B - M J H T')).toBeInTheDocument();
  });

  it('counts down while the code is on screen', async () => {
    installBridge();
    render(<DeviceCodeStep />);
    await startFlow();

    await act(async () => {
      vi.advanceTimersByTime(62_000);
    });
    expect(document.querySelector('.code-meta')?.textContent).toContain('expires in 13:58');
  });

  /**
   * The label is a promise about where the click leads. Assembled independently of the destination
   * it is a promise that can quietly stop being true, so it is read off the URI main validated.
   */
  it('labels the verify button from the destination it was given', () => {
    expect(verifyLabel('https://github.com/login/device')).toBe('github.com/login/device');
    expect(verifyLabel('https://github.com/login/device/')).toBe('github.com/login/device');
    expect(verifyLabel('not a url')).toBe('not a url');
  });

  it('opens the verification page without naming it', async () => {
    const { bridge } = installBridge();
    render(<DeviceCodeStep />);
    await startFlow();

    fireEvent.click(screen.getByRole('button', { name: /Verify at github\.com/ }));
    expect(bridge.openGitHubDeviceVerification).toHaveBeenCalledWith();
    // No argument at all: main opens the URL it validated itself, so this is not an open-anything
    // primitive reachable from a context that renders model-authored text.
    expect(bridge.openGitHubDeviceVerification.mock.calls[0]).toEqual([]);
  });

  it('copies the user code and says it did', async () => {
    installBridge();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<DeviceCodeStep />);
    await startFlow();

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('WDJB-MJHT');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('reports every failure with its own copy, and offers a retry', async () => {
    const { emit } = installBridge();
    render(<DeviceCodeStep />);
    await startFlow();

    emit({ state: 'failed', reason: 'expired' });
    expect(await screen.findByText('That code expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();

    emit({ state: 'failed', reason: 'denied' });
    expect(await screen.findByText('Authorization was declined')).toBeInTheDocument();
  });

  /**
   * The one failure retrying cannot fix. A user who is not told that will retry until they give up
   * on the app rather than on the build, so the copy names it as a build problem and points at the
   * ticket that resolves it.
   */
  it('names a missing client id as a build problem, not a user one', async () => {
    const { emit } = installBridge();
    render(<DeviceCodeStep />);
    await startFlow();

    emit({ state: 'failed', reason: 'not_configured' });
    expect(await screen.findByText('This build cannot sign in yet')).toBeInTheDocument();
    expect(screen.getByText(/retrying will not change it/)).toBeInTheDocument();
  });

  it('reports success and says what is happening next', async () => {
    const { emit } = installBridge();
    render(<DeviceCodeStep />);
    await startFlow();

    emit({ state: 'connected' });
    expect(
      await screen.findByText('Connected. Restarting the local runtime with your credential…'),
    ).toBeInTheDocument();
    // The gate routes onward on its own once the restarted daemon reports ready; offering the
    // button again here would invite a second sign-in over a credential that already landed.
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeDisabled();
  });

  /**
   * Without this the user authorizes on github.com, hands Pipenzo a live `repo` token, and only
   * then learns it cannot be kept -- having issued a real credential for nothing.
   */
  it('refuses to start at all on a machine with no credential store', () => {
    const { bridge } = installBridge();
    render(<DeviceCodeStep unavailableReason="plaintext_backend" />);

    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeDisabled();
    expect(screen.getByText('This machine cannot store a token')).toBeInTheDocument();
    expect(screen.getByText(/published constant key/)).toBeInTheDocument();
    expect(bridge.startGitHubDeviceFlow).not.toHaveBeenCalled();
  });

  /**
   * Deliberately the opposite of what it first did. Cancelling on unmount looked like tidy-up and
   * was two bugs: it sent a cancel main could not act on when the component unmounted during the
   * `requestCode` round trip (no grant existed yet, so the flow was orphaned), and it burned a live
   * device code every time the user flipped to Connect's second step and back -- defeating main's
   * own reuse of an unexpired grant and re-minting a code they may have been part-way through
   * typing. Ending the flow is the Cancel button's job, which is an instruction rather than a side
   * effect of navigating.
   */
  it('does not cancel the flow merely because the step unmounted', async () => {
    const { bridge } = installBridge();
    const { unmount } = render(<DeviceCodeStep />);
    await startFlow();

    unmount();
    await Promise.resolve();
    expect(bridge.cancelGitHubDeviceFlow).not.toHaveBeenCalled();
  });

  it('cancels when the user actually asks', async () => {
    const { bridge } = installBridge();
    render(<DeviceCodeStep />);
    await startFlow();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(bridge.cancelGitHubDeviceFlow).toHaveBeenCalledTimes(1);
  });

  /**
   * Main's `expired` outcome is real but late: it arrives only after the next poll's sleep, up to a
   * minute away once `slow_down` has raised the interval, and it is lost entirely if the window is
   * recreated between main sending it and this component resubscribing. Without a local transition
   * the user watches a dead code sit at 0:00 with nothing to do.
   */
  it('gives up on its own when the countdown runs out', async () => {
    installBridge();
    render(<DeviceCodeStep />);
    await startFlow();

    await act(async () => {
      vi.advanceTimersByTime(901_000);
    });
    expect(await screen.findByText('That code expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  /**
   * `DeviceFlowError.reason` does not survive IPC -- Electron flattens the error and drops the
   * field -- so the renderer cannot tell a build with no client id from a laptop on a plane.
   * Guessing `not_configured` showed the one message whose purpose is to stop the user retrying, to
   * the user for whom retrying is exactly right. Main knows, and pushes the precise reason.
   */
  it('does not guess a build fault from a rejected start', async () => {
    const { emit } = installBridge({ start: () => Promise.reject(new Error('offline')) });
    render(<DeviceCodeStep />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    expect(await screen.findByText('Could not reach GitHub')).toBeInTheDocument();

    // ...and main's push corrects it when the cause really is the build.
    emit({ state: 'failed', reason: 'not_configured' });
    expect(await screen.findByText('This build cannot sign in yet')).toBeInTheDocument();
  });

  /**
   * A device flow is a public client with no secret, so Pipenzo cannot revoke a token on the user's
   * behalf. Any outcome where GitHub may already have issued one has to say so, or the user is left
   * with a live `repo` grant they do not know about.
   */
  it('tells the user to revoke when GitHub may hold a live authorization', async () => {
    const { emit } = installBridge();
    render(<DeviceCodeStep />);
    await startFlow();

    emit({ state: 'failed', reason: 'storage_unavailable' });
    expect(await screen.findByText(/revoke Pipenzo under Settings/)).toBeInTheDocument();

    emit({ state: 'failed', reason: 'cancelled' });
    expect(await screen.findByText(/revoke Pipenzo under Settings/)).toBeInTheDocument();
  });

  it('reports an unreachable GitHub as its own thing', async () => {
    const { emit } = installBridge();
    render(<DeviceCodeStep />);
    await startFlow();

    emit({ state: 'failed', reason: 'unreachable' });
    expect(await screen.findByText('Could not reach GitHub')).toBeInTheDocument();
  });

  it('still refuses, and still explains, for a storage reason it does not recognise', () => {
    installBridge();
    render(<DeviceCodeStep unavailableReason="something_added_later" />);

    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeDisabled();
    // A reason this build has no copy for must not render an empty notice: failing closed on the
    // refusal and open on the explanation is the worst of both.
    expect(screen.getByText(/could not be saved|would complete on GitHub and then fail to save/)).toBeInTheDocument();
  });

  it('offers the demo when it is given one, and never asks the bridge for a code to do it', () => {
    const onEnterDemo = vi.fn();
    installBridge();
    render(<DeviceCodeStep onEnterDemo={onEnterDemo} />);

    fireEvent.click(screen.getByRole('button', { name: 'Try a demo' }));
    expect(onEnterDemo).toHaveBeenCalledTimes(1);
  });
});
