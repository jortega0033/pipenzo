import { AccountPanel } from './AccountPanel.js';
import { AppearancePanel } from './AppearancePanel.js';
import { ConcurrencyPanel } from './ConcurrencyPanel.js';
import { ConnectedReposPanel } from './ConnectedReposPanel.js';
import { LessonsPanel } from './LessonsPanel.js';
import { NotificationsPanel } from './NotificationsPanel.js';

/**
 * The Settings screen's page body (issue #125): the per-machine framing note, then the two-column
 * grid every settings panel lands in.
 *
 * ## Why the note is first, and is not a notice
 *
 * `Settings.dc.html` opens with it, above everything, and it is doing real work: Pipenzo is one
 * desktop app per developer rather than a shared server, so nothing on this page changes anything
 * another person can see. Somebody who assumes otherwise will read "Connected repos" as team
 * configuration and "Disconnect GitHub" as revoking an integration for everyone. It is `.sec-note`
 * — quiet standing context — rather than a `Notice`, because a notice is something that happened,
 * and this is simply true all the time.
 *
 * ## Why the grid, and why it is only half full
 *
 * `.cols` is a two-column CSS grid with `align-items: start`, so each column's panels stack to
 * their own heights instead of the taller column stretching the shorter one. `.col` is itself a
 * flex column (`gap: 16px`), so a column holding more than one panel stacks them with the same
 * rhythm the canvas draws — which is why `ConnectedReposPanel` and `LessonsPanel` share one `.col`
 * below rather than each claiming a grid cell of their own. The left column holds Connected repos
 * (#125), Concurrency (#126) and Lesson memory (#128), in the canvas's own order; the right holds
 * Notifications (#129) ahead of Account / Providers / Disconnect (#130), matching the canvas's own
 * right-column order. The remaining canvas panel is its own still-open ticket — Default mode (#127)
 * slots into the left column below Concurrency once built — and it will drop into its column here
 * rather than restating the layout.
 *
 * ## What this is not
 *
 * Not the app shell. `AppShell`/`Sidebar`/`MainHead` are separate primitives and the nav that
 * selects this screen belongs to the shell ticket, not to the page it would show. This component
 * is the `.page` element the shell's `.main` column renders into, so it can be dropped in without
 * that ticket having to unpick a frame this one guessed at.
 *
 * `openRepoPickerToken`/`onConnectedReposChange` (issue #89) pass straight through to
 * `ConnectedReposPanel` -- see its own doc comments. This page has no opinion on either; it only
 * sits between the shell that owns the workspace switcher and the panel that owns the picker.
 */
export function SettingsPage({
  openRepoPickerToken,
  onConnectedReposChange,
}: {
  openRepoPickerToken?: number;
  onConnectedReposChange?: (repositories: readonly string[]) => void;
} = {}) {
  return (
    <div className="page">
      <p className="sec-note">
        Everything here is per-machine. Pipenzo is one desktop app per developer, not a shared
        server — the shared state is on GitHub, in labels and issue assignment, and none of it is
        changed by anything on this page.
      </p>

      <div className="cols">
        <div className="col">
          <ConnectedReposPanel
            openPickerToken={openRepoPickerToken}
            onRepositoriesChange={onConnectedReposChange}
          />
          <ConcurrencyPanel />
          <LessonsPanel />
        </div>
        <div className="col">
          <NotificationsPanel />
          <AccountPanel />
          <AppearancePanel />
        </div>
      </div>
    </div>
  );
}
