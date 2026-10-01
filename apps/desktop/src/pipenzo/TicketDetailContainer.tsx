import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { ActivityStreamPanel } from './ActivityStreamPanel.js';
import { CumulativeRiskStrip } from './CumulativeRiskStrip.js';
import { ModelRoutingBlock } from './ModelRoutingBlock.js';
import { PhaseStepperPanel } from './PhaseStepperPanel.js';
import { PlanReviewGate } from './PlanReviewGate.js';
import { RefusalPanel } from './RefusalPanel.js';
import { RunControlsPanel } from './RunControlsPanel.js';
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
 * screen is open. `runControls` (issue #103's `RunControlsPanel`) does the same, through its own
 * `use-ticket-run-controls.ts` -- it renders nothing at all unless a fresh, polled answer says this
 * ticket's dispatched session is genuinely live right now, never a guess from `ticket.attempts`.
 *
 * ## What is deliberately left unwired, and why
 *
 * - **`statusBlock` (issue #94)** -- no component for this rail slot exists yet anywhere in this
 *   codebase (`git grep` for it turns up nothing but this screen's own doc comment naming it). Left
 *   `undefined`, which `TicketDetailScreen` already renders as nothing, rather than guessing at a
 *   design that has not been built.
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
 *
 * ## `RefusalPanel` (issue #469), and what its absence means here
 *
 * Renders at the top of the stream, ahead of the activity feed, for any ticket whose `labels`
 * carry `pipenzo:needs-pre-scoping` *and* whose view carries a `refusal` block
 * (`pipenzoTicketRefusalV1Schema`, `@agent-dock/shared`) -- both real, wire-persisted fields, never
 * a guess. Investigating this ticket found that nothing before it ever let a refusal's
 * estimate/tripped-threshold/proposedSplit survive past the original Refine request/response
 * cycle: `#reportRefusal` (`pipenzo-phase-service.ts`) now caches the spec onto the ticket record
 * the moment the diff-size gate refuses it (the same early write issue #99's `stack` verdict
 * already made), and `toTicketView()` (`routes/pipenzo-tickets.ts`) surfaces just its
 * `estimate`/`proposedSplit` as `refusal`.
 *
 * A `needs-pre-scoping` ticket with no `refusal` block is not a bug to paper over -- it is a
 * ticket refused before this caching existed, or one whose best-effort cache write failed the same
 * way `#reportStackVerdict`'s already can. Nothing renders in its place, the same "absent, not
 * faked" convention every other unavailable slot on this screen already follows, rather than a
 * placeholder that would assert a number this screen does not actually have.
 *
 * `onRetryRefine` is left unset, same reasoning as `runControls` above: retrying Refine needs a
 * repository checkout, a provider and a model, none of which this container is given -- the same
 * inputs `ImplementDialog.tsx`'s own "Refine ticket" step already asks the operator for. Omitting
 * the callback is exactly what `RefusalPanel`'s own doc comment already sanctions for a caller
 * without a real retry to offer; inventing one with nothing behind it would be worse than the
 * button not existing at all.
 *
 * ## `PlanReviewGate` (issue #15, UI half #101)
 *
 * Renders at the top of the stream, ahead of `RefusalPanel` and the activity feed, for any ticket
 * whose view carries `planReview` -- `toTicketView()`'s own real, wire-persisted projection
 * (`pipenzoTicketPlanReviewV1Schema`, `@agent-dock/shared`), populated only when the ticket's local
 * `awaitingPlanReview` marker is genuinely set and its cached spec survived. No label to check here
 * the way `RefusalPanel`'s own `pipenzo:needs-pre-scoping` is: the gate deliberately parks a ticket
 * under the bare `pipenzo:needs-human` label instead of a dedicated one (see
 * `pipenzoTicketRecordV1Schema.awaitingPlanReview`'s own doc comment for why), so `planReview`'s
 * mere presence on the wire is the one real signal this container has, mirroring exactly how
 * `needs-human-card.ts`'s own `classifyNeedsHumanCard` reads the same field for the board card.
 *
 * Unlike `RefusalPanel`, this is not purely presentational over already-fetched ticket fields --
 * approving, requesting changes, or rejecting are real daemon round trips `PlanReviewGate` makes
 * itself (via `use-plan-review.ts`), the same "does its own live bridge calls rather than trusting
 * this possibly-stale list snapshot" shape `runControls`/`stepper` above already use. `repo` is
 * passed through because `approve()` needs it to resolve a repository checkout the same way
 * `BoardImplementDialog.tsx` already does -- see that hook's own doc comment for why this is the one
 * plan-review action that needs more than `ticketId` alone, and why that does not reopen the
 * `onRetryRefine`-shaped gap just closed above for a different action.
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
      runControls={<RunControlsPanel ticketId={ticket.ticketId} />}
      riskBlock={<CumulativeRiskStrip risk={ticket.risk} />}
      modelRoutingBlock={<ModelRoutingBlock attempts={ticket.attempts} />}
      headroomBlock={
        <SubscriptionHeadroomBlock attempts={ticket.attempts} budget={ticket.budget} />
      }
    >
      {ticket.planReview && <PlanReviewGate ticketId={ticket.ticketId} repo={ticket.repo} />}
      {ticket.labels.includes('pipenzo:needs-pre-scoping') && ticket.refusal && (
        <RefusalPanel
          repo={ticket.repo}
          issueNumber={ticket.issueNumber}
          estimate={ticket.refusal.estimate}
          proposedSplit={ticket.refusal.proposedSplit}
        />
      )}
      <ActivityStreamPanel ticketId={ticket.ticketId} />
    </TicketDetailScreen>
  );
}
