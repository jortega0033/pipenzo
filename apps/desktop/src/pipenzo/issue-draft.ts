import type { PipenzoIssueDraftV1 } from '@agent-dock/shared';

/**
 * Rendering a drafted issue (Pipenzo issue #84).
 *
 * Main.dc.html's plan dialog makes a claim under the draft, and these functions are what makes it
 * true rather than a caption:
 *
 * > Written by a cheap-tier style pass over prose only. Every number, gate result and check below
 * > it is rendered from data and never rewritten.
 *
 * So: the drafting session returns a **structured** draft whose only prose field is `title`, and
 * everything a human reads below that title is laid out here, by pure functions, from those
 * fields. There is no path by which model-written markdown reaches a GitHub issue body — not
 * because a prompt asks it not to, but because `PipenzoIssueDraftV1` has no field to put it in and
 * `renderDraftedIssueBody` reads only the ones it does have.
 */

/**
 * The one-line summary the dialog's preview shows under the title.
 *
 * Assembled in the canvas's own order — acceptance, then out of scope, then the estimate — because
 * that is the order a reader needs them in to decide whether to file: what it must do, what it
 * will not do, and what it will cost.
 */
export function renderDraftSummary(draft: PipenzoIssueDraftV1): string {
  const acceptance = draft.acceptanceCriteria.map((criterion) => criterion.text).join(' ');
  const outOfScope = draft.outOfScope.join(', ');
  const files = `${draft.estimate.filesTouched} file${draft.estimate.filesTouched === 1 ? '' : 's'}`;
  return (
    `Acceptance: ${acceptance} ` +
    `Out of scope: ${outOfScope}. ` +
    `Est. ≤ ${draft.estimate.changedLines} lines across ${files}.`
  );
}

/**
 * The issue body, in markdown, from the draft's fields and nothing else.
 *
 * Every section is present whether or not it has content, and an empty one says so — "None
 * recorded." rather than a missing heading. A reader of a filed issue has to be able to tell "the
 * drafter had no open questions" from "this tool does not record open questions", and a heading
 * that vanishes when empty destroys exactly that distinction.
 */
export function renderDraftedIssueBody(draft: PipenzoIssueDraftV1): string {
  const sections = [
    '## Acceptance criteria',
    '',
    ...draft.acceptanceCriteria.map(
      (criterion) => `- **${criterion.id}** (${criterion.kind}) ${criterion.text}`,
    ),
    '',
    '## Out of scope',
    '',
    ...draft.outOfScope.map((entry) => `- ${entry}`),
    '',
    '## Estimate',
    '',
    `- ${draft.estimate.changedLines} changed lines across ${draft.estimate.filesTouched} files`,
    `- Splits into 2-4 dependency-ordered pull requests: ${draft.estimate.layered ? 'yes' : 'no'}`,
    '',
    '## Open questions',
    '',
    ...(draft.openQuestions.length > 0
      ? draft.openQuestions.map((entry) => `- ${entry}`)
      : ['None recorded.']),
    '',
    // Provenance, on every issue this flow files. A reader six months later needs to know a model
    // drafted the title and a person pressed the button, and neither half is obvious from the
    // result.
    '---',
    '',
    'Drafted by Pipenzo from a free-text idea and filed by a human. The title is prose; every ' +
      'section above it is rendered from the drafted fields and was not rewritten.',
  ];
  return sections.join('\n');
}
