import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { PhaseStepper } from '../components/primitives/PhaseStepper.js';
import { Notice } from '../components/primitives/Notice.js';
import { Skeleton } from '../components/primitives/Skeleton.js';
import { ticketPhaseSteps, type TicketPhaseStepId } from './ticket-phase-steps.js';
import { useTicketPhaseStepper } from './use-ticket-phase-stepper.js';

export interface TicketPhaseSliceSelection {
  stepId: TicketPhaseStepId;
  ticket: PipenzoTicketViewV1;
}

/**
 * TicketDetail's phase stepper (issue #91, split of epic #3), wired to real data: `PhaseStepper.tsx`
 * (issue #64's presentational primitive) driven by `useTicketPhaseStepper` (bound to the phase
 * machine and its phase-change SSE stream) through `ticketPhaseSteps` (the pure data mapping) --
 * no mocked phase data anywhere in this path.
 *
 * There is no `TicketDetail` screen to mount this into yet, and no router in this app at all -- the
 * same gap `BoardScreen.tsx`'s own doc comment states about `onConnectRepo`/`onNewFromIdea`. So
 * `onSelectSlice` is an optional callback rather than built-in navigation: this panel's job is
 * reporting *which* step a click targeted against real ticket data, not deciding what a click does
 * once a ticket-detail screen and a place to send it exist.
 */
export function PhaseStepperPanel({
  ticketId,
  onSelectSlice,
}: {
  ticketId: string;
  /** "Click-to-view-slice": fired with the clicked step and the ticket it belongs to. A completed
   * step's slice is the cluster of activity-stream events that phase produced (issue #65's `Evt`
   * rows); the CI step's slice is the ci-failed block. Resolving that into an actual scroll/highlight
   * is the mounting screen's job -- see this component's own doc comment for why. */
  onSelectSlice?: (selection: TicketPhaseSliceSelection) => void;
}) {
  const { state } = useTicketPhaseStepper(ticketId);

  if (state.status === 'loading') {
    return (
      <div className="stepper" aria-busy="true" data-testid="phase-stepper-loading">
        {[64, 96, 84, 72, 76].map((width, index) => (
          <Skeleton key={index} width={width} height={32} shape="pill" />
        ))}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <Notice tone="danger" icon="warning" title="Could not read this ticket's phase">
        The daemon did not answer for #{ticketId} — try again once it reconnects.
      </Notice>
    );
  }

  const { ticket } = state;
  const { steps, hint } = ticketPhaseSteps(ticket);

  return (
    <PhaseStepper
      steps={steps}
      onSelect={(id) => onSelectSlice?.({ stepId: id as TicketPhaseStepId, ticket })}
      hint={hint}
    />
  );
}
