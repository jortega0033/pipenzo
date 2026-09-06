import type { ReactNode } from 'react';
import type { ReviewReportV1 } from '@agent-dock/shared';
import { Finding, FindingsCount, FindingsList } from '../components/primitives/FindingsList.js';
import { VerificationBlock, VRow } from '../components/primitives/VerificationBlock.js';
import {
  combineFindings,
  deterministicGateRows,
  findingLocation,
  formatDiffScopeSummary,
  mapFindingSeverity,
  tallyFindings,
} from './rail.js';
import { ScreenshotEvidence, type RailScreenshot } from './ScreenshotEvidence.js';

export type { RailScreenshot };

/**
 * The diff-review rail (issue #109): Machine-verified → Agent-captured → Findings by severity →
 * Review/verifier summary → Commit block, in exactly that order -- DiffReview.dc.html's own `.rail`
 * ordering, which is not arbitrary (README: deterministic gates are the one thing that gates the
 * ticket; everything below them is advisory or informational, and the rail's top-to-bottom order
 * is the same "what actually gates this" ordering the review-gates runner itself enforces).
 *
 * Everything here is a plain typed prop over `ReviewReportV1` (`packages/shared/src/
 * pipenzo-review-v1.ts`) plus the handful of things that schema doesn't carry: screenshots (no
 * capture-manifest schema exists yet, issue #138) and the agent's own self-reported claims about
 * its work (no pre-commitment/self-assessment schema exists yet either). Both are optional and
 * empty by default rather than faked -- an empty agent-captured zone with no rows is an honest
 * rendering of "nothing to show yet", not a placeholder standing in for missing wiring.
 */
export function RailPanel({
  report,
  agentCapturedRows = [],
  screenshots = [],
  screenshotProvenance,
  selectedFindingIndex,
  onSelectFinding,
  commit,
}: {
  report: ReviewReportV1;
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
          </VRow>
        ))}
        {report.diffScope &&
          (() => {
            const summary = formatDiffScopeSummary(report.diffScope);
            return (
              <VRow tone={report.diffScope.exceededEstimate ? 'danger' : 'ok'}>
                {summary.statusText} <span className="m">{summary.detailText}</span>
              </VRow>
            );
          })()}
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
