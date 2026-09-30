import { useCallback, useEffect, useState } from 'react';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { Chip } from '../components/primitives/Chip.js';
import {
  CommandPalette,
  type CommandPaletteGroup,
  type CommandPaletteItem,
} from '../components/primitives/CommandPalette.js';
import { Kbd } from '../components/primitives/Kbd.js';
import {
  filterReposForPalette,
  filterTicketsForPalette,
  paletteLaneTitle,
  paletteLaneTone,
  paletteTicketLabel,
} from './command-palette-data.js';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Wires `CommandPalette.tsx` (#33 -- presentation and the up/down/enter/esc keyboard model only)
 * into the real board (issue #88): a global Ctrl/Cmd+K to open it from anywhere, ticket results
 * read straight from the board's own ticket-store state (never the poll cache, per #33's own doc
 * comment), repo results from the workspace's real connected-repos list, and the navigation
 * actions that have a real screen behind them today.
 *
 * `tickets` and `repositories` are handed down rather than read here: `PipenzoAppShell.tsx`'s own
 * doc comment already settled "one read, reused everywhere" for the connected-repos list
 * (`useConnectedRepoList`, issue #89) so the workspace switcher and the load-line share a single
 * fetch -- a second, ad-hoc `pipenzoConnectedRepos()` call from inside this component would be
 * exactly the duplicate read that comment argues against.
 *
 * ## Why the Actions group has two rows, not the canvas's four
 *
 * `Main.dc.html` draws "New from idea", "Open Board", "Open Activity" and "Open Settings" here.
 * `PipenzoAppShell.tsx`'s own doc comment already declined to add "Activity" (and "Open PRs",
 * "Models & gates") to the sidebar for a stated reason: a nav item that leads nowhere is worse
 * than one that does not exist, and Activity's own screen is still three open tickets away (#116,
 * #93, #118). "New from idea" is close to unblocked now that `resolvePipenzoCheckout` and
 * `BoardImplementDialog`'s checkout/trust flow exist (#342/#344), but mounting
 * `NewFromIdeaDialog` for real still needs its own answer to a question this ticket has no
 * business deciding on the side -- does drafting an issue need the same workspace-trust gate
 * Implement does, or can it skip straight to a checkout the way a read-only drafter arguably
 * should -- so it stays a follow-up rather than a decision folded into "wire up the palette".
 * "Open Board" and "Open Settings" are the two actions this shell can wire to something real,
 * with no new design questions, today.
 *
 * ## Why a ticket or repo row does what it does
 *
 * A ticket row opens Board, where the ticket-store-backed card already lives -- there is no
 * ticket-detail screen to jump to yet, so "go to the screen that shows it" is the honest version
 * of "jump to a ticket", and it is also the property #33's own doc comment cares about: finding a
 * ticket the board is still waiting on a poll to show. A repo row does what the sidebar's own
 * workspace switcher does for the same repo -- `onSelectRepo` -- and then opens Board, since
 * switching which repo is active is only meaningful looking at the board it (eventually) filters.
 */
export function BoardCommandPalette({
  tickets,
  repositories,
  onOpenBoard,
  onOpenSettings,
  onSelectRepo,
}: {
  tickets: readonly PipenzoTicketViewV1[];
  repositories: readonly string[];
  onOpenBoard: () => void;
  onOpenSettings: () => void;
  onSelectRepo: (repoFullName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const closePalette = useCallback(() => setOpen(false), []);

  // Global shortcuts (issue #88): Ctrl/Cmd+K toggles the palette from anywhere, matching its own
  // trigger's "⌘K" hint. The two real nav actions get the single-letter shortcut the canvas draws
  // next to them, live only while the palette is closed and nothing editable has focus, so typing
  // "b" into a ticket title, a repo filter, or the palette's own search field is never hijacked.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }
      if (open || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      if (event.key === 'b' || event.key === 'B') {
        event.preventDefault();
        onOpenBoard();
      } else if (event.key === ',') {
        event.preventDefault();
        onOpenSettings();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenBoard, onOpenSettings]);

  const selectBoard = useCallback(() => {
    onOpenBoard();
    closePalette();
  }, [onOpenBoard, closePalette]);

  const selectSettings = useCallback(() => {
    onOpenSettings();
    closePalette();
  }, [onOpenSettings, closePalette]);

  const selectRepo = useCallback(
    (fullName: string) => {
      onSelectRepo(fullName);
      onOpenBoard();
      closePalette();
    },
    [onSelectRepo, onOpenBoard, closePalette],
  );

  const filteredTickets = filterTicketsForPalette(tickets, query);
  const filteredRepos = filterReposForPalette(repositories, query);

  const groups: CommandPaletteGroup[] = [];

  if (filteredTickets.length > 0) {
    groups.push({
      title: 'Tickets · recent',
      items: filteredTickets.map(
        (ticket): CommandPaletteItem => ({
          key: `ticket-${ticket.ticketId}`,
          id: `#${ticket.issueNumber}`,
          label: paletteTicketLabel(ticket),
          meta: <Chip tone={paletteLaneTone(ticket.lane)}>{paletteLaneTitle(ticket.lane)}</Chip>,
          onSelect: selectBoard,
        }),
      ),
    });
  }

  if (filteredRepos.length > 0) {
    groups.push({
      title: 'Repos',
      items: filteredRepos.map(
        (fullName): CommandPaletteItem => ({
          key: `repo-${fullName}`,
          label: fullName,
          onSelect: () => selectRepo(fullName),
        }),
      ),
    });
  }

  groups.push({
    title: 'Actions',
    items: [
      {
        key: 'action-board',
        icon: 'board',
        label: 'Open Board',
        meta: <Kbd>B</Kbd>,
        onSelect: selectBoard,
      },
      {
        key: 'action-settings',
        icon: 'settings',
        label: 'Open Settings',
        meta: <Kbd>,</Kbd>,
        onSelect: selectSettings,
      },
    ],
  });

  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      footer={
        <>
          <Kbd>↑↓</Kbd>
          <Kbd>↵</Kbd>
          <span className="grow">
            Tickets come from the ticket store, so the palette finds one the board is still
            waiting on a poll to show.
          </span>
        </>
      }
    />
  );
}
