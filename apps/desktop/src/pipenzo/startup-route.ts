import type { PipenzoGitHubConnectionV1 } from '@agent-dock/shared';

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
export type ConnectedRepoState = 'not-tracked' | number;

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
       * True when the running daemon's credential came from an inherited `PIPENZO_GITHUB_TOKEN`
       * rather than the vault. The rule epic #4 actually cares about is not "no fallbacks" but "no
       * **silent** precedence" — a development build publishing with a shell variable is fine, and
       * publishing with one while the UI implies a stored account is not. `pipenzo-credential-v1.ts`
       * records this field as unrendered and names this ticket as the one that renders it.
       */
      readonly environmentCredential: boolean;
    };

export interface PipenzoStartupInput {
  /** `undefined` until the first `pipenzoGitHubConnection()` call resolves. */
  readonly connection: PipenzoGitHubConnectionV1 | undefined;
  /** The step the user navigated to, if they navigated at all. */
  readonly requestedStep?: PreAppStep;
  readonly connectedRepos?: ConnectedRepoState;
}

/**
 * The whole routing rule, in one place.
 *
 * The ordering below is the argument. **Whether a usable credential exists** is asked first and is
 * asked of `source`, not of `state`: `state` describes the vault, and the vault is not the only
 * place a credential can come from. A development build with an empty vault and a
 * `PIPENZO_GITHUB_TOKEN` in its environment has a daemon that can reach GitHub right now, and
 * sending that install to "Connect GitHub" would be both false and unfixable from that screen —
 * connecting stores into a vault the daemon is not reading this run.
 */
export function routePipenzoStartup(input: PipenzoStartupInput): PipenzoStartupRoute {
  const { connection } = input;
  if (!connection) return { screen: 'loading' };

  const connectedRepos = input.connectedRepos ?? 'not-tracked';
  const hasCredential = connection.source !== 'none';
  const reposSatisfied = connectedRepos === 'not-tracked' || connectedRepos > 0;

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
