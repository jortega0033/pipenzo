import type { ReactNode } from 'react';
import type { PipenzoPublishResultV1, PipenzoPullRequestInputV1 } from '@agent-dock/shared';
import { Chip, RiskChip, type RiskLevel } from '../components/primitives/Chip.js';
import { PublishActions } from './PublishActions.js';

export interface DiffReviewStat {
  readonly additions: number;
  readonly deletions: number;
  readonly filesChanged: number;
  /** e.g. `"within budget · ≤ 100 lines, ≤ 10 files"` or `"over budget · ..."`. */
  readonly budgetLabel: string;
  readonly withinBudget: boolean;
  /** Publish-gate risk grade -- absent when the risk classifier (build step 6, not yet built)
   * has nothing to report; the chip is simply omitted rather than rendered as a false LOW. */
  readonly risk?: RiskLevel;
}

/**
 * DiffReview's shell + head (issue #106): the id line, title, stat row, and the three publish
 * actions, matching DiffReview.dc.html's `.head` exactly. The id line, title and stat row are
 * plain typed props -- consistent with every other data-driven primitive in this codebase
 * (VerificationBlock, FindingsList, ...) -- rather than a component that fetches its own data;
 * see issue #109/#111 for where the review-report-shaped data behind them gets assembled once a
 * review-report route exists (apps/daemon/src/review-gates.ts, issue #181, has none yet).
 *
 * Push branch / Push & open PR / Discard branch are real: they're `PublishActions` (issue #69),
 * wired to the daemon's actual publish gate and worktree cleanup routes.
 */
export function DiffReviewHead({
  idLine,
  title,
  stat,
  worktreeId,
  branch,
  remote,
  pullRequest,
  onDiscardClick,
  discardDisabled,
  onPushed,
  onPullRequestOpened,
}: {
  /** e.g. `"#94 · issue-94 → main · committed locally, nothing pushed"`. */
  idLine: ReactNode;
  title: ReactNode;
  stat: DiffReviewStat;
  worktreeId: string;
  branch: string;
  remote?: string;
  pullRequest?: PipenzoPullRequestInputV1;
  onDiscardClick?: () => void;
  discardDisabled?: boolean;
  onPushed?: (result: PipenzoPublishResultV1) => void;
  onPullRequestOpened?: (result: PipenzoPublishResultV1) => void;
}) {
  return (
    <div className="head">
      <div className="head-l">
        <span className="h-id mono">{idLine}</span>
        <span className="h-title">{title}</span>
        <div className="stat-row">
          <span className="mono">
            <span className="add-t">+{stat.additions}</span>{' '}
            <span className="del-t">−{stat.deletions}</span>
          </span>
          <span>{stat.filesChanged} files changed</span>
          <Chip tone={stat.withinBudget ? 'ok' : 'danger'}>{stat.budgetLabel}</Chip>
          {stat.risk && <RiskChip level={stat.risk}>{stat.risk.toUpperCase()} · publish</RiskChip>}
        </div>
      </div>
      <PublishActions
        worktreeId={worktreeId}
        branch={branch}
        remote={remote}
        pullRequest={pullRequest}
        onDiscardClick={onDiscardClick}
        discardDisabled={discardDisabled}
        onPushed={onPushed}
        onPullRequestOpened={onPullRequestOpened}
      />
    </div>
  );
}
