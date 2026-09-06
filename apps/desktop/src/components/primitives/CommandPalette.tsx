import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';
import { Popover } from './Popover.js';

export interface CommandPaletteItem {
  /** Stable key for React and for tracking the keyboard-active row across re-filters. */
  key: string;
  /** Leading mono id, e.g. "#85" for a ticket row -- omitted for a repo or action row. */
  id?: string;
  icon?: IconName;
  label: string;
  /** Trailing content -- a Chip, a Kbd, or a plain mono count, matching the canvas's own rows. */
  meta?: ReactNode;
  onSelect: () => void;
}

export interface CommandPaletteGroup {
  title: string;
  items: CommandPaletteItem[];
}

/**
 * The ⌘K command palette from Foundations.dc.html's "Popovers" section: a search field over
 * results grouped by type -- tickets, repos, then actions -- always in that fixed order, never
 * ranked by relevance, so the same key sequence lands on the same row every time. Built on top
 * of Popover.tsx (ticket #32) rather than reimplementing the floating shell.
 *
 * `groups` is supplied already filtered by the caller (whatever `query` currently is) -- this
 * component owns presentation and the up/down/enter/esc keyboard model, not the search/filter
 * logic or where results come from. That data source matters: the palette is specified to read
 * from the ticket store directly rather than the board's poll cache, so it can find a ticket the
 * board is still waiting on a poll to show -- but that's a property of what the caller passes as
 * `groups`, not something a presentational primitive enforces.
 *
 * Deliberately has no "run" action anywhere in its item model: the palette navigates and drafts
 * only. Approving an action or starting a run happens on the card and in the approval gate,
 * where the pre-commitment and reject-reason context actually live.
 */
export function CommandPalette({
  open,
  onOpenChange,
  query,
  onQueryChange,
  groups,
  placeholder = 'Jump to ticket, repo, action…',
  triggerLabel = 'Jump to ticket, repo, action…',
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  groups: CommandPaletteGroup[];
  placeholder?: string;
  triggerLabel?: string;
  footer?: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const flatItems = groups.flatMap((group) => group.items);
  const [activeKey, setActiveKey] = useState<string | undefined>(flatItems[0]?.key);

  // The active row resets to the top of the (fixed-order) results whenever the palette opens or
  // the result set changes shape -- e.g. a new query re-filtered the groups.
  useEffect(() => {
    if (!open) return;
    setActiveKey((current) =>
      current && flatItems.some((item) => item.key === current) ? current : flatItems[0]?.key,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, groups]);

  const activeIndex = flatItems.findIndex((item) => item.key === activeKey);

  const moveActive = (delta: number) => {
    if (flatItems.length === 0) return;
    const nextIndex = (activeIndex + delta + flatItems.length) % flatItems.length;
    setActiveKey(flatItems[nextIndex]!.key);
  };

  const select = (item: CommandPaletteItem) => {
    item.onSelect();
    onOpenChange(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const active = flatItems.find((item) => item.key === activeKey);
      if (active) select(active);
    }
    // Escape is handled by Popover itself.
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={open ? 'cmdk open' : 'cmdk'}
        onClick={() => onOpenChange(true)}
      >
        <Icon name="search" />
        <span>{triggerLabel}</span>
        <span className="kbd">⌘K</span>
      </button>
      <Popover
        open={open}
        onClose={() => onOpenChange(false)}
        anchorRef={triggerRef}
        className="cmdk-panel"
        aria-label="Command palette"
        footer={footer}
      >
        <div className="cmdk-search" onKeyDown={onKeyDown}>
          <Icon name="search" />
          <input
            className="field"
            placeholder={placeholder}
            aria-label="Search tickets, repos and actions"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="pop-sep" />
        <div className="cmdk-results" onKeyDown={onKeyDown}>
          {groups.map((group) => (
            <div className="cmdk-group" key={group.title}>
              <span className="cmdk-group-title">{group.title}</span>
              {group.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={item.key === activeKey ? 'cmdk-item active' : 'cmdk-item'}
                  onClick={() => select(item)}
                >
                  {item.icon && <Icon name={item.icon} />}
                  {item.id && <span className="cmdk-id">{item.id}</span>}
                  <span className="cmdk-lbl">{item.label}</span>
                  {item.meta}
                </button>
              ))}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}
