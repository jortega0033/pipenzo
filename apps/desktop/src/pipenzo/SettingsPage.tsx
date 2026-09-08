import { AccountPanel } from './AccountPanel.js';
import { ConnectedReposPanel } from './ConnectedReposPanel.js';

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
 * their own heights instead of the taller column stretching the shorter one. The left column holds
 * Connected repos (#125); the right holds Account / Providers / Disconnect (#130), which is where
 * the canvas puts it. The remaining canvas panels are their own tickets — Concurrency (#126),
 * Default mode (#127), Lesson memory (#128), Notifications (#129) — and each drops into a column
 * here rather than restating the layout. A `.col` element stays absent until something occupies it:
 * an empty grid child is markup that renders nothing and that a later reader has to prove is
 * unused.
 *
 * ## What this is not
 *
 * Not the app shell. `AppShell`/`Sidebar`/`MainHead` are separate primitives and the nav that
 * selects this screen belongs to the shell ticket, not to the page it would show. This component
 * is the `.page` element the shell's `.main` column renders into, so it can be dropped in without
 * that ticket having to unpick a frame this one guessed at.
 */
export function SettingsPage() {
  return (
    <div className="page">
      <p className="sec-note">
        Everything here is per-machine. Pipenzo is one desktop app per developer, not a shared
        server — the shared state is on GitHub, in labels and issue assignment, and none of it is
        changed by anything on this page.
      </p>

      <div className="cols">
        <div className="col">
          <ConnectedReposPanel />
        </div>
        <div className="col">
          <AccountPanel />
        </div>
      </div>
    </div>
  );
}
