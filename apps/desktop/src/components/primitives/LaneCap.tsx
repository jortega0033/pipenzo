import type { ReactNode } from 'react';
import { Icon } from './Icon.js';

/**
 * The Working lane header's capacity pill -- see "lane capacity · Working lane header, mono,
 * amber when full". Three renderings: `running` (under capacity, play icon), `full` (at
 * capacity, amber tint, still play icon -- it's a degradation, not a failure), and `held` (a
 * ticket waiting on a file-overlap slot, pause icon instead of play).
 */
export type LaneCapKind = 'running' | 'full' | 'held';

export function LaneCap({ kind, children }: { kind: LaneCapKind; children: ReactNode }) {
  return (
    <span className={kind === 'full' ? 'lane-cap full' : 'lane-cap'}>
      <Icon name={kind === 'held' ? 'pause' : 'play'} size="sm" />
      {children}
    </span>
  );
}
