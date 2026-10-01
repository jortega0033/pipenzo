import { useState } from 'react';
import type { PipenzoStopResultV1 } from '@agent-dock/shared';
import { RunControls } from '../components/primitives/RunControls.js';
import { useTicketRunControls } from './use-ticket-run-controls.js';

/**
 * `TicketDetailScreen`'s `runControls` slot (issue #103), filling the gap
 * `TicketDetailContainer.tsx`'s own doc comment names: `RunControls.tsx` existed with no live
 * `onSteer`/`onStop` bridge behind it. This is that bridge's renderer-side caller — the daemon
 * side (`steerImplement`/`stopImplement`/`runStatus`, `pipenzo-phase-service.ts`) is what actually
 * enforces every safety property named below; this component only asks for what a human clicked.
 *
 * Three pieces of local state layer on top of `useTicketRunControls`' real, polled `run` status:
 * - `view` is which of `RunControls`' four states this human is looking at right now (`live` is
 *   the default whenever `run.live` is true; `steer`/`stop-confirm` are this component's own
 *   transient panels, never persisted anywhere).
 * - `stopped` is the one thing worth keeping after `run.live` goes false: the daemon's own
 *   `stopImplement()` result, shown once as this human's own action's outcome. `RunControls.tsx`'s
 *   "no absent state" rule means a caller decides whether to render anything at all once a run is
 *   no longer live — rendering this ticket's own just-completed stop is a deliberate exception to
 *   "present only while genuinely running" (about a *live* run, not about acknowledging the click
 *   that just ended one), not a contradiction of it: reopening this ticket later, after `stopped`
 *   is gone with this component instance, renders nothing, exactly as the rule asks.
 *
 * `worktreePath` on `RunControls`' `stop-confirm`/`stopped` variants is `run.branch` here, not a
 * filesystem path — this surface follows the same "addressed by id/branch, never by path" rule
 * `pipenzoTicketWorktreeViewV1Schema` already states for every other Pipenzo wire contract, and
 * neither `PipenzoRunStatusResultV1` nor `PipenzoStopResultV1` carries one to display.
 */
export function RunControlsPanel({ ticketId }: { ticketId: string }) {
  const { state, steer, stop } = useTicketRunControls(ticketId);
  const [view, setView] = useState<'live' | 'steer' | 'stop-confirm'>('live');
  const [stopped, setStopped] = useState<{ result: PipenzoStopResultV1; time: string } | undefined>(
    undefined,
  );

  if (state.status !== 'ready' || !state.run.live) {
    if (!stopped) return null;
    return (
      <RunControls
        state="stopped"
        time={stopped.time}
        commitCount={stopped.result.commitCount}
        branch={stopped.result.branch}
        worktreePath={stopped.result.branch}
        label={stopped.result.label}
      />
    );
  }

  const run = state.run;
  const commitWord = run.commitCount === 1 ? 'commit' : 'commits';

  if (view === 'steer') {
    return (
      <RunControls
        state="steer"
        onCancel={() => setView('live')}
        onSend={(instruction) => {
          setView('live');
          // Fire-and-forget from this component's own perspective, same as `onStop` below: a
          // rejected steer (the session ended in the race between this click and delivery) simply
          // means the next poll finds `run.live` false and this panel renders nothing, which is
          // the true state either way.
          void steer(instruction);
        }}
      />
    );
  }

  if (view === 'stop-confirm') {
    return (
      <RunControls
        state="stop-confirm"
        commitCount={run.commitCount}
        branch={run.branch}
        worktreePath={run.branch}
        onKeepRunning={() => setView('live')}
        onStop={() => {
          void stop().then((result) => {
            setStopped({ result, time: new Date().toLocaleTimeString() });
            setView('live');
          });
        }}
      />
    );
  }

  return (
    <RunControls
      state="live"
      phaseLabel="Implement is running"
      meta={`${run.model} · ${run.tier} · ${run.commitCount} ${commitWord} on ${run.branch}, nothing pushed`}
      onSteer={() => setView('steer')}
      onStop={() => setView('stop-confirm')}
    />
  );
}
