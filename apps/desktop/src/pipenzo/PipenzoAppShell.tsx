import { useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
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
import { WaitNote } from '../components/primitives/CardNote.js';
import { Chip } from '../components/primitives/Chip.js';
import { LoadLine } from '../components/primitives/LoadLine.js';
import { SyncStatusPill, type SyncStatus } from '../components/primitives/SyncStatusPill.js';
import { WorkspaceSwitcher } from '../components/primitives/WorkspaceSwitcher.js';
import { ActivityFilterBar } from './ActivityFilterBar.js';
import { ActivityRow } from './ActivityRow.js';
import { ActivityScreen } from './ActivityScreen.js';
import { BoardCommandPalette } from './BoardCommandPalette.js';
import { BoardImplementDialog } from './BoardImplementDialog.js';
import { BoardScreen } from './BoardScreen.js';
import { SettingsPage } from './SettingsPage.js';
import { TicketDetailContainer } from './TicketDetailContainer.js';
import { useActivityFilter } from './use-activity-filter.js';
import { useConnectedRepoList } from './use-connected-repo-list.js';
import { usePipenzoTickets } from './use-pipenzo-tickets.js';
import {
  buildWorkspaceSwitcherRepos,
  manageReposNote,
  resolveActiveRepoId,
} from './workspace-switcher.js';

/**
 * The real, connected-session shell (issue #274): `Main.dc.html`'s `AppShell`/`Sidebar`/`MainHead`
 * frame, hosting `BoardScreen` (#81) as the default view and `SettingsPage` (#125) as a navigable
 * second one. This is what replaces `<App>` -- the AgentDock demo shell this product inherited --
 * for a real, non-demo session; `AppRoot.tsx` still renders `<App>` for `demoMode`, since
 * `demo-bridge.ts`'s Pipenzo methods (`pipenzoListTickets` included) throw rather than answer, and
 * this shell has nothing else to show.
 *
 * ## Why the nav has exactly these items (issue #341)
 *
 * `Main.dc.html`'s own sidebar also carries "Needs me", "Open PRs" and "Models & gates" -- none of
 * which have a screen behind them yet. A nav item that leads nowhere is worse than one that does
 * not exist: it is a control a person can click, in an app whose whole premise is "every action is
 * real or absent, never decorative". Board, Activity and Settings are the three top-level screens
 * with a real, tested container behind them today (`BoardScreen`, `ActivityScreen`,
 * `SettingsPage`); the rest are their own future tickets, each free to add its own row when it
 * lands. TicketDetail is deliberately not a nav item -- it is a drill-down into one ticket, reached
 * from a board card or an activity row, never a standing destination of its own (see "Reaching
 * TicketDetail" below).
 *
 * ## Reaching TicketDetail (issue #341)
 *
 * `TicketDetailScreen.tsx`'s own doc comment named this file as the one that owes it real
 * composition and routing -- `TicketDetailContainer.tsx` is that composition (issue #91/#92/#95/#96/
 * #93's panels, wired to one real ticket), and `view`/`selectedTicketId` here are the routing.
 * `goToTicketDetail` is reached from two real, already-built "reporting, not deciding" callbacks
 * that had nowhere to report to until now: `ActivityRow.tsx`'s `onOpenTicket` (below, in the
 * Activity screen) and `TicketSwitcherPanel.tsx`'s `onSwitch` (inside `TicketDetailContainer`
 * itself, for switching between Needs-human tickets without leaving the screen). Board cards get
 * the same reachability below, next to the Queued-only Implement dialog this file already wires.
 * The crumb trail's leading "Board" item becomes a real click target only while on TicketDetail --
 * see `CrumbLink` below -- since that is the one screen this shell can reach that is not one prefix
 * away from the sidebar itself.
 *
 * ## Where the tickets come from
 *
 * `usePipenzoTickets` (issue #255) is called here, not threaded down from `AppRoot.tsx` -- the
 * board's data is this shell's own concern once it exists, the same way `BoardScreen.tsx`'s own doc
 * comment already anticipated ("whoever mounts `BoardScreen` for real wires... the real data").
 * `'loading'` used to render the board with an empty ticket list, same as a clean backlog -- issue
 * #67 found that collision and fixed it: `BoardScreen`'s own `loading` prop now renders its
 * `SkeletonBoard` instead, with a `LoadLine` above it naming what is being read, matching
 * `Foundations.dc.html`'s cold-start state. `'error'` is different (issue #276): rather than
 * rendering that same silent empty board -- indistinguishable from a genuinely clean backlog -- a
 * `Banner` above it says the read failed and offers `usePipenzoTickets`'s own `refresh()` as a
 * retry. The board still renders underneath, empty, since there is nothing better to show it.
 *
 * ## What the load-line names (issue #67)
 *
 * `Foundations.dc.html`'s own example is a single named repo ("Reading open issues from
 * `jortega0033/agentdock`..."), but a workspace can have up to `PIPENZO_MAX_CONNECTED_REPOS`
 * connected, and this shell has no reason to guess how the canvas would word a poll across many of
 * them -- that copy decision belongs to whichever ticket first needs it. `connectedRepoNames` is
 * read best-effort, purely for this line: naming the one repo when there is exactly one, since that
 * is the case the canvas actually specifies, and falling back to the honest, ownership-free "your
 * connected repos" otherwise (zero, many, or the read not having answered yet).
 *
 * ## What a ticket card looks like here
 *
 * `Card` -- id/title, plus the one status chip and foot line each lane's own real data already
 * supports without guessing (Working's phase, Ready-for-review's branch). This still is not a
 * guess at #86/#87's lane-specific card content: Needs-human's seven variants (#86) and
 * Ready-for-review's ci-failed variant (#87) stay their own tickets, and nothing here invents data
 * those tickets are meant to add -- `ticket.phase`/`ticket.worktree` are already real fields on
 * `PipenzoTicketViewV1`, not placeholders standing in for a schema that does not exist yet.
 *
 * ## The Working lane's held card (issue #85)
 *
 * A Working ticket the ticket-list route reported `concurrency.state === 'held'` (see
 * `working-lane-concurrency.ts`) renders `Card`'s own `held` dimming plus a `WaitNote` naming the
 * real overlapping ticket and file straight off the wire -- never invented copy, since both are
 * `ticket.concurrency`'s own fields once it is that variant. The foot's "Run anyway" is a `Button`
 * with `disabled` and no `onClick`: `Main.dc.html`'s own markup gives that control no handler at
 * all (a plain `<button class="btn sm ghost">`, unlike every other card action's `onClick={{...}}`
 * ), so making it do something here would be inventing an affordance the canvas deliberately left
 * inert -- there is no real "run this anyway, bypassing the hold" capability behind it yet, and a
 * clickable button promising one would be a lie the canvas itself does not tell.
 *
 * ## Queued cards open the Implement dialog (issue #342); every other lane opens TicketDetail (#341)
 *
 * A Queued card's `onClick` (via `Card`'s own, which also makes it a keyboard-reachable `button`)
 * opens `BoardImplementDialog` for that ticket, which resolves the repo's local checkout (#344) and
 * then mounts the real `ImplementDialog` -- unchanged from #342. README's Implement is the action a
 * Queued ticket is waiting for; a Working, Ready-for-review or Needs-human card's own *lane-specific*
 * next action (a held card's real "run anyway", Needs-human's seven reason variants, Ready-for-
 * review's ci-failed card) is still owned by #85/#86/#87 and not guessed at here. But every card
 * already carries the one action every lane shares regardless of what its own ticket eventually
 * adds: viewing the ticket's detail. That is what a click on any non-Queued card does now --
 * `goToTicketDetail`, the same navigation `ActivityRow`'s `onOpenTicket` reports to below -- so a
 * person can actually reach the phase stepper, rail blocks and activity stream #341 was asked to
 * make reachable, for a real ticket, from a real screen.
 *
 * `onImplementStarted` reports a successful dispatch upward rather than toasting here, because the
 * toast stack lives in `AppRoot` alongside the sync pill's own failure toast. The dialog closes
 * itself on success: its Start button would otherwise still be there, and a second press would try
 * to cut a second worktree for the same ticket.
 *
 * ## The workspace switcher (issue #89)
 *
 * `WorkspaceSwitcher.tsx` (#34) and `RepoPicker.tsx` (#115) were both already built; this shell is
 * where they get real data. `useConnectedRepoList` answers the connected-repos list itself -- the
 * same read the load-line's own `connectedRepoNames` now uses, rather than a second, ad-hoc fetch of
 * the same list for the switcher -- and `usePipenzoTickets`'s own tickets (already fetched here for
 * the board) are tallied per repo by `workspace-switcher.ts`. "Switch active repo" only ever changes
 * `requestedActiveRepoId` -- `resolveActiveRepoId` is what falls back to the first connected repo the
 * moment the requested one stops being connected, rather than pointing the switcher at a repo that no
 * longer exists. "Manage repos…" does not duplicate `ConnectedReposPanel`'s own picker dialog; it
 * routes to the Settings screen and hands it `openRepoPickerToken`, which opens that same dialog
 * there (see that panel's own doc comment for why a token, not a boolean).
 *
 * ## The command palette (issue #88)
 *
 * `BoardCommandPalette` wires `CommandPalette.tsx` (#33) up the same way: `tickets` and
 * `connectedRepoNames` are the exact values already computed here for the board and the switcher,
 * not a second read of either, and `onSelectRepo` is the switcher's own `setRequestedActiveRepoId`
 * -- picking a repo in the palette is the same action as picking one in the switcher. See that
 * component's own doc comment for why its Actions group has two rows rather than the canvas's four.
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
  const [view, setView] = useState<'board' | 'settings' | 'activity' | 'ticket-detail'>('board');
  const { ticketList, refresh } = usePipenzoTickets();
  const { repoList, refresh: refreshRepoList } = useConnectedRepoList();
  const [implementing, setImplementing] = useState<PipenzoTicketViewV1>();
  // The ticket TicketDetail is currently open on -- a ticket id, not the ticket object itself, so
  // switching lanes/lists under it (a live board sync) is picked up on the next render rather than
  // pinning a stale snapshot (issue #341).
  const [selectedTicketId, setSelectedTicketId] = useState<string | undefined>(undefined);
  // The user's own pick, when they have made one -- resolved against the live connected list by
  // `resolveActiveRepoId` below rather than trusted on its own, since a repo it names can stop being
  // connected (removed from Settings) out from under this state.
  const [requestedActiveRepoId, setRequestedActiveRepoId] = useState<string | undefined>(undefined);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // Incremented once per "Manage repos…" click, `undefined` otherwise (see `ConnectedReposPanel.tsx`'s
  // own doc comment on why a token rather than a boolean).
  const [openRepoPickerToken, setOpenRepoPickerToken] = useState<number | undefined>(undefined);

  // Issue #341: the one navigation every "reporting, not deciding" callback built ahead of this
  // shell (`ActivityRow.tsx`'s `onOpenTicket`, `TicketSwitcherPanel.tsx`'s `onSwitch`, and this
  // shell's own board cards below) resolves to.
  const goToTicketDetail = useCallback((ticketId: string) => {
    setSelectedTicketId(ticketId);
    setView('ticket-detail');
  }, []);

  const renderTicket = useCallback(
    (ticket: PipenzoTicketViewV1) => {
      const concurrency = ticket.lane === 'working' ? ticket.concurrency : undefined;
      const held = concurrency?.state === 'held' ? concurrency : undefined;
      return (
        <Card
          id={`#${ticket.issueNumber}`}
          title={ticket.title ?? `Issue #${ticket.issueNumber}`}
          chip={laneChip(ticket)}
          held={held !== undefined}
          onClick={
            ticket.lane === 'queued'
              ? () => setImplementing(ticket)
              : () => goToTicketDetail(ticket.ticketId)
          }
        >
          {held && (
            <>
              <WaitNote>
                <b>Waiting — file overlap with #{held.overlapIssueNumber}.</b> Both plan to touch{' '}
                <span className="mono">{held.overlapFile}</span>. Starts on its own when #
                {held.overlapIssueNumber} finishes; a slot is reserved.
              </WaitNote>
              <CardFoot>
                <CardMeta icon="pause">held</CardMeta>
                <Button size="sm" variant="ghost" disabled>
                  Run anyway
                </Button>
              </CardFoot>
            </>
          )}
          {ticket.lane === 'ready-for-review' && ticket.worktree && (
            <CardFoot>
              <CardMeta icon="git-branch">{ticket.worktree.branch}</CardMeta>
            </CardFoot>
          )}
        </Card>
      );
    },
    [goToTicketDetail],
  );

  // Best-effort, and shared by the load-line's own wording and the workspace switcher below -- see
  // this file's doc comment on why an unresolved or multi-repo answer degrades to a generic phrase
  // rather than guessing, and on why this is the switcher's own data source too, not a second read.
  const connectedRepoNames = useMemo(
    () => (repoList.status === 'ready' ? repoList.repositories : []),
    [repoList],
  );
  const tickets = useMemo(
    () => (ticketList.status === 'ready' ? ticketList.tickets : []),
    [ticketList],
  );
  // Issue #341: the Activity screen's own filter state, over the same unfiltered `tickets` this
  // shell already reads for the board -- never a second, separate ticket read (see
  // `use-activity-filter.ts`'s own doc comment).
  const { active: activityFilter, setActive: setActivityFilter, filteredTickets: activityTickets } =
    useActivityFilter(tickets);
  // Issue #341: the ticket TicketDetail is open on, resolved against the same live list every
  // render -- `undefined` both before anything is selected and once a selected ticket genuinely
  // stops being in the list (merged, or a stale id), so the "not found" fallback below is never
  // guessed at from a snapshot that might already be stale.
  const selectedTicket = useMemo(
    () => tickets.find((ticket) => ticket.ticketId === selectedTicketId),
    [tickets, selectedTicketId],
  );
  // Built from the same two real reads the rest of this shell already makes -- the connected-repos
  // list and the board's own ticket list -- never a mocked or hardcoded count (issue #89).
  const workspaceRepos = useMemo(
    () => buildWorkspaceSwitcherRepos(connectedRepoNames, tickets),
    [connectedRepoNames, tickets],
  );
  const activeRepoId = resolveActiveRepoId(connectedRepoNames, requestedActiveRepoId);

  const goToBoard = useCallback(() => setView('board'), []);

  const goToActivity = useCallback(() => setView('activity'), []);

  const goToSettings = useCallback(() => {
    // A plain nav click must never reopen a picker left over from an earlier "Manage repos…" click,
    // so this always clears the token rather than leaving whatever it last was.
    setOpenRepoPickerToken(undefined);
    setView('settings');
  }, []);

  const onManageRepos = useCallback(() => {
    // Incremented rather than set to a fixed truthy value: `ConnectedReposPanel` may already be
    // mounted on the Settings screen, in which case only a *changed* prop retriggers its effect --
    // see that effect's own comment.
    setOpenRepoPickerToken((token) => (token ?? 0) + 1);
    setView('settings');
  }, []);

  return (
    <AppShell
      sidebar={
        <Sidebar>
          <SidebarBrand />
          {workspaceRepos.length > 0 && (
            <WorkspaceSwitcher
              open={switcherOpen}
              onOpenChange={setSwitcherOpen}
              repos={workspaceRepos}
              activeRepoId={activeRepoId ?? ''}
              onSelectRepo={setRequestedActiveRepoId}
              onManageRepos={onManageRepos}
              manageReposNote={manageReposNote(workspaceRepos.length)}
            />
          )}
          <NavGroup title="Work">
            <NavItem icon="board" active={view === 'board'} onClick={goToBoard}>
              Board
            </NavItem>
            <NavItem icon="activity" active={view === 'activity'} onClick={goToActivity}>
              Activity
            </NavItem>
          </NavGroup>
          <NavGroup title="Repo">
            <NavItem icon="settings" active={view === 'settings'} onClick={goToSettings}>
              Settings
            </NavItem>
          </NavGroup>
        </Sidebar>
      }
    >
      <MainHead>
        <Crumbs items={crumbItems(view, selectedTicket, goToBoard)} />
        <MainHeadRight>
          <SyncStatusPill status={sync.status} label={sync.label} onRefresh={onRefreshSync} />
          <BoardCommandPalette
            tickets={tickets}
            repositories={connectedRepoNames}
            onOpenBoard={goToBoard}
            onOpenSettings={goToSettings}
            onSelectRepo={setRequestedActiveRepoId}
          />
        </MainHeadRight>
      </MainHead>
      {view === 'board' && (
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
          {ticketList.status === 'loading' && (
            <LoadLine>
              Reading open issues from {loadLineTarget(connectedRepoNames)} — first poll of this
              session
            </LoadLine>
          )}
          <BoardScreen
            tickets={tickets}
            loading={ticketList.status === 'loading'}
            workingLaneCapacity={
              ticketList.status === 'ready' ? ticketList.workingLaneCapacity : undefined
            }
            renderTicket={renderTicket}
          />
        </>
      )}
      {view === 'settings' && (
        <SettingsPage
          openRepoPickerToken={openRepoPickerToken}
          onConnectedReposChange={() => refreshRepoList()}
        />
      )}
      {view === 'activity' && (
        <ActivityScreen
          tickets={activityTickets}
          filterBar={
            <ActivityFilterBar tickets={tickets} active={activityFilter} onChange={setActivityFilter} />
          }
          renderEntry={(entry) => (
            <ActivityRow entry={entry} onOpenTicket={(ticket) => goToTicketDetail(ticket.ticketId)} />
          )}
        />
      )}
      {view === 'ticket-detail' &&
        (selectedTicket ? (
          <TicketDetailContainer ticket={selectedTicket} onSwitchTicket={goToTicketDetail} />
        ) : (
          <Banner icon="warning" tone="warn" action={<Button size="sm" variant="ghost" onClick={goToBoard}>Back to Board</Button>}>
            {ticketList.status === 'loading'
              ? "Reading this ticket's real state from the local daemon…"
              : "This ticket isn't in the board's current list anymore -- it may have merged or closed."}
          </Banner>
        ))}
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
 * The crumb trail for each of this shell's four screens (issue #341), matching each artboard's own
 * `.crumbs` markup: a single current-page item for Board/Settings/Activity, and a real "Board" ->
 * `#<issueNumber>` trail for TicketDetail -- `TicketDetail.dc.html`'s own two-item crumb, with the
 * leading "Board" made a genuine click target via `CrumbLink` rather than the inert `<span>` the
 * static canvas mock uses, since this is the one screen in this shell actually reached by drilling
 * down rather than by a sidebar click. A `selectedTicket` that is not (yet, or no longer) resolved
 * falls back to a plain "Ticket" crumb rather than a guessed number.
 */
function crumbItems(
  view: 'board' | 'settings' | 'activity' | 'ticket-detail',
  selectedTicket: PipenzoTicketViewV1 | undefined,
  goToBoard: () => void,
): ReactNode[] {
  switch (view) {
    case 'board':
      return ['Board'];
    case 'settings':
      return ['Settings'];
    case 'activity':
      return ['Activity'];
    case 'ticket-detail':
      return [
        <CrumbLink key="board" onClick={goToBoard}>
          Board
        </CrumbLink>,
        selectedTicket ? `#${selectedTicket.issueNumber}` : 'Ticket',
      ];
  }
}

/** A crumb item a person can actually click back through, the same "canvas markup made real"
 *  treatment `Card`/`NavItem` already give their own inert-looking canvas elements: `tabIndex`,
 *  `role="button"` and an Enter/Space handler alongside the click, not just an `onClick`. */
function CrumbLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
  };
  return (
    <span tabIndex={0} role="button" onClick={onClick} onKeyDown={onKeyDown}>
      {children}
    </span>
  );
}

/**
 * The cold-start load-line's target phrase (issue #67): the one connected repo named in mono, the
 * same way `Foundations.dc.html`'s own example names `jortega0033/agentdock` -- or the generic,
 * still-true "your connected repos" for the cases that example does not cover (the read has not
 * answered yet, or there is more than one). See `PipenzoAppShell`'s own doc comment for why this
 * file does not invent copy for the multi-repo case instead of falling back.
 */
function loadLineTarget(repoNames: readonly string[] | undefined): ReactNode {
  if (repoNames?.length === 1) {
    return <span className="mono">{repoNames[0]}</span>;
  }
  return 'your connected repos';
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
