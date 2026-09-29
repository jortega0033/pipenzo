import { useCallback, useState } from 'react';
import type { PipenzoImplementResultV1, PipenzoTicketViewV1 } from '@agent-dock/shared';
import {
  AppShell,
  Crumbs,
  MainHead,
  MainHeadRight,
  NavGroup,
  NavItem,
  Sidebar,
  SidebarBrand,
} from '../components/primitives/AppShell.js';
import { Banner } from '../components/primitives/Banner.js';
import { Button } from '../components/primitives/Button.js';
import { Card, CardFoot, CardMeta } from '../components/primitives/Card.js';
import { Chip } from '../components/primitives/Chip.js';
import { SyncStatusPill, type SyncStatus } from '../components/primitives/SyncStatusPill.js';
import { BoardImplementDialog } from './BoardImplementDialog.js';
import { BoardScreen } from './BoardScreen.js';
import { SettingsPage } from './SettingsPage.js';
import { usePipenzoTickets } from './use-pipenzo-tickets.js';

/**
 * The real, connected-session shell (issue #274): `Main.dc.html`'s `AppShell`/`Sidebar`/`MainHead`
 * frame, hosting `BoardScreen` (#81) as the default view and `SettingsPage` (#125) as a navigable
 * second one. This is what replaces `<App>` -- the AgentDock demo shell this product inherited --
 * for a real, non-demo session; `AppRoot.tsx` still renders `<App>` for `demoMode`, since
 * `demo-bridge.ts`'s Pipenzo methods (`pipenzoListTickets` included) throw rather than answer, and
 * this shell has nothing else to show.
 *
 * ## Why the nav is exactly two items
 *
 * `Main.dc.html`'s own sidebar also carries "Needs me", "Activity", "Open PRs" and "Models & gates"
 * -- none of which have a screen behind them yet. A nav item that leads nowhere is worse than one
 * that does not exist: it is a control a person can click, in an app whose whole premise is "every
 * action is real or absent, never decorative". Board and Settings are the two screens #274 was
 * actually asked to mount (`BoardScreen`, `SettingsPage`); the rest are their own future tickets,
 * each free to add its own row when it lands.
 *
 * ## Where the tickets come from
 *
 * `usePipenzoTickets` (issue #255) is called here, not threaded down from `AppRoot.tsx` -- the
 * board's data is this shell's own concern once it exists, the same way `BoardScreen.tsx`'s own doc
 * comment already anticipated ("whoever mounts `BoardScreen` for real wires... the real data").
 * `'loading'` renders the board with an empty ticket list, same as before: `usePipenzoTickets`'s
 * own doc comment says a `'loading'` answer is not worth a screen of its own here, and `BoardScreen`
 * already renders a truthful empty state for it. `'error'` is different (issue #276): rather than
 * rendering that same silent empty board -- indistinguishable from a genuinely clean backlog -- a
 * `Banner` above it says the read failed and offers `usePipenzoTickets`'s own `refresh()` as a
 * retry. The board still renders underneath, empty, since there is nothing better to show it.
 *
 * ## What a ticket card looks like here
 *
 * `Card` -- id/title, plus the one status chip and foot line each lane's own real data already
 * supports without guessing (Working's phase, Ready-for-review's branch). This still is not a
 * guess at #85/#86/#87's lane-specific card content: Needs-human's seven variants (#86) and
 * Working's capacity pill/held cards (#85) stay their own tickets, and nothing here invents data
 * those tickets are meant to add -- `ticket.phase`/`ticket.worktree` are already real fields on
 * `PipenzoTicketViewV1`, not placeholders standing in for a schema that does not exist yet.
 *
 * ## Queued cards open the Implement dialog (issue #342)
 *
 * A Queued card is the one card this shell makes clickable: `Card`'s own `onClick` (which also
 * makes it a keyboard-reachable `button`) opens `BoardImplementDialog` for that ticket, which
 * resolves the repo's local checkout (#344) and then mounts the real `ImplementDialog`. Only
 * Queued, because README's Implement is the action a Queued ticket is waiting for -- a Working,
 * Ready-for-review or Needs-human card has a different next action, owned by #85/#86/#87, and making
 * those clickable here would be guessing at it.
 *
 * `onImplementStarted` reports a successful dispatch upward rather than toasting here, because the
 * toast stack lives in `AppRoot` alongside the sync pill's own failure toast. The dialog closes
 * itself on success: its Start button would otherwise still be there, and a second press would try
 * to cut a second worktree for the same ticket.
 */
export function PipenzoAppShell({
  sync,
  onRefreshSync,
  onImplementStarted,
  onImplementFailed,
}: {
  sync: { status: SyncStatus; label: string };
  onRefreshSync: () => void;
  onImplementStarted?: (ticket: PipenzoTicketViewV1, started: PipenzoImplementResultV1) => void;
  /** Issue #77: a real Start failure, named by the ticket it failed for -- the toast stack lives in
   * `AppRoot`, same as the success case above. */
  onImplementFailed?: (ticket: PipenzoTicketViewV1, message: string, retry: () => void) => void;
}) {
  const [view, setView] = useState<'board' | 'settings'>('board');
  const { ticketList, refresh } = usePipenzoTickets();
  const [implementing, setImplementing] = useState<PipenzoTicketViewV1>();

  const renderTicket = useCallback(
    (ticket: PipenzoTicketViewV1) => (
      <Card
        id={`#${ticket.issueNumber}`}
        title={ticket.title ?? `Issue #${ticket.issueNumber}`}
        chip={laneChip(ticket)}
        {...(ticket.lane === 'queued' ? { onClick: () => setImplementing(ticket) } : {})}
      >
        {ticket.lane === 'ready-for-review' && ticket.worktree && (
          <CardFoot>
            <CardMeta icon="git-branch">{ticket.worktree.branch}</CardMeta>
          </CardFoot>
        )}
      </Card>
    ),
    [],
  );

  return (
    <AppShell
      sidebar={
        <Sidebar>
          <SidebarBrand />
          <NavGroup title="Work">
            <NavItem icon="board" active={view === 'board'} onClick={() => setView('board')}>
              Board
            </NavItem>
          </NavGroup>
          <NavGroup title="Repo">
            <NavItem icon="settings" active={view === 'settings'} onClick={() => setView('settings')}>
              Settings
            </NavItem>
          </NavGroup>
        </Sidebar>
      }
    >
      <MainHead>
        <Crumbs items={[view === 'board' ? 'Board' : 'Settings']} />
        <MainHeadRight>
          <SyncStatusPill status={sync.status} label={sync.label} onRefresh={onRefreshSync} />
        </MainHeadRight>
      </MainHead>
      {view === 'board' ? (
        <>
          {ticketList.status === 'error' && (
            <Banner
              icon="warning"
              tone="danger"
              action={
                <Button size="sm" variant="ghost" onClick={refresh}>
                  Retry
                </Button>
              }
            >
              Couldn&apos;t read the ticket list from the local daemon. The board below is empty
              until this succeeds.
            </Banner>
          )}
          <BoardScreen
            tickets={ticketList.status === 'ready' ? ticketList.tickets : []}
            renderTicket={renderTicket}
          />
        </>
      ) : (
        <SettingsPage />
      )}
      {implementing && (
        <BoardImplementDialog
          // Keyed by ticket so opening a different card never inherits the last one's checkout,
          // trust answer or refined spec.
          key={implementing.ticketId}
          ticket={implementing}
          onClose={() => setImplementing(undefined)}
          onStarted={(started) => {
            setImplementing(undefined);
            refresh();
            onImplementStarted?.(implementing, started);
          }}
          onFailed={(message, retry) => onImplementFailed?.(implementing, message, retry)}
        />
      )}
    </AppShell>
  );
}

/**
 * The one status chip a card gets (issue #274's follow-on: a full backlog audit found every lane's
 * card rendering identically regardless of real state, even though `Card` already supports one).
 * Queued and Needs-human are left without one on purpose: Queued's next action is already the
 * whole card (clicking it opens Implement, which is state enough), and Needs-human's real variant
 * set -- which label, which of the seven reasons -- is #86's own ticket, not a guess made here.
 *
 * `Chip.tsx`'s own doc comment already names these tones for these lanes
 * (`Refining/Implementing/Reviewing... (warn)`, `Ready for review (ok)`); this reads them off the
 * one real field each lane's ticket already carries (`phase`) rather than inventing new ones.
 */
function laneChip(ticket: PipenzoTicketViewV1) {
  if (ticket.lane === 'working') {
    const label =
      ticket.phase === 'refine' ? 'refining' : ticket.phase === 'review' ? 'reviewing' : 'implementing';
    return <Chip tone="warn">{label}</Chip>;
  }
  if (ticket.lane === 'ready-for-review') {
    return <Chip tone="ok">ready for review</Chip>;
  }
  return undefined;
}
