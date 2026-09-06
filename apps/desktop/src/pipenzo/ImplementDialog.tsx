import { useState } from 'react';
import type { OwnedWorktreeV2 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Button } from '../components/primitives/Button.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { Notice } from '../components/primitives/Notice.js';
import { Select } from '../components/primitives/Select.js';
import { TextField } from '../components/primitives/TextField.js';
import { Textarea } from '../components/primitives/Textarea.js';
import { useAsyncAction } from './use-async-action.js';

export interface ImplementDialogTicket {
  readonly num: number;
  readonly title: string;
  /** `owner/name`, shown in the mono subtitle line. */
  readonly repo: string;
  /** e.g. `"+38 −6 · 2 files"` — the Refine estimate label from Main.dc.html's board card. */
  readonly estimateLabel?: string;
}

/** Main.dc.html's four Run budget options, in canvas order. Walking-skeleton: nothing downstream
 * enforces this yet (build step 6 owns the actual budget/retry ladder) -- Start carries it through
 * on `onStarted` so the seam is ready the day something does. */
const RUN_BUDGET_OPTIONS = [
  { value: 'unlimited', label: 'Unlimited' },
  { value: '1', label: '1 run' },
  { value: '3', label: '3 runs' },
  { value: '200k_tokens', label: 'Cap at 200k tokens' },
] as const;
export type RunBudget = (typeof RUN_BUDGET_OPTIONS)[number]['value'];

/** Same character rule `worktreePreviewRequestV2Schema` enforces server-side -- checked here too
 * so a rejected override reads as an inline field error instead of a round trip that always fails. */
const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export interface ImplementStartInput {
  readonly worktreeName: string;
  readonly extraInstructions: string;
  readonly runBudget: RunBudget;
}

/**
 * The result of the claim pre-flight issue #83 names: "assign issue + uncached GET /issues/:n
 * immediately before dispatch, refuse if assigned elsewhere."
 *
 * `claimed` here means **claimed by somebody else** — it is a refusal signal, not a success one.
 * The name is inherited from the original injected-check shape and kept so callers do not silently
 * invert on upgrade; `claimIssueForTicket` maps the daemon's `claimed_elsewhere` onto it.
 */
export interface ClaimPreflightResult {
  readonly claimed: boolean;
  readonly assignee?: string;
}

/**
 * The real claim pre-flight, against the daemon route issue #184 added.
 *
 * Both halves of README's Team-usage rule happen on the daemon side of this call — assign, then
 * re-read the issue *uncached*, then compare — so the renderer cannot execute only the first half.
 * The login is not passed: the daemon holds the token and resolves the authenticated user itself,
 * because a renderer that could name the assignee could claim a ticket as somebody else.
 */
export async function claimIssueForTicket(ticket: {
  repo: string;
  num: number;
}): Promise<ClaimPreflightResult> {
  const result = await getBridge().claimPipenzoIssue({
    repo: ticket.repo,
    issueNumber: ticket.num,
  });
  if (result.outcome === 'claimed') return { claimed: false };
  // The other assignees, not this operator's own login — the card has to name who holds it.
  const holder = result.assignees[0];
  return { claimed: true, ...(holder ? { assignee: holder } : {}) };
}

/**
 * The Implement dialog's full form (issue #83, built on issue #69's pending-button wiring).
 * Matches Main.dc.html's `#dialogOpen` dialog: extra instructions, a branch-name override with
 * inline validation, a run-budget select, and Start.
 *
 * Start's pending state spans two real daemon round trips under one `useAsyncAction` -- a worktree
 * preview (fail-closed on a secret-shaped `.worktreeinclude`, matching `ImplementOrchestrator`'s
 * own `worktree_secret_risk` gate) and the worktree create itself -- both real, already-routed
 * daemon calls. See `use-async-action.ts` and `ImplementDialog`'s original issue #69 history for
 * why session dispatch inside the new worktree is not chained here too: a worktree's real
 * filesystem path is deliberately withheld from every route response the renderer can reach.
 *
 * ## The claim pre-flight, now real
 *
 * This used to be an optional injected check with a warning notice attached, because
 * `GitHubClient` had no `assignIssue` and nothing exposed it as a route. Issue #184 added both, so
 * `claimPreflight` now **defaults to `claimIssueForTicket`** and Start refuses closed on a
 * conflict rather than warning that it cannot check. The prop survives so a test can drive the
 * conflict path without a daemon; it is no longer how a caller opts *in* to safety.
 *
 * The refusal is deliberately not a retryable error. Losing an assignment race is not a transient
 * failure — README's Team-usage section makes the loser's card the one Needs-human variant with no
 * action available, because the current user is not the person who can resolve someone else's
 * claim — so the Start button does not turn into Retry for it.
 *
 * Still not chained here: dispatching the implement session inside the new worktree.
 * `implementPipenzo` exists now and does exactly that, but it takes a `RefineSpecV1`, and a board
 * card does not carry one until the ticket that gives cards their spec lands. Calling it with a
 * fabricated spec would put invented acceptance criteria in front of the implementer, which is
 * worse than the extra step.
 */
export function ImplementDialog({
  open,
  onClose,
  ticket,
  cwd,
  claimPreflight,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  ticket: ImplementDialogTicket;
  /** The repository checkout the worktree is cut from. */
  cwd: string;
  /**
   * Overrides the real pre-flight. For tests only — the default is
   * `claimIssueForTicket`, which speaks to the daemon. There is no way to switch the check *off*.
   */
  claimPreflight?: () => Promise<ClaimPreflightResult>;
  onStarted?: (worktree: OwnedWorktreeV2, input: ImplementStartInput) => void;
}) {
  const [extraInstructions, setExtraInstructions] = useState('');
  const [branchOverride, setBranchOverride] = useState('');
  const [runBudget, setRunBudget] = useState<RunBudget>('unlimited');
  const [claimConflict, setClaimConflict] = useState<string>();
  const start = useAsyncAction<OwnedWorktreeV2>();

  const defaultName = `issue-${ticket.num}`;
  const worktreeName = branchOverride.trim() || defaultName;
  const branchError =
    branchOverride.trim() && !WORKTREE_NAME_PATTERN.test(branchOverride.trim())
      ? 'Use only letters, numbers, "." "_" "-" (no spaces or slashes).'
      : undefined;

  const runStart = () => {
    if (branchError) return;
    setClaimConflict(undefined);
    void start
      .run(async () => {
        // Always. There is no branch that skips this, which is the difference between a
        // pre-flight and a warning.
        const claim = await (claimPreflight ?? (() => claimIssueForTicket(ticket)))();
        if (claim.claimed) {
          setClaimConflict(claim.assignee);
          throw new Error(
            claim.assignee
              ? `Already claimed by @${claim.assignee} — refusing to start a second worktree on this ticket.`
              : 'Already claimed by another instance — refusing to start a second worktree on this ticket.',
          );
        }
        const preview = await getBridge().previewWorktree({ cwd, name: worktreeName });
        if (preview.secretRisk) {
          throw new Error(
            "This repository's .worktreeinclude would copy a secret-shaped file into the agent " +
              'worktree. Review it in Settings before starting.',
          );
        }
        return getBridge().createWorktree({ cwd, name: worktreeName, confirmIncludeCopy: true });
      })
      .then((worktree) => {
        if (worktree) onStarted?.(worktree, { worktreeName, extraInstructions, runBudget });
      });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Implement #${ticket.num} — ${ticket.title}`}
      subtitle={
        <span className="mono">
          {ticket.repo} · pipenzo:queued{ticket.estimateLabel ? ` · est. ${ticket.estimateLabel}` : ''}
        </span>
      }
      width={480}
      actions={
        <>
          <Button onClick={onClose} disabled={start.pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="play"
            pending={start.pending}
            disabled={!!branchError}
            onClick={start.status === 'error' && !claimConflict ? () => void start.retry() : runStart}
          >
            {start.pending ? 'Starting…' : start.status === 'error' && !claimConflict ? 'Retry' : 'Start'}
          </Button>
        </>
      }
    >
      {claimConflict !== undefined && (
        <Notice tone="warn" icon="warning" quiet>
          {claimConflict
            ? `Claimed by @${claimConflict}. Nothing was started — this ticket is theirs to finish or release.`
            : 'Claimed by another instance. Nothing was started.'}
        </Notice>
      )}
      <Textarea
        label="Extra instructions (optional)"
        placeholder="e.g. only touch the daemon side, skip the renderer for now"
        value={extraInstructions}
        onChange={(event) => setExtraInstructions(event.target.value)}
        disabled={start.pending}
      />
      <div className="two-col">
        <TextField
          label="Branch name override"
          mono
          placeholder={defaultName}
          value={branchOverride}
          onChange={(event) => setBranchOverride(event.target.value)}
          error={branchError}
          disabled={start.pending}
        />
        <Select
          label="Run budget"
          mono
          options={RUN_BUDGET_OPTIONS as unknown as { value: string; label: string }[]}
          value={runBudget}
          onChange={(event) => setRunBudget(event.target.value as RunBudget)}
          disabled={start.pending}
        />
      </div>
      <span className="f-help">
        Budget applies to this ticket only. When it runs out the ticket parks in Needs human instead
        of retrying.
      </span>
      {start.status === 'error' && start.error && (
        <span className="f-err" role="alert">
          {start.error}
        </span>
      )}
    </Dialog>
  );
}
