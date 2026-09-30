import type { ReviewReportV1 } from '@agent-dock/shared';
import { combineFindings } from './rail.js';

/**
 * `LessonPrompt`'s pure logic (issue #104): what to pre-fill its field with, and how to read the
 * daemon's own post-save answer. Kept separate from the component so the sourcing decision below
 * is independently testable without touching JSX, the same split `rail.ts` already uses for
 * `RailPanel.tsx`.
 */

/** `pipenzoLessonCreateV1Schema`'s own `text` cap, mirrored here so a derived pre-fill can never
 *  itself be the reason a save is rejected. */
const LESSON_TEXT_MAX = 500;

/**
 * `TicketDetail.dc.html`'s own comment on this prompt: "pre-filled from the mismatch this run
 * actually hit." Never invented copy -- only text this run's own review report actually produced,
 * in this preference order:
 *
 * 1. The highest-severity finding either LLM pass reported. `combineFindings` already merges and
 *    severity-sorts the reviewer's and verifier's findings for the rail (issue #109); reused here
 *    rather than re-derived, so the two views of the same report can never quietly disagree on
 *    which finding matters most.
 * 2. Failing that, a blown diff-scope estimate (issue #144/#145) -- also real and already
 *    computed, just a different field of the same report.
 * 3. Failing that, an empty string. `LessonPrompt` still renders an editable, empty field rather
 *    than skip the offer entirely -- see that component's own doc comment -- but this module never
 *    fabricates a sentence just to avoid handing back "".
 */
export function deriveLessonPrefill(report: ReviewReportV1 | undefined): string {
  if (!report) return '';

  const findings = combineFindings(report.reviewer, report.verifier);
  if (findings.length > 0) return findings[0]!.message.slice(0, LESSON_TEXT_MAX);

  const { diffScope } = report;
  if (diffScope?.exceededEstimate && diffScope.estimate) {
    const sentence =
      `This run's diff came in at ${diffScope.implementation.changedLines} lines against a ` +
      `${diffScope.estimate.changedLines}-line Refine estimate.`;
    return sentence.slice(0, LESSON_TEXT_MAX);
  }

  return '';
}

/**
 * The per-repo count `LessonPrompt`'s saved state reads for "Saved locally — N lesson(s) on
 * {repo}" (`TicketDetail.dc.html`'s own example: "Saved locally — 1 lesson on
 * jortega0033/agentdock"). Computed from the daemon's own post-save list
 * (`POST /v2/pipenzo/lessons`'s `PipenzoLessonListV1` response), never a locally incremented guess
 * -- the same "the daemon's own answer, not a filtered view this renderer assembled" reasoning
 * `LessonsPanel.tsx` already states for its own delete.
 */
export function countLessonsForRepo(lessons: readonly { readonly repo: string }[], repo: string): number {
  return lessons.filter((lesson) => lesson.repo === repo).length;
}
