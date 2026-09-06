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

/** The result of the claim pre-flight issue #83 names: "assign issue + uncached GET /issues/:n
 * immediately before dispatch, refuse if assigned elsewhere." */
export interface ClaimPreflightResult {
  readonly claimed: boolean;
  readonly assignee?: string;
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
 * `claimPreflight` is this ticket's own explicit, honest gap. The ticket's title makes the claim
 * check core scope: assign the issue, then an *uncached* `GET /issues/:n` immediately before
 * dispatch, refusing if it comes back assigned to someone else (README's "Team usage" best-effort
 * assignment race). Nothing in this repo can do that today -- `GitHubClient` (issue #177) has no
 * `assignIssue`, and nothing exposes it or `getIssue` as a daemon route the renderer can reach; see
 * `apps/daemon/src/github-client.ts`'s interface. Rather than silently skip the safety property
 * (auto-allow is exactly what CLAUDE.md's hard rules forbid doing quietly) or fabricate a call to a
 * route that doesn't exist, this component takes `claimPreflight` as an optional injected check: a
 * caller that has one wires it in and Start refuses closed on a claim conflict (`Conflict.tsx`'s
 * existing "claimed by @someone-else" treatment); a caller without one -- which is every real
 * caller today -- gets an explicit, un-dismissable notice instead of a false sense of safety.
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
        if (claimPreflight) {
          const claim = await claimPreflight();
          if (claim.claimed) {
            setClaimConflict(claim.assignee);
            throw new Error(
              claim.assignee
                ? `Already claimed by @${claim.assignee} — refusing to start a second worktree on this ticket.`
                : 'Already claimed by another instance — refusing to start a second worktree on this ticket.',
            );
          }
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
      {!claimPreflight && (
        <Notice tone="warn" icon="warning" quiet>
          Claim verification isn't wired up yet — Start does not check whether someone else already
          claimed this ticket before creating a worktree.
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
