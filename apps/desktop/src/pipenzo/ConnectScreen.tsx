import { useState } from 'react';
import { Notice } from '../components/primitives/Notice.js';
import { DeviceCodeStep } from './DeviceCodeStep.js';
import { ConnectPane, PreAppShell } from './PreAppShell.js';
import type { PipenzoStartupRoute, PreAppStep } from './startup-route.js';

/**
 * The pre-app screen (issue #113): the shell, plus whichever of the two steps the route selected.
 *
 * Step 1 is real as of #114 — `DeviceCodeStep` owns its own pane, because everything in it (the
 * heading's promise about where the token goes, the scope disclosure, the actions) belongs to the
 * flow rather than to the frame. Step 2 is still #115's, and shows its real heading from the canvas
 * with a plain statement of what is not built yet: a plausible-looking stub of a repo picker would
 * be worse than an empty frame, since a fake list is indistinguishable from a broken one.
 */
export function ConnectScreen({
  route,
  onEnterDemo,
}: {
  route: Extract<PipenzoStartupRoute, { screen: 'pre-app' }>;
  /**
   * "Try a demo" lives inside `App`, which this screen replaces — so without an entry point here, a
   * token-less install (the entire audience for a demo) would be the one install that cannot reach
   * it. It sits on step 1's action row rather than in the topbar because it is an alternative to
   * connecting, not a piece of the shell.
   */
  onEnterDemo?: () => void;
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
        <DeviceCodeStep
          {...(route.unavailableReason ? { unavailableReason: route.unavailableReason } : {})}
          {...(onEnterDemo ? { onEnterDemo } : {})}
        />
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
