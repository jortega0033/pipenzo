import { useState } from 'react';
import { DeviceCodeStep } from './DeviceCodeStep.js';
import { RepoPicker } from './RepoPicker.js';
import { ConnectPane, PreAppShell } from './PreAppShell.js';
import type { PipenzoStartupRoute, PreAppStep } from './startup-route.js';

/**
 * The pre-app screen (issue #113): the shell, plus whichever of the two steps the route selected.
 *
 * Both steps are real now. `DeviceCodeStep` (#114) owns its own pane, because everything in it —
 * the heading's promise about where the token goes, the scope disclosure, the actions — belongs to
 * the flow rather than to the frame. Step 2 hosts `RepoPicker` (#115), which is a separate
 * component rather than inline markup because Settings reuses it (#125): "Add a repo…" there is
 * this same picker in a different frame.
 */
export function ConnectScreen({
  route,
  onEnterDemo,
  onReposConnected,
}: {
  route: Extract<PipenzoStartupRoute, { screen: 'pre-app' }>;
  /**
   * "Try a demo" lives inside `App`, which this screen replaces — so without an entry point here, a
   * token-less install (the entire audience for a demo) would be the one install that cannot reach
   * it. It sits on step 1's action row rather than in the topbar because it is an alternative to
   * connecting, not a piece of the shell.
   */
  onEnterDemo?: () => void;
  /**
   * Called after the picker saves (issue #115). The gate re-reads the connected count itself, so
   * this exists to make that re-read *immediate* rather than leaving the user on a screen they
   * have finished with until something else happens to refresh it.
   */
  onReposConnected?: (repositories: readonly string[]) => void;
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
          subtitle={
            <>
              Pipenzo authenticates as <i>you</i>, not as an installed GitHub App — so there is no
              org-install step for an admin to grant, and it can reach exactly what your own account
              already can. Org-level access control stays GitHub&apos;s own permission model.
            </>
          }
        >
          <RepoPicker {...(onReposConnected ? { onConnected: onReposConnected } : {})} />
        </ConnectPane>
      )}
    </PreAppShell>
  );
}
