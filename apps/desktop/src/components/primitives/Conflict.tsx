import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

export interface ConflictFile {
  path: string;
  /** e.g. "2 hunks". */
  hunks: string;
}

/**
 * The `.conflict` card block from Foundations.dc.html's "Cards" section -- deliberately one
 * family serving two different Needs-human card reactions rather than two separate blocks:
 * - `pipenzo:merge-conflict`: the branch went stale while it waited, so it names the conflicting
 *   files (`files`, with hunk counts) and a one-sentence `conflict-why` explaining that nothing
 *   failed and no commit is lost.
 * - claim conflict: another teammate's uncached re-check found the issue already assigned. There
 *   is nothing to name here (`files` omitted), and the card built on top of this block ends up
 *   the one Needs-human card with no action -- the claim is not this instance's to release.
 *
 * Both read amber, never red: neither is a failure, and nothing here invites forcing it.
 */
export function Conflict({
  icon,
  head,
  files,
  children,
}: {
  icon: IconName;
  head: ReactNode;
  files?: ConflictFile[];
  /** The `.conflict-why` paragraph. */
  children: ReactNode;
}) {
  return (
    <div className="conflict">
      <span className="conflict-head">
        <Icon name={icon} size="sm" />
        {head}
      </span>
      {files && files.length > 0 && (
        <div className="conflict-files">
          {files.map((file) => (
            <span className="conflict-file" key={file.path}>
              <span className="p">{file.path}</span>
              <span className="h">{file.hunks}</span>
            </span>
          ))}
        </div>
      )}
      <span className="conflict-why">{children}</span>
    </div>
  );
}
