import { useMemo, useState } from 'react';
import { Icon } from '../components/primitives/Icon.js';
import { parseUnifiedDiff, splitPath, type DiffFile, type DiffLine } from './diff-parser.js';

/** A finding's `file:line` reference (issue #109's rail), used to mark that line's gutter --
 * `tr.hit` in DiffReview.dc.html -- rather than scroll it out from under the reader. */
export interface DiffHitLocation {
  readonly path: string;
  readonly line: number;
}

/**
 * The unified-diff renderer (issue #107): parses a real diff string into per-file cards with a
 * path split (directory dimmed, filename bright — DiffReview.dc.html's `.file-head .path`),
 * per-file `+N`/`−N` stats, `@@ … @@` hunk headers, collapsible hunks, and the two-column
 * (old/new) line-numbered `add`/`del`/`ctx` table.
 *
 * Hunks default expanded, matching the canvas's own always-expanded example; collapsing is this
 * component's own addition on top of the static artboard (same shape as `ScreenshotLightbox`'s
 * prev/next/Esc — a real interaction a static canvas has no way to show). Each hunk header is a
 * real `<button>` inside its `td.code` cell, not a bare clickable `<tr>`, so it stays a proper
 * keyboard/screen-reader target.
 */
export function DiffFileList({
  diffText,
  hitLocation,
}: {
  diffText: string;
  hitLocation?: DiffHitLocation;
}) {
  const files = useMemo(() => parseUnifiedDiff(diffText), [diffText]);

  return (
    <div className="diffs">
      {files.map((file) => (
        <DiffFileCard key={file.path} file={file} hitLocation={hitLocation} />
      ))}
    </div>
  );
}

function DiffFileCard({ file, hitLocation }: { file: DiffFile; hitLocation?: DiffHitLocation }) {
  const { dir, name } = splitPath(file.path);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());

  const toggleHunk = (hunkIndex: number) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(hunkIndex)) next.delete(hunkIndex);
      else next.add(hunkIndex);
      return next;
    });
  };

  return (
    <div className="file">
      <div className="file-head">
        <span className="path">
          <Icon name="file" size="sm" />
          {dir && <span className="dir">{dir}</span>}
          {name}
        </span>
        <span className="file-stat">
          <span className="add-t">+{file.additions}</span>
          <span className="del-t">−{file.deletions}</span>
        </span>
      </div>
      <table className="hunk">
        <tbody>
          {file.hunks.map((hunk, hunkIndex) => {
            const isCollapsed = collapsed.has(hunkIndex);
            return (
              <HunkRows
                key={hunkIndex}
                header={hunk.header}
                lines={hunk.lines}
                collapsed={isCollapsed}
                onToggle={() => toggleHunk(hunkIndex)}
                path={file.path}
                hitLocation={hitLocation}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HunkRows({
  header,
  lines,
  collapsed,
  onToggle,
  path,
  hitLocation,
}: {
  header: string;
  lines: readonly DiffLine[];
  collapsed: boolean;
  onToggle: () => void;
  path: string;
  hitLocation?: DiffHitLocation;
}) {
  return (
    <>
      <tr className="hh">
        <td className="ln" />
        <td className="ln" />
        <td className="sign" />
        <td className="code">
          <button type="button" className="hunk-toggle" onClick={onToggle} aria-expanded={!collapsed}>
            <Icon name={collapsed ? 'caret-right' : 'caret-down'} size="xs" />
            {header}
          </button>
        </td>
      </tr>
      {!collapsed &&
        lines.map((line, lineIndex) => {
          const lineNumber = line.newLineNumber ?? line.oldLineNumber;
          const isHit =
            !!hitLocation && hitLocation.path === path && lineNumber === hitLocation.line;
          const rowClass = isHit ? `${line.kind === 'context' ? 'ctx' : line.kind} hit` : line.kind === 'context' ? 'ctx' : line.kind;
          return (
            <tr key={lineIndex} className={rowClass}>
              <td className="ln">{line.oldLineNumber ?? ''}</td>
              <td className="ln">{line.newLineNumber ?? ''}</td>
              <td className="sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</td>
              <td className="code">{line.content}</td>
            </tr>
          );
        })}
    </>
  );
}
