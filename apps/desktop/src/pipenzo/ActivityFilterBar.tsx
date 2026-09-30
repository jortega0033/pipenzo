import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { Segmented } from '../components/primitives/Segmented.js';
import {
  ACTIVITY_FILTER_OPTIONS,
  countActivityFilters,
  type ActivityFilterKey,
} from './activity-filters.js';

/**
 * `Activity.dc.html`'s `.seg` filter tabs (issue #117), dropped into `ActivityScreen`'s `filterBar`
 * slot. The same `Segmented` pill-button-group primitive `TicketSwitcherPanel.tsx` already uses for
 * this exact canvas element — its own doc comment names "Activity's filter tabs" as one of the
 * controls sharing this one visual treatment, so this component reuses it rather than hand-rolling a
 * second `.seg` markup.
 *
 * Every count comes from `countActivityFilters(tickets)` — the real ticket list a caller already has
 * from `usePipenzoTickets()`, the same unfiltered list `ActivityScreen` itself renders — never a
 * separate tally kept in sync by hand. `${count}/${total}` is this component's own rendering of the
 * issue's "N of M events" ask: `total` is `tickets.length`, identical to the number `ActivityScreen`'s
 * own feed-count line reports, so the two can never drift apart.
 *
 * This component only reports which tab is active — the same "reporting, not deciding" shape
 * `TicketSwitcherPanel`'s `onSwitch` and `BoardScreen`'s `onConnectRepo` already use. Turning that
 * into an actually-filtered `tickets` prop for `ActivityScreen` is the caller's job (see
 * `use-activity-filter.ts`), the same division `ActivityScreen.tsx`'s own doc comment draws between
 * this control and the shell it plugs into.
 */
export function ActivityFilterBar({
  tickets,
  active,
  onChange,
}: {
  /** Every ticket the feed is built from, unfiltered — the same list `ActivityScreen` is handed. */
  tickets: readonly PipenzoTicketViewV1[];
  active: ActivityFilterKey;
  onChange: (key: ActivityFilterKey) => void;
}) {
  const counts = countActivityFilters(tickets);
  const total = tickets.length;

  return (
    <Segmented
      aria-label="Filter activity"
      value={active}
      onChange={onChange}
      options={ACTIVITY_FILTER_OPTIONS.map((option) => ({
        value: option.key,
        label: `${option.label} ${counts[option.key]}/${total}`,
      }))}
    />
  );
}
