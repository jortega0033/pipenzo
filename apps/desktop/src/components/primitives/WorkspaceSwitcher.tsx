import { useRef, type ReactNode } from 'react';
import { Icon } from './Icon.js';
import { Popover } from './Popover.js';

export interface WorkspaceSwitcherRepo {
  id: string;
  /** The 2-letter monogram shown in the 24-28px circle -- "JO", "ad", "pz", ... */
  monogram: string;
  /** e.g. "jortega0033/agentdock" */
  name: string;
  /**
   * The full subline, e.g. "main · 15 open · 2 running" / "main · 3 open · idle" /
   * "master · 5 open · 1 needs you" -- the canvas uses three different tail phrases depending on
   * repo state, so this is left to the caller rather than the component trying to encode that
   * business logic itself.
   */
  subline: string;
}

/**
 * The workspace switcher from Foundations.dc.html's "Popovers" section (.ws-menu: connected-repos
 * rows with a monogram, name + subline, an active check, and a "Manage repos…" footer row) plus
 * the .ws trigger it hangs off of, ported from the identical shared base CSS block where the
 * canvas first defines it (Main.dc.html's sidebar). Built on Popover.tsx (#32).
 *
 * Read-only, on purpose: this menu only switches which connected repo is active. Adding or
 * removing a connected repo is Settings' job -- the menu says so via its footer note instead of
 * growing an inline add/remove control, and "Manage repos…" is the one way out to that flow.
 */
export function WorkspaceSwitcher({
  open,
  onOpenChange,
  repos,
  activeRepoId,
  onSelectRepo,
  onManageRepos,
  manageReposNote,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repos: WorkspaceSwitcherRepo[];
  activeRepoId: string;
  onSelectRepo: (id: string) => void;
  onManageRepos: () => void;
  manageReposNote: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeRepo = repos.find((repo) => repo.id === activeRepoId);

  const selectRepo = (id: string) => {
    onSelectRepo(id);
    onOpenChange(false);
  };

  return (
    <>
      <button ref={triggerRef} type="button" className="ws" onClick={() => onOpenChange(true)}>
        <span className="ws-ic">{activeRepo?.monogram}</span>
        <span className="ws-text">
          <span className="ws-name">{activeRepo?.name}</span>
          <span className="ws-sub">{activeRepo?.subline}</span>
        </span>
        <Icon name="caret-down" className="ws-caret" />
      </button>
      <Popover
        open={open}
        onClose={() => onOpenChange(false)}
        anchorRef={triggerRef}
        className="ws-menu"
        title={`Connected repos · ${repos.length}`}
        footer={<span className="grow">{manageReposNote}</span>}
      >
        {repos.map((repo) => {
          const isActive = repo.id === activeRepoId;
          return (
            <button
              key={repo.id}
              type="button"
              className={isActive ? 'ws-menu-item active' : 'ws-menu-item'}
              onClick={() => selectRepo(repo.id)}
            >
              <span className="ws-ic">{repo.monogram}</span>
              <span className="wm-text">
                <span className="wm-name">{repo.name}</span>
                <span className="wm-sub">{repo.subline}</span>
              </span>
              {isActive && <Icon name="check" size="sm" className="wm-check" />}
            </button>
          );
        })}
        <div className="pop-sep" />
        <button
          type="button"
          className="ws-menu-item foot"
          onClick={() => {
            onManageRepos();
            onOpenChange(false);
          }}
        >
          <Icon name="settings" />
          Manage repos…
        </button>
      </Popover>
    </>
  );
}
