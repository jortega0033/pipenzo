import { useState, type ReactNode } from 'react';
import type { PipenzoPlanReviewSpecV1 } from '@agent-dock/shared';
import {
  ApprovalCard,
  ApprovalP,
  RefCell,
  RefGrid,
  RLink,
} from '../components/primitives/ApprovalCard.js';
import { Button } from '../components/primitives/Button.js';
import { Chip } from '../components/primitives/Chip.js';
import { Split, type SplitRow } from '../components/primitives/Split.js';
import { Textarea } from '../components/primitives/Textarea.js';

/**
 * The plan-review gate panel (issue #15's own UI sub-ticket, #101), for a ticket Refine parked for
 * a human's Approve/Request-changes/Reject decision after a clean (`single`) diff-size-gate verdict
 * -- `design/artboards/TicketDetail.dc.html`'s own `showPlanPanel`/`showPlanApproved`/
 * `showPlanChanges`/`showPlanRejected` blocks, the real "ticket #98" worked example the issue body
 * points at.
 *
 * Four states, matching `StackApproval.tsx`'s own ask/accepted/rejected split for a different gate,
 * widened by one for the third real decision: `PlanReviewPanel` is the plan a human reads and
 * decides on, `PlanReviewApproved`/`PlanReviewChangesRequested`/`PlanReviewRejected` are the three
 * resolved outcomes. The caller (the ticket-detail screen) owns which one is on screen, the same way
 * it owns that split for stack approval and HIGH.
 *
 * ## One shared reason field, required for two of the three decisions
 *
 * `TicketDetail.dc.html`'s own textarea label reads "Reason, if rejecting or asking for
 * changes … required on both" -- one field, not two, because a human only ever picks one of those
 * two actions per decision and the ticket's issue only ever gets one comment either way. Approve
 * needs no written justification (CLAUDE.md hard rule #3's actual requirement is "HIGH-risk actions
 * never auto-allow," not "never an unexplained allow," and Approve here is a human's own unambiguous
 * click, the same reasoning `HighApprovalStreamCard`'s own doc comment states for a different
 * decision). Both Reject and Request changes stay disabled until the *trimmed* reason is non-empty --
 * the same discipline `StackApprovalPanel`'s own Reject button already applies -- and the same
 * emptiness rule is re-applied server-side (`pipenzoPlanReviewDecideRequestV1Schema`'s own
 * `superRefine`, and `PipenzoPhaseService.requestPlanReviewChanges()`/`rejectPlanReview()` reading a
 * real, non-blank string), so a caller cannot route around either disabled button by calling the
 * bridge directly with an empty string.
 */
export function PlanReviewPanel({
  spec,
  onApprove,
  onRequestChanges,
  onReject,
  footNote,
}: {
  spec: PipenzoPlanReviewSpecV1;
  /** Called with no arguments -- Approve needs no written justification, see this module's own doc
   * comment. */
  onApprove: () => void;
  /** Called with the trimmed, guaranteed-non-empty feedback -- never called while the field is
   * blank, since Request changes is disabled until then. */
  onRequestChanges: (feedback: string) => void;
  /** Called with the trimmed, guaranteed-non-empty reason -- never called while the field is blank,
   * since Reject is disabled until then. */
  onReject: (reason: string) => void;
  /** The `.approval-foot` rules line, e.g. an OS-notification note. */
  footNote?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const trimmedReason = reason.trim();
  const reasonGiven = trimmedReason.length > 0;

  const criteriaRows: SplitRow[] = spec.acceptanceCriteria.map((criterion) => ({
    n: criterion.id.replace(/^AC-/, ''),
    children: (
      <>
        <span className="mono">{criterion.id}</span> ({criterion.kind}) {criterion.text}
      </>
    ),
  }));
  const outOfScopeRows: SplitRow[] = spec.outOfScope.map((entry) => ({ n: '—', children: entry }));
  const filesRows: SplitRow[] = spec.filesLikelyTouched.map((path, index) => ({
    n: index + 1,
    children: <span className="mono">{path}</span>,
  }));

  return (
    <ApprovalCard
      tone="warn"
      icon="gates"
      title="Plan review — approve the spec before Implement starts"
      sub={`pipenzo:needs-human · refine finished · no worktree, no branch, nothing written`}
      chip={<Chip tone="warn">blocks the run</Chip>}
      actions={
        <>
          <Button
            variant="danger"
            icon="x"
            disabled={!reasonGiven}
            onClick={() => onReject(trimmedReason)}
          >
            Reject
          </Button>
          <Button icon="implement" disabled={!reasonGiven} onClick={() => onRequestChanges(trimmedReason)}>
            Request changes
          </Button>
          <Button variant="primary" icon="check" onClick={onApprove}>
            Approve &amp; start Implement
          </Button>
        </>
      }
      foot={footNote}
    >
      <ApprovalP>
        Refine is read-only by construction, so nothing has been implemented and no run has been
        spent. Implement does not start until you accept this spec — it is seeded with the spec and
        nothing else, which is exactly why the spec is worth a look before it goes.
      </ApprovalP>
      {criteriaRows.length > 0 && (
        <Split icon="gates" head="Acceptance criteria · EARS notation" rows={criteriaRows} />
      )}
      {outOfScopeRows.length > 0 && (
        <Split icon="prohibit" head="Out of scope · written down so it cannot drift" rows={outOfScopeRows} />
      )}
      <Split
        icon="file"
        head={`Files likely touched · ${filesRows.length}`}
        rows={filesRows}
      />
      <RefGrid>
        <RefCell
          label="Estimated diff"
          value={`+${spec.estimate.changedLines} lines`}
          mono
          sub={`${spec.estimate.filesTouched} files · ${spec.estimate.layered ? 'layered' : 'no clean layering'}`}
        />
      </RefGrid>
      {spec.openQuestions.length > 0 && (
        <Split
          icon="info"
          quiet
          head={`${spec.openQuestions.length} open question${spec.openQuestions.length === 1 ? '' : 's'} Refine could not answer`}
          rows={spec.openQuestions.map((question, index) => ({ n: index + 1, children: question }))}
        />
      )}
      <Textarea
        label="Reason, if rejecting or asking for changes"
        requiredNote="required on both"
        rows={2}
        placeholder="Fed back into a fresh Refine. Nothing is implemented against a spec you have not accepted."
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <span className="f-help" style={{ marginTop: -6 }}>
        The published label set does not name this state yet, so the ticket parks under{' '}
        <span className="mono">pipenzo:needs-human</span> rather than inventing a label a teammate's
        older build would not understand.
      </span>
    </ApprovalCard>
  );
}

/**
 * The approved resolved state. `TicketDetail.dc.html`'s own `showPlanApproved` block: the spec is
 * now the real thing the diff-scope gate measures at Review (README's blown-estimate rule, #144),
 * stated here rather than left implicit.
 */
export function PlanReviewApproved({
  branch,
  onBackToProposal,
}: {
  /** The worktree branch the approve dispatch just cut -- `PipenzoImplementResultV1.branch`. */
  branch: string;
  onBackToProposal?: () => void;
}) {
  return (
    <ApprovalCard
      tone="ok"
      icon="check"
      title="Spec approved — Implement starts on the next free slot"
      sub={`worktree and branch ${branch} created · seeded with this spec and nothing else`}
      actions={onBackToProposal && <RLink faint onClick={onBackToProposal}>Back to the spec</RLink>}
      actionsJustify="end"
    >
      <ApprovalP>
        The spec is now the thing the diff is checked against. The estimate you accepted is what the
        diff-scope gate measures at Review, and a final diff more than 50% over it moves the ticket
        to <span className="mono">pipenzo:awaiting-stack-approval</span> with the real numbers
        against these.
      </ApprovalP>
    </ApprovalCard>
  );
}

/** The changes-requested resolved state. `TicketDetail.dc.html`'s own `showPlanChanges` block: a
 * fresh read-only Refine pass, not a continuation of the last one. */
export function PlanReviewChangesRequested({
  onBackToProposal,
}: {
  onBackToProposal?: () => void;
}) {
  return (
    <ApprovalCard
      tone="quiet"
      icon="implement"
      title="Changes requested — Refine runs again with your note"
      sub="still no worktree · a fresh read-only pass, not a continuation of the last one"
      actions={onBackToProposal && <RLink faint onClick={onBackToProposal}>Back to the spec</RLink>}
      actionsJustify="end"
    />
  );
}

/** The rejected resolved state. `TicketDetail.dc.html`'s own `showPlanRejected` block -- no actions
 * beyond the caller's own "back to the proposal", the same deferral `StackApprovalRejected`'s own
 * doc comment states for a different outcome. */
export function PlanReviewRejected({
  issueNumber,
  onBackToProposal,
}: {
  issueNumber: number;
  onBackToProposal?: () => void;
}) {
  return (
    <ApprovalCard
      icon="x"
      title={`Plan rejected — reason posted to #${issueNumber}`}
      sub="the ticket stays in Needs human · no worktree was created · nothing retries on its own"
      actions={onBackToProposal && <RLink faint onClick={onBackToProposal}>Back to the spec</RLink>}
      actionsJustify="end"
    />
  );
}
