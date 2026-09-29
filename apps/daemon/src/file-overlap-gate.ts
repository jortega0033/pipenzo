/**
 * File-overlap serialisation (Pipenzo issue #164), split off epic #5's "Build step 5: Queue +
 * dual-audience mode, bounded concurrency".
 *
 * README's *Build order* step 5 and the research report's concurrency decision (§11 decision 06,
 * and the step-5 build-order row) both land on the same rule: the bounded-concurrency queue runs a
 * default of 2 tickets at once (hard cap 4), and "two tickets whose Refine-phase 'files likely
 * touched' lists overlap" are serialised rather than dispatched in parallel — a conflict-avoidance
 * property a cloud sandbox fleet (Devin's model, which this project explicitly declines) does not
 * get for free.
 *
 * **This module is that comparison and nothing else.** The queue/orchestrator that would call it
 * (issue #5) does not exist yet in this codebase, so this is deliberately just the pure hold-vs-run
 * decision over two or more tickets' `filesLikelyTouched` lists — no dispatcher, no concurrency
 * semaphore, no persistence of the lists onto the ticket record (`pipenzo-ticket-v1.ts` does not
 * carry a field for them today; a future #5 would need to add one, or read them back from the
 * `RefineSpecV1` the Refine phase already produced). It matches `refine-gate.ts`'s shape: a pure
 * function over an already-shipped Refine-phase field (`RefineSpecV1['filesLikelyTouched']`, issue
 * #179), no I/O, nothing to fake in a test — the same reason that gate lives in this file's sibling
 * rather than inline in the phase it guards.
 *
 * Comparison is by exact repo-relative path, the same convention `filesLikelyTouched` is already
 * validated to (`repoRelativePathSchema` in `pipenzo-refine-v1.ts`: POSIX separators, no leading
 * slash, no `..` traversal) and the same one `review-gates.ts`'s `parseTouchedFiles` uses for the
 * real (not predicted) diff. A file only overlaps another ticket's prediction if the two strings are
 * the same path, not merely under the same directory — a prediction list is, by construction, files
 * rather than directories, so directory-prefix matching would be answering a question this list was
 * never shaped to answer.
 */

/** One in-flight ticket's identity plus the Refine-phase prediction to compare against. */
export interface FileOverlapCandidateV1 {
  readonly ticketId: string;
  /** Matches `RefineSpecV1['filesLikelyTouched']`'s element type — repo-relative POSIX paths. */
  readonly filesLikelyTouched: readonly string[];
}

export type FileOverlapDecisionV1 = 'run' | 'hold';

export interface FileOverlapVerdictV1 {
  readonly decision: FileOverlapDecisionV1;
  /** Which in-flight tickets share at least one file with the candidate, in `inFlight` order. */
  readonly overlappingTicketIds: readonly string[];
  /** The union of files responsible for the overlap, first-seen order, deduplicated. */
  readonly overlappingFiles: readonly string[];
}

/**
 * The set intersection two tickets' predictions share, by exact repo-relative path. Exported on its
 * own because it is the one primitive a future dispatcher is most likely to also want directly (for
 * example, to explain a hold decision in a log line) without paying for the full verdict shape.
 */
export function findOverlappingFiles(a: readonly string[], b: readonly string[]): string[] {
  const bSet = new Set(b);
  const seen = new Set<string>();
  const overlap: string[] = [];
  for (const path of a) {
    if (bSet.has(path) && !seen.has(path)) {
      seen.add(path);
      overlap.push(path);
    }
  }
  return overlap;
}

/**
 * The hold-vs-run decision issue #164 asks for: would dispatching `candidate` alongside `inFlight`
 * violate README's "overlapping-file tickets serialised" rule?
 *
 * `inFlight` entries sharing `candidate.ticketId` are ignored — a ticket never serialises against
 * itself, which keeps this safe to call with a snapshot of "every currently working ticket" whether
 * or not that snapshot happens to already include the candidate.
 */
export function evaluateFileOverlapGate(
  candidate: FileOverlapCandidateV1,
  inFlight: readonly FileOverlapCandidateV1[],
): FileOverlapVerdictV1 {
  const overlappingTicketIds: string[] = [];
  const overlappingFilesSeen = new Set<string>();
  const overlappingFiles: string[] = [];

  for (const other of inFlight) {
    if (other.ticketId === candidate.ticketId) continue;
    const overlap = findOverlappingFiles(candidate.filesLikelyTouched, other.filesLikelyTouched);
    if (overlap.length === 0) continue;
    overlappingTicketIds.push(other.ticketId);
    for (const path of overlap) {
      if (!overlappingFilesSeen.has(path)) {
        overlappingFilesSeen.add(path);
        overlappingFiles.push(path);
      }
    }
  }

  return {
    decision: overlappingTicketIds.length > 0 ? 'hold' : 'run',
    overlappingTicketIds,
    overlappingFiles,
  };
}
