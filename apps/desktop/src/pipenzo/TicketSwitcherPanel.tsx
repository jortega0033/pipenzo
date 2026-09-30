import { Segmented } from '../components/primitives/Segmented.js';
import { Skeleton } from '../components/primitives/Skeleton.js';
import { ticketsByLane } from './board-lanes.js';
import { usePipenzoTickets } from './use-pipenzo-tickets.js';

/**
 * TicketDetail's "Needs you" ticket switcher (issue #92, split of epic #3): `TicketDetail.dc.html`'s
 * `.switch` -- a `Segmented` control (the same pill-button-group primitive `Foundations.dc.html`
 * shares across Simple/Expert, Connect's step bar, and Activity's filter tabs) listing every ticket
 * the board's own `needs-human` lane holds right now. Wired through `usePipenzoTickets()` and
 * `board-lanes.ts`'s `ticketsByLane` -- the same lane grouping `BoardScreen.tsx` already trusts,
 * never a second "what counts as needs-human" filter invented here. No mocked ticket data anywhere
 * in this path.
 *
 * ## Reporting, not deciding
 *
 * `onSwitch` fires with the clicked ticket's id -- the same "reporting, not deciding" shape
 * `PhaseStepperPanel.tsx`'s `onSelectSlice` and `BoardScreen.tsx`'s `onConnectRepo` already use.
 * There is no `TicketDetail` container mounted yet to own "which ticket is currently open" (that
 * composition, and the routing it implies, is #341's job -- see `TicketDetailScreen.tsx`'s own doc
 * comment), so this panel does not carry that state itself and cannot navigate on its own.
 *
 * ## Resetting per-ticket state on switch is the caller's job, not this panel's
 *
 * `TicketDetail.dc.html`'s own mock logic answers what "switch" should do to the rest of the
 * screen directly: its ticket-switcher `select` handler resets every piece of in-flight decision
 * state the canvas tracks (`medium`, `stackDecision`, `highDecision`, `planDecision`, `run`,
 * `lesson`) back to null in the same call that changes which ticket is open. This panel has no
 * access to that state -- it lives in whatever real components the caller mounts below the switch
 * (e.g. `LessonPrompt.tsx`, whose own doc comment makes the identical call: "a fresh resolution is
 * a fresh mount, keyed by whatever identifies that resolution at the call site -- this component
 * has no notion of 'resolution' of its own to re-key against"). The caller already owns
 * `activeTicketId` -- it is the one place that can key the ticket-scoped subtree it renders by that
 * id so React remounts it fresh on every switch, rather than this panel guessing at a subtree it
 * does not own. `TicketSwitcherPanel.test.tsx` proves that composition actually resets a real
 * per-ticket component's state, not just that a ticket id prop changed.
 */
export function TicketSwitcherPanel({
  activeTicketId,
  onSwitch,
}: {
  /** The ticket currently open in TicketDetail -- highlighted in the control, matching
   *  `TicketDetail.dc.html`'s `k.cls` (`'active'` on the current ticket, unset otherwise). */
  activeTicketId: string;
  /** Fired with the clicked ticket's id. `Segmented` only calls `onChange` on an actual value
   *  change, so this never fires for the already-active ticket. */
  onSwitch: (ticketId: string) => void;
}) {
  const { ticketList } = usePipenzoTickets();

  if (ticketList.status === 'loading') {
    return (
      <div className="switch" data-testid="ticket-switcher-loading" aria-busy="true">
        <span className="label">Needs you</span>
        <Skeleton width={96} height={32} shape="pill" />
      </div>
    );
  }

  // An error and a genuinely empty needs-human lane both render nothing: there is nothing to
  // switch to either way, and `TicketDetailScreen`'s own step-row already collapses away when
  // neither the stepper nor this switcher is supplied.
  if (ticketList.status === 'error') return null;

  const needsHuman = ticketsByLane(ticketList.tickets)['needs-human'];
  if (needsHuman.length === 0) return null;

  return (
    <div className="switch">
      <span className="label">Needs you</span>
      <Segmented
        aria-label="Needs you"
        value={activeTicketId}
        options={needsHuman.map((ticket) => ({
          value: ticket.ticketId,
          label: `#${ticket.issueNumber}`,
        }))}
        onChange={onSwitch}
      />
    </div>
  );
}
