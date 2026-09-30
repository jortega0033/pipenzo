import { useState, type ReactNode } from 'react';
import type {
  PipenzoStackApprovalDecideChildV1,
  RefineEstimateV1,
  RefineProposedSplitPartV1,
} from '@agent-dock/shared';
import {
  ApprovalCard,
  ApprovalP,
  RefCell,
  RefGrid,
  RLink,
  StackList,
  StackNote,
} from '../components/primitives/ApprovalCard.js';
import { Button } from '../components/primitives/Button.js';
import { Chip } from '../components/primitives/Chip.js';
import { Icon } from '../components/primitives/Icon.js';
import { Kids, type KidSpec } from '../components/primitives/Stack.js';
import { StackRow } from '../components/primitives/StackRow.js';
import { Textarea } from '../components/primitives/Textarea.js';

/**
 * The stack approval panel (issue #99), for a ticket the diff-size gate parked on
 * `pipenzo:awaiting-stack-approval` from a Refine-time `stack` verdict --
 * `apps/daemon/src/refine-gate.ts`'s own doc comment names the gap this panel fills ("not built by
 * this ticket [#270]; #100's panel and whatever builds the stack-approval flow own it").
 *
 * Three states, matching `TicketDetail.dc.html`'s own `showStackPanel`/`showStackAccepted`/
 * `showStackRejected` blocks and `HighApproval.tsx`'s own ask/resolved split
 * (`HighApprovalStreamCard` vs. `HighApprovalResolved`): `StackApprovalPanel` is the proposal a
 * human reorders and decides on, `StackApprovalAccepted`/`StackApprovalRejected` are the two
 * resolved outcomes. The caller (the ticket-detail screen) owns which one is on screen, the same
 * way it owns that split for HIGH.
 *
 * `StackRow`/`StackList`/`Kids`/`RefGrid`/`ApprovalCard` are all pre-existing primitives --
 * `ApprovalCard.tsx`'s own doc comments already named "stack approval (proposal / accepted /
 * rejected)" as one of the four states its shell was built to carry, and `StackRow.tsx`'s own doc
 * comment already says "TicketDetail wires `onMoveUp`/`onMoveDown` to reorder the whole list before
 * Accept" -- this panel is the first real wiring of primitives that were built ahead of it, not new
 * chrome invented for this ticket.
 *
 * ## Mandatory reason to reject, unlike the design canvas's own placeholder copy
 *
 * `TicketDetail.dc.html`'s mock textarea reads "Reason, if rejecting (optional -- posted to the
 * issue)". This panel does not match that word for word: issue #99's own text requires "Reject with
 * reason posted to issue," and the daemon's own wire contract
 * (`pipenzoStackApprovalDecideRequestV1Schema`'s `superRefine`, `apps/daemon/src/
 * stack-approval-store.ts`'s own re-check) already refuses a reject with no reason, mirroring the
 * mandatory-reason discipline issue #98 established for HIGH. A canvas mockup's placeholder copy is
 * not a wire contract; matching a UI affordance to a contract that will refuse it anyway would be
 * the actual inconsistency. Reject stays disabled until the trimmed reason is non-empty, the same
 * `HighApprovalStreamCard` pattern.
 *
 * ## Reordering is local-only until Accept
 *
 * `order` is component state, never sent anywhere until the human clicks Accept -- there is no
 * "save my reorder" round trip, matching the design canvas's own `stackOrder` local state. The
 * daemon only ever learns the *final* approved order, as a permutation of the indices it captured
 * (`StackApprovalStore.decide()`'s own bounded-permutation check) -- see `pipenzo-stack-approval-v1
 * .ts`'s module comment for why this bounds an accept's fan-out regardless of what a compromised or
 * buggy renderer might submit.
 */
export function StackApprovalPanel({
  estimate,
  parts,
  onAccept,
  onReject,
  footNote,
}: {
  estimate: RefineEstimateV1;
  /** The captured parts, in the order Refine originally proposed them -- `capture()`'s own
   * response, never reordered by this component's caller. */
  parts: readonly RefineProposedSplitPartV1[];
  /** Called with the parts in the human-approved order (a reordering of `parts`, never a copy with
   * different content) once Accept is clicked. */
  onAccept: (orderedParts: readonly RefineProposedSplitPartV1[]) => void;
  /** Called with the trimmed, guaranteed-non-empty reason -- never called while the reason is
   * blank, since Reject is disabled until then. */
  onReject: (reason: string) => void;
  /** The `.approval-foot` rules line, e.g. an OS-notification note. */
  footNote?: ReactNode;
}) {
  const [order, setOrder] = useState<number[]>(() => parts.map((_, index) => index));
  const [reason, setReason] = useState('');
  const trimmedReason = reason.trim();

  function moveUp(position: number): void {
    if (position <= 0) return;
    setOrder((current) => {
      const next = [...current];
      const [moved] = next.splice(position, 1);
      next.splice(position - 1, 0, moved!);
      return next;
    });
  }

  function moveDown(position: number): void {
    if (position >= order.length - 1) return;
    setOrder((current) => {
      const next = [...current];
      const [moved] = next.splice(position, 1);
      next.splice(position + 1, 0, moved!);
      return next;
    });
  }

  return (
    <ApprovalCard
      tone="warn"
      icon="pr-stack"
      title={`Stack approval — ${parts.length} ${parts.length === 1 ? 'PR' : 'PRs'}, dependency-ordered`}
      sub={`pipenzo:awaiting-stack-approval · est. ${estimate.changedLines.toLocaleString()} lines · ${estimate.filesTouched} files · one PR would be over budget`}
      chip={<Chip tone="warn">awaiting sign-off</Chip>}
      actions={
        <>
          <Button
            variant="danger"
            icon="x"
            disabled={trimmedReason.length === 0}
            onClick={() => onReject(trimmedReason)}
          >
            Reject
          </Button>
          <Button variant="primary" icon="check" onClick={() => onAccept(order.map((i) => parts[i]!))}>
            Accept stack in this order
          </Button>
        </>
      }
      foot={
        footNote && (
          <>
            <Icon name="notified" size="sm" />
            <span>{footNote}</span>
          </>
        )
      }
    >
      <ApprovalP>
        Accepting creates one child ticket per entry, each with its own worktree and branch, and
        turns this ticket into a container card on the board. Pipenzo owns the split and the order;
        restacking after a merge is GitHub’s job (<span className="mono">gh stack</span>).
      </ApprovalP>
      <RefGrid>
        <RefCell
          label="Estimate"
          value={`${estimate.changedLines.toLocaleString()} lines`}
          mono
          sub={`${estimate.filesTouched} files · ${estimate.layered ? 'layered' : 'no clean layering'}`}
        />
        <RefCell label="Entries" value={String(parts.length)} sub="dependency-ordered" />
      </RefGrid>
      <StackList>
        {order.map((partIndex, position) => {
          const part = parts[partIndex]!;
          return (
            <StackRow
              key={partIndex}
              index={`${position + 1}/${order.length}`}
              title={part.summary}
              meta={`≈${part.changedLines.toLocaleString()} lines · ${part.filesTouched} files · base ${
                position === 0 ? 'main' : `PR ${position}`
              }`}
              canMoveUp={position > 0}
              canMoveDown={position < order.length - 1}
              onMoveUp={() => moveUp(position)}
              onMoveDown={() => moveDown(position)}
            />
          );
        })}
      </StackList>
      <Textarea
        label="Reason, if rejecting"
        requiredNote="required to reject"
        rows={2}
        placeholder="Posted as a comment on the issue."
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
    </ApprovalCard>
  );
}

/**
 * The accepted resolved state. Each `Kid` row's external-link button opens that *child's own*
 * issue (`repo`+`issueNumber`), never a single shared stack URL -- `TicketDetail.dc.html`'s own
 * kid rows each carry their own id, and a stack with no native `gh stack` view (README: "without
 * `gh` the stack still ships as dependency-ordered sequential PRs with a base-branch note") has no
 * single URL that would represent the whole stack anyway.
 */
export function StackApprovalAccepted({
  repo,
  parentIssueNumber,
  children,
}: {
  /** `owner/repo`, for each child's "Open on GitHub" link. */
  repo: string;
  parentIssueNumber: number;
  children: readonly PipenzoStackApprovalDecideChildV1[];
}) {
  const kids: KidSpec[] = children.map((child, index) => ({
    key: child.ticketId,
    status: 'pending',
    index: `${index + 1}/${children.length}`,
    title: child.title,
    id: `#${child.issueNumber}`,
    onOpen: () => {
      window.open(`https://github.com/${repo}/issues/${child.issueNumber}`, '_blank', 'noreferrer');
    },
  }));

  return (
    <ApprovalCard
      tone="ok"
      icon="check"
      title={`Stack accepted — ${children.length} child ${children.length === 1 ? 'ticket' : 'tickets'} created`}
      sub={`#${parentIssueNumber} is now a container card · children run in dependency order, one worktree each, under the concurrency limit`}
      chip={<Chip tone="ok">accepted</Chip>}
      actions={
        <a
          className="btn"
          href={`https://github.com/${repo}/issues/${parentIssueNumber}`}
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="external" size="sm" />
          Open stack on GitHub
        </a>
      }
    >
      <Kids items={kids} />
      <StackNote>
        Maintenance is read-only here. Restack, rebase and the PR-to-PR view live on GitHub’s
        native stacked PRs. Without <span className="mono">gh</span> the stack still ships as
        dependency-ordered sequential PRs with a base-branch note.
      </StackNote>
    </ApprovalCard>
  );
}

/** The rejected resolved state -- no actions beyond the caller's own "back to the proposal", which
 * this panel deliberately does not own (the same deferral `RefusalPanel`'s `onRetryRefine` gives:
 * whether to show the proposal again is the ticket-detail screen's own navigation state, not
 * something this outcome card should assume it can rebuild). */
export function StackApprovalRejected({
  parentIssueNumber,
  onBackToProposal,
}: {
  parentIssueNumber: number;
  onBackToProposal?: () => void;
}) {
  return (
    <ApprovalCard
      icon="x"
      title={`Stack rejected — reason posted to #${parentIssueNumber}`}
      sub="the ticket stays in Needs human · no worktree was created · nothing retries on its own"
      chip={<Chip tone="danger">rejected</Chip>}
      actions={onBackToProposal && <RLink faint onClick={onBackToProposal}>Back to the proposal</RLink>}
      actionsJustify="end"
    />
  );
}
