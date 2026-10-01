import { useEffect, useState } from 'react';
import {
  PIPENZO_DIFF_SIZE_THRESHOLDS,
  PROVIDER_IDS,
  MODEL_TIERS,
  type ModelTier,
  type PipenzoImplementDiffResultV1,
  type PipenzoImplementResultV1,
  type PipenzoPublishResultV1,
  type ProviderId,
  type RefineSpecV1,
} from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Button } from '../components/primitives/Button.js';
import { Notice } from '../components/primitives/Notice.js';
import { Select } from '../components/primitives/Select.js';
import { TextField } from '../components/primitives/TextField.js';
import { buildCommitMessage, buildConfidenceLine, buildPullRequestInput } from './pr-assembly.js';
import { DiffFileList } from './DiffFileList.js';
import { DiffReviewHead, type DiffReviewStat } from './DiffReviewHead.js';
import { deriveLessonPrefill } from './lesson-prompt.js';
import { LessonPrompt } from './LessonPrompt.js';
import { RailPanel } from './RailPanel.js';
import { buildReviewRequest, useImplementPoll, useReviewAction } from './use-implement-review.js';
import { useAsyncAction } from './use-async-action.js';

/**
 * The Review/Diff/Publish screen (Pipenzo issue #90's follow-on stack, step 2): assembles
 * `DiffReviewHead`/`DiffFileList`/`RailPanel`/`PublishActions` -- real, tested, previously unmounted
 * -- around real data instead of the mock props their own component tests use.
 *
 * Mounted for one dispatched Implement run at a time: `ticket`/`spec`/`started` come from the same
 * `ImplementDialog` flow that already produced them (`spec` from Refine, `started` from Implement's
 * own response), so this screen never re-derives or guesses either. It owns four steps in sequence:
 *
 * 1. **Poll** `implementResultPipenzo` (`useImplementPoll`) until the dispatched session reaches a
 *    terminal state.
 * 2. **Fetch the diff** (`implementDiffPipenzo`, this stack's new route) for `baseCommit..headCommit`
 *    once the poll is `'ready'`.
 * 3. **Run review**, once a human supplies a real reviewer/verifier model choice -- see
 *    `use-implement-review.ts`'s own module comment for why this screen does not invent one:
 *    `review-gates.ts` dispatches `reviewer.model`/`verifier.model` as the literal model argument to
 *    the provider CLI, and nothing reachable from the desktop today (no model catalog, no Models &
 *    gates screen) can resolve a real one on a caller's behalf. The form below is the honest
 *    alternative to fabricating one: a human types it, the same way `ImplementDialog`'s own "extra
 *    instructions" field is a real, typed value rather than an invented default.
 * 4. **Publish**, via `DiffReviewHead`'s own `PublishActions` -- unchanged, already wired to the
 *    real `publishPipenzo` gate.
 *
 * A completed push or an opened pull request is also the closest concrete "this ticket has
 * resolved" event that exists as running code today (issue #104) -- `TicketDetail.dc.html`'s own
 * `.lesson` prompt is offered once `resolved` flips true, pre-filled from this run's own
 * `ReviewReportV1` (`lesson-prompt.ts`'s `deriveLessonPrefill`), never from an invented string.
 */
export function DiffReviewScreen({
  ticket,
  spec,
  started,
  onDiscardClick,
  discardDisabled,
  onPushed,
  onPullRequestOpened,
}: {
  ticket: { readonly num: number; readonly title: string; readonly repo: string };
  spec: RefineSpecV1;
  started: PipenzoImplementResultV1;
  onDiscardClick?: () => void;
  discardDisabled?: boolean;
  onPushed?: (result: PipenzoPublishResultV1) => void;
  onPullRequestOpened?: (result: PipenzoPublishResultV1) => void;
}) {
  const poll = useImplementPoll(started);
  const diff = useImplementDiff(poll.status === 'ready' ? poll.commits : undefined);
  const review = useReviewAction();
  // Flips once, on a real push or a real opened pull request -- never reset back to false, so
  // `LessonPrompt` below is offered exactly once for this screen's one run (issue #104).
  const [resolved, setResolved] = useState(false);
  const handlePushed = (result: PipenzoPublishResultV1) => {
    setResolved(true);
    onPushed?.(result);
  };
  const handlePullRequestOpened = (result: PipenzoPublishResultV1) => {
    setResolved(true);
    onPullRequestOpened?.(result);
  };

  if (poll.status === 'polling') {
    return (
      <div className="stream" role="status" aria-label={`Waiting for the implement session on #${ticket.num} to finish`}>
        <span className="f-help">
          Watching the implement session on <span className="mono">{started.branch}</span>…
        </span>
      </div>
    );
  }

  if (poll.status === 'error') {
    return (
      <Notice tone="danger" icon="warning" title="Couldn't read the implement result">
        {poll.message}
      </Notice>
    );
  }

  const { commits } = poll;
  if (commits.commits.length === 0) {
    return (
      <Notice tone="warn" icon="warning" title="Nothing was committed">
        The implement session on <span className="mono">{started.branch}</span> ended without
        committing anything to review.
      </Notice>
    );
  }

  if (diff.status === 'loading') {
    return (
      <div className="stream" role="status" aria-label="Loading the diff">
        <span className="f-help">Loading the diff…</span>
      </div>
    );
  }

  if (diff.status === 'error') {
    return (
      <Notice tone="danger" icon="warning" title="Couldn't read the diff" actions={[{ label: 'Retry', onClick: diff.retry }]}>
        {diff.message}
      </Notice>
    );
  }

  const { result } = diff;
  const totalLines = result.additions + result.deletions;
  const { onePrMaxLines, onePrMaxFiles } = PIPENZO_DIFF_SIZE_THRESHOLDS;
  const withinBudget = totalLines <= onePrMaxLines && result.filesChanged <= onePrMaxFiles;
  const stat: DiffReviewStat = {
    additions: result.additions,
    deletions: result.deletions,
    filesChanged: result.filesChanged,
    budgetLabel: withinBudget
      ? `within budget · ≤ ${onePrMaxLines} lines, ≤ ${onePrMaxFiles} files`
      : `over budget · ≤ ${onePrMaxLines} lines, ≤ ${onePrMaxFiles} files`,
    withinBudget,
    // No `risk` -- the risk classifier isn't wired in yet (README's own "designed, not wired in
    // yet" list), and `DiffReviewStat.risk`'s own doc comment is explicit that omitting it is the
    // correct rendering of "nothing to report" rather than a guessed LOW.
  };

  const report = review.result;
  const pullRequest = report ? buildPullRequestInput(spec, report) : undefined;
  const commit = report
    ? { message: buildCommitMessage(spec), confidence: buildConfidenceLine(report) }
    : undefined;

  return (
    <>
      <DiffReviewHead
        idLine={`#${ticket.num} · ${started.branch} → committed locally, nothing pushed`}
        title={ticket.title}
        stat={stat}
        worktreeId={started.worktreeId}
        branch={started.branch}
        pullRequest={pullRequest}
        onDiscardClick={onDiscardClick}
        discardDisabled={discardDisabled}
        onPushed={handlePushed}
        onPullRequestOpened={handlePullRequestOpened}
      />
      {resolved && (
        // Keyed by the resolution's own identity (issue #104's callers have no other id for a
        // ticket): a screen reused for a different ticket without a full remount must still get a
        // fresh `LessonPrompt` mount, per that component's own "keyed by whatever identifies that
        // resolution at the call site" doc comment -- otherwise its draft/step state would leak
        // from one ticket's resolution into another's.
        <LessonPrompt
          key={`${ticket.repo}#${ticket.num}`}
          repo={ticket.repo}
          issueNumber={ticket.num}
          prefill={deriveLessonPrefill(report)}
        />
      )}
      <div className="body">
        <DiffFileList diffText={result.diffText} />
        <div className="rail">
          {report ? (
            <RailPanel report={report} commit={commit} />
          ) : (
            <RunReviewForm
              pending={review.pending}
              error={review.error}
              onRun={(choice) =>
                void review.run(
                  buildReviewRequest({
                    spec,
                    commits: result,
                    implementerTier: choice.implementerTier,
                    implementerProvider: choice.provider,
                    reviewer: { provider: choice.provider, model: choice.reviewerModel, tier: choice.tier },
                    verifier: { provider: choice.provider, model: choice.verifierModel, tier: choice.tier },
                  }),
                )
              }
            />
          )}
        </div>
      </div>
    </>
  );
}

/** Fetches the diff for a finished poll's commit range (issue #90's stack, step 2's own route).
 * A one-shot fetch, not a poll -- unlike `useImplementPoll`, the range is fixed the moment the
 * session is terminal, so there is nothing to re-check on an interval, only a retry on failure. */
function useImplementDiff(
  commits: { worktreeId: string; baseCommit: string; headCommit: string } | undefined,
):
  | { status: 'loading' }
  | { status: 'ready'; result: PipenzoImplementDiffResultV1 }
  | { status: 'error'; message: string; retry: () => void } {
  const action = useAsyncAction<PipenzoImplementDiffResultV1>();
  const { run } = action;
  const worktreeId = commits?.worktreeId;
  const baseCommit = commits?.baseCommit;
  const headCommit = commits?.headCommit;

  useEffect(() => {
    if (worktreeId === undefined || baseCommit === undefined || headCommit === undefined) return;
    void run(() => getBridge().implementDiffPipenzo({ worktreeId, baseCommit, headCommit }));
  }, [run, worktreeId, baseCommit, headCommit]);

  if (action.status === 'error') {
    return { status: 'error', message: action.error ?? 'the request failed', retry: () => void action.retry() };
  }
  if (action.result) return { status: 'ready', result: action.result };
  return { status: 'loading' };
}

interface ReviewModelChoiceForm {
  readonly provider: ProviderId;
  readonly implementerTier: ModelTier;
  readonly tier: ModelTier;
  readonly reviewerModel: string;
  readonly verifierModel: string;
}

const TIER_OPTIONS = MODEL_TIERS.map((tier) => ({ value: tier, label: tier }));
const PROVIDER_OPTIONS = PROVIDER_IDS.map((provider) => ({ value: provider, label: provider }));

/**
 * "Run review", made of real, human-typed fields rather than an invented default -- see this
 * file's own module comment for why. `implementerTier` is asked for too: nothing tracks what tier
 * the dispatched Implement session actually ran at, and README's verifier-never-weaker rule is
 * meaningless to enforce against a silent guess, so this makes the assumption a visible,
 * human-confirmable field instead of an invisible one.
 */
function RunReviewForm({
  pending,
  error,
  onRun,
}: {
  pending: boolean;
  error?: string;
  onRun: (choice: ReviewModelChoiceForm) => void;
}) {
  const [provider, setProvider] = useState<ProviderId>('claude');
  const [implementerTier, setImplementerTier] = useState<ModelTier>('mid');
  const [tier, setTier] = useState<ModelTier>('mid');
  const [reviewerModel, setReviewerModel] = useState('');
  const [verifierModel, setVerifierModel] = useState('');

  const canRun = reviewerModel.trim().length > 0 && verifierModel.trim().length > 0 && !pending;

  return (
    <div className="v-block">
      <span className="label">Run review</span>
      <span className="f-help">
        Nothing has been reviewed yet. The reviewer and verifier each run a fresh session at the
        model you name here -- there is no catalog to pick one from yet, so type the exact model
        id each provider CLI expects.
      </span>
      <Select
        label="Provider"
        options={PROVIDER_OPTIONS}
        value={provider}
        onChange={(event) => setProvider(event.target.value as ProviderId)}
        disabled={pending}
      />
      <Select
        label="Implementer tier"
        help="What tier the just-dispatched Implement session ran at -- not tracked automatically yet."
        options={TIER_OPTIONS}
        value={implementerTier}
        onChange={(event) => setImplementerTier(event.target.value as ModelTier)}
        disabled={pending}
      />
      <TextField
        label="Reviewer model"
        mono
        placeholder="e.g. claude-sonnet-4-5"
        value={reviewerModel}
        onChange={(event) => setReviewerModel(event.target.value)}
        disabled={pending}
      />
      <TextField
        label="Verifier model"
        mono
        placeholder="e.g. claude-opus-4-1"
        value={verifierModel}
        onChange={(event) => setVerifierModel(event.target.value)}
        disabled={pending}
      />
      <Select
        label="Reviewer & verifier tier"
        options={TIER_OPTIONS}
        value={tier}
        onChange={(event) => setTier(event.target.value as ModelTier)}
        disabled={pending}
      />
      <Button
        variant="primary"
        icon="search"
        pending={pending}
        disabled={!canRun}
        onClick={() => onRun({ provider, implementerTier, tier, reviewerModel, verifierModel })}
      >
        {pending ? 'Reviewing…' : 'Run review'}
      </Button>
      {error && (
        <span className="f-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
