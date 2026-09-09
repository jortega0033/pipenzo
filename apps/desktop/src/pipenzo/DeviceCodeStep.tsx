import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PipenzoDeviceCodeV1, PipenzoDeviceFailureReasonV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Button } from '../components/primitives/Button.js';
import { Icon } from '../components/primitives/Icon.js';
import { LoadLine } from '../components/primitives/LoadLine.js';
import { Notice } from '../components/primitives/Notice.js';
import { ConnectPane } from './PreAppShell.js';

/**
 * `mm:ss` remaining, clamped at zero so an expired code never renders a negative countdown.
 *
 * Rounds *up*, which is the difference between a fifteen-minute code reading `15:00` the moment it
 * appears and reading `14:59` — a code is issued with a whole number of seconds left, and flooring
 * loses the fractional millisecond that has already elapsed by the time it renders. Counting up
 * also means the display reaches `0:00` exactly when the code expires rather than a second early.
 */
export function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.ceil(msRemaining / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * What each failure means, in the user's terms and with the *next action* in it.
 *
 * The canvas has no error states for this step at all — it shows only the nominal "code issued,
 * waiting" case — so these are designed rather than ported, and the shape they are designed to is:
 * say what happened, then say whose move it is. `not_configured` is the one that matters most,
 * because it is the only one no amount of retrying fixes, and a user who is not told that will
 * retry until they give up on the app rather than on the build.
 */
const FAILURE_COPY: Record<PipenzoDeviceFailureReasonV1, { title: string; body: string }> = {
  expired: {
    title: 'That code expired',
    body: 'Device codes last about fifteen minutes. Ask for a new one and finish on github.com while it is on screen.',
  },
  denied: {
    title: 'Authorization was declined',
    body: 'GitHub reported that the request was cancelled or denied. Starting again issues a new code — nothing was stored.',
  },
  cancelled: {
    title: 'Sign-in cancelled',
    body: 'Nothing was stored here. If you had already authorized on github.com, revoke Pipenzo under Settings › Applications › Authorized OAuth Apps — this app has no client secret, so it cannot revoke a token for you.',
  },
  not_configured: {
    title: 'This build cannot sign in yet',
    body: 'Pipenzo has no GitHub OAuth client id, or device flow is not enabled on it. That is a build problem rather than anything you did, and retrying will not change it — see issue #220.',
  },
  unreachable: {
    title: 'Could not reach GitHub',
    body: 'The sign-in could not be completed. Check your connection and start again; nothing was stored.',
  },
  storage_unavailable: {
    title: 'This machine has nowhere to keep the token',
    body: 'GitHub authorized the sign-in, but there is no usable OS credential store here, so Pipenzo discarded the token rather than keep it unprotected — on Linux this usually means no keyring is running. The authorization still exists on GitHub: revoke Pipenzo under Settings › Applications › Authorized OAuth Apps, since a device flow has no client secret and cannot revoke its own token.',
  },
};

/** Why a machine cannot hold a credential at all, said in the user's terms rather than the enum's. */
const UNAVAILABLE_COPY: Record<string, string> = {
  os_encryption_unavailable:
    'This machine reports no OS credential store, so there is nowhere to keep a GitHub token safely. On Linux that usually means no keyring (gnome-keyring or kwallet) is running.',
  plaintext_backend:
    'The only credential store available here encrypts with a published constant key, which is not encryption. Pipenzo refuses to store a token under it rather than claim protection it would not have.',
  backend_unknown:
    'Pipenzo could not yet confirm what credential store this machine has -- this usually resolves on its own a moment after startup. Try again shortly.',
  unreadable:
    'A stored credential exists but cannot be read on this machine — a keyring that went away, or a record written by a different build. Disconnecting and connecting again replaces it.',
};

/**
 * `github.com/login/device` from `https://github.com/login/device` -- the canvas's own label, but
 * read off the destination rather than retyped beside it. Falls back to the whole string if it will
 * not parse, which cannot happen for a grant main produced but is not worth throwing over.
 */
export function verifyLabel(verificationUri: string): string {
  try {
    const url = new URL(verificationUri);
    return `${url.host}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return verificationUri;
  }
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; code: PipenzoDeviceCodeV1 }
  /** Authorized and stored. Held only until the daemon restarts and the gate routes onward. */
  | { kind: 'connected' }
  | { kind: 'failed'; reason: PipenzoDeviceFailureReasonV1 };

/**
 * Connect's step 1 (issue #114): the device code, the two actions, and the explanation of what
 * the token is about to be able to do.
 *
 * Everything that touches a credential happens in Electron main. This component's whole job is to
 * show an eight-character pairing code, offer to open GitHub's page in the user's own browser, and
 * report how it ended — see `github-device-flow.ts` for why the device code and the token never
 * reach this process, and `pipenzo-credential-v1.ts` for the wire shapes that make that structural
 * rather than a convention.
 */
export function DeviceCodeStep({
  unavailableReason,
  onEnterDemo,
}: {
  /**
   * Set when this machine has no usable credential store. Sign-in is refused up front rather than
   * offered and failed: without this the user would authorize on github.com, hand Pipenzo a real
   * `repo` token, and only then be told it cannot be kept -- having paid the whole cost of the
   * flow and issued a live credential for nothing.
   */
  unavailableReason?: string;
  /** See `ConnectScreen`: the pre-app is the only place a token-less install can reach a demo. */
  onEnterDemo?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const canStore = unavailableReason === undefined;
  // Read by the outcome subscription, which must not be torn down and re-established every time
  // the phase changes -- an outcome arriving during that gap would be lost, and it is the only
  // notification this screen gets that the sign-in succeeded.
  useEffect(() => {
    const unsubscribe = getBridge().onGitHubDeviceOutcome((outcome) => {
      setPhase(
        outcome.state === 'connected'
          ? { kind: 'connected' }
          : { kind: 'failed', reason: outcome.reason },
      );
    });
    return unsubscribe;
  }, []);

  /**
   * Expiry is *derived*, not a state transition scheduled by the timer.
   *
   * The timer's only job is to move `now`; whether the code is dead is then a question about two
   * numbers, answered fresh on every render. Setting a `failed` phase from inside the interval
   * instead would make the correctness of this screen depend on a callback firing at the right
   * tick, which is both harder to reason about and harder to test than a comparison.
   *
   * It has to be settled here at all — rather than left to main's own `expired` outcome — because
   * that outcome is real but late: it arrives only after the next poll's sleep completes, up to a
   * minute away once `slow_down` has raised the interval, and it is lost outright if the window is
   * recreated between main sending it and this component resubscribing. Without this the user
   * watches a dead code sit at `0:00` with nothing to do.
   */
  const expired = phase.kind === 'waiting' && now >= phase.code.expiresAt;
  // Memoized because `copy` closes over it: a fresh object every render would give that callback a
  // new identity every second, for a value that only actually changes when the code does.
  const shown: Phase = useMemo(
    () => (expired ? { kind: 'failed', reason: 'expired' } : phase),
    [expired, phase],
  );

  const waiting = shown.kind === 'waiting';
  // One timer, only while a live code is on screen. The countdown is the only reason this component
  // re-renders on a clock at all, so it stops the moment there is nothing counting down -- which
  // includes the moment the code expires, since `waiting` is read off the derived phase.
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  // Deliberately *no* cancel on unmount.
  //
  // It looked like tidy-up and was two bugs. Unmounting during the `requestCode` round trip sent a
  // cancel main could not act on -- there was no grant yet -- leaving a flow that then polled for
  // its full lifetime with no subscriber. And flipping to Connect's second step and back unmounts
  // this component, so the cancel burned a live device code every time, defeating main's own
  // reuse of an unexpired grant and re-minting a code the user may have been part-way through
  // typing. Main's flow is bounded and self-terminating; ending it is the Cancel button's job,
  // which is an instruction rather than a side effect of navigation.

  const start = useCallback(() => {
    setCopied(false);
    setPhase({ kind: 'starting' });
    void getBridge()
      .startGitHubDeviceFlow()
      .then((code) => setPhase({ kind: 'waiting', code }))
      .catch(() => {
        // `unreachable`, never `not_configured`. `DeviceFlowError.reason` does not survive IPC --
        // Electron flattens the error and drops the field -- so nothing here can tell a build with
        // no client id from a laptop on a plane. Guessing `not_configured` meant showing the one
        // message whose entire purpose is to stop the user retrying, to the user for whom retrying
        // is exactly right. Main knows the real reason and pushes it on the outcome channel, which
        // overwrites this the moment it lands; until then `unreachable` is true of every case.
        setPhase({ kind: 'failed', reason: 'unreachable' });
      });
  }, []);

  const copy = useCallback(() => {
    if (shown.kind !== 'waiting') return;
    void navigator.clipboard
      ?.writeText(shown.code.userCode)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, [shown]);

  return (
    <ConnectPane
      title="Connect GitHub"
      subtitle="Pipenzo reads your issues, writes its own labels and opens pull requests as you. It needs a GitHub token to do any of that, and it keeps that token encrypted by this machine's own credential store — never in plaintext, and never in the environment of any agent it runs."
      actions={
        shown.kind === 'waiting' ? (
          <>
            <Button
              variant="primary"
              size="lg"
              icon="external"
              onClick={() => void getBridge().openGitHubDeviceVerification()}
            >
              {/* Derived from the URI main validated and pinned, not a hardcoded string that
                  happens to match it. The label is a promise about where the click leads, and a
                  promise assembled independently of the destination is one that can quietly stop
                  being true. `verificationUri` exists on the wire for exactly this. */}
              Verify at {verifyLabel(shown.code.verificationUri)}
            </Button>
            <Button size="lg" icon="code" onClick={copy}>
              {copied ? 'Copied' : 'Copy code'}
            </Button>
            <Button size="lg" onClick={() => void getBridge().cancelGitHubDeviceFlow()}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              size="lg"
              icon="external"
              pending={shown.kind === 'starting'}
              // A sign-in this machine cannot finish is not offered. See `unavailableReason`.
              disabled={canStore === false || shown.kind === 'connected'}
              onClick={start}
            >
              {shown.kind === 'starting'
                ? 'Asking GitHub…'
                : shown.kind === 'failed'
                  ? 'Try again'
                  : 'Connect GitHub'}
            </Button>
            {onEnterDemo && (
              <Button size="lg" onClick={onEnterDemo}>
                Try a demo
              </Button>
            )}
          </>
        )
      }
    >
      {shown.kind === 'waiting' && (
        <div className="code-box">
          <span className="label">Your device code</span>
          {/* The one thing on this screen a human has to carry to another surface, so it is the
              largest type in the design -- and `aria-label` spells it out, because a screen reader
              reading "WDJB-MJHT" as a word is exactly the case where the letters matter. */}
          <span className="code" aria-label={shown.code.userCode.split('').join(' ')}>
            {shown.code.userCode}
          </span>
          <span className="code-meta">
            <Icon name="clock" size="sm" />
            expires in {formatCountdown(shown.code.expiresAt - now)} · single use
          </span>
        </div>
      )}

      {shown.kind === 'waiting' && (
        <LoadLine>Waiting for you to authorize on GitHub…</LoadLine>
      )}

      {/* The gate routes onward by itself once the restarted daemon reports ready, so this is a
          progress report rather than a step: without it the screen would sit on a dead code box
          for the second or two the restart takes, which reads as the click not having landed. */}
      {shown.kind === 'connected' && (
        <LoadLine>Connected. Restarting the local runtime with your credential…</LoadLine>
      )}

      {shown.kind === 'failed' && (
        <Notice tone="danger" icon="warning" title={FAILURE_COPY[shown.reason].title}>
          {FAILURE_COPY[shown.reason].body}
        </Notice>
      )}

      {/* Shown instead of anything else this step could offer: on a machine with no credential
          store, starting the flow would issue a real `repo` token and then throw it away. */}
      {!canStore && (
        <Notice tone="danger" icon="warning" title="This machine cannot store a token">
          {UNAVAILABLE_COPY[unavailableReason] ??
            'This machine has no usable credential store, so a sign-in would complete on GitHub and then fail to save. Signing in is disabled rather than offered.'}
        </Notice>
      )}

      {/* Shown before the code as well as beside it: the point of disclosing the scope is that the
          user reads it *before* authorizing, and a notice that only appears once a code is already
          on screen has missed the moment it exists for. */}
      <Notice
        icon="gates"
        title={
          <>
            Pipenzo asks for the <span className="mono">repo</span> scope on private repositories
          </>
        }
      >
        Creating labels and opening pull requests both need write access, and there is no narrower
        scope that grants one without the other. The token can write to any repo you can write to —
        which is why it is written to the Electron-main token vault and never handed to a provider
        subprocess.
      </Notice>

      <div className="why">
        <div className="why-row">
          <span className="n">1</span>
          <span>
            <b>You authorize on github.com.</b> Pipenzo polls GitHub for completion — the device
            flow&apos;s own polling, unrelated to the 30–60s ticket sync everywhere else in the app.
          </span>
        </div>
        <div className="why-row">
          <span className="n">2</span>
          <span>
            <b>The token goes to the Electron-main token vault.</b> Publishing is a daemon-side
            service the agent cannot call, so no provider subprocess ever sees it.
          </span>
        </div>
        <div className="why-row">
          <span className="n">3</span>
          <span>
            <b>You pick the repos Pipenzo manages.</b> A token with no selected repo is not yet
            useful, so the app moves straight to repo selection rather than dropping you on an empty
            board.
          </span>
        </div>
      </div>
    </ConnectPane>
  );
}
