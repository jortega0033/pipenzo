import type { ReactNode } from 'react';
import { Icon } from './Icon.js';

/**
 * The inline progress line from Foundations.dc.html's "Loading, error and empty" section: a
 * spinning icon plus one sentence naming what is actually being read, e.g. "Reading open issues
 * from jortega0033/agentdock — first poll of this session". It appears above the page-level board
 * skeleton on a cold start, and reappears anywhere else content is being fetched from a named
 * source rather than merely "loading" -- the canvas's own note is that this line is what says
 * *what*, while the skeleton underneath it says *how much*.
 */
export function LoadLine({ children }: { children: ReactNode }) {
  return (
    <div className="load-line">
      <Icon name="spinner" size="sm" className="spin" />
      <span>{children}</span>
    </div>
  );
}
