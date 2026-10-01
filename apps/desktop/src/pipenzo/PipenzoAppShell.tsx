import { useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type {
  PipenzoImplementResultV1,
  PipenzoPublishResultV1,
  PipenzoTicketAttemptV1,
  PipenzoTicketViewV1,
  RefineSpecV1,
} from '@agent-dock/shared';
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
import { FailNote, WaitNote } from '../components/primitives/CardNote.js';
import { Chip } from '../components/primitives/Chip.js';
import { Conflict } from '../components/primitives/Conflict.js';
import { LoadLine } from '../components/primitives/LoadLine.js';
import { Notice } from '../components/primitives/Notice.js';
import { Split, type SplitRow } from '../components/primitives/Split.js';
import { SyncStatusPill, type SyncStatus } from '../components/primitives/SyncStatusPill.js';
import { WorkspaceSwitcher } from '../components/primitives/WorkspaceSwitcher.js';
import { ActivityFilterBar } from './ActivityFilterBar.js';
import { ActivityRow } from './ActivityRow.js';
import { ActivityScreen } from './ActivityScreen.js';
import { BoardCommandPalette } from './BoardCommandPalette.js';
import { BoardImplementDialog } from './BoardImplementDialog.js';
import { BoardNewFromIdeaDialog } from './BoardNewFromIdeaDialog.js';
import { BoardScreen } from './BoardScreen.js';
import { DiffReviewScreen } from './DiffReviewScreen.js';
import { DiscardBranchDialog } from './DiscardBranchDialog.js';
import { ModelsGatesScreen } from './ModelsGatesScreen.js';
import { classifyNeedsHumanCard, type NeedsHumanCardClassification } from './needs-human-card.js';
import { SettingsPage } from './SettingsPage.js';
import { TicketDetailContainer } from './TicketDetailContainer.js';
import { useActivityFilter } from './use-activity-filter.js';
import { useBoardDragDrop } from './use-board-drag-drop.js';
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
 * ## Why the nav has exactly these items (issue #341, plus Models & gates via #470)
 *
 * `Main.dc.html`'s own sidebar also carries "Needs me" and "Open PRs", neither of which has a
 * screen behind them yet. A nav item that leads nowhere is worse than one that does not exist: it
 * is a control a person can click, in an app whose whole premise is "every action is real or
 * absent, never decorative". Board, Activity, Models & gates and Settings are the four top-level
 * screens with a real, tested container behind them today (`BoardScreen`, `ActivityScreen`,
 * `ModelsGatesScreen`, `SettingsPage`); "Needs me" and "Open PRs" are their own future tickets,
 * each free to add its own row when it lands. TicketDetail is deliberately not a nav item -- it is
 * a drill-down into one ticket, reached from a board card or an activity row, never a standing
 * destination of its own (see "Reaching TicketDetail" below).
 *
 * ## Reaching ModelsGatesScreen (issue #470)
 *
 * `DeterministicGatesPanel.tsx`/`AgentCapturedPanel.tsx` (#123/#124) rendered real, tested content
 * with no route reaching them -- `ModelsGatesScreen` is that route, and this shell mounts it the
 * same additive way #341 added Activity: one `NavItem` under the existing "Repo" group (next to
 * Settings, matching `Main.dc.html`'s own grouping), one `view` case, and one crumb case. It takes
 * `activeRepo`, the same `owner/name` the workspace switcher below already resolves -- see that
 * screen's own doc comment for why an agent-captured capability probe needs one.
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
 * ## Reaching DiffReviewScreen (issue #341 PR 2)
 *
 * `DiffReviewScreen.tsx`'s own module comment said exactly what it needed and did not have: "this
 * screen is not mounted anywhere in the app today... `ticket`/`spec`/`started` come from the same
 * `ImplementDialog` flow that already produced them." That flow already runs inside this shell's own
 * `BoardImplementDialog` (issue #342) -- `ImplementDialog`'s `onStarted` always had the real
 * `RefineSpecV1` it just dispatched to `implementPipenzo` in scope, it simply had no caller asking
 * for it. Both `ImplementDialog.tsx` and `BoardImplementDialog.tsx` now pass `spec` through
 * `onStarted` by identity (never re-derived), which is what lets `reviewing` below hold the exact
 * three-piece state `DiffReviewScreen` was built to take: the ticket (for `ticket.num`/`title`/
 * `repo`, plus its real `ticketId` for `PublishActions`'s MEDIUM-approval card, issue #97), `spec`
 * and `started`.
 *
 * `reviewing` is set the moment Start dispatches, alongside closing `BoardImplementDialog` and
 * switching `view` to `'diff-review'` -- the same "the dialog closes itself on success" rule
 * `onImplementStarted` above already documents, just also landing on the screen that dialog's own
 * dispatch was always meant to lead to instead of the board. There is deliberately no second way
 * back into an in-progress review once a person navigates away from it (via the Board nav item or
 * the crumb trail) -- `reviewing` stays in memory so returning via `TicketDetail`'s own switcher
 * does not lose it, but nothing here builds a "resume review" entry point, because inventing one
 * without a design for it would be exactly the kind of guessed affordance this shell's own "Queued
 * cards" section above refuses to build.
 *
 * `onPushed`/`onPullRequestOpened` mirror `DiffReviewScreen`'s own prop names one level up, the same
 * way `onImplementStarted` mirrors `ImplementDialog`'s -- each fires once, reports the real
 * `PipenzoPublishResultV1` upward for `AppRoot`'s own toast, then this shell clears `reviewing`,
 * refreshes the board (the ticket's lane just changed) and returns to it, since there is nothing
 * left on the review screen once its one run has resolved.
 *
 * ## Discard branch (issue #112), wired alongside it
 *
 * `DiscardBranchDialog.tsx` was real, tested and already backed by a real daemon route
 * (`cleanupWorktree`) but had no caller either -- `PublishActions`'s own Discard button only renders
 * when handed `onDiscardClick` at all, so without this it would have stayed invisible on the one
 * screen that could finally show it. `discarding` needs nothing this shell does not already have in
 * `reviewing.started` (`worktreeId`, `branch`), so this wires it rather than leaving a second real,
 * tested primitive dark next to the one #341 was actually asked to reach.
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
 * supports without guessing (Working's phase, Ready-for-review's branch and, since issue #87, its
 * own ci-failed `FailNote`). Needs-human is issue #86 (plus #15's `plan-review` addition):
 * `needs-human-card.ts`'s own `classifyNeedsHumanCard` picks one of six real variants
 * (`needs-pre-scoping`/`awaiting-stack-approval`/`plan-review`/`interrupted`/`merge-conflict`/
 * `failed`, plus a `generic` fallback for a bare park this router does not further specialize), and
 * `needsHumanChip`/`needsHumanCardBody` below turn that answer into a chip and a body -- never a
 * guess at the one named variant (`claim-conflict`) that module's own doc comment found no
 * persisted backend signal for yet.
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
 * Queued ticket is waiting for; a Working or Needs-human card's own *lane-specific* next action (a
 * held card's real "run anyway", Needs-human's seven reason variants) is still owned by #86 and
 * not guessed at here -- Ready-for-review's own ci-failed card is issue #87, built above. But every
 * card already carries the one action every lane shares regardless of what its own ticket eventually
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
 * -- picking a repo in the palette is the same action as picking one in the switcher. `onNewFromIdea`
 * opens `BoardNewFromIdeaDialog` for `activeRepoId` -- the same repo the switcher and load-line
 * already name as "the" repo, since the palette itself has no other notion of which repo a
 * repo-less idea is about. See that component's own doc comment for why its Actions group has
 * three rows rather than the canvas's four, and `BoardNewFromIdeaDialog`'s for why it gates on
 * workspace trust the same way `BoardImplementDialog` does.
 */
export function PipenzoAppShell({
  sync,
  onRefreshSync,
  onImplementStarted,
  onImplementFailed,
  onPushed,
  onPullRequestOpened,
  onTicketTransitionFailed,
  initialTicketId,
}: {
  sync: { status: SyncStatus; label: string };
  onRefreshSync: () => void;
  onImplementStarted?: (ticket: PipenzoTicketViewV1, started: PipenzoImplementResultV1) => void;
  /** Issue #77: a real Start failure, named by the ticket it failed for -- the toast stack lives in
   * `AppRoot`, same as the success case above. */
  onImplementFailed?: (ticket: PipenzoTicketViewV1, message: string, retry: () => void) => void;
  /** Issue #341 PR 2: mirrors `DiffReviewScreen`'s own `onPushed`/`onPullRequestOpened`, named for
   *  the ticket the same way every other report-upward callback here is -- see "Reaching
   *  DiffReviewScreen" above. */
  onPushed?: (ticket: PipenzoTicketViewV1, result: PipenzoPublishResultV1) => void;
  onPullRequestOpened?: (ticket: PipenzoTicketViewV1, result: PipenzoPublishResultV1) => void;
  /** Issue #82: a board drag's real `pipenzoTicketTransition` call came back rejected, or the
   * daemon could not be reached -- the card has already snapped back to where it started (see
   * `use-board-drag-drop.ts`) by the time this fires. Mirrors `onImplementFailed` exactly: the toast
   * stack lives in `AppRoot.tsx`, not here. */
  onTicketTransitionFailed?: (ticket: PipenzoTicketViewV1, message: string) => void;
  /** Issue #133: `SimpleModeShell`'s "See the technical details" crossover link, via
   * `AppRoot.tsx` -- see this file's own doc comment section on it. Read once, as this shell's
   * starting `view`/`selectedTicketId`, never afterwards. */
  initialTicketId?: string;
}) {
  const [view, setView] = useState<
    'board' | 'settings' | 'activity' | 'ticket-detail' | 'diff-review' | 'models'
  >(initialTicketId ? 'ticket-detail' : 'board');
  const { ticketList, refresh } = usePipenzoTickets();
  const { repoList, refresh: refreshRepoList } = useConnectedRepoList();
  const [implementing, setImplementing] = useState<PipenzoTicketViewV1>();
  // The one dispatched Implement run `DiffReviewScreen` is open on (issue #341 PR 2) -- see
  // "Reaching DiffReviewScreen" above for where each piece comes from and why this holds all three
  // rather than re-deriving any of them.
  const [reviewing, setReviewing] = useState<{
    ticket: PipenzoTicketViewV1;
    spec: RefineSpecV1;
    started: PipenzoImplementResultV1;
  }>();
  // `DiscardBranchDialog`'s own open state, keyed off `reviewing.started` when it is opened -- see
  // "Discard branch" above.
  const [discarding, setDiscarding] = useState<{ worktreeId: string; branch: string }>();
  // The ticket TicketDetail is currently open on -- a ticket id, not the ticket object itself, so
  // switching lanes/lists under it (a live board sync) is picked up on the next render rather than
  // pinning a stale snapshot (issue #341).
  const [selectedTicketId, setSelectedTicketId] = useState<string | undefined>(initialTicketId);
  const [newFromIdeaOpen, setNewFromIdeaOpen] = useState(false);
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
          {ticket.lane === 'ready-for-review' && (
            <>
              {ticket.labels.includes('pipenzo:ci-failed') && (
                <FailNote>{ciFixReadyDetail(ticket)}</FailNote>
              )}
              {ticket.worktree && (
                <CardFoot>
                  <CardMeta icon="git-branch">{ticket.worktree.branch}</CardMeta>
                </CardFoot>
              )}
            </>
          )}
          {ticket.lane === 'needs-human' && needsHumanCardBody(classifyNeedsHumanCard(ticket))}
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
  // Issue #82: the board's own optimistic view of `tickets` above -- everywhere else in this shell
  // (Activity's filter, the ticket switcher, `selectedTicket` below) keeps reading the real,
  // unmodified list; only `<BoardScreen>` gets the drag-in-flight overlay, since nothing else on
  // screen is what a drag visually moved.
  const { tickets: boardTickets, onCardDrop } = useBoardDragDrop(tickets, onTicketTransitionFailed);
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

  const goToModels = useCallback(() => setView('models'), []);

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
            <NavItem icon="gates" active={view === 'models'} onClick={goToModels}>
              Models &amp; gates
            </NavItem>
            <NavItem icon="settings" active={view === 'settings'} onClick={goToSettings}>
              Settings
            </NavItem>
          </NavGroup>
        </Sidebar>
      }
    >
      <MainHead>
        <Crumbs
          items={crumbItems(view, selectedTicket, reviewing?.ticket, goToBoard, goToTicketDetail)}
        />
        <MainHeadRight>
          <SyncStatusPill status={sync.status} label={sync.label} onRefresh={onRefreshSync} />
          <BoardCommandPalette
            tickets={tickets}
            repositories={connectedRepoNames}
            onOpenBoard={goToBoard}
            onOpenSettings={goToSettings}
            onSelectRepo={setRequestedActiveRepoId}
            onNewFromIdea={() => setNewFromIdeaOpen(true)}
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
            tickets={boardTickets}
            loading={ticketList.status === 'loading'}
            workingLaneCapacity={
              ticketList.status === 'ready' ? ticketList.workingLaneCapacity : undefined
            }
            renderTicket={renderTicket}
            onCardDrop={onCardDrop}
          />
        </>
      )}
      {view === 'settings' && (
        <SettingsPage
          openRepoPickerToken={openRepoPickerToken}
          onConnectedReposChange={() => refreshRepoList()}
        />
      )}
      {view === 'models' && <ModelsGatesScreen activeRepo={activeRepoId} />}
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
      {view === 'diff-review' &&
        (reviewing ? (
          <DiffReviewScreen
            key={reviewing.ticket.ticketId}
            ticket={{
              num: reviewing.ticket.issueNumber,
              title: reviewing.ticket.title ?? `Issue #${reviewing.ticket.issueNumber}`,
              repo: reviewing.ticket.repo,
            }}
            spec={reviewing.spec}
            started={reviewing.started}
            ticketId={reviewing.ticket.ticketId}
            onDiscardClick={() =>
              setDiscarding({
                worktreeId: reviewing.started.worktreeId,
                branch: reviewing.started.branch,
              })
            }
            onPushed={(result) => {
              refresh();
              setReviewing(undefined);
              setView('board');
              onPushed?.(reviewing.ticket, result);
            }}
            onPullRequestOpened={(result) => {
              refresh();
              setReviewing(undefined);
              setView('board');
              onPullRequestOpened?.(reviewing.ticket, result);
            }}
          />
        ) : (
          // Defensive, not reachable through this shell's own navigation today (`reviewing` is set
          // in the same call that sets `view` to `'diff-review'`) -- kept honest rather than assumed,
          // the same discipline TicketDetail's own not-found fallback above already applies.
          <Banner icon="warning" tone="warn" action={<Button size="sm" variant="ghost" onClick={goToBoard}>Back to Board</Button>}>
            There is no dispatched Implement run to review right now.
          </Banner>
        ))}
      {implementing && (
        <BoardImplementDialog
          // Keyed by ticket so opening a different card never inherits the last one's checkout,
          // trust answer or refined spec.
          key={implementing.ticketId}
          ticket={implementing}
          onClose={() => setImplementing(undefined)}
          onStarted={(started, spec) => {
            setImplementing(undefined);
            refresh();
            onImplementStarted?.(implementing, started);
            // Issue #341 PR 2: the dispatch this dialog exists to make is also the one
            // `DiffReviewScreen` has been waiting for a caller to produce -- see "Reaching
            // DiffReviewScreen" above.
            setReviewing({ ticket: implementing, spec, started });
            setView('diff-review');
          }}
          onFailed={(message, retry) => onImplementFailed?.(implementing, message, retry)}
        />
      )}
      {discarding && (
        <DiscardBranchDialog
          open
          worktreeId={discarding.worktreeId}
          branch={discarding.branch}
          onClose={() => setDiscarding(undefined)}
          onDiscarded={() => {
            setDiscarding(undefined);
            setReviewing(undefined);
            setView('board');
            refresh();
          }}
        />
      )}
      {newFromIdeaOpen && activeRepoId && (
        <BoardNewFromIdeaDialog
          // Keyed by repo so switching the active repo mid-dialog never hands a stale checkout's
          // draft to a newly-picked one.
          key={activeRepoId}
          repo={activeRepoId}
          onClose={() => setNewFromIdeaOpen(false)}
          onCreated={() => {
            setNewFromIdeaOpen(false);
            refresh();
          }}
        />
      )}
    </AppShell>
  );
}

/**
 * The crumb trail for each of this shell's five screens (issue #341), matching each artboard's own
 * `.crumbs` markup: a single current-page item for Board/Settings/Activity, a real "Board" ->
 * `#<issueNumber>` trail for TicketDetail (`TicketDetail.dc.html`'s own two-item crumb), and a real
 * "Board" -> `#<issueNumber>` -> "Review diff" trail for DiffReview (`DiffReview.dc.html`'s own
 * three-item one) -- with every non-current item a genuine click target via `CrumbLink` rather than
 * the inert `<span>` the static canvas mocks use, since these are the two screens this shell
 * actually reaches by drilling down rather than by a sidebar click. A `selectedTicket`/`reviewingTicket`
 * that is not (yet, or no longer) resolved falls back to a plain "Ticket" crumb rather than a
 * guessed number.
 */
function crumbItems(
  view: 'board' | 'settings' | 'activity' | 'ticket-detail' | 'diff-review' | 'models',
  selectedTicket: PipenzoTicketViewV1 | undefined,
  reviewingTicket: PipenzoTicketViewV1 | undefined,
  goToBoard: () => void,
  goToTicketDetail: (ticketId: string) => void,
): ReactNode[] {
  switch (view) {
    case 'board':
      return ['Board'];
    case 'settings':
      return ['Settings'];
    case 'activity':
      return ['Activity'];
    case 'models':
      return ['Models & gates'];
    case 'ticket-detail':
      return [
        <CrumbLink key="board" onClick={goToBoard}>
          Board
        </CrumbLink>,
        selectedTicket ? `#${selectedTicket.issueNumber}` : 'Ticket',
      ];
    case 'diff-review':
      return [
        <CrumbLink key="board" onClick={goToBoard}>
          Board
        </CrumbLink>,
        reviewingTicket ? (
          <CrumbLink key="ticket" onClick={() => goToTicketDetail(reviewingTicket.ticketId)}>
            #{reviewingTicket.issueNumber}
          </CrumbLink>
        ) : (
          'Ticket'
        ),
        'Review diff',
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
 *
 * Ready-for-review's own two variants (issue #87): a ticket carrying `pipenzo:ci-failed` is the
 * `ci-failed · fix ready` card -- `Main.dc.html`'s own `ready` sample data spells the chip text
 * exactly that way (`chipLabel: 'ci-failed · fix ready'`), and `activity-row.ts`'s own
 * `classifyActivityRow` already treats that label as this ticket's one real signal for the same
 * lane. This never re-derives whether a fix is actually ready -- `pipenzo-phase-machine.ts`'s own
 * `needs-human` -> `ready-for-review` transition (README's `pipenzo:ci-failed` row) is what keeps
 * that label on a ticket sitting in *this* lane true to "the fix commits, then it moves here"; a
 * ticket in this lane with the label is trusted the same way `board-lanes.ts`'s own module comment
 * already trusts `lane` itself. Every other ready-for-review ticket -- no `pipenzo:ci-failed` --
 * is the plain gates-passed case.
 *
 * Needs-human's own six variants (issue #86, plus #15's `plan-review`): the chip text matches each
 * real label verbatim except `failed` (reads `3 failed` -- `Main.dc.html`'s own board sample spells
 * it that way for the "parked after repeated failures" reading of the bare `pipenzo:needs-human`
 * label) and `plan-review` (no dedicated label exists -- see `needs-human-card.ts`'s own doc
 * comment -- so the chip reads the bare label its ticket actually carries, with its own distinct
 * tone). The one remaining named variant (`claim-conflict`) has no persisted signal to key a chip
 * off yet -- see that module's doc comment -- so `classifyNeedsHumanCard` never returns it and no
 * chip text exists for it here.
 */
function laneChip(ticket: PipenzoTicketViewV1) {
  if (ticket.lane === 'working') {
    const label =
      ticket.phase === 'refine' ? 'refining' : ticket.phase === 'review' ? 'reviewing' : 'implementing';
    return <Chip tone="warn">{label}</Chip>;
  }
  if (ticket.lane === 'ready-for-review') {
    if (ticket.labels.includes('pipenzo:ci-failed')) {
      return <Chip tone="ci">ci-failed · fix ready</Chip>;
    }
    return <Chip tone="ok">ready for review</Chip>;
  }
  if (ticket.lane === 'needs-human') {
    return needsHumanChip(classifyNeedsHumanCard(ticket));
  }
  return undefined;
}

/** The needs-human chip text and tone for each of `needs-human-card.ts`'s six real variants. */
function needsHumanChip(card: NeedsHumanCardClassification) {
  switch (card.variant) {
    case 'needs-pre-scoping':
      return <Chip tone="neutral">pipenzo:needs-pre-scoping</Chip>;
    case 'awaiting-stack-approval':
      return <Chip tone="warn">pipenzo:awaiting-stack-approval</Chip>;
    case 'plan-review':
      return <Chip tone="warn">plan review</Chip>;
    case 'interrupted':
      return <Chip tone="warn">pipenzo:interrupted</Chip>;
    case 'merge-conflict':
      return <Chip tone="warn">pipenzo:merge-conflict</Chip>;
    case 'failed':
      return <Chip tone="danger">3 failed</Chip>;
    case 'generic':
      return <Chip tone="danger">pipenzo:needs-human</Chip>;
  }
}

/**
 * The `FailNote` body for the ci-failed ready-for-review card (issue #87). `Main.dc.html`'s own
 * sample reads "typecheck failed on PR #115... committed +3 -1 locally" -- a real PR number and a
 * real diff stat for the fix commit, neither of which `PipenzoTicketViewV1` carries today (its
 * `attempts[]` entries are `sessionId`/`tier`/`model`/`outcome` only; see
 * `pipenzo-ticket-v1.ts`'s own doc comment on why the attempt-outcome vocabulary is still the
 * phase machine's to define). Rather than inventing either number, this reads the one real signal
 * the wire shape does carry -- the last recorded attempt's tier and model -- the same restraint
 * `activity-row.ts`'s own `pipenzo:ci-failed` branch already applies, and the same honest fallback
 * for a ticket whose `attempts[]` came back empty (should not happen for a ticket the phase machine
 * actually moved here, but this card does not assume the invariant instead of checking it).
 */
function ciFixReadyDetail(ticket: PipenzoTicketViewV1): string {
  const last = ticket.attempts[ticket.attempts.length - 1];
  return last
    ? `A post-merge-request check failed. A fix attempt has since committed (${last.tier} tier, ${last.model}) and is waiting on this same human push gate -- it is never resubmitted on its own.`
    : 'A post-merge-request check failed on this ticket. It only moves here once a fix attempt commits -- nothing is pushed without an explicit human approval.';
}

/**
 * The Needs-human card body for each of `needs-human-card.ts`'s six real variants (issue #86, plus
 * #15's `plan-review`) -- see that module's own doc comment for exactly which real fields each one
 * is built from and which one named variant (`claim-conflict`) never reaches this function at all.
 *
 * `needs-pre-scoping`/`awaiting-stack-approval`/`plan-review` all reuse `Split` -- the same
 * primitive `RefusalPanel` already renders a richer version of on `TicketDetail`, and
 * `Main.dc.html`'s own board mock uses the identical `.split` block for the first two -- with only
 * the base `ticket.estimate` and, for a refusal, a real cached `proposedSplit` when one survived.
 * `plan-review`'s own full spec (EARS acceptance criteria, out-of-scope, files, estimate) is the
 * dedicated `PlanReviewPanel`'s job (`PlanReview.tsx`, issue #101), not this compact board card's --
 * same restraint `awaiting-stack-approval` already applies by not rendering its own reorder UI here.
 * `interrupted` uses the generic `Notice` rather
 * than the dangling `Resume` primitive: `Resume`'s own test suite (`Resume.test.tsx`) fixes Discard
 * and restart as *always* enabled, a contract this board card cannot honestly meet -- the ticket
 * list this card renders from carries no crash-recovery session data to back a real resume or
 * discard action from here, and a board-level "always enabled, does nothing" button would be
 * exactly the decorative control this codebase's own doc comments repeatedly refuse to ship. Wiring
 * `Resume` for real is a follow-up once the recovery report reaches the board (see this module's
 * sibling doc comment). `merge-conflict` reuses `Conflict` in its file-less mode -- no PR number, no
 * per-file hunk list, both absent from `PipenzoTicketViewV1` today -- with README's own real,
 * generic explanation of what the label means. `failed`/`generic` both reuse `FailNote`, the same
 * "parked, here's why" treatment issue #87 already established for a different lane.
 */
function needsHumanCardBody(card: NeedsHumanCardClassification): ReactNode {
  switch (card.variant) {
    case 'needs-pre-scoping':
      return (
        <Split
          icon="prohibit"
          quiet
          head="Declined at Refine · nothing written"
          kv={estimateKv(card)}
          rows={
            card.proposedSplit
              ? card.proposedSplit.map(
                  (part, index): SplitRow => ({
                    n: index + 1,
                    children: (
                      <>
                        {part.summary}{' '}
                        <span className="mono">
                          ≈ {part.changedLines.toLocaleString()} lines · {part.filesTouched} files
                        </span>
                      </>
                    ),
                  }),
                )
              : []
          }
        />
      );
    case 'awaiting-stack-approval':
      return (
        <Split
          icon="pr-stack"
          head={
            card.childCount > 0
              ? `Proposed stack · ${card.childCount} ${card.childCount === 1 ? 'PR' : 'PRs'}`
              : 'Awaiting a human decision on how to split or proceed'
          }
          kv={estimateKv(card)}
          rows={[]}
        />
      );
    case 'plan-review':
      return (
        <Split
          icon="gates"
          head="Refine finished · approve the spec before Implement starts"
          kv={estimateKv(card)}
          rows={[]}
        />
      );
    case 'interrupted':
      return (
        <Notice tone="warn" icon="warning" title="The daemon died mid-run">
          Last phase: <b>{phaseLabel(card.phase)}</b>.
          {card.branch && (
            <>
              {' '}
              Worktree branch <span className="mono">{card.branch}</span>.
            </>
          )}{' '}
          It never auto-resumes on its own -- open the ticket for the full record once resume/discard
          reaches the board.
        </Notice>
      );
    case 'merge-conflict':
      return (
        <Conflict icon="git-branch" head="Conflicts with main">
          <b>Nothing failed and no commit is lost.</b> The approved branch stopped merging cleanly
          with main while it waited -- a rebase re-enters the same human push gate.
        </Conflict>
      );
    case 'failed':
      return <FailNote>{failedOrGenericDetail(card, true)}</FailNote>;
    case 'generic':
      return <FailNote>{failedOrGenericDetail(card, false)}</FailNote>;
  }
}

/** The real lines/files/layered line every Split-based Needs-human variant shares -- never the
 *  canvas's own invented added/removed line split, which `pipenzoTicketEstimateV1Schema` does not
 *  carry (see `needs-human-card.ts`'s own doc comment). */
function estimateKv(card: { lines: number; files: number; layered: boolean }): string {
  const { lines, files, layered } = card;
  return `${lines.toLocaleString()} changed lines · ${files} file${files === 1 ? '' : 's'}${
    layered ? ' · layered' : ' · no clean layering'
  }`;
}

/** `Refine`/`Implement`/`Review`, the same three real phases `PIPENZO_PHASES` closes over. */
function phaseLabel(phase: PipenzoTicketViewV1['phase']): string {
  if (phase === 'refine') return 'Refine';
  if (phase === 'implement') return 'Implement';
  return 'Review';
}

/**
 * `failed`'s and `generic`'s shared `FailNote` body -- `isThreeFailed` only changes the headline
 * clause, never which fields are read: both variants carry the identical real shape
 * (`attemptCount`/`last`), and both fall back to the same honest "no attempts recorded yet" when
 * `last` is absent.
 */
function failedOrGenericDetail(
  card: { attemptCount: number; last?: PipenzoTicketAttemptV1 },
  isThreeFailed: boolean,
): ReactNode {
  const headline = isThreeFailed
    ? `Parked after ${card.attemptCount} failed attempts -- no more runs will be spent.`
    : `Parked for a human to look at -- ${card.attemptCount} attempt${
        card.attemptCount === 1 ? '' : 's'
      } recorded.`;
  if (!card.last) {
    return isThreeFailed ? headline : 'Parked for a human to look at -- no attempts recorded yet.';
  }
  return (
    <>
      {headline} Last attempt: {card.last.tier} tier, {card.last.model}, outcome &quot;
      {card.last.outcome}&quot;.
    </>
  );
}
