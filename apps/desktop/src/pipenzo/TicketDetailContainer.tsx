import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { ActivityStreamPanel } from './ActivityStreamPanel.js';
import { CumulativeRiskStrip } from './CumulativeRiskStrip.js';
import { ModelRoutingBlock } from './ModelRoutingBlock.js';
import { PhaseStepperPanel } from './PhaseStepperPanel.js';
import { SubscriptionHeadroomBlock } from './SubscriptionHeadroomBlock.js';
import { TicketDetailScreen } from './TicketDetailScreen.js';
import { TicketSwitcherPanel } from './TicketSwitcherPanel.js';

/**
 * The real composition `TicketDetailScreen.tsx`'s own doc comment deferred to issue #341: every
 * slot that has a real, tested panel behind it (issue #91's `PhaseStepperPanel`, #92's
 * `TicketSwitcherPanel`, #95/#96's three rail blocks, #93's `ActivityStreamPanel`) wired to the one
 * ticket this screen is open on -- no mocked phase, risk, routing or stream data anywhere in this
 * path.
 *
 * `ticket` is the board's own `PipenzoTicketViewV1` (the same object `PipenzoAppShell`'s
 * `usePipenzoTickets()` list already holds) -- `riskBlock`/`modelRoutingBlock`/`headroomBlock` read
 * straight off its `risk`/`attempts`/`budget` fields, the wire-persisted state each block's own doc
 * comment says it renders. `stepper`/`ticketSwitcher`/the stream panel each do their own live
 * `pipenzoTicketRead`/phase-event subscription (see `use-ticket-phase-stepper.ts`) rather than
 * trusting this possibly-stale list snapshot for anything that needs to stay current while the
 * screen is open.
 *
 * ## What is deliberately left unwired, and why
 *
 * - **`statusBlock` (issue #94)** -- no component for this rail slot exists yet anywhere in this
 *   codebase (`git grep` for it turns up nothing but this screen's own doc comment naming it). Left
 *   `undefined`, which `TicketDetailScreen` already renders as nothing, rather than guessing at a
 *   design that has not been built.
 * - **`runControls` (issue #103)** -- `RunControls.tsx` exists but needs live Steer/Stop backend
 *   calls (`onSteer`/`onStop`) this codebase has no bridge method for yet (`bridge.ts` has no
 *   steer/stop route). `RunControls`'s own doc comment says a caller renders nothing at all rather
 *   than a disabled control when no session is genuinely live -- that is exactly what omitting this
 *   slot does.
 * - **`lessonPrompt` (issue #104)** -- `LessonPrompt` is real and already wired into
 *   `DiffReviewScreen.tsx`, keyed off that screen's own `resolved` flag (a push or opened PR just
 *   happened, in that same session). Viewing a ticket's detail is not that event -- there is no
 *   "this ticket just resolved" signal to key it off here, so offering it would be a guess at a
 *   trigger this screen does not have. It stays this screen's own future addition once resolution
 *   truly reaches TicketDetail (e.g. once `DiffReviewScreen` itself is reachable from here).
 * - **`ModelRoutingBlock`'s `reviewer`/`verifier`** -- those come from a live `ReviewReportV1`
 *   (see `model-routing.ts`'s own doc comment), and no ticket-store field persists one. Only the
 *   `Implement` row renders here; a Reviewer/Verifier row appears once a live review pass is
 *   threaded through, the same gap `DiffReviewScreen.tsx`'s own module comment already names.
 * - **`PhaseStepperPanel`'s `onSelectSlice`** -- "reporting, not deciding" per that panel's own doc
 *   comment: resolving a step click into an actual scroll/highlight in the stream below needs a
 *   real anchor this screen does not build yet, so the callback is left unset rather than wired to
 *   a no-op that would look like it did something.
 */
export function TicketDetailContainer({
  ticket,
  onSwitchTicket,
}: {
  ticket: PipenzoTicketViewV1;
  onSwitchTicket: (ticketId: string) => void;
}) {
  return (
    <TicketDetailScreen
      ticketId={`#${ticket.issueNumber}`}
      title={ticket.title ?? `Issue #${ticket.issueNumber}`}
      stepper={<PhaseStepperPanel ticketId={ticket.ticketId} />}
      ticketSwitcher={
        <TicketSwitcherPanel activeTicketId={ticket.ticketId} onSwitch={onSwitchTicket} />
      }
      riskBlock={<CumulativeRiskStrip risk={ticket.risk} />}
      modelRoutingBlock={<ModelRoutingBlock attempts={ticket.attempts} />}
      headroomBlock={
        <SubscriptionHeadroomBlock attempts={ticket.attempts} budget={ticket.budget} />
      }
    >
      <ActivityStreamPanel ticketId={ticket.ticketId} />
    </TicketDetailScreen>
  );
}
