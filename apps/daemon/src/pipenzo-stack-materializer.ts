import { randomUUID } from 'node:crypto';
import type {
  PipenzoTicketRecordV1,
  RefineProposedSplitPartV1,
} from '@agent-dock/shared';
import type { GitHubClient, GitHubIssue, RepoRef } from './github-client.js';
import { ticketBranchName } from './implement-orchestrator.js';
import { runGitCommand, type PipenzoGitRunner } from './pipenzo-git.js';
import type { FileTicketStore } from './pipenzo-ticket-store.js';

/**
 * The actual consequence of an accepted stack proposal (Pipenzo issue #99): one real GitHub issue,
 * one real owned worktree and branch, and one real ticket record per approved part, created in the
 * human-approved dependency order, followed by the parent ticket's own `stack.childIds` update.
 *
 * ## Why child worktrees stack on each other's branches, not the parent's base
 *
 * README's stacked-PR model (`gh stack`) means each child in the approved order is meant to review
 * and merge *on top of* the one before it -- `TicketDetail.dc.html`'s own mock data spells this out
 * (`base: i===0 ? 'main' : 'PR ${i}'`). So child 0's worktree branches from the repository's current
 * default ref (whatever `repositoryPath`'s checkout is on -- no `ref` passed, exactly like a normal
 * Implement dispatch with no `baseRef`), and every child after it branches from the *previous
 * child's own branch*, not from the parent's base. Branches are repository-wide refs, so a later
 * child's worktree can resolve an earlier child's branch by name even though it lives in a different
 * worktree -- the same reason `git worktree add` never needs the two worktrees to coexist for this
 * to work.
 *
 * ## Partial failure is reported, never silently rolled back
 *
 * A GitHub issue create, a worktree provision, or a branch creation can each fail independently, and
 * they can fail on child 2 of 3 after child 1 already exists for real -- a real GitHub issue with a
 * real worktree, genuinely usable, just not part of a complete stack yet. This function does not
 * delete what it already created on a later failure: `apps/daemon/src/pipenzo-git.ts`'s own hardened
 * git boundary has no authority to delete a worktree it did not just create in this same call
 * (deleting one it did just create would still leave orphaned GitHub issues nobody asked to close),
 * and closing issues automatically on a partial failure would be a second, surprising GitHub write
 * on top of the one that already failed. `StackMaterializationError.children` carries whatever was
 * successfully created before the failure, so the caller (`PipenzoPhaseService.acceptStack`) can
 * report exactly what exists and let a human decide the next step -- the same "report, don't guess"
 * reasoning `implement-orchestrator.ts`'s own error paths use throughout.
 *
 * ## Why this does not touch the parent ticket's GitHub label
 *
 * CLAUDE.md hard rule 5 closes off inventing an eleventh `pipenzo:` label for "this ticket is now a
 * read-only container" -- there is no such label in README's table, and this module does not add
 * one. `stack.childIds` on the *local* ticket record (README: "this store is authoritative for
 * everything GitHub can't hold") is the fact that makes a ticket a container; the parent's GitHub
 * label is left exactly as `pipenzo:awaiting-stack-approval` left it, because the decision it named
 * ("does this ticket become a stack") has been made, and nothing in README's label vocabulary has a
 * next state to move it to. A board rendering that reads non-empty `childIds` as "render this as a
 * container card, not an actionable one" is real, useful follow-up work this module deliberately
 * leaves unbuilt rather than invents a label to route around not having it yet.
 */

/** The slice of `OwnedWorktreeManager` this module uses -- same shape as `ImplementWorktreeManager`
 * in `implement-orchestrator.ts`, minus `preview()`: an accepted stack has already been approved by
 * a human, so there is no secret-risk confirmation step left to run before provisioning. */
export interface StackWorktreePort {
  create(input: {
    cwd: string;
    name: string;
    ref?: string;
    confirmIncludeCopy: true;
  }): Promise<{ id: string }>;
  ownedLocation(id: string): { path: string } | undefined;
}

/** Local-only ticket-record access this module needs: reading the parent, creating each child, and
 * `list` to find a child record the reconciler's intake (issue #511) may already have created. */
export type StackTicketStorePort = Pick<FileTicketStore, 'get' | 'update' | 'create' | 'list'>;

export interface MaterializeStackOptions {
  readonly parentTicket: PipenzoTicketRecordV1;
  readonly repositoryPath: string;
  readonly orderedParts: readonly RefineProposedSplitPartV1[];
  /** Narrowed to exactly the one call this module makes -- a test double only ever has to implement
   * `createIssue`, and this module's coupling to `GitHubClient`'s much wider surface stays honest. */
  readonly github: Pick<GitHubClient, 'createIssue'>;
  readonly repoRef: RepoRef;
  readonly worktrees: StackWorktreePort;
  readonly tickets: StackTicketStorePort;
  /** Injection seam for tests, matching `pipenzo-git.ts`'s own `PipenzoGitRunner` convention.
   * Production always defaults to `runGitCommand`. */
  readonly runGit?: PipenzoGitRunner;
}

export interface MaterializedStackChild {
  readonly ticketId: string;
  readonly issueNumber: number;
  readonly title: string;
}

export class StackMaterializationError extends Error {
  readonly cause: unknown;
  /** Whatever children were successfully created before this failure -- see the module comment's
   * "partial failure" section. Empty if the very first child failed. */
  readonly children: readonly MaterializedStackChild[];

  constructor(message: string, children: readonly MaterializedStackChild[], cause?: unknown) {
    super(message);
    this.name = 'StackMaterializationError';
    this.children = children;
    this.cause = cause;
  }
}

/** GitHub's own issue-title ceiling (`assertIssueDraft` in `github-client.ts`) is 256 characters,
 * tighter than a proposed-split part's 500-character `summary`. Truncated with an ellipsis rather
 * than refused outright -- a human already approved this part's summary in the panel; a title too
 * long to post verbatim is a formatting mismatch, not a reason to fail the whole accept. */
function childIssueTitle(part: RefineProposedSplitPartV1, position: number, total: number): string {
  const prefix = `[${position + 1}/${total}] `;
  const budget = 256 - prefix.length;
  const summary =
    part.summary.length > budget ? `${part.summary.slice(0, Math.max(0, budget - 1))}…` : part.summary;
  return `${prefix}${summary}`;
}

function childIssueBody(
  part: RefineProposedSplitPartV1,
  parent: PipenzoTicketRecordV1,
  position: number,
  total: number,
): string {
  const lines = [
    `Part ${position + 1} of ${total} in a dependency-ordered stack approved from #${parent.issueNumber}.`,
    '',
    part.summary,
    '',
    `Estimate carried over from the approved split: ≈${part.changedLines} changed lines, ${part.filesTouched} files.`,
  ];
  if (position > 0) {
    lines.push('', `Branches on top of stack entry ${position} — see #${parent.issueNumber} for the full order.`);
  }
  return lines.join('\n');
}

export async function materializeStack(options: MaterializeStackOptions): Promise<MaterializedStackChild[]> {
  const runGit = options.runGit ?? runGitCommand;
  const children: MaterializedStackChild[] = [];
  const total = options.orderedParts.length;
  let previousBranch: string | undefined;

  for (let index = 0; index < total; index += 1) {
    const part = options.orderedParts[index]!;

    let issue: GitHubIssue;
    try {
      issue = await options.github.createIssue(options.repoRef, {
        title: childIssueTitle(part, index, total),
        body: childIssueBody(part, options.parentTicket, index, total),
        labels: ['pipenzo:queued', 'pipenzo:schema-v1'],
      });
    } catch (error) {
      throw new StackMaterializationError(
        `could not create the GitHub issue for stack entry ${index + 1} of ${total}`,
        children,
        error,
      );
    }

    const branch = ticketBranchName(issue.number);
    let worktreeId: string;
    try {
      const worktree = await options.worktrees.create({
        cwd: options.repositoryPath,
        name: branch,
        ...(previousBranch ? { ref: previousBranch } : {}),
        confirmIncludeCopy: true,
      });
      worktreeId = worktree.id;
    } catch (error) {
      throw new StackMaterializationError(
        `could not provision a worktree for stack entry ${index + 1} of ${total} (issue #${issue.number} was already created)`,
        children,
        error,
      );
    }

    const location = options.worktrees.ownedLocation(worktreeId);
    if (!location) {
      throw new StackMaterializationError(
        `the newly created worktree for stack entry ${index + 1} of ${total} could not be located`,
        children,
      );
    }

    const created = await runGit(['switch', '--create', branch, '--no-guess'], location.path);
    if (created.code !== 0) {
      throw new StackMaterializationError(
        `could not create branch ${branch} for stack entry ${index + 1} of ${total}: ${created.stderr.trim().slice(0, 500)}`,
        children,
      );
    }

    // Issue #511: the child issue is intake-eligible (`pipenzo:queued` + the v1 marker) from the
    // moment `createIssue` returns, and the worktree and branch above take seconds -- so the
    // reconciler's intake may already have admitted it as a plain, stackless ticket. That record is
    // taken over (same id, this module's richer content) rather than duplicated beside.
    const repoKey = options.parentTicket.repo.toLowerCase();
    const admitted = options.tickets
      .list()
      .find((candidate) => candidate.repo.toLowerCase() === repoKey && candidate.issueNumber === issue.number);
    const ticketId = admitted?.ticketId ?? randomUUID();
    const ticket: PipenzoTicketRecordV1 = {
      schemaVersion: 1,
      ticketId,
      repo: options.parentTicket.repo,
      issueNumber: issue.number,
      title: issue.title,
      lane: 'queued',
      phase: 'refine',
      labels: ['pipenzo:queued', 'pipenzo:schema-v1'],
      estimate: { lines: part.changedLines, files: part.filesTouched, layered: false },
      taskType: options.parentTicket.taskType,
      stack: { parentId: options.parentTicket.ticketId, childIds: [], index },
      worktree: { id: worktreeId, path: location.path, branch },
      attempts: [],
      budget: { tokensUsed: 0, limit: 0 },
      risk: { score: 0, lastResetAt: new Date().toISOString() },
      precommits: [],
      etags: {},
    };
    try {
      if (admitted) options.tickets.update(ticketId, ticket);
      else options.tickets.create(ticket);
    } catch (error) {
      throw new StackMaterializationError(
        `could not persist the ticket record for stack entry ${index + 1} of ${total} (issue #${issue.number} and its worktree were already created)`,
        children,
        error,
      );
    }

    children.push({ ticketId, issueNumber: issue.number, title: issue.title });
    previousBranch = branch;
  }

  return children;
}
