/**
 * A unified-diff parser and per-file/per-hunk model for the DiffReview renderer (issue #107).
 *
 * No `react-diff-view` (or `gitdiff-parser`) dependency: nothing in this repo's package.json pulls
 * either in, and every other primitive in `components/primitives/` is hand-built to match the
 * design canvas's exact markup rather than adopt a third-party component's own DOM shape (see
 * VerificationBlock.tsx, FindingsList.tsx, Screenshot.tsx). DiffReview.dc.html's `table.hunk`
 * markup -- two line-number columns, a sign column, a code column, `tr.hh`/`.ctx`/`.add`/`.del` --
 * is bespoke to this design system, so a hand-rolled parser producing exactly that shape is more
 * consistent with the codebase than pulling in a library built around a different one.
 *
 * The input is a real unified diff string: what `GitHubClient.getPullRequestDiff` (issue #177)
 * returns for an open PR, or the output of `git diff` against a worktree's base commit for one
 * that isn't pushed yet. Either way, this module only ever sees text -- it does not run `git`
 * itself.
 */

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Absent for an added line -- it did not exist in the old file. */
  readonly oldLineNumber?: number;
  /** Absent for a removed line -- it does not exist in the new file. */
  readonly newLineNumber?: number;
  readonly content: string;
}

export interface DiffHunk {
  /** The raw `@@ -a,b +c,d @@ ...` header line, shown verbatim in the hunk's `tr.hh` row. */
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface DiffFile {
  /** Repo-relative path. Equal to `newPath` except for a pure delete, where only `oldPath` exists. */
  readonly path: string;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const OLD_FILE_LINE = /^--- (?:a\/(.+)|\/dev\/null)$/;
const NEW_FILE_LINE = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/;

/** Splits a repo-relative path into its directory and file-name halves, matching
 * DiffReview.dc.html's `.file-head .path` markup (`<span class="dir">…/</span>filename`). */
export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { dir: '', name: path }
    : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** Parses a real unified diff (as produced by `git diff` or GitHub's `.diff` media type) into one
 * `DiffFile` per file, each with its hunks already split and every line classified and numbered. */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diffText.split(/\r?\n/);

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const fileMatch = FILE_HEADER.exec(line);
    if (!fileMatch) {
      index += 1;
      continue;
    }
    index += 1;

    let oldPath: string | undefined = fileMatch[1];
    let newPath: string | undefined = fileMatch[2];

    // Skip metadata lines (`index …`, `new file mode …`, `deleted file mode …`, `similarity
    // index …`, `rename from/to …`, …) until the --- / +++ pair or the next file/end of input.
    while (index < lines.length && !FILE_HEADER.test(lines[index] ?? '') && !HUNK_HEADER.test(lines[index] ?? '')) {
      const candidate = lines[index] ?? '';
      const oldMatch = OLD_FILE_LINE.exec(candidate);
      const newMatch = NEW_FILE_LINE.exec(candidate);
      if (oldMatch) {
        oldPath = oldMatch[1];
        index += 1;
        continue;
      }
      if (newMatch) {
        newPath = newMatch[1];
        index += 1;
        continue;
      }
      index += 1;
    }

    const hunks: DiffHunk[] = [];
    let additions = 0;
    let deletions = 0;

    while (index < lines.length) {
      const hunkMatch = HUNK_HEADER.exec(lines[index] ?? '');
      if (!hunkMatch) break;
      const header = lines[index] ?? '';
      index += 1;
      let oldLineNumber = Number(hunkMatch[1]);
      let newLineNumber = Number(hunkMatch[2]);
      const hunkLines: DiffLine[] = [];

      while (index < lines.length) {
        const body = lines[index];
        if (body === undefined || FILE_HEADER.test(body) || HUNK_HEADER.test(body)) break;
        if (body.startsWith('\\')) {
          // "\ No newline at end of file" -- not a line of the diff itself.
          index += 1;
          continue;
        }
        if (body.startsWith('+')) {
          hunkLines.push({ kind: 'add', newLineNumber, content: body.slice(1) });
          newLineNumber += 1;
          additions += 1;
        } else if (body.startsWith('-')) {
          hunkLines.push({ kind: 'del', oldLineNumber, content: body.slice(1) });
          oldLineNumber += 1;
          deletions += 1;
        } else {
          // A context line is a leading space plus content; tolerate a bare blank line too.
          hunkLines.push({
            kind: 'context',
            oldLineNumber,
            newLineNumber,
            content: body.startsWith(' ') ? body.slice(1) : body,
          });
          oldLineNumber += 1;
          newLineNumber += 1;
        }
        index += 1;
      }
      hunks.push({ header, lines: hunkLines });
    }

    const path = newPath ?? oldPath ?? '(unknown file)';
    files.push({ path, oldPath, newPath, additions, deletions, hunks });
  }

  return files;
}
