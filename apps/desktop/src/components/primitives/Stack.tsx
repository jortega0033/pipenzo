import type { ReactNode } from 'react';
import { Icon } from './Icon.js';

export type KidStatus = 'pending' | 'run' | 'done';

export interface KidSpec {
  key: string;
  status: KidStatus;
  /** The `x/n` index, e.g. `"2/3"`. */
  index: ReactNode;
  title: ReactNode;
  /** Rendered `.t.done` (text-faint) once `status` is `done`. */
  done?: boolean;
  /** The issue id, e.g. `"#109"` or `"#122 · waiting for a slot"`. */
  id: ReactNode;
  onOpen?: () => void;
}

/**
 * `.kids` / `.kid` -- the read-only child-ticket rows from Foundations.dc.html's "Cards" section
 * (a PR-stack container card) and TicketDetail.dc.html's stack-accepted approval card (same
 * markup, reused verbatim once a proposal is accepted). Each row: a 16px status well (`done` ->
 * check, `run` -> the play glyph, `pending` -> the plain surface-4 well with no icon -- the
 * canvas has no worked pending sample, so this follows `.kid-ic`'s own unmodified default rather
 * than inventing a fourth icon), the `x/n` index, the title (dimmed once `done`), the issue id,
 * and a real `<button>` external-link affordance (not the canvas's bare `<span tabindex="0">`,
 * for the same reason Notice.tsx's `.n-act` items are real buttons -- a keyboard/screen-reader
 * user gets an actual interactive element).
 */
export function Kids({ items }: { items: KidSpec[] }) {
  return (
    <div className="kids">
      {items.map(({ key, ...item }) => (
        <Kid key={key} {...item} />
      ))}
    </div>
  );
}

function Kid({ status, index, title, done = false, id, onOpen }: Omit<KidSpec, 'key'>) {
  return (
    <div className="kid">
      <span className={status === 'pending' ? 'kid-ic' : `kid-ic ${status}`}>
        {status === 'done' && <Icon name="check" size="xs" />}
        {status === 'run' && <Icon name="play" size="xs" />}
      </span>
      <span className="n">{index}</span>
      <span className={done ? 't done' : 't'}>{title}</span>
      <span className="id">{id}</span>
      <button type="button" className="ext" tabIndex={0} onClick={onOpen} aria-label="Open on GitHub">
        <Icon name="external" size="sm" />
      </button>
    </div>
  );
}
