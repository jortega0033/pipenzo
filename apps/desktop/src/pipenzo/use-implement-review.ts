import { useEffect, useState } from 'react';
import type {
  ModelTier,
  PipenzoImplementCommitsV1,
  PipenzoImplementResultV1,
  PipenzoReviewRequestV1,
  PipenzoReviewResultV1,
  ProviderId,
  RefineSpecV1,
} from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { useAsyncAction, type AsyncActionState } from './use-async-action.js';

/**
 * Poll implement/result + a "Run review" action (Pipenzo issue #90's follow-on: the app's core
 * loop currently dead-ends at "Implement started" because nothing after `ImplementDialog`'s Start
 * ever reads what the dispatched session did). Both `implementResultPipenzo` and `reviewPipenzo`
 * were already wired end-to-end -- daemon route, IPC handler, preload bridge, `window.d.ts` --
 * by issue #184/#192; nothing in `apps/desktop/src/pipenzo/` had called either one yet. This file
 * is the first real caller.
 */

/** How often `implement/result` is polled while the dispatched session is still `'running'`.
 *
 * No existing precedent in this codebase sets this number, so it is picked here: frequent enough
 * that a finished run becomes visible within a few seconds, and comfortably under the phase
 * routes' own human-paced rate limit (`pipenzo-phases.ts`'s `{ max: 10, timeWindow: '1 minute' }`)
 * even with one ticket screen open and polling continuously. */
export const IMPLEMENT_POLL_INTERVAL_MS = 4_000;

export type ImplementPollStatus = 'polling' | 'ready' | 'error';

export type ImplementPollState =
  | { readonly status: 'polling' }
  | { readonly status: 'ready'; readonly commits: PipenzoImplementCommitsV1 }
  | { readonly status: 'error'; readonly message: string };

/**
 * Polls `implementResultPipenzo` from the moment a dispatched Implement session's identity
 * (`started`) is known until the session reaches a terminal state (issue #192's
 * `ImplementSessionStateV1`: anything other than `'running'`, including the two states that mean
 * "terminal, but committed nothing" -- `commits.sessionState` is what draws that line, not this
 * hook, which only ever asks "is it still worth polling again".
 *
 * `started` is `undefined` before a dispatch exists (e.g. `ImplementDialog` has not returned yet)
 * -- the hook then reports `'polling'` forever and never calls the bridge, the same "nothing to
 * read yet" shape `usePipenzoGitHubHealth` reports before its first frame arrives.
 *
 * A thrown `implementResultPipenzo` call (including the daemon's own `implement_empty_diff` --
 * `pipenzo-phases.ts` maps that outcome to a rejected call, not a success shape with an empty
 * array) is reported as `'error'` with the daemon's message. Nothing on the IPC boundary threads a
 * structured error `code` back to the renderer today -- every existing phase-route caller
 * (`ImplementDialog.tsx`'s `runStart`, `PublishActions.tsx`'s push) already reads only `.message`
 * for the same reason -- so a caller that wants to say something sharper about an empty diff
 * specifically has to read it out of the message text, the same boundary every other caller lives
 * with rather than a new one this hook introduces.
 */
export function useImplementPoll(
  started: Pick<PipenzoImplementResultV1, 'worktreeId' | 'branch' | 'baseCommit'> | undefined,
): ImplementPollState {
  const [state, setState] = useState<ImplementPollState>({ status: 'polling' });
  // Read out as primitives, and only these -- never `started` itself -- so the effect below
  // restarts when the dispatch this hook is polling actually changes, not whenever a caller
  // re-renders with a fresh-but-equal `started` object (`ImplementDialog`'s own `onStarted`
  // payload is exactly that: a new object literal on every dispatch, including ones this hook has
  // already started polling for).
  const worktreeId = started?.worktreeId;
  const branch = started?.branch;
  const baseCommit = started?.baseCommit;

  useEffect(() => {
    if (worktreeId === undefined || branch === undefined || baseCommit === undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = () => {
      void getBridge()
        .implementResultPipenzo({ worktreeId, branch, baseCommit })
        .then((commits) => {
          if (cancelled) return;
          if (commits.sessionState === undefined || commits.sessionState === 'running') {
            setState({ status: 'polling' });
            timer = setTimeout(poll, IMPLEMENT_POLL_INTERVAL_MS);
            return;
          }
          setState({ status: 'ready', commits });
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          setState({
            status: 'error',
            message: caught instanceof Error ? caught.message : 'the request failed',
          });
        });
    };

    setState({ status: 'polling' });
    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [worktreeId, branch, baseCommit]);

  return state;
}

/**
 * A reviewer/verifier model choice, real and human-supplied -- never invented here.
 *
 * `PipenzoReviewRequestV1.reviewer.model`/`.verifier.model` are dispatched *as the literal model
 * argument* to the provider CLI (`review-gates.ts`'s `#runReviewer`/`#runVerifier` pass
 * `request.reviewer.model` straight into `this.#sessions.run({ model: ... })`), so a wrong or
 * placeholder string here is not a cosmetic gap -- it is a real, wrong argument to a real process.
 * Unlike `ImplementDialog`'s `model` (optional; omitted means "the CLI's own default"), Review's
 * wire contract requires a concrete model string on both passes, and nothing reachable from the
 * desktop today can resolve one on a caller's behalf: `ProviderStatusV2` (`listProvidersV2`)
 * carries no model catalog, and there is no Models & gates screen yet (README's own "designed, not
 * wired in yet" list). So this type -- and `buildReviewRequest` below -- take the choice as an
 * explicit input a human supplied, the same deferral this codebase already uses for `renderTicket`,
 * `onConnectRepo`/`onNewFromIdea`, and `onRetryRefine`: the caller owns picking it, this file only
 * owns turning a picked value into a valid request.
 */
export interface ReviewModelChoice {
  readonly provider: ProviderId;
  readonly model: string;
  readonly tier: ModelTier;
}

/**
 * Assembles a `PipenzoReviewRequestV1` from what a finished implement poll actually returned plus
 * an explicit reviewer/verifier choice -- pure, so it is trivial to unit test without a bridge.
 *
 * `implementerTier` is threaded through from the caller rather than guessed at here for the same
 * reason `reviewer`/`verifier` are: nothing resolves "what tier did the dispatched Implement
 * session actually run at" from `PipenzoImplementResultV1`/`PipenzoImplementCommitsV1` (neither
 * carries a tier), and README's own rule -- the verifier must never be weaker than the implementer
 * -- is meaningless to enforce against a guess.
 */
export function buildReviewRequest(options: {
  readonly spec: RefineSpecV1;
  readonly commits: Pick<PipenzoImplementCommitsV1, 'worktreeId' | 'baseCommit' | 'headCommit'>;
  readonly implementerTier: ModelTier;
  readonly implementerProvider?: ProviderId;
  readonly reviewer: ReviewModelChoice;
  readonly verifier: ReviewModelChoice;
  readonly ticketId?: string;
}): PipenzoReviewRequestV1 {
  return {
    spec: options.spec,
    worktreeId: options.commits.worktreeId,
    baseCommit: options.commits.baseCommit,
    headCommit: options.commits.headCommit,
    implementerTier: options.implementerTier,
    ...(options.implementerProvider ? { implementerProvider: options.implementerProvider } : {}),
    reviewer: options.reviewer,
    verifier: options.verifier,
    ...(options.ticketId ? { ticketId: options.ticketId } : {}),
  };
}

export interface ReviewActionState extends Omit<AsyncActionState<PipenzoReviewResultV1>, 'run'> {
  /** Runs `reviewPipenzo` with this request, tracking pending/error state the same way
   * `AsyncActionState.run` does around an arbitrary thunk. */
  run: (request: PipenzoReviewRequestV1) => Promise<PipenzoReviewResultV1 | undefined>;
}

/**
 * The "Run review" action: `reviewPipenzo` under `useAsyncAction`'s pending/error/retry shape
 * (issue #69's pattern), decoupled from request assembly -- a caller builds the request (typically
 * via `buildReviewRequest` above, once it has a real reviewer/verifier choice) and passes it to
 * `run`. Exported as its own hook, rather than folded into `useImplementPoll`, because the two have
 * different lifetimes: polling starts the moment a dispatch exists and stops itself once terminal,
 * while review only ever runs on an explicit click and only once commits are `'ready'`.
 */
export function useReviewAction(): ReviewActionState {
  const action = useAsyncAction<PipenzoReviewResultV1>();
  return {
    ...action,
    run: (request) => action.run(() => getBridge().reviewPipenzo(request)),
  };
}
