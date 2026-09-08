import { useCallback, useState } from 'react';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
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
import { Card } from '../components/primitives/Card.js';
import { SyncStatusPill, type SyncStatus } from '../components/primitives/SyncStatusPill.js';
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
 * `'loading'` and `'error'` both render the board with an empty ticket list rather than a distinct
 * screen: `usePipenzoTickets`'s own doc comment says a `'loading'` answer is not worth a screen of
 * its own here, and `BoardScreen` already renders a truthful empty state either way. A dedicated
 * error treatment (a banner distinguishing "genuinely no tickets" from "could not ask") is real,
 * user-visible work this ticket did not scope -- filed separately rather than improvised here.
 *
 * ## What a ticket card looks like here
 *
 * `Card` -- the bare id/title anatomy, no variant body -- not a guess at #85/#86/#87's lane-specific
 * card content. Those tickets own what a Working/Needs-human/Ready-for-review card actually shows;
 * this shell only has to prove real tickets reach real lanes.
 */
export function PipenzoAppShell({
  sync,
  onRefreshSync,
}: {
  sync: { status: SyncStatus; label: string };
  onRefreshSync: () => void;
}) {
  const [view, setView] = useState<'board' | 'settings'>('board');
  const { ticketList } = usePipenzoTickets();

  const renderTicket = useCallback(
    (ticket: PipenzoTicketViewV1) => (
      <Card id={`#${ticket.issueNumber}`} title={ticket.title ?? `Issue #${ticket.issueNumber}`} />
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
        <BoardScreen
          tickets={ticketList.status === 'ready' ? ticketList.tickets : []}
          renderTicket={renderTicket}
        />
      ) : (
        <SettingsPage />
      )}
    </AppShell>
  );
}
