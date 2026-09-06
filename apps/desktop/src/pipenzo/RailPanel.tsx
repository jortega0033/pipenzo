import type { ReactNode } from 'react';
import type { ReviewReportV1, SpecTestAdjudicationV1 } from '@agent-dock/shared';
import { Finding, FindingsCount, FindingsList } from '../components/primitives/FindingsList.js';
import { VerificationBlock, VRow } from '../components/primitives/VerificationBlock.js';
import {
  combineFindings,
  deterministicGateRows,
  findingLocation,
  formatDiffScopeSummary,
  mapFindingSeverity,
  specTestRulingAttribution,
  specTestRulingRows,
  tallyFindings,
  type DiffScopeSummary,
} from './rail.js';
import { ScreenshotEvidence, type RailScreenshot } from './ScreenshotEvidence.js';

export type { RailScreenshot };

/**
 * The two halves of the diff, and the sentence that says which one the gate judged (issue #145).
 *
 * The sentence is not decoration. "412 implementation lines" and "980 generated-test lines" next
 * to a "400-line estimate" is ambiguous until something says the estimate was compared against the
 * first number only — and that ambiguity is exactly what would let a reader conclude a ticket blew
 * its estimate because its generated tests were large.
 */
function DiffScopeSplit({ summary }: { summary: DiffScopeSummary }) {
  return (
    <span className="diff-scope-split">
      <span className="m"> {summary.implementationText}</span>
      <span className="m"> · {summary.generatedTestsText}</span>
      <span className="m"> — {summary.measuredAgainstText}</span>
    </span>
  );
}

/**
 * The diff-review rail (issue #109): Machine-verified → Agent-captured → Findings by severity →
 * Review/verifier summary → Commit block, in exactly that order -- DiffReview.dc.html's own `.rail`
 * ordering, which is not arbitrary (README: deterministic gates are the one thing that gates the
 * ticket; everything below them is advisory or informational, and the rail's top-to-bottom order
 * is the same "what actually gates this" ordering the review-gates runner itself enforces).
 *
 * Everything here is a plain typed prop over `ReviewReportV1` (`packages/shared/src/
 * pipenzo-review-v1.ts`) plus the spec-test adjudication record (issue #146) and the handful of
 * things neither schema carries: the agent's own self-reported claims about its work (no
 * pre-commitment/self-assessment schema exists yet). Those are optional and empty by default
 * rather than faked -- an empty agent-captured zone with no rows is an honest rendering of
 * "nothing to show yet", not a placeholder standing in for missing wiring.
 */
export function RailPanel({
  report,
  adjudication,
  agentCapturedRows = [],
  screenshots = [],
  screenshotProvenance,
  selectedFindingIndex,
  onSelectFinding,
  commit,
}: {
  report: ReviewReportV1;
  /**
   * The spec-test adjudication for this diff (issue #146), when one was made. A sibling record
   * rather than a field on the report — see `pipenzo-adjudication-v1.ts` for why. Absent means no
   * generated test failed, which is why no row is rendered rather than an empty "none" row.
   */
  adjudication?: SpecTestAdjudicationV1;
  /** Self-reported claims (e.g. "3/3 acceptance criteria met") -- no backend schema for these
   * yet; see the module comment. */
  agentCapturedRows?: readonly ReactNode[];
  /** Rendered via `ScreenshotEvidence` (issue #110), which owns opening/closing its own lightbox
   * -- the rail never has to know a lightbox exists. */
  screenshots?: readonly RailScreenshot[];
  screenshotProvenance?: ReactNode;
  /** Highlights the finding at this index and marks its line in `DiffFileList` via the same
   * `path`/`line` (see `findingLocation`). */
  selectedFindingIndex?: number;
  onSelectFinding?: (index: number | undefined) => void;
  /** The commit block (issue #111): the proposed commit message and the confidence line. Omit
   * either to omit that row -- a report with no assembled commit yet renders no commit block
   * rather than an empty one. */
  commit?: { message?: string; confidence?: ReactNode };
}) {
  const findings = combineFindings(report.reviewer, report.verifier);
  const tally = tallyFindings(findings);
  const diffScope = report.diffScope ? formatDiffScopeSummary(report.diffScope) : undefined;
  const hasDiffScopeGate = report.deterministic.some((gate) => gate.id === 'diff_scope');

  return (
    <div className="rail">
      <VerificationBlock
        headLabel="Machine-verified"
        headSub="Deterministic gates. Each one ran on this machine and either passed or blocked the ticket."
      >
        {deterministicGateRows(report.deterministic).map(({ gate, tone }) => (
          <VRow key={gate.id} tone={tone}>
            {gate.summary}
            {gate.durationMs > 0 && (
              <span className="m"> {(gate.durationMs / 1000).toFixed(gate.durationMs >= 1000 ? 0 : 1)}s</span>
            )}
            {/* The implementation/generated-test split belongs *inside* the gate that judged it
                (issue #145). It used to be a second row below the gate list, which read as a
                seventh deterministic gate and said the same thing twice. */}
            {gate.id === 'diff_scope' && diffScope && (
              <DiffScopeSplit summary={diffScope} />
            )}
          </VRow>
        ))}
        {/* Only when the report carries scope numbers but no `diff_scope` gate ran to hang them
            on. The numbers are the point; losing them because a gate row is missing would be the
            one outcome worse than duplicating them. */}
        {report.diffScope && !hasDiffScopeGate && (
          <VRow tone={report.diffScope.exceededEstimate ? 'danger' : 'ok'}>
            {diffScope?.statusText} <DiffScopeSplit summary={diffScope!} />
          </VRow>
        )}
        {/* Spec-test rulings (issue #146). Inside the machine-verified zone because a ruling is
            about a deterministic gate's result — but every row says which model ruled, because
            the ruling itself is a model's judgement and must not read as a machine check. */}
        {adjudication && (
          <>
            <VRow>{specTestRulingAttribution(adjudication)}</VRow>
            {specTestRulingRows(adjudication).map((row) => (
              <VRow key={row.testId} tone={row.tone}>
                {row.verdictLabel} <span className="m">{row.testId}{row.criterion}</span>
                <span className="m"> — {row.rationale}</span>
              </VRow>
            ))}
          </>
        )}
      </VerificationBlock>

      {(agentCapturedRows.length > 0 || screenshots.length > 0) && (
        <VerificationBlock
          agent
          headLabel="Agent-captured"
          headSub="Evidence the agent gathered about its own work. Shown for context; none of it can satisfy a gate."
        >
          {agentCapturedRows.map((row, index) => (
            <VRow key={index} self>
              {row}
            </VRow>
          ))}
          {screenshots.length > 0 && (
            <ScreenshotEvidence screenshots={screenshots} provenance={screenshotProvenance} />
          )}
        </VerificationBlock>
      )}

      {findings.length > 0 && (
        <VerificationBlock
          headLabel="Findings · by severity"
          headSub="What the reviewer and the adversarial verifier wrote about this diff. None of these blocked the ticket; a critical one would."
        >
          <FindingsCount critical={tally.critical} warning={tally.warning} info={tally.info} />
          <FindingsList>
            {findings.map((finding, index) => {
              const loc = findingLocation(finding);
              return (
                <Finding
                  key={index}
                  severity={finding.severity}
                  active={selectedFindingIndex === index}
                  loc={loc ?? '—'}
                  onClick={
                    onSelectFinding
                      ? () => onSelectFinding(selectedFindingIndex === index ? undefined : index)
                      : undefined
                  }
                >
                  {finding.message}
                </Finding>
              );
            })}
          </FindingsList>
        </VerificationBlock>
      )}

      {(report.reviewer || report.verifier) && (
        <div className="v-block">
          <span className="label">Review</span>
          {report.reviewer && (
            <VRow>
              Reviewer ({report.reviewer.model}): {report.reviewer.findings.length} advisory{' '}
              {report.reviewer.findings.length === 1 ? 'finding' : 'findings'}, none blocking{' '}
              <span className="m">may run below the implementer's tier</span>
            </VRow>
          )}
          {report.verifier && (
            <VRow>
              Verifier ({report.verifier.model}):{' '}
              {report.verifier.findings.filter((finding) => mapFindingSeverity(finding.severity) === 'critical')
                .length}{' '}
              critical · verdict {report.verifier.verdict}{' '}
              <span className="m">never below the implementer's tier</span>
            </VRow>
          )}
        </div>
      )}

      {commit?.message && (
        <div className="v-block">
          <span className="label">Commit</span>
          <div className="commit">{commit.message}</div>
          {commit.confidence && <div className="confidence">{commit.confidence}</div>}
        </div>
      )}
    </div>
  );
}
