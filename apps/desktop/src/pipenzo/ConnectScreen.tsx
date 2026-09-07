import { useState } from 'react';
import { Notice } from '../components/primitives/Notice.js';
import { ConnectPane, PreAppShell } from './PreAppShell.js';
import type { PipenzoStartupRoute, PreAppStep } from './startup-route.js';

/** Why a machine cannot hold a credential at all, said in the user's terms rather than the enum's. */
const UNAVAILABLE_COPY: Record<string, string> = {
  os_encryption_unavailable:
    'This machine reports no OS credential store, so there is nowhere to keep a GitHub token safely. On Linux that usually means no keyring (gnome-keyring or kwallet) is running.',
  plaintext_backend:
    'The only credential store available here encrypts with a published constant key, which is not encryption. Pipenzo refuses to store a token under it rather than claim protection it would not have.',
  unreadable:
    'A stored credential exists but cannot be read on this machine — a keyring that went away, or a record written by a different build. Disconnecting and connecting again replaces it.',
};

/**
 * The pre-app screen (issue #113): the shell, plus whichever of the two steps the route selected.
 *
 * The step **bodies** are not here. The device-code flow is #114 and the repo picker is #115, and
 * both are substantial enough that stubbing a plausible-looking version of either would be worse
 * than an empty frame — a fake code box is indistinguishable from a broken one. What each step
 * shows today is its real heading from the canvas and a plain statement of what is not built yet.
 */
export function ConnectScreen({
  route,
}: {
  route: Extract<PipenzoStartupRoute, { screen: 'pre-app' }>;
}) {
  // The route decides which step is *shown by default* and which are reachable; this holds the
  // user's own navigation on top of that. It is not lifted into the router because it is genuinely
  // view state -- nothing outside this screen needs to know which step is on screen, and a step the
  // route no longer allows is corrected by the router on the next render rather than remembered.
  const [requestedStep, setRequestedStep] = useState<PreAppStep | undefined>(undefined);
  const step =
    requestedStep && (requestedStep !== 'choose-repos' || route.canChooseRepos)
      ? requestedStep
      : route.step;

  return (
    <PreAppShell step={step} canChooseRepos={route.canChooseRepos} onStepChange={setRequestedStep}>
      {step === 'device-code' ? (
        <ConnectPane
          title="Connect GitHub"
          subtitle="Pipenzo reads your issues, writes its own labels and opens pull requests as you. It needs a GitHub token to do any of that, and it keeps that token in this machine's own credential store — never in a file it wrote, and never in the environment of any agent it runs."
        >
          {route.unavailableReason && (
            <Notice tone="danger" icon="warning" title="This machine cannot store a token">
              {UNAVAILABLE_COPY[route.unavailableReason] ??
                'This machine cannot hold a credential safely, so connecting would complete and then fail to save.'}
            </Notice>
          )}
          <Notice icon="info" title="The device-code flow is not built yet">
            Connecting is issue #114. Until it lands, a development build can run against a{' '}
            <code className="mono">PIPENZO_GITHUB_TOKEN</code> in its own environment; a packaged
            build refuses that fallback and has no other way in yet.
          </Notice>
        </ConnectPane>
      ) : (
        <ConnectPane
          title="Choose the repos Pipenzo manages"
          subtitle="Pipenzo only ever looks at the repositories you pick here. Adding or removing one later is a Settings change, not a reconnect."
        >
          <Notice icon="info" title="The repo picker is not built yet">
            Choosing repositories is issue #115. Your GitHub connection is already stored, so
            nothing here needs redoing once it lands.
          </Notice>
        </ConnectPane>
      )}
    </PreAppShell>
  );
}
