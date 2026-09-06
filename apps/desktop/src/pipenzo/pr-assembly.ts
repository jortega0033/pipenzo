import type { PipenzoPullRequestInputV1, RefineSpecV1, ReviewReportV1 } from '@agent-dock/shared';
import { formatDiffScopeSummary, mapFindingSeverity } from './rail.js';

/**
 * Commit message and PR body assembly (issue #111) -- pure functions over the two contracts that
 * actually exist (`RefineSpecV1`, `ReviewReportV1`) plus a small options bag for the pieces
 * neither schema carries yet, all listed below. Kept as pure string-building rather than another
 * LLM call: README's Refine/Review phases already produced everything real used here, and a third
 * pass to reword it into prose would be an extra model call this walking-skeleton step does not
 * need and this ticket was never scoped to add.
 *
 * What this deliberately does NOT invent data for:
 * - **Conventional-commit `type(scope)`** (`fix(mcp): …`). Neither `RefineSpecV1` nor
 *   `ReviewReportV1` carries a task type -- that's issue #10's "Task-type-aware routing" table,
 *   not built yet. `commitType`/`commitScope` are optional caller-supplied strings; omitted, the
 *   subject line is the issue title with no prefix rather than a guessed one.
 * - **Pre-commitment match/mismatch counts.** The canvas's own confidence-line example
 *   ("1 of 2 pre-commitments matched…") reads a schema that doesn't exist yet either -- no
 *   pre-commitment/self-assessment contract is defined anywhere in `packages/shared`.
 *   `buildConfidenceLine` instead reports what `ReviewReportV1` actually contains: the verifier's
 *   verdict, how many critical findings survived it, and how the diff landed against its estimate.
 * - **Dropped spec-test rulings.** `REVIEW_OUTCOMES` names `awaiting_test_adjudication` as a
 *   possible outcome, but the report shape carries no list of *which* spec-generated tests were
 *   adjudicated or dropped. `droppedSpecTests` is an optional caller-supplied list; empty by
 *   default, rendered as "none" rather than omitted, so a PR body reader can tell "none happened"
 *   apart from "this tool doesn't report that yet".
 */
export interface PullRequestAssemblyOptions {
  readonly commitType?: string;
  readonly commitScope?: string;
  readonly droppedSpecTests?: readonly string[];
}

function commitSubject(spec: RefineSpecV1, options: PullRequestAssemblyOptions): string {
  const title = spec.issue.title;
  const lowered = title.charAt(0).toLowerCase() + title.slice(1);
  if (!options.commitType) return title;
  const scope = options.commitScope ? `(${options.commitScope})` : '';
  return `${options.commitType}${scope}: ${lowered}`;
}

/** The proposed commit message: a subject line, a blank line, the Refine summary, and a trailing
 * `Closes #N.` -- DiffReview.dc.html's `.commit` block. */
export function buildCommitMessage(spec: RefineSpecV1, options: PullRequestAssemblyOptions = {}): string {
  const subject = commitSubject(spec, options);
  return `${subject}\n\n${spec.summary.trim()} Closes #${spec.issue.number}.`;
}

/** The `.confidence` line: what `ReviewReportV1` actually supports a confidence statement from --
 * the verifier's verdict, how many critical findings survived review, and whether the diff landed
 * within its Refine estimate. See the module comment for why this isn't the canvas's own
 * pre-commitment-count example. */
export function buildConfidenceLine(report: ReviewReportV1): string {
  const parts: string[] = [];
  if (report.verifier) {
    const critical = report.verifier.findings.filter(
      (finding) => mapFindingSeverity(finding.severity) === 'critical',
    ).length;
    parts.push(
      `The verifier ${report.verifier.verdict} this diff with ${critical} critical finding${critical === 1 ? '' : 's'} sustained.`,
    );
  }
  if (report.diffScope) {
    parts.push(
      report.diffScope.exceededEstimate
        ? `The diff exceeded its Refine estimate (${(report.diffScope.ratio * 100).toFixed(0)}% of predicted lines).`
        : `The diff stayed within its Refine estimate (${(report.diffScope.ratio * 100).toFixed(0)}% of predicted lines).`,
    );
  }
  return parts.join(' ');
}

const SECTION_RULE = '---';

/** The generated PR body: two-zone evidence (machine-verified vs. agent-captured, never merged
 * into one list -- same split as the rail, README's own requirement), the confidence line, the
 * diff-scope numbers with the implementation/generated-test split reported separately, and dropped
 * spec-test rulings. */
export function buildPullRequestBody(
  spec: RefineSpecV1,
  report: ReviewReportV1,
  options: PullRequestAssemblyOptions = {},
): string {
  const sections: string[] = [];

  sections.push(`## Summary\n\n${spec.summary.trim()}`);

  const gateLines = report.deterministic.map((gate) => {
    const icon = gate.status === 'passed' ? '✅' : gate.status === 'skipped' ? '⚠️' : '❌';
    return `- ${icon} ${gate.summary}`;
  });
  sections.push(`## Machine-verified\n\n${gateLines.length > 0 ? gateLines.join('\n') : '(no deterministic gates recorded)'}`);

  if (report.diffScope) {
    const summary = formatDiffScopeSummary(report.diffScope);
    sections.push(`## Diff scope\n\n${summary.statusText} — ${summary.detailText}`);
  }

  const reviewLines: string[] = [];
  if (report.reviewer) {
    reviewLines.push(
      `- Reviewer (${report.reviewer.model}): ${report.reviewer.findings.length} advisory finding${report.reviewer.findings.length === 1 ? '' : 's'}, none blocking.`,
    );
  }
  if (report.verifier) {
    reviewLines.push(`- Verifier (${report.verifier.model}): verdict ${report.verifier.verdict}.`);
  }
  if (reviewLines.length > 0) sections.push(`## Agent-captured (self-reported — not verified by a human)\n\n${reviewLines.join('\n')}`);

  const confidence = buildConfidenceLine(report);
  if (confidence) sections.push(`## Confidence\n\n${confidence}`);

  const dropped = options.droppedSpecTests ?? [];
  sections.push(
    `## Dropped spec-test rulings\n\n${dropped.length > 0 ? dropped.map((entry) => `- ${entry}`).join('\n') : 'None.'}`,
  );

  sections.push(`Closes #${spec.issue.number}.`);

  return sections.join(`\n\n${SECTION_RULE}\n\n`);
}

/** Assembles both halves the publish gate's `pullRequest` input needs (see `PublishActions.tsx`
 * and `pipenzoPullRequestInputV1Schema`) in one call, so a "Push & open PR" click has exactly one
 * function to call for its `pullRequest` prop. */
export function buildPullRequestInput(
  spec: RefineSpecV1,
  report: ReviewReportV1,
  options: PullRequestAssemblyOptions = {},
): PipenzoPullRequestInputV1 {
  return {
    title: commitSubject(spec, options),
    body: buildPullRequestBody(spec, report, options),
  };
}
