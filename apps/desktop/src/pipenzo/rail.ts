import type {
  DeterministicGateResultV1,
  DiffScopeV1,
  GateStatus,
  LlmReviewPassV1,
  ReviewFindingV1,
  SpecTestAdjudicationV1,
  SpecTestVerdictV1,
  VerifierPassV1,
} from '@agent-dock/shared';

type ReviewFindingSeverityV1 = ReviewFindingV1['severity'];
import type { FindingSeverity } from '../components/primitives/FindingsList.js';
import type { VRowTone } from '../components/primitives/VerificationBlock.js';

/**
 * Rail composition helpers (issue #109) -- pure functions that turn a `ReviewReportV1` (the
 * review-gates runner's own contract, `packages/shared/src/pipenzo-review-v1.ts`) into exactly
 * what `RailPanel.tsx` renders. Kept separate from the component so the mapping decisions below
 * are independently testable and reviewable without touching JSX.
 */

/** `deterministicGateResultV1Schema`'s four statuses map onto `VRow`'s three tones. A `skipped`
 * gate is `warn`, never the green `ok` check -- an absent tool must never read as a passed one
 * (the same property the schema's own comment states about `skipped`). */
export function gateTone(status: GateStatus): VRowTone {
  if (status === 'passed') return 'ok';
  if (status === 'skipped') return 'warn';
  return 'danger'; // 'failed' | 'errored'
}

/**
 * `reviewFindingSeverityV1Schema`'s four levels (`info`/`low`/`medium`/`high`) collapse onto
 * `FindingsList.tsx`'s three UI tones (`info`/`warning`/`critical`), which predate this ticket and
 * were built against Foundations.dc.html's own three-tier findings sample. `high` is unambiguously
 * `critical` (README: the one severity that holds the push gate closed) and `medium` is
 * `warning`; `low` collapses into `info` alongside `info` itself rather than inventing a fourth UI
 * tier the design system has no chip for.
 */
export function mapFindingSeverity(severity: ReviewFindingSeverityV1): FindingSeverity {
  if (severity === 'high') return 'critical';
  if (severity === 'medium') return 'warning';
  return 'info'; // 'low' | 'info'
}

export interface CombinedFinding {
  readonly severity: FindingSeverity;
  readonly source: 'reviewer' | 'verifier';
  readonly message: string;
  readonly path?: string;
  readonly line?: number;
  readonly criterionId?: string;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2 };

function toCombined(
  finding: ReviewFindingV1,
  source: CombinedFinding['source'],
): CombinedFinding {
  return {
    severity: mapFindingSeverity(finding.severity),
    source,
    message: finding.message,
    ...(finding.path !== undefined ? { path: finding.path } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    ...(finding.criterionId !== undefined ? { criterionId: finding.criterionId } : {}),
  };
}

/**
 * Merges the reviewer's and verifier's findings into the one severity-ordered list
 * DiffReview.dc.html's rail shows -- both passes are advisory (README: only a critical finding
 * holds the push gate closed, and that's the verifier's `verdict` field, not a property of being
 * *in* this list), so nothing here needs to know which pass a finding came from to render it
 * correctly; `source` is kept on each entry only for a caller that wants to say so.
 */
export function combineFindings(
  reviewer?: LlmReviewPassV1,
  verifier?: VerifierPassV1,
): CombinedFinding[] {
  const combined = [
    ...(reviewer?.findings.map((finding) => toCombined(finding, 'reviewer')) ?? []),
    ...(verifier?.findings.map((finding) => toCombined(finding, 'verifier')) ?? []),
  ];
  return combined
    .map((finding, index) => ({ finding, index })) // stable sort: ties keep arrival order
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] || a.index - b.index,
    )
    .map(({ finding }) => finding);
}

export interface FindingTally {
  readonly critical: number;
  readonly warning: number;
  readonly info: number;
}

export function tallyFindings(findings: readonly CombinedFinding[]): FindingTally {
  return findings.reduce<FindingTally>(
    (tally, finding) => ({ ...tally, [finding.severity]: tally[finding.severity] + 1 }),
    { critical: 0, warning: 0, info: 0 },
  );
}

/** `finding.path`/`finding.line` rendered as `path:line`, or just the path with no line -- the
 * `.f-loc` text and the `hitLocation` `DiffFileList` marks a selected finding's gutter with are
 * the same two fields, so this is shared rather than reformatted twice. */
export function findingLocation(finding: CombinedFinding): string | undefined {
  if (!finding.path) return undefined;
  return finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
}

export interface DiffScopeSummary {
  readonly statusText: string;
  readonly detailText: string;
  /** The half the estimate is actually measured against. Lines and files, never merged. */
  readonly implementationText: string;
  /** Counted, reported, and excluded from the estimate comparison. */
  readonly generatedTestsText: string;
  /**
   * The sentence that makes the split mean something. Rendered wherever the numbers are, because
   * two counts side by side do not on their own say which one the gate judged.
   */
  readonly measuredAgainstText: string;
}

function countText(part: { changedLines: number; filesTouched: number }): string {
  const files = `${part.filesTouched} file${part.filesTouched === 1 ? '' : 's'}`;
  return `${part.changedLines} line${part.changedLines === 1 ? '' : 's'} across ${files}`;
}

/**
 * DiffReview.dc.html's diff-scope row, as the implementation/generated-test split (issue #145).
 *
 * README's requirement is not "show two numbers", it is that **a large generated test file can
 * never blow a ticket's size estimate on its own**. Two numbers side by side do not say that — a
 * reader seeing "412 lines" and "980 lines" against a "400-line estimate" has no way to tell which
 * one the gate compared. So `measuredAgainstText` is part of the summary rather than a caption a
 * renderer may drop, and both halves report files as well as lines: `DiffScopeV1` carries
 * `filesTouched` on every half and on the estimate, and reporting only the line counts threw away
 * half of what was measured.
 */
export function formatDiffScopeSummary(diffScope: DiffScopeV1): DiffScopeSummary {
  const statusText = diffScope.exceededEstimate
    ? 'Diff scope exceeded the Refine estimate'
    : 'Diff scope within the Refine estimate';
  const implementationText = `Implementation: ${countText(diffScope.implementation)}`;
  const generatedTestsText = `Generated tests: ${countText(diffScope.generatedTests)}`;
  const measuredAgainstText =
    `Measured against the ${diffScope.estimate.changedLines}-line / ` +
    `${diffScope.estimate.filesTouched}-file estimate using the implementation half only; ` +
    'generated tests are counted and reported, never charged to the estimate.';
  return {
    statusText,
    detailText:
      `+${diffScope.implementation.changedLines} of ≤ ${diffScope.estimate.changedLines} implementation` +
      ` · +${diffScope.generatedTests.changedLines} generated tests, reported separately`,
    implementationText,
    generatedTestsText,
    measuredAgainstText,
  };
}

/** One line per deterministic gate, in the order the report lists them -- README's requirement
 * that deterministic gates are never reordered applies to how they're *displayed*, not only how
 * they run. */
export function deterministicGateRows(
  gates: readonly DeterministicGateResultV1[],
): readonly { readonly gate: DeterministicGateResultV1; readonly tone: VRowTone }[] {
  return gates.map((gate) => ({ gate, tone: gateTone(gate.status) }));
}

export interface SpecTestRulingRow {
  readonly testId: string;
  readonly verdict: SpecTestVerdictV1;
  /** What a human reads. `test_wrong` says the consequence, not just the verdict. */
  readonly verdictLabel: string;
  readonly rationale: string;
  /** ` (AC-2)` or an empty string, so a caller can concatenate without a conditional. */
  readonly criterion: string;
  readonly tone: VRowTone;
}

/**
 * Every spec-test ruling, in the order it was recorded (issue #146).
 *
 * **Every** one, not only the drops. A reader shown only the dropped tests learns that the
 * adjudicator removed two checks and nothing else; a reader shown all of them learns that it
 * removed two and sustained three, which is a different — and true — impression of the run. That
 * is the difference between a record and a summary of the convenient half.
 *
 * The label for `test_wrong` says "dropped" out loud because that is the consequence, and
 * README's rule is that a dropped test is never silently deleted. A row reading only "test wrong"
 * would be technically the verdict and practically an omission.
 */
export function specTestRulingRows(
  adjudication: SpecTestAdjudicationV1,
): readonly SpecTestRulingRow[] {
  return adjudication.rulings.map((ruling) => ({
    testId: ruling.testId,
    verdict: ruling.verdict,
    verdictLabel: ruling.verdict === 'test_wrong' ? 'Test wrong, dropped' : 'Code wrong, test kept',
    rationale: ruling.rationale,
    criterion: ruling.criterionId ? ` (${ruling.criterionId})` : '',
    // A dropped check is a warning, not a success: the ticket now has one fewer machine check than
    // its spec asked for, and the rail's tones are the one place that is visible at a glance.
    tone: ruling.verdict === 'test_wrong' ? 'warn' : 'danger',
  }));
}

/** One line summarising who ruled, so the tier that made the call is never implicit. */
export function specTestRulingAttribution(adjudication: SpecTestAdjudicationV1): string {
  const { ruledBy } = adjudication;
  const dropped = adjudication.rulings.filter((ruling) => ruling.verdict === 'test_wrong').length;
  const kept = adjudication.rulings.length - dropped;
  return (
    `Ruled once by the ${ruledBy.tier}-tier verifier (${ruledBy.model}): ` +
    `${dropped} dropped, ${kept} sustained against the code.`
  );
}
