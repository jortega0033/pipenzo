import type { ReactNode } from 'react';

/**
 * `.grade-table` -- the risk-graded comparison grid from Foundations.dc.html's "Risk-graded
 * approval" section (the LOW/MEDIUM/HIGH behaviour matrix, 140px label column + 3 equal data
 * columns) and its "findings" severity-effect table (severity / chip / effect on the gate, a
 * different 96px/110px/1fr layout passed via `columns`). A plain CSS grid, one `GradeHeader` (or
 * `GradeCell`) per column per row, in row-major order -- the grid itself doesn't know about rows,
 * so callers lay cells out flat the same way the canvas's own markup does.
 *
 * `GradeCell`'s `deemphasize` is the canvas's `.no` treatment (text-faint) for a cell that's
 * explicitly *not* the case -- "Never", "No — proceeds, logged", "Recorded and shown. No effect
 * on any gate." -- read as de-emphasized rather than a plain answer.
 */
export function GradeTable({
  columns,
  children,
}: {
  /** Overrides the default `140px repeat(3, 1fr)` grid-template-columns, e.g.
   * `"96px 110px minmax(0,1fr)"` for the findings table. */
  columns?: string;
  children: ReactNode;
}) {
  return (
    <div className="grade-table" style={columns ? { gridTemplateColumns: columns } : undefined}>
      {children}
    </div>
  );
}

/** One `.gh` header cell -- the column's caption, or empty in the top-left corner. */
export function GradeHeader({ children }: { children?: ReactNode }) {
  return <div className="gh">{children}</div>;
}

/** One plain data cell. `deemphasize` applies `.no` (text-faint) for an explicit "not the case"
 * answer, as opposed to a plain unstyled fact. */
export function GradeCell({
  deemphasize = false,
  children,
}: {
  deemphasize?: boolean;
  children?: ReactNode;
}) {
  return <div className={deemphasize ? 'no' : undefined}>{children}</div>;
}
