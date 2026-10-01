import { useCallback, useEffect, useState } from 'react';
import type { PipenzoRunStatusResultV1, PipenzoStopResultV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';

/**
 * A single ticket's live run status (issue #103), the `RunControls.tsx` counterpart to
 * `use-ticket-phase-stepper.ts`'s phase-stepper state — same shape, same reasoning: `loading`
 * before the first read lands, `ready` with a real, fresh answer, `error` when the daemon could
 * not be asked. There is no cached "probably still running" state in between; a caller that has
 * not confirmed liveness renders nothing, matching `RunControls.tsx`'s own "no absent state" rule
 * (a caller decides whether to render it at all, never renders it disabled).
 */
export type TicketRunControlsState =
  | { status: 'loading' }
  | { status: 'ready'; run: PipenzoRunStatusResultV1 }
  | { status: 'error' };

/** Same burst-collapsing reasoning as `use-ticket-phase-stepper.ts`'s own constant: a reconciler
 *  tick can announce several tickets at once, and only one of them is this screen's. */
const PHASE_EVENT_DEBOUNCE_MS = 300;

export function useTicketRunControls(ticketId: string): {
  state: TicketRunControlsState;
  /** Delivers one instruction to the running session at its next tool boundary (issue #103) --
   *  never touches the ticket's approved spec. Rejects with the daemon's own error when the
   *  session is not running right now; a caller shows that rather than assuming success. */
  steer: (instruction: string) => Promise<void>;
  /** Abandons only the running session's current in-flight turn and parks the ticket on
   *  `pipenzo:needs-human` -- never a commit or the worktree. Refreshes this hook's own state
   *  immediately after, so a caller does not have to wait for the next phase event to see the
   *  ticket parked, and returns the daemon's own result so a caller can show a "stopped" banner
   *  with real commit/branch numbers rather than guessing them from `run` after it has gone away. */
  stop: () => Promise<PipenzoStopResultV1>;
} {
  const [state, setState] = useState<TicketRunControlsState>({ status: 'loading' });
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let latest = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const read = (): void => {
      latest += 1;
      const generation = latest;
      void getBridge()
        .runStatusPipenzo({ ticketId })
        .then((run) => {
          if (cancelled || generation !== latest) return;
          setState({ status: 'ready', run });
        })
        .catch(() => {
          if (cancelled || generation !== latest) return;
          setState((current) => (current.status === 'ready' ? current : { status: 'error' }));
        });
    };

    const debouncedRead = (): void => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        read();
      }, PHASE_EVENT_DEBOUNCE_MS);
    };

    read();
    const unsubscribeStatus = getBridge().onDaemonStatus((status) => {
      if (status.state === 'ready') read();
    });
    // A run's liveness only ever changes at a phase event: Implement's own dispatch, a completed
    // session moving the ticket to ready-for-review/needs-human, or this hook's own `stop()`
    // parking it there directly. See `use-ticket-phase-stepper.ts`'s doc comment for why filtering
    // the board-wide stream on `ticketId` is the right subscription here too.
    const unsubscribeEvents = getBridge().onPipenzoPhaseEvent((event) => {
      if (event.ticketId === ticketId) debouncedRead();
    });

    return () => {
      cancelled = true;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      unsubscribeStatus();
      unsubscribeEvents();
    };
  }, [ticketId, revision]);

  const steer = useCallback(
    async (instruction: string) => {
      await getBridge().steerPipenzo({ ticketId, instruction });
    },
    [ticketId],
  );

  const stop = useCallback(async () => {
    const result = await getBridge().stopPipenzo({ ticketId });
    refresh();
    return result;
  }, [ticketId, refresh]);

  return { state, steer, stop };
}
