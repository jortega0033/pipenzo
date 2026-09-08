import type { RefineEstimateV1 } from '@agent-dock/shared';
import { ApprovalCard, ApprovalP, RefCell, RefGrid } from '../components/primitives/ApprovalCard.js';
import { Button } from '../components/primitives/Button.js';
import { Chip } from '../components/primitives/Chip.js';
import { Split, type SplitRow } from '../components/primitives/Split.js';

/**
 * The refusal outcome panel (issue #100), for a ticket the diff-size gate at Refine declined
 * (#270). `TicketDetail.dc.html`'s own note is the framing this panel exists to carry: this is a
 * *finished* outcome, not an error -- nothing was written, no worktree exists, and no runs were
 * spent, so the panel reads as a report, not an apology.
 *
 * Composed entirely from primitives that already existed before this ticket
 * (`ApprovalCard`/`RefGrid`/`Split`/`Chip`), each already used by other, unrelated approval
 * surfaces (agentdock's own HIGH/MEDIUM approval cards) -- this is the first Pipenzo-specific
 * consumer of the `.approval-card` shell, not a new primitive built for one caller.
 *
 * ## What this panel does not invent
 *
 * - **No "posted as a comment N ago" clause.** `PipenzoRefineResultV1` carries no comment
 *   timestamp -- `refine()` posts the comment as a side effect (#270) but does not return when.
 *   Rather than guess, that clause is simply absent.
 * - **No OS-notification foot line.** Nothing in this codebase sends an OS notification for a
 *   refusal yet; the canvas's own foot slot is left unrendered rather than filled with a time that
 *   does not exist.
 * - **No proposed split unless one was actually generated.** Nothing in this codebase produces a
 *   decomposition today (#271 is the follow-up that would) -- `proposedSplit` is optional, and the
 *   `Split` block renders only when the caller has real rows to show.
 * - **"Open on GitHub" is a real link, not a stubbed callback.** `apps/desktop/electron/main.ts`'s
 *   `setWindowOpenHandler` already routes any `https:` target through the same validated
 *   `openAllowedExternalUrl` gate every other "open externally" path in this app uses -- so a plain
 *   `target="_blank"` anchor is the honest, already-wired choice, not a placeholder waiting on a
 *   bridge method that does not exist.
 * - **"Retry refine" stays a caller-supplied callback**, the same deferral `BoardScreen`'s
 *   `onConnectRepo`/`onNewFromIdea` already established: this panel does not own the daemon call
 *   that re-invokes Refine (repo, issue number, repository path and provider all have to come from
 *   somewhere this component is not given), only the button that asks for it.
 */
export function RefusalPanel({
  repo,
  issueNumber,
  estimate,
  proposedSplit,
  onRetryRefine,
}: {
  /** `owner/repo`, for the "Open on GitHub" link. */
  repo: string;
  issueNumber: number;
  estimate: RefineEstimateV1;
  /** Absent until #271 exists to produce one. */
  proposedSplit?: readonly {
    summary: string;
    changedLines: number;
    filesTouched: number;
  }[];
  onRetryRefine?: () => void;
}) {
  const trip = trippedBy(estimate);

  return (
    <ApprovalCard
      tone="quiet"
      icon="prohibit"
      title="Declined at Refine — needs pre-scoping"
      sub="pipenzo:needs-pre-scoping"
      chip={<Chip tone="neutral">finished</Chip>}
      actionsJustify="start"
      actions={
        <>
          <a
            className="btn"
            href={`https://github.com/${repo}/issues/${issueNumber}`}
            target="_blank"
            rel="noreferrer"
          >
            Open on GitHub
          </a>
          {onRetryRefine && (
            <Button variant="ghost" icon="undo" onClick={onRetryRefine}>
              Retry refine
            </Button>
          )}
        </>
      }
    >
      <ApprovalP>
        This is the finished outcome for the ticket, not an error. Nothing was written, no
        worktree exists, and no runs will be spent until a person re-scopes it.
      </ApprovalP>
      <RefGrid>
        <RefCell
          label="Estimate"
          value={`${estimate.changedLines.toLocaleString()} lines`}
          mono
          sub={`${estimate.filesTouched} files · ${estimate.layered ? 'layered' : 'no clean layering'}`}
        />
        <RefCell label="Tripped" value={trip.headline} sub={trip.detail} />
        <RefCell
          label="One-PR budget"
          value="≤ 100 · ≤ 10"
          mono
          sub="changed lines · files. Stacks cover 100–400, layered"
        />
      </RefGrid>
      {proposedSplit && proposedSplit.length > 0 && (
        <Split
          icon="pr-stack"
          head={`Proposed split · ${proposedSplit.length} ${proposedSplit.length === 1 ? 'ticket' : 'tickets'}, in this order`}
          rows={proposedSplit.map(
            (part, index): SplitRow => ({
              n: index + 1,
              children: (
                <>
                  {part.summary}
                  <span className="mono">
                    ≈ {part.changedLines.toLocaleString()} lines · {part.filesTouched} files
                  </span>
                </>
              ),
            }),
          )}
        />
      )}
      {onRetryRefine && (
        <span className="f-help" style={{ marginTop: -6 }}>
          Retry only runs when you click it, after the issue has been re-scoped. It is never
          automatic.
        </span>
      )}
    </ApprovalCard>
  );
}

/**
 * Which of README's two refusal conditions applies, purely from the estimate itself -- the same
 * boundary `apps/daemon/src/refine-gate.ts`'s `evaluateDiffSizeGate` and
 * `pipenzo-phase-service.ts`'s `refusalCommentBody` (issue #270) already compute daemon-side.
 * Recomputed here rather than carried on the wire: `estimate` already has everything this needs,
 * README's 100/10/400/20 numbers are the one stated source of truth both sides read from (not two
 * independent guesses), and the alternative -- a `trippedBy` field added to
 * `PipenzoRefineResultV1` -- is a real option a later ticket can still take if this ever drifts.
 */
function trippedBy(estimate: RefineEstimateV1): { headline: string; detail: string } {
  if (estimate.changedLines > 400 || estimate.filesTouched > 20) {
    return {
      headline: '> 400 changed lines',
      detail: 'also > 20 files — either one alone declines',
    };
  }
  return {
    headline: 'no clean layering',
    detail: `${estimate.changedLines} lines · ${estimate.filesTouched} files fit a stack, but not cleanly`,
  };
}
