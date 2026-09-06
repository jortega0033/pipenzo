import { Fragment, type KeyboardEvent, type ReactNode } from 'react';
import { Avatar } from './Avatar.js';
import { Icon, type IconName } from './Icon.js';

/**
 * `.shell` -- the app's own two-column layout from Main.dc.html's shared sidebar/main-head block
 * (the same base CSS every other artboard reuses): a fixed-width `Sidebar` plus the `.main`
 * column everything else renders into. Just the frame -- `sidebar` and `children` are free-form
 * so a screen composes its own nav/content inside them.
 */
export function AppShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="shell">
      {sidebar}
      <div className="main">{children}</div>
    </div>
  );
}

/** `.sidebar` -- 240px wide, collapsing to 64px (icon rail only) when `collapsed`. The width
 * transition and which sub-parts hide (`wordmark`, `ws-text`, nav labels/counts, `sb-user-text`)
 * are handled entirely by the `.sidebar.collapsed` CSS rule -- children render unconditionally,
 * the same content just narrows around them. */
export function Sidebar({
  collapsed = false,
  children,
}: {
  collapsed?: boolean;
  children: ReactNode;
}) {
  return <div className={collapsed ? 'sidebar collapsed' : 'sidebar'}>{children}</div>;
}

/** `.brand` -- the circular logo mark plus wordmark at the top of the sidebar. */
export function SidebarBrand({
  mark = 'p',
  name = 'pipenzo',
}: {
  mark?: ReactNode;
  name?: ReactNode;
}) {
  return (
    <div className="brand">
      <div className="logo-mark">{mark}</div>
      <span className="wordmark">{name}</span>
    </div>
  );
}

/** `.nav-group` -- a labeled cluster of `NavItem`s (e.g. "Work", "Repo"). `title` is optional
 * since the canvas's own nav groups all carry one, but a collapsed sidebar hides it via CSS
 * regardless. */
export function NavGroup({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <div className="nav-group">
      {title && <span className="nav-title">{title}</span>}
      {children}
    </div>
  );
}

/**
 * `.nav-item` -- one sidebar row: an icon, a label, and an optional trailing count. `hot` tints
 * the count danger-text/bold, e.g. Needs-me's unread-style "7" -- a count worth noticing, as
 * opposed to Board's plain "15". `kbd` renders the count as a `.kbd` pill instead of plain mono
 * text, the one canvas example being the Collapse row's `"["` shortcut hint
 * (`class="nav-count kbd"`, both together).
 */
export function NavItem({
  icon,
  active = false,
  count,
  hot = false,
  kbd = false,
  onClick,
  children,
}: {
  icon: IconName;
  active?: boolean;
  count?: ReactNode;
  hot?: boolean;
  kbd?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick?.();
    }
  };
  const countClass = ['nav-count', hot && 'hot', kbd && 'kbd'].filter(Boolean).join(' ');

  return (
    <div
      className={active ? 'nav-item active' : 'nav-item'}
      tabIndex={0}
      role="button"
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <Icon name={icon} />
      <span className="nav-lbl">{children}</span>
      {count !== undefined && <span className={countClass}>{count}</span>}
    </div>
  );
}

/** `.sb-foot` -- pinned to the bottom of the sidebar (`margin-top: auto`): the Collapse toggle
 * (a plain `NavItem` with `kbd` count `"["`) and `SidebarUser` below it. */
export function SidebarFoot({ children }: { children: ReactNode }) {
  return <div className="sb-foot">{children}</div>;
}

/** `.sb-user` -- the account row at the very bottom of the sidebar: an `Avatar`, name and mode
 * subline (e.g. "Expert mode"). */
export function SidebarUser({
  initials,
  name,
  sub,
  onClick,
}: {
  initials: string;
  name: ReactNode;
  sub: ReactNode;
  onClick?: () => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick?.();
    }
  };

  return (
    <div className="sb-user" tabIndex={0} role="button" onClick={onClick} onKeyDown={onKeyDown}>
      <Avatar initials={initials} />
      <span className="sb-user-text">
        <span className="sb-user-name">{name}</span>
        <span className="sb-user-sub">{sub}</span>
      </span>
    </div>
  );
}

/** `.main-head` -- the 56px header row above a screen's own content: `Crumbs` on the left,
 * `MainHeadRight` (sync status, ⌘K, primary action, avatar -- each its own existing primitive)
 * on the right. */
export function MainHead({ children }: { children: ReactNode }) {
  return <div className="main-head">{children}</div>;
}

export function MainHeadRight({ children }: { children: ReactNode }) {
  return <div className="main-head-r">{children}</div>;
}

/** `.crumbs` -- a `caret-right`-separated trail, the last item bolded (`.cur`) as the current
 * page. Earlier items render as given (wrap one in `.mono` yourself for a repo-name-shaped
 * crumb, matching the canvas's own `"jortega0033/agentdock"` first crumb). */
export function Crumbs({ items }: { items: ReactNode[] }) {
  return (
    <div className="crumbs">
      {items.map((item, i) => (
        <Fragment key={i}>
          {i > 0 && <Icon name="caret-right" size="sm" />}
          {i === items.length - 1 ? <span className="cur">{item}</span> : item}
        </Fragment>
      ))}
    </div>
  );
}
