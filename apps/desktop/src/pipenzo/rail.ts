import type {
  DeterministicGateResultV1,
  DiffScopeV1,
  GateStatus,
  LlmReviewPassV1,
  ReviewFindingV1,
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
}

/** DiffReview.dc.html's diff-scope `VRow`: "Diff scope within/exceeded the Refine estimate" plus
 * a mono detail naming the implementation total against the estimate and the generated-test total
 * reported separately -- the implementation/test split issue #145 and README require so a large
 * generated test file can never blow a ticket's size estimate on its own. */
export function formatDiffScopeSummary(diffScope: DiffScopeV1): DiffScopeSummary {
  const statusText = diffScope.exceededEstimate
    ? 'Diff scope exceeded the Refine estimate'
    : 'Diff scope within the Refine estimate';
  const detailText =
    `+${diffScope.implementation.changedLines} of ≤ ${diffScope.estimate.changedLines} implementation` +
    ` · +${diffScope.generatedTests.changedLines} generated tests, reported separately`;
  return { statusText, detailText };
}

/** One line per deterministic gate, in the order the report lists them -- README's requirement
 * that deterministic gates are never reordered applies to how they're *displayed*, not only how
 * they run. */
export function deterministicGateRows(
  gates: readonly DeterministicGateResultV1[],
): readonly { readonly gate: DeterministicGateResultV1; readonly tone: VRowTone }[] {
  return gates.map((gate) => ({ gate, tone: gateTone(gate.status) }));
}
