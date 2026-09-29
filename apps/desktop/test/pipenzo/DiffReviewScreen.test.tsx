import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PipenzoImplementCommitsV1,
  PipenzoImplementDiffResultV1,
  PipenzoImplementResultV1,
  PipenzoPublishResultV1,
  PipenzoReviewResultV1,
  RefineSpecV1,
} from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { DiffReviewScreen } from '../../src/pipenzo/DiffReviewScreen.js';

const STARTED: PipenzoImplementResultV1 = {
  worktreeId: '11111111-1111-1111-1111-111111111111',
  branch: 'issue-94',
  baseCommit: 'a'.repeat(40),
  sessionId: 'session-1',
};

const TICKET = { num: 94, title: 'Sanitize environment for MCP stdio servers', repo: 'jortega0033/pipenzo' };

const SPEC: RefineSpecV1 = {
  schemaVersion: 1,
  issue: { repo: 'jortega0033/pipenzo', number: 94, title: 'Sanitize environment for MCP stdio servers' },
  summary: 'Build the sanitized environment floor.',
  acceptanceCriteria: [{ id: 'AC-1', kind: 'ubiquitous', text: 'The connection shall not leak the host env.' }],
  outOfScope: [],
  filesLikelyTouched: [],
  estimate: { changedLines: 60, filesTouched: 2, layered: false },
  openQuestions: [],
};

function commits(overrides: Partial<PipenzoImplementCommitsV1> = {}): PipenzoImplementCommitsV1 {
  return {
    worktreeId: STARTED.worktreeId,
    branch: STARTED.branch,
    baseCommit: STARTED.baseCommit,
    headCommit: 'b'.repeat(40),
    commits: ['b'.repeat(40)],
    sessionState: 'completed',
    ...overrides,
  };
}

function diffResult(overrides: Partial<PipenzoImplementDiffResultV1> = {}): PipenzoImplementDiffResultV1 {
  return {
    worktreeId: STARTED.worktreeId,
    baseCommit: STARTED.baseCommit,
    headCommit: 'b'.repeat(40),
    diffText:
      'diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,3 @@\n context\n+added line\n context\n',
    truncated: false,
    additions: 8,
    deletions: 0,
    filesChanged: 1,
    ...overrides,
  };
}

function reviewReport(): PipenzoReviewResultV1 {
  return {
    schemaVersion: 1,
    outcome: 'approved',
    baseCommit: STARTED.baseCommit,
    headCommit: 'b'.repeat(40),
    implementerTier: 'mid',
    risk: 'low',
    deterministic: [
      { id: 'build', status: 'passed', summary: 'Build and typecheck passed', durationMs: 900 },
    ],
    reviewer: { sessionId: 's1', tier: 'mid', model: 'reviewer-model', findings: [] },
    verifier: {
      sessionId: 's2',
      tier: 'mid',
      model: 'verifier-model',
      verdict: 'approved',
      vendorDiversityUnavailable: false,
      findings: [],
    },
  };
}

afterEach(() => {
  clearBridgeOverride();
});

describe('DiffReviewScreen', () => {
  it('polls implement/result, then fetches the diff, then renders DiffReviewHead + DiffFileList', async () => {
    const implementResultPipenzo = vi.fn().mockResolvedValue(commits());
    const implementDiffPipenzo = vi.fn().mockResolvedValue(diffResult());
    setBridgeOverride({ implementResultPipenzo, implementDiffPipenzo } as never);

    render(<DiffReviewScreen ticket={TICKET} spec={SPEC} started={STARTED} />);

    expect(screen.getByRole('status', { name: /waiting for the implement session/i })).toBeInTheDocument();

    await waitFor(() => expect(implementDiffPipenzo).toHaveBeenCalledWith({
      worktreeId: STARTED.worktreeId,
      baseCommit: STARTED.baseCommit,
      headCommit: 'b'.repeat(40),
    }));

    await waitFor(() => expect(screen.getByText(TICKET.title)).toBeInTheDocument());
    expect(screen.getByText(/#94 · issue-94 → committed locally, nothing pushed/)).toBeInTheDocument();
    expect(screen.getByText('added line')).toBeInTheDocument();
    expect(screen.getByText(/within budget/)).toBeInTheDocument();
    // No review has run yet, so Push & open PR (which needs a pullRequest) stays disabled.
    expect(screen.getByRole('button', { name: /push & open pr/i })).toBeDisabled();
  });

  it('shows a "nothing was committed" notice when the session ended with an empty diff', async () => {
    const implementResultPipenzo = vi.fn().mockResolvedValue(commits({ commits: [] }));
    setBridgeOverride({ implementResultPipenzo, implementDiffPipenzo: vi.fn() } as never);

    render(<DiffReviewScreen ticket={TICKET} spec={SPEC} started={STARTED} />);

    await waitFor(() => expect(screen.getByText(/nothing was committed/i)).toBeInTheDocument());
  });

  it('surfaces a poll failure as a danger notice', async () => {
    const implementResultPipenzo = vi.fn().mockRejectedValue(new Error('worktree not found'));
    setBridgeOverride({ implementResultPipenzo, implementDiffPipenzo: vi.fn() } as never);

    render(<DiffReviewScreen ticket={TICKET} spec={SPEC} started={STARTED} />);

    await waitFor(() => expect(screen.getByText('worktree not found')).toBeInTheDocument());
  });

  it('surfaces a diff-fetch failure with a working retry', async () => {
    const implementResultPipenzo = vi.fn().mockResolvedValue(commits());
    const implementDiffPipenzo = vi
      .fn()
      .mockRejectedValueOnce(new Error('could not read the diff for this range'))
      .mockResolvedValueOnce(diffResult());
    setBridgeOverride({ implementResultPipenzo, implementDiffPipenzo } as never);

    render(<DiffReviewScreen ticket={TICKET} spec={SPEC} started={STARTED} />);

    await waitFor(() => expect(screen.getByText('could not read the diff for this range')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByText(TICKET.title)).toBeInTheDocument());
    expect(implementDiffPipenzo).toHaveBeenCalledTimes(2);
  });

  it('a real "Run review" click sends a real reviewPipenzo request built from human-typed model fields, and renders the real report in RailPanel', async () => {
    const implementResultPipenzo = vi.fn().mockResolvedValue(commits());
    const implementDiffPipenzo = vi.fn().mockResolvedValue(diffResult());
    const report = reviewReport();
    const reviewPipenzo = vi.fn().mockResolvedValue(report);
    setBridgeOverride({ implementResultPipenzo, implementDiffPipenzo, reviewPipenzo } as never);

    render(<DiffReviewScreen ticket={TICKET} spec={SPEC} started={STARTED} />);
    await waitFor(() => expect(screen.getByText(TICKET.title)).toBeInTheDocument());

    // Nothing invented: the run button stays disabled until a human has typed both model ids.
    const runButton = screen.getByRole('button', { name: /run review/i });
    expect(runButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Reviewer model'), { target: { value: 'claude-sonnet-4-5' } });
    fireEvent.change(screen.getByLabelText('Verifier model'), { target: { value: 'claude-opus-4-1' } });
    expect(runButton).toBeEnabled();

    fireEvent.click(runButton);

    await waitFor(() => expect(reviewPipenzo).toHaveBeenCalledTimes(1));
    expect(reviewPipenzo).toHaveBeenCalledWith({
      spec: SPEC,
      worktreeId: STARTED.worktreeId,
      baseCommit: STARTED.baseCommit,
      headCommit: 'b'.repeat(40),
      implementerTier: 'mid',
      implementerProvider: 'claude',
      reviewer: { provider: 'claude', model: 'claude-sonnet-4-5', tier: 'mid' },
      verifier: { provider: 'claude', model: 'claude-opus-4-1', tier: 'mid' },
    });

    // The real report renders in RailPanel (Machine-verified block), and the commit block is
    // assembled from the real spec + report via pr-assembly.ts.
    await waitFor(() => expect(screen.getByText('Build and typecheck passed')).toBeInTheDocument());
    expect(screen.getByText(/The verifier approved this diff with 0 critical findings sustained\./)).toBeInTheDocument();
    // A report now exists, so Push & open PR is enabled.
    expect(screen.getByRole('button', { name: /push & open pr/i })).toBeEnabled();
  });

  it('Push branch calls the real publishPipenzo route with this worktree/branch', async () => {
    const implementResultPipenzo = vi.fn().mockResolvedValue(commits());
    const implementDiffPipenzo = vi.fn().mockResolvedValue(diffResult());
    const publishResult: PipenzoPublishResultV1 = {
      worktreeId: STARTED.worktreeId,
      remote: 'origin',
      branch: STARTED.branch,
      headSha: 'b'.repeat(40),
      updatedRemote: true,
    };
    const publishPipenzo = vi.fn().mockResolvedValue(publishResult);
    setBridgeOverride({ implementResultPipenzo, implementDiffPipenzo, publishPipenzo } as never);

    const onPushed = vi.fn();
    render(<DiffReviewScreen ticket={TICKET} spec={SPEC} started={STARTED} onPushed={onPushed} />);
    await waitFor(() => expect(screen.getByText(TICKET.title)).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /push branch/i }));
    });

    await waitFor(() => expect(publishPipenzo).toHaveBeenCalledWith({
      worktreeId: STARTED.worktreeId,
      branch: STARTED.branch,
      remote: undefined,
      operation: 'push',
    }));
    expect(onPushed).toHaveBeenCalledWith(publishResult);
  });
});
