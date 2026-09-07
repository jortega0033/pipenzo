import { useState } from 'react';
import type {
  PipenzoImplementResultV1,
  ProviderId,
  RefineSpecV1,
} from '@agent-dock/shared';
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

/**
 * The branch (and worktree) name the Implement phase will use, mirroring the daemon's own
 * `ticketBranchName()`.
 *
 * Derived here rather than chosen: `pipenzoImplementRequestV1Schema` has no branch field, because
 * "one worktree per ticket" is an invariant of README's Team-usage section rather than a preference.
 * The renderer computes the same name only so the pre-flight preview asks about the directory the
 * daemon is actually going to create, and so the operator can read it before pressing Start.
 */
function ticketBranchName(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

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
 * Matches Main.dc.html's `#dialogOpen` dialog: extra instructions, the ticket's branch, a
 * run-budget select, and Start.
 *
 * Start's pending state spans several real daemon round trips under one `useAsyncAction` -- the
 * claim pre-flight, a worktree preview (fail-closed on a secret-shaped `.worktreeinclude`,
 * matching `ImplementOrchestrator`'s own `worktree_secret_risk` gate), and the implement dispatch
 * itself. What comes back from that last call is a worktree *id*, a branch and a base commit: a
 * worktree's real filesystem path is deliberately withheld from every route response the renderer
 * can reach, which is exactly why the session is started daemon-side rather than here.
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
 * ## Refine before Implement, because a board card carries no spec
 *
 * `implementPipenzo` takes a `RefineSpecV1` and nothing else describes the work to it — that is the
 * enforcement of README's "the implementer sees the spec, not the ticket". A board card has a
 * number and a title, so this dialog has to *produce* a spec before Implement is reachable at all,
 * and the only honest way to produce one is to run the real Refine phase. So Start is two clicks:
 *
 * 1. **Refine ticket** calls `refinePipenzo` — the real read-only phase, against the operator's own
 *    checkout — and renders the `RefineSpecV1` it returns: summary, EARS acceptance criteria,
 *    what the ticket is *not*, the estimate, and any open questions the pass could not resolve.
 * 2. **Start** claims the ticket and calls `implementPipenzo` with *that* spec object.
 *
 * There is no third path. `runStart` returns early without a spec, and the Start button does not
 * exist until one has arrived, so there is no branch on which a fabricated spec — invented
 * acceptance criteria in front of the implementer — could reach the route. A caller that already
 * has a real spec (a ticket re-opened after a refine) passes it as `spec` and lands on step 2.
 *
 * ## What the branch-name override became
 *
 * It is now a read-only display of the derived name. `pipenzoImplementRequestV1Schema` has no
 * branch field: the daemon derives `issue-<n>` from the spec, one worktree per ticket. An input
 * that no longer changed anything would be a lie in the UI, so it reads out what the daemon will
 * do instead of pretending to choose it.
 */
export function ImplementDialog({
  open,
  onClose,
  ticket,
  cwd,
  provider,
  model,
  spec: existingSpec,
  claimPreflight,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  ticket: ImplementDialogTicket;
  /** The repository checkout Refine reads and the worktree is cut from. */
  cwd: string;
  provider: ProviderId;
  model?: string;
  /**
   * A spec this ticket already has. Omitted — the board-card case — the dialog refines first and
   * Implement is not reachable until that real spec has come back and been read.
   */
  spec?: RefineSpecV1;
  /**
   * Overrides the real pre-flight. For tests only — the default is
   * `claimIssueForTicket`, which speaks to the daemon. There is no way to switch the check *off*.
   */
  claimPreflight?: () => Promise<ClaimPreflightResult>;
  onStarted?: (started: PipenzoImplementResultV1, input: ImplementStartInput) => void;
}) {
  const [extraInstructions, setExtraInstructions] = useState('');
  const [runBudget, setRunBudget] = useState<RunBudget>('unlimited');
  const [claimConflict, setClaimConflict] = useState<string>();
  const [refinedSpec, setRefinedSpec] = useState<RefineSpecV1>();
  const refine = useAsyncAction<RefineSpecV1>();
  const start = useAsyncAction<PipenzoImplementResultV1>();

  const spec = refinedSpec ?? existingSpec;
  const worktreeName = ticketBranchName(spec?.issue.number ?? ticket.num);

  const runRefine = () => {
    void refine
      .run(async () => {
        const result = await getBridge().refinePipenzo({
          repo: ticket.repo,
          issueNumber: ticket.num,
          repositoryPath: cwd,
          provider,
          ...(model ? { model } : {}),
        });
        return result.spec;
      })
      .then((result) => {
        if (result) setRefinedSpec(result);
      });
  };

  const runStart = () => {
    // Not a guard against a race — a guard against the whole class of bug this dialog exists to
    // avoid. Without a spec there is nothing to send, and nothing here invents one.
    if (!spec) return;
    setClaimConflict(undefined);
    void start
      .run(async () => {
        if (spec.issue.number !== ticket.num) {
          throw new Error(
            `This spec is for #${spec.issue.number}, not #${ticket.num}. Refuse rather than claim ` +
              'one ticket and implement another.',
          );
        }
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
        // The daemon's `ImplementOrchestrator.start()` runs this same preview and fails closed on
        // it; this one is here to fail *early*, with the sentence that names the actual problem,
        // before a claim turns into a half-started ticket. It does not replace the daemon's gate.
        const preview = await getBridge().previewWorktree({ cwd, name: worktreeName });
        if (preview.secretRisk) {
          throw new Error(
            "This repository's .worktreeinclude would copy a secret-shaped file into the agent " +
              'worktree. Review it in Settings before starting.',
          );
        }
        return getBridge().implementPipenzo({
          spec,
          repositoryPath: cwd,
          provider,
          ...(model ? { model } : {}),
          ...(extraInstructions.trim() ? { extraInstructions: extraInstructions.trim() } : {}),
        });
      })
      .then((started) => {
        if (started) onStarted?.(started, { worktreeName, extraInstructions, runBudget });
      });
  };

  const busy = refine.pending || start.pending;
  const startFailed = start.status === 'error' && !claimConflict;

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
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {spec ? (
            <Button
              variant="primary"
              icon="play"
              pending={start.pending}
              onClick={startFailed ? () => void start.retry() : runStart}
            >
              {start.pending ? 'Starting…' : startFailed ? 'Retry' : 'Start'}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon="search"
              pending={refine.pending}
              onClick={refine.status === 'error' ? () => void refine.retry() : runRefine}
            >
              {refine.pending ? 'Refining…' : refine.status === 'error' ? 'Retry' : 'Refine ticket'}
            </Button>
          )}
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

      {spec ? (
        <RefineSpecReview spec={spec} />
      ) : (
        <span className="f-help">
          Nothing has been started. Refine reads this checkout and writes nothing; the spec it
          returns is what the implementer will be given, so read it before you press Start.
        </span>
      )}

      <Textarea
        label="Extra instructions (optional)"
        placeholder="e.g. only touch the daemon side, skip the renderer for now"
        value={extraInstructions}
        onChange={(event) => setExtraInstructions(event.target.value)}
        disabled={busy}
      />
      <div className="two-col">
        <TextField
          label="Branch"
          mono
          readOnly
          value={worktreeName}
          help="Derived from the ticket — one worktree per ticket."
          disabled={busy}
        />
        <Select
          label="Run budget"
          mono
          options={RUN_BUDGET_OPTIONS as unknown as { value: string; label: string }[]}
          value={runBudget}
          onChange={(event) => setRunBudget(event.target.value as RunBudget)}
          disabled={busy}
        />
      </div>
      <span className="f-help">
        Budget applies to this ticket only. When it runs out the ticket parks in Needs human instead
        of retrying.
      </span>
      {(refine.status === 'error' || start.status === 'error') && (
        <span className="f-err" role="alert">
          {start.error ?? refine.error}
        </span>
      )}
    </Dialog>
  );
}

/**
 * The spec, laid out from its fields (Pipenzo issue #179's contract) and never from prose.
 *
 * Same discipline `issue-draft.ts` states for a drafted issue: `RefineSpecV1.summary` is the one
 * free-text field, and every other line here is rendered from structured data — criterion ids and
 * their EARS kinds, the out-of-scope list, the numeric estimate. Open questions get a warn notice
 * rather than a bullet, because README's Refine step stops and asks a human while it is still
 * cheap, and a question buried in a list is not a stop.
 */
function RefineSpecReview({ spec }: { spec: RefineSpecV1 }) {
  return (
    <>
      <div className="draft">
        <span className="label">Refined spec</span>
        <span className="draft-title">{spec.summary}</span>
        <div className="draft-body">
          Acceptance criteria
          <ul>
            {spec.acceptanceCriteria.map((criterion) => (
              <li key={criterion.id}>
                <span className="mono">{criterion.id}</span> ({criterion.kind}) {criterion.text}
              </li>
            ))}
          </ul>
          Out of scope
          <ul>
            {/* Index keys: the schema does not make these unique, and nothing here reorders. */}
            {spec.outOfScope.map((entry, index) => (
              <li key={index}>{entry}</li>
            ))}
          </ul>
          {`Est. ${spec.estimate.changedLines} changed lines across ${spec.estimate.filesTouched} ` +
            `file${spec.estimate.filesTouched === 1 ? '' : 's'}.`}
        </div>
      </div>
      {spec.openQuestions.length > 0 && (
        <Notice tone="warn" icon="warning" quiet>
          Refine could not answer {spec.openQuestions.length} question
          {spec.openQuestions.length === 1 ? '' : 's'} from the repository:{' '}
          {spec.openQuestions.join(' ')}
        </Notice>
      )}
    </>
  );
}
