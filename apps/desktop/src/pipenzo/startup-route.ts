import type { PipenzoGitHubConnectionV1 } from '@agent-dock/shared';
import type { DaemonState } from './use-github-connection.js';

/**
 * Which screen a Pipenzo install opens on, and — when that is the pre-app — which of its two steps
 * (issue #113).
 *
 * ## Why this is a pure function and not a `useEffect`
 *
 * The decision has four inputs that arrive at different times and in any order: the daemon's
 * status, the vault's state, the daemon's *actual* credential source, and the user's own step
 * navigation. Written inline in a component that would be four booleans and a render tree, and the
 * interesting cases — "the vault is empty but a development daemon is running on an inherited
 * variable", "the status has not been read yet" — are precisely the ones nobody would write a test
 * for. Here every combination is one call with one answer.
 */

/** The two steps of the pre-app, in order. Labels live in `PreAppShell.tsx`. */
export type PreAppStep = 'device-code' | 'choose-repos';

/**
 * Whether the workspace's connected-repos list (issue #115) is satisfied.
 *
 * `not-tracked` is today's honest answer and the default: nothing in this app records a
 * connected-repos list yet, and gating the whole product on a list that no code writes would lock
 * every user out of an app they are correctly credentialed for. #115 is what starts passing a real
 * count, at which point `0` begins routing to step 2 on its own.
 */
export type ConnectedRepoState =
  /**
   * No answer *yet* — the first read is still outstanding. Routes to `loading`, for the same reason
   * an unread connection does: a credentialed install with no repositories chosen would otherwise
   * render the board and then have it replaced by the picker a moment later, which is precisely the
   * flash the loading screen exists to prevent, reintroduced for the second gate condition.
   */
  | 'unknown'
  /**
   * No answer, and none coming — the daemon could not be asked. Treated as *satisfied*, because
   * the alternative is routing a fully-configured install to the repo picker every time its daemon
   * is slow to start, and the daemon restarts as part of connecting GitHub.
   */
  | 'not-tracked'
  | number;

export type PipenzoStartupRoute =
  /**
   * The connection has not been read yet. Deliberately its own screen rather than defaulting to
   * either real one: defaulting to the app flashes the board at a token-less install, and
   * defaulting to the pre-app flashes "Connect GitHub" at every correctly-connected user on every
   * launch. Both are wrong, and the second is the one that reads as a bug.
   */
  | { readonly screen: 'loading' }
  | {
      readonly screen: 'pre-app';
      readonly step: PreAppStep;
      /**
       * Whether step 2 can be entered at all. A repo picker with no credential behind it has
       * nothing to list, so the step bar renders it as unreachable rather than letting a click
       * land on an empty screen.
       */
      readonly canChooseRepos: boolean;
      /**
       * Present only when the machine cannot hold a credential at all (no OS credential store, a
       * plaintext Linux backend, an unreadable record). The device-code step needs it because on
       * such a machine the flow would complete and then fail to store, and telling the user that
       * *before* they authorize is the difference between an explanation and a mystery.
       */
      readonly unavailableReason?: NonNullable<PipenzoGitHubConnectionV1['reason']>;
    }
  | {
      readonly screen: 'app';
      /**
       * True when the running daemon's credential came from the development fallback (a file
       * under Electron's own data directory, issue #212 -- an inherited `PIPENZO_GITHUB_TOKEN`
       * shell variable before that) rather than the vault. The rule epic #4 actually cares about is
       * not "no fallbacks" but "no **silent** precedence" — a development build publishing with
       * the fallback is fine, and publishing with one while the UI implies a stored account is not.
       * `pipenzo-credential-v1.ts` records this field as unrendered and names this ticket as the
       * one that renders it.
       */
      readonly environmentCredential: boolean;
    }
  /**
   * The daemon could not start at all (issue #286), for a vault that already holds a credential.
   * Distinct from `pre-app`'s token-less `device-code` step on purpose: this install is not
   * disconnected and signing in again would not help, so telling it to "Connect GitHub" would be
   * false. `loading` isn't right either -- there is nothing left to wait for.
   */
  | { readonly screen: 'daemon-unavailable' };

export interface PipenzoStartupInput {
  /** `undefined` until the first `pipenzoGitHubConnection()` call resolves. */
  readonly connection: PipenzoGitHubConnectionV1 | undefined;
  /** The step the user navigated to, if they navigated at all. */
  readonly requestedStep?: PreAppStep;
  readonly connectedRepos?: ConnectedRepoState;
  /**
   * The local daemon's own lifecycle (issue #286), independent of `connection.source`. `undefined`
   * (not read yet) is treated the same as `'connecting'`: both mean "no answer yet, keep waiting."
   *
   * Exists to resolve one specific ambiguity: since #209, `connection.source` reads `'none'` until
   * the daemon *confirms* a credential over its `/health` check, so a vault that has one stored
   * (`connection.state === 'connected'`) looks identical to a genuinely empty one for as long as the
   * daemon is still starting. Left unresolved, that ambiguity is what flashes `ConnectScreen` at an
   * already-connected install on every launch, and never corrects it if the daemon fails outright.
   */
  readonly daemonState?: DaemonState;
}

/**
 * The whole routing rule, in one place.
 *
 * The ordering below is the argument. **Whether a usable credential exists** is asked first and is
 * asked of `source`, not of `state`: `state` describes the vault, and the vault is not the only
 * place a credential can come from. A development build with an empty vault and a development
 * fallback token in place (issue #212) has a daemon that can reach GitHub right now, and
 * sending that install to "Connect GitHub" would be both false and unfixable from that screen —
 * connecting stores into a vault the daemon is not reading this run.
 */
export function routePipenzoStartup(input: PipenzoStartupInput): PipenzoStartupRoute {
  const { connection } = input;
  if (!connection) return { screen: 'loading' };

  const connectedRepos = input.connectedRepos ?? 'not-tracked';
  // Asked before anything else, and only when a credential exists: a token-less install belongs in
  // the pre-app regardless of what it has chosen, so waiting on a repository count there would just
  // delay the screen it is going to see anyway.
  const hasCredential = connection.source !== 'none';

  // The ambiguous window (issue #286): the vault already holds a credential, but the daemon has not
  // confirmed using it yet, so `source` still reads `'none'` (#209 made that reporting honest rather
  // than optimistic). Resolved by the daemon's own state rather than guessed from `connection` alone:
  // - not ready yet (`'connecting'`, or not read yet) -- still worth waiting for, so `loading`, not
  //   `ConnectScreen`. Ruling this out is what stops the startup flash.
  // - `'unavailable'` -- nothing left to wait for, and this install was never actually disconnected,
  //   so it gets its own honest screen rather than silently falling through to `ConnectScreen`.
  // A daemon that reports `'ready'` without ever confirming a source really has nothing (#209's
  // reconciliation only sets a real `source` once `ready` fires), so that case is intentionally not
  // covered here and falls through to the ordinary token-less routing below.
  if (!hasCredential && connection.state === 'connected') {
    if (input.daemonState === 'unavailable') return { screen: 'daemon-unavailable' };
    if (input.daemonState !== 'ready') return { screen: 'loading' };
  }

  if (hasCredential && connectedRepos === 'unknown') return { screen: 'loading' };
  const reposSatisfied = typeof connectedRepos !== 'number' || connectedRepos > 0;

  // Note what this does *not* do for `state: 'unavailable'` with a working `source`: the vault
  // being unreadable while a development daemon runs on an inherited variable routes to the app,
  // and `unavailableReason` is dropped. That is intended. The reason exists to explain why
  // connecting cannot work, and this install is not trying to connect — it can already reach
  // GitHub, and the banner names what it is using. Surfacing a vault error to someone who is not
  // blocked by it is noise.
  if (hasCredential && reposSatisfied) {
    return { screen: 'app', environmentCredential: connection.source === 'environment' };
  }

  // Past this line the install is either token-less or has no repos chosen, so it belongs in the
  // pre-app. Which step it lands on is a separate question from which steps it may *visit*.
  const canChooseRepos = hasCredential;
  const step: PreAppStep =
    input.requestedStep && (input.requestedStep !== 'choose-repos' || canChooseRepos)
      ? input.requestedStep
      : canChooseRepos
        ? 'choose-repos'
        : 'device-code';

  return {
    screen: 'pre-app',
    step,
    canChooseRepos,
    // Only ever set alongside `unavailable`; a disconnected vault on a healthy machine has no
    // reason to explain itself.
    ...(connection.state === 'unavailable' && connection.reason
      ? { unavailableReason: connection.reason }
      : {}),
  };
}
