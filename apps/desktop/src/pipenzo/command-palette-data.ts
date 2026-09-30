import type { PipenzoLaneV1, PipenzoTicketViewV1 } from '@agent-dock/shared';
import type { ChipTone } from '../components/primitives/Chip.js';
import { BOARD_LANES } from './board-lanes.js';

/**
 * The command palette's pure search/label rules (issue #88), separated from `BoardCommandPalette`
 * the same way `repo-picker.ts` is separated from `RepoPicker` -- a filter and a label are rules,
 * not renderings, and testing them without mounting React keeps the wiring component's own tests
 * about wiring rather than string-matching.
 */

/** How many rows the Tickets/Repos groups show before a narrower query is needed -- matching the
 * canvas's "recent" framing (`Tickets · recent`): a jump list, not a full-text browser. */
const MAX_PALETTE_RESULTS = 5;

const LANE_TITLES: Readonly<Record<PipenzoLaneV1, string>> = Object.freeze(
  Object.fromEntries(BOARD_LANES.map((lane) => [lane.lane, lane.title])),
) as Readonly<Record<PipenzoLaneV1, string>>;

/** Lane -> the palette row's trailing `Chip` tone. Queued is the neutral, waiting-to-start state;
 * Working is in flight (warn, matching the board's own lane-dot color); Ready-for-review is the
 * good outcome (ok); Needs-human is the one that wants attention (danger) -- the same tone logic
 * `Chip.tsx`'s own doc comment already states for the board's status chips. */
const LANE_CHIP_TONES: Readonly<Record<PipenzoLaneV1, ChipTone>> = Object.freeze({
  queued: 'neutral',
  working: 'warn',
  'ready-for-review': 'ok',
  'needs-human': 'danger',
});

/** A ticket row's label: the cached title if the ticket has one, `Issue #N` otherwise -- the same
 * fallback `PipenzoAppShell.tsx`'s own `renderTicket` already uses for the board's cards. */
export function paletteTicketLabel(ticket: Pick<PipenzoTicketViewV1, 'title' | 'issueNumber'>): string {
  return ticket.title ?? `Issue #${ticket.issueNumber}`;
}

export function paletteLaneTitle(lane: PipenzoLaneV1): string {
  return LANE_TITLES[lane];
}

export function paletteLaneTone(lane: PipenzoLaneV1): ChipTone {
  return LANE_CHIP_TONES[lane];
}

/**
 * Tickets matching `query`, search-as-you-type (issue #88): by bare issue number (with or
 * without a leading "#", so "85" and "#85" both find issue #85 -- matching how the palette's own
 * `.cmdk-id` column reads it) or by a case-insensitive title substring. An empty query matches
 * everything, capped at `limit`, so opening the palette shows recent tickets rather than an empty
 * group the moment it opens.
 */
export function filterTicketsForPalette(
  tickets: readonly PipenzoTicketViewV1[],
  query: string,
  limit = MAX_PALETTE_RESULTS,
): readonly PipenzoTicketViewV1[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return tickets.slice(0, limit);

  const numberNeedle = needle.replace(/^#/, '');
  const matches = tickets.filter((ticket) => {
    const numberMatch = numberNeedle.length > 0 && String(ticket.issueNumber).includes(numberNeedle);
    const titleMatch = paletteTicketLabel(ticket).toLowerCase().includes(needle);
    return numberMatch || titleMatch;
  });
  return matches.slice(0, limit);
}

/** Connected repos matching `query` by full name -- the same case-insensitive substring rule
 * `repo-picker.ts`'s `filterRepos` uses for the first-run picker, so a repo that matches one
 * search matches the other. */
export function filterReposForPalette(
  repositories: readonly string[],
  query: string,
  limit = MAX_PALETTE_RESULTS,
): readonly string[] {
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? repositories.filter((fullName) => fullName.toLowerCase().includes(needle))
    : repositories;
  return matches.slice(0, limit);
}
