import { useState } from 'react';
import type { ReviewReportV1 } from '@agent-dock/shared';
import { Evt, EvtHead, EvtTitle, SubRow, SubLines } from '../components/primitives/ActivityEvent.js';
import { LowLine } from '../components/primitives/Risk.js';
import { PreCommitment } from '../components/primitives/PreCommitment.js';
import { RiskChip } from '../components/primitives/Chip.js';
import { Notice } from '../components/primitives/Notice.js';
import { Empty } from '../components/primitives/Empty.js';
import { SkeletonEvent } from '../components/primitives/Skeleton.js';
import {
  activityStreamAttemptTitle,
  activityStreamIcon,
  activityStreamIconTone,
  activityStreamLineEnds,
  activityStreamReviewTitle,
  buildActivityStream,
  isLowRiskActivityEntry,
  type ActivityStreamEntry,
} from './activity-stream.js';
import { useTicketPhaseStepper } from './use-ticket-phase-stepper.js';

/**
 * `TicketDetail.dc.html`'s `.stream` (issue #93, split of epic #3): `activity-stream.ts`'s pure
 * mapping, rendered through `ActivityEvent.tsx`'s already-built primitives
 * (`Evt`/`EvtHead`/`EvtTitle`/`SubRow`/`SubLines`) and `Risk.tsx`'s `LowLine` for the one real
 * LOW-compact case. Bound to `useTicketPhaseStepper` -- the exact hook `PhaseStepperPanel.tsx`
 * (issue #91) already uses for a single ticket's live phase-change SSE stream -- rather than a new
 * subscription, per that hook's own doc comment: a per-ticket screen "subscribe[s] to that same
 * stream and ignore[s] events for any other ticket", which is exactly what this panel needs too, so
 * a live-pulsing attempt row updates the moment the daemon reconciles a phase change, no polling of
 * its own.
 *
 * `reviewReport`/`reviewPending` are optional, caller-supplied state -- see `activity-stream.ts`'s
 * own doc comment for why no ticket-store field carries a `ReviewReportV1` for this panel to read on
 * its own. `continuesBelow` is the same kind of deferral `TicketDetailScreen.tsx`'s `children` slot
 * already draws: true when the mounting screen is about to render more stream content right after
 * this panel (e.g. a pending approval card from a sibling ticket), so the last row's connecting line
 * should not read as the end of the stream.
 */
export function ActivityStreamPanel({
  ticketId,
  reviewReport,
  reviewPending = false,
  continuesBelow = false,
}: {
  ticketId: string;
  reviewReport?: ReviewReportV1;
  reviewPending?: boolean;
  continuesBelow?: boolean;
}) {
  const { state } = useTicketPhaseStepper(ticketId);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  if (state.status === 'loading') {
    return (
      <div aria-busy="true" data-testid="activity-stream-loading">
        <SkeletonEvent />
        <SkeletonEvent last />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <Notice tone="danger" icon="warning" title="Could not read this ticket's activity">
        The daemon did not answer for #{ticketId} — try again once it reconnects.
      </Notice>
    );
  }

  const entries = buildActivityStream(state.ticket, { reviewReport, reviewPending });

  if (entries.length === 0) {
    return (
      <Empty variant="lane" title="No activity recorded yet">
        Nothing has been dispatched against this ticket yet.
      </Empty>
    );
  }

  return (
    <div className="stream" data-testid="activity-stream">
      {entries.map((entry, index) => (
        <ActivityStreamRow
          key={activityStreamRowKey(entry, index)}
          entry={entry}
          end={activityStreamLineEnds(index, entries, continuesBelow)}
          transcriptOpen={transcriptOpen}
          onToggleTranscript={() => setTranscriptOpen((value) => !value)}
        />
      ))}
    </div>
  );
}

function activityStreamRowKey(entry: ActivityStreamEntry, index: number): string {
  if (entry.kind === 'attempt') return `attempt-${entry.attempt.sessionId}`;
  return `${entry.kind}-${index}`;
}

function ActivityStreamRow({
  entry,
  end,
  transcriptOpen,
  onToggleTranscript,
}: {
  entry: ActivityStreamEntry;
  end: boolean;
  transcriptOpen: boolean;
  onToggleTranscript: () => void;
}) {
  const icon = activityStreamIcon(entry);
  const iconTone = activityStreamIconTone(entry);

  if (isLowRiskActivityEntry(entry) && entry.kind === 'review') {
    // The one real LOW-compact row -- see `activity-stream.ts`'s own doc comment on why a
    // LOW-graded review report is the sole case this module ever has real grounds to render this
    // way. `time` carries the one real, non-fabricated field left to put there (the implementer's
    // tier) rather than a timestamp neither `ReviewReportV1` nor this row has ever had.
    return (
      <Evt icon={icon} low end={end}>
        <LowLine time={entry.report.implementerTier} tag="LOW · review">
          {activityStreamReviewTitle(entry.report)}
        </LowLine>
      </Evt>
    );
  }

  switch (entry.kind) {
    case 'attempt':
      return (
        <Evt icon={icon} iconTone={iconTone} end={end}>
          <EvtHead
            tool="implement"
            meta={`${entry.attempt.tier} · ${entry.attempt.model}`}
            metaLive={entry.live}
          />
          <EvtTitle>{activityStreamAttemptTitle(entry.attempt)}</EvtTitle>
        </Evt>
      );

    case 'precommit': {
      const { precommit } = entry;
      const status = precommit.verdict === 'match' ? 'match' : 'mismatch';
      return (
        <Evt icon={icon} end={end}>
          <EvtHead tool="implement" meta="pre-commitment" />
          <EvtTitle>{precommit.action}</EvtTitle>
          <PreCommitment status={status}>
            <PreCommitment.Row k="expect">{precommit.expect}</PreCommitment.Row>
            <PreCommitment.Row k="if_wrong">{precommit.ifWrong}</PreCommitment.Row>
            <PreCommitment.Outcome tone={status === 'match' ? 'ok' : 'mismatch'} k="outcome">
              {precommit.outcome}
            </PreCommitment.Outcome>
          </PreCommitment>
        </Evt>
      );
    }

    case 'review': {
      const { report } = entry;
      const hasTranscript = Boolean(report.reviewer || report.verifier);
      return (
        <Evt icon={icon} iconTone={iconTone} end={end}>
          <EvtHead
            tool="review"
            risk={<RiskChip level={report.risk}>{report.risk.toUpperCase()}</RiskChip>}
            meta={report.implementerTier}
          />
          <EvtTitle>{activityStreamReviewTitle(report)}</EvtTitle>
          {hasTranscript && (
            <SubRow open={transcriptOpen} onToggle={onToggleTranscript}>
              {transcriptSummaryLabel(report)}
            </SubRow>
          )}
          {hasTranscript && transcriptOpen && <SubLines>{renderTranscript(report)}</SubLines>}
        </Evt>
      );
    }

    case 'review-pending':
      return (
        <Evt icon={icon} iconTone={iconTone} end={end}>
          <EvtHead tool="review" meta="running" metaLive />
          <EvtTitle>Review running — reviewer and verifier passes in progress</EvtTitle>
        </Evt>
      );
  }
}

/** The `SubRow` label -- a real tool-call/finding-count summary, never a fabricated transcript
 *  line. Only called when at least one pass is present (`hasTranscript` above). */
function transcriptSummaryLabel(report: ReviewReportV1): string {
  const parts: string[] = [];
  if (report.reviewer) parts.push(`reviewer · ${report.reviewer.findings.length} findings`);
  if (report.verifier) parts.push(`verifier · ${report.verifier.verdict} · ${report.verifier.findings.length} findings`);
  return parts.join(' · ');
}

/**
 * The `SubLines` body -- real reviewer/verifier data only (`ReviewReportV1.reviewer`/`.verifier`,
 * issue #157/#160's structured findings, the closest thing this codebase persists to a subagent's
 * own transcript; there is no raw session log stored anywhere this panel can read). Absent passes
 * render nothing, never a placeholder standing in for a transcript this codebase does not have.
 */
function renderTranscript(report: ReviewReportV1) {
  return (
    <>
      {report.reviewer && (
        <div>
          <b>reviewer · {report.reviewer.model}</b>
          {report.reviewer.findings.length === 0 ? (
            <div className="ok">no findings</div>
          ) : (
            report.reviewer.findings.map((finding, index) => (
              <div key={index}>
                [{finding.severity}] {finding.message}
                {finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ''})` : ''}
              </div>
            ))
          )}
        </div>
      )}
      {report.verifier && (
        <div>
          <b className={report.verifier.verdict === 'approved' ? 'ok' : undefined}>
            verifier · {report.verifier.model} · {report.verifier.verdict}
          </b>
          {report.verifier.findings.length === 0 ? (
            <div className="ok">no findings</div>
          ) : (
            report.verifier.findings.map((finding, index) => (
              <div key={index}>
                [{finding.severity}] {finding.message}
                {finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ''})` : ''}
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}
