import { useMemo, useState } from 'react';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { filterActivityTickets, type ActivityFilterKey } from './activity-filters.js';

/**
 * Owns "which of `Activity.dc.html`'s five tabs is active" and derives the filtered ticket list from
 * it (issue #117). Split out from `ActivityFilterBar` for the same reason `use-screenshot-lightbox.ts`
 * is split from `ScreenshotEvidence.tsx`: the bar renders a tab and reports a click, a real caller
 * needs the click to actually narrow what `ActivityScreen` renders, and that state has to live above
 * both `ActivityFilterBar` and `ActivityScreen` since neither owns the other.
 *
 * `tickets` in, `tickets` (filtered) and `active` out — the exact shape a caller wires straight into
 * `<ActivityScreen tickets={filteredTickets} filterBar={<ActivityFilterBar tickets={tickets}
 * active={active} onChange={setActive} />} .../>`. Nothing here reads a daemon or a bridge; a future
 * ticket wiring this into the real app shell (there is no Activity route mounted yet — see
 * `PipenzoAppShell.tsx`'s own doc comment on which screens are actually wired) supplies its own
 * `usePipenzoTickets()` list, the same way `TicketSwitcherPanel.tsx` supplies its own.
 */
export function useActivityFilter(tickets: readonly PipenzoTicketViewV1[]): {
  active: ActivityFilterKey;
  setActive: (key: ActivityFilterKey) => void;
  filteredTickets: readonly PipenzoTicketViewV1[];
} {
  const [active, setActive] = useState<ActivityFilterKey>('all');
  const filteredTickets = useMemo(
    () => filterActivityTickets(tickets, active),
    [tickets, active],
  );
  return { active, setActive, filteredTickets };
}
