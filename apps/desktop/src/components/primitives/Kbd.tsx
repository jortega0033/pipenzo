import type { ReactNode } from 'react';

/** One key of a keyboard shortcut, e.g. `<Kbd>⌘</Kbd><Kbd>K</Kbd>` for "opens the command palette". */
export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}
