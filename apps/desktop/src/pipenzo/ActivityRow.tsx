import type { KeyboardEvent } from 'react';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { Icon } from '../components/primitives/Icon.js';
import { Chip } from '../components/primitives/Chip.js';
import type { ActivityRowEntry } from './activity-grouping.js';
import { activityRowTime, activityRowTitle, classifyActivityRow } from './activity-row.js';

/**
 * `Activity.dc.html`'s `.act` row (issue #118, the last split of epic #3) -- the real `renderEntry`
 * `ActivityScreen.tsx` takes as a required prop (see that file's own doc comment: a placeholder row
 * built there would be a design this ticket gets to guess wrong before it exists). One row per
 * `ActivityRowEntry` (`activity-grouping.ts`), its content entirely decided by `classifyActivityRow`
 * (`activity-row.ts`) -- this component only lays the result out: a mono time column, a tone-coded
 * icon well, the id/title/state-chip head, a detail paragraph, and a mono meta line, matching the
 * canvas's `.act`/`.act-ic`/`.act-head`/`.act-detail`/`.act-meta` structure exactly.
 *
 * ## Deep-link: reporting, not deciding
 *
 * `onOpenTicket` fires with the row's own ticket -- the same "reporting, not deciding" shape
 * `PhaseStepperPanel.tsx`'s `onSelectSlice` and `TicketSwitcherPanel.tsx`'s `onSwitch` already use.
 * Both of those components' own doc comments explain why: there is still no router in this app, so
 * this row cannot navigate on its own -- resolving "open ticket #94" into an actual screen change is
 * whatever container eventually mounts `ActivityScreen` with this component as its `renderEntry`.
 * The whole row is the click target -- `Card.tsx`'s own `tabIndex`/`role="button"`/Enter-Space
 * convention -- with the canvas's trailing chevron (`.act-go`) staying purely decorative, exactly as
 * `Card.tsx` leaves its own chevron-equivalent affordances to the row itself.
 */
export function ActivityRow({
  entry,
  onOpenTicket,
}: {
  entry: ActivityRowEntry;
  /** Fired with this row's ticket when the row is clicked, or activated with Enter/Space while
   *  focused. Omit to render a non-interactive row (e.g. a read-only preview context). */
  onOpenTicket?: (ticket: PipenzoTicketViewV1) => void;
}) {
  const { ticket } = entry;
  const classification = classifyActivityRow(ticket);
  const iconClass = classification.tone === 'neutral' ? 'act-ic' : `act-ic ${classification.tone}`;

  const onClick = onOpenTicket ? () => onOpenTicket(ticket) : undefined;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onClick) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <div
      className="act"
      tabIndex={0}
      role={onClick ? 'button' : undefined}
      onClick={onClick}
      onKeyDown={onClick ? onKeyDown : undefined}
    >
      <span className="act-time">{activityRowTime(entry)}</span>
      <span className={iconClass}>
        <Icon name={classification.icon} size="sm" />
      </span>
      <span className="act-body">
        <span className="act-head">
          <span className="act-id">#{ticket.issueNumber}</span>
          <span className="act-title">{activityRowTitle(ticket)}</span>
          <Chip tone={classification.chipTone}>{classification.chipLabel}</Chip>
        </span>
        <span className="act-detail">{classification.detail}</span>
        <span className="act-meta">{classification.meta}</span>
      </span>
      <Icon name="caret-right" size="sm" className="act-go" />
    </div>
  );
}
