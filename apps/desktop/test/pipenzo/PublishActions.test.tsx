import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoPublishResultV1 } from '@agent-dock/shared';
import { PublishActions } from '../../src/pipenzo/PublishActions.js';
import type { AgentDockBridge } from '../../src/window.js';

const WORKTREE_ID = '123e4567-e89b-42d3-a456-426614174000';

const PUSH_RESULT: PipenzoPublishResultV1 = {
  worktreeId: WORKTREE_ID,
  remote: 'origin',
  branch: 'issue-94',
  headSha: 'a'.repeat(40),
  updatedRemote: true,
};

function installBridge(overrides: Partial<AgentDockBridge> = {}): {
  publishPipenzo: ReturnType<typeof vi.fn>;
} {
  const publishPipenzo = vi.fn().mockResolvedValue(PUSH_RESULT);
  (window as unknown as { agentDock: Partial<AgentDockBridge> }).agentDock = {
    publishPipenzo,
    ...overrides,
  };
  return { publishPipenzo };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe('PublishActions', () => {
  it('holds pending on Push branch from the click until the daemon confirms the push', async () => {
    let resolvePublish: (value: PipenzoPublishResultV1) => void = () => {};
    const publishPipenzo = vi.fn(
      () =>
        new Promise<PipenzoPublishResultV1>((resolve) => {
          resolvePublish = resolve;
        }),
    );
    installBridge({
      publishPipenzo: publishPipenzo as unknown as AgentDockBridge['publishPipenzo'],
    });

    render(<PublishActions worktreeId={WORKTREE_ID} branch="issue-94" />);
    fireEvent.click(screen.getByRole('button', { name: 'Push branch' }));

    const pendingBtn = await screen.findByRole('button', { name: 'Pushing…' });
    expect(pendingBtn).toHaveAttribute('aria-busy', 'true');
    expect(publishPipenzo).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      branch: 'issue-94',
      remote: undefined,
      operation: 'push',
    });

    resolvePublish(PUSH_RESULT);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Push branch' })).not.toHaveAttribute('aria-busy'),
    );
  });

  it('calls onPushed with the daemon result once the push resolves', async () => {
    installBridge();
    const onPushed = vi.fn();
    render(<PublishActions worktreeId={WORKTREE_ID} branch="issue-94" onPushed={onPushed} />);

    fireEvent.click(screen.getByRole('button', { name: 'Push branch' }));
    await waitFor(() => expect(onPushed).toHaveBeenCalledWith(PUSH_RESULT));
  });

  it('shows a Retry affordance after a failed push, and retry() re-attempts the identical call', async () => {
    const publishPipenzo = vi
      .fn()
      .mockRejectedValueOnce(new Error('the worktree has uncommitted changes'))
      .mockResolvedValueOnce(PUSH_RESULT);
    installBridge({
      publishPipenzo: publishPipenzo as unknown as AgentDockBridge['publishPipenzo'],
    });

    render(<PublishActions worktreeId={WORKTREE_ID} branch="issue-94" />);
    fireEvent.click(screen.getByRole('button', { name: 'Push branch' }));

    const retryBtn = await screen.findByRole('button', { name: 'Retry push' });
    expect(screen.getByText('the worktree has uncommitted changes')).toBeInTheDocument();

    fireEvent.click(retryBtn);
    await waitFor(() => expect(publishPipenzo).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Push branch' })).toBeInTheDocument(),
    );
  });

  it('disables Push & open PR until pull request details are supplied', () => {
    installBridge();
    render(<PublishActions worktreeId={WORKTREE_ID} branch="issue-94" />);
    expect(screen.getByRole('button', { name: 'Push & open PR' })).toBeDisabled();
  });

  it('sends the pull request title/body to the daemon on Push & open PR', async () => {
    const publishPipenzo = vi.fn().mockResolvedValue({
      ...PUSH_RESULT,
      pullRequest: {
        number: 1,
        htmlUrl: 'https://github.com/o/r/pull/1',
        baseRef: 'main',
        draft: false,
      },
    });
    installBridge({
      publishPipenzo: publishPipenzo as unknown as AgentDockBridge['publishPipenzo'],
    });

    render(
      <PublishActions
        worktreeId={WORKTREE_ID}
        branch="issue-94"
        pullRequest={{ title: 'fix: sanitize env', body: 'Closes #94.' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Push & open PR' }));

    await waitFor(() =>
      expect(publishPipenzo).toHaveBeenCalledWith({
        worktreeId: WORKTREE_ID,
        branch: 'issue-94',
        remote: undefined,
        operation: 'push_and_open_pull_request',
        pullRequest: { title: 'fix: sanitize env', body: 'Closes #94.' },
      }),
    );
  });

  it('pushing does not disable the Push & open PR button, and vice versa (independent pending state)', async () => {
    let resolvePush: (value: PipenzoPublishResultV1) => void = () => {};
    const publishPipenzo = vi.fn(
      () =>
        new Promise<PipenzoPublishResultV1>((resolve) => {
          resolvePush = resolve;
        }),
    );
    installBridge({
      publishPipenzo: publishPipenzo as unknown as AgentDockBridge['publishPipenzo'],
    });

    render(
      <PublishActions
        worktreeId={WORKTREE_ID}
        branch="issue-94"
        pullRequest={{ title: 'fix: sanitize env', body: 'Closes #94.' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Push branch' }));
    await screen.findByRole('button', { name: 'Pushing…' });

    expect(screen.getByRole('button', { name: 'Push & open PR' })).not.toBeDisabled();
    resolvePush(PUSH_RESULT);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Push branch' })).toBeInTheDocument(),
    );
  });

  it('renders Discard branch only when onDiscardClick is provided, and wires the click through', () => {
    installBridge();
    const onDiscardClick = vi.fn();
    const { rerender } = render(<PublishActions worktreeId={WORKTREE_ID} branch="issue-94" />);
    expect(screen.queryByRole('button', { name: 'Discard branch' })).not.toBeInTheDocument();

    rerender(
      <PublishActions worktreeId={WORKTREE_ID} branch="issue-94" onDiscardClick={onDiscardClick} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard branch' }));
    expect(onDiscardClick).toHaveBeenCalledTimes(1);
  });
});

/**
 * The `risk` gate (issue #157/#160, CLAUDE.md hard rule #3): a HIGH- or MEDIUM-graded push or
 * PR-open must never auto-allow. `DiffReviewHead.test.tsx` covers the same property wired through
 * its real `DiffReviewStat.risk` prop end to end; these exercise `PublishActions`'s own gating
 * logic directly, including reject and the Push & open PR variant.
 */
describe('PublishActions — risk-graded approval', () => {
  it('never calls the bridge on the first click when risk is high, and approving runs the real push', async () => {
    const { publishPipenzo } = installBridge();
    render(<PublishActions worktreeId={WORKTREE_ID} branch="issue-94" risk="high" />);

    fireEvent.click(screen.getByRole('button', { name: 'Push branch' }));
    expect(publishPipenzo).not.toHaveBeenCalled();
    expect(screen.getByText('HIGH')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(publishPipenzo).toHaveBeenCalledWith({
        worktreeId: WORKTREE_ID,
        branch: 'issue-94',
        remote: undefined,
        operation: 'push',
      }),
    );
  });

  it('Reject on the HIGH card closes it without ever calling the bridge', () => {
    const { publishPipenzo } = installBridge();
    render(<PublishActions worktreeId={WORKTREE_ID} branch="issue-94" risk="high" />);

    fireEvent.click(screen.getByRole('button', { name: 'Push branch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    expect(publishPipenzo).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Push branch' })).toBeInTheDocument();
  });

  it('gates Push & open PR behind the HIGH card too, keyed independently of Push branch', async () => {
    const { publishPipenzo } = installBridge();
    render(
      <PublishActions
        worktreeId={WORKTREE_ID}
        branch="issue-94"
        risk="high"
        pullRequest={{ title: 'fix: sanitize env', body: 'Closes #94.' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Push & open PR' }));
    expect(publishPipenzo).not.toHaveBeenCalled();
    // Push branch's own button is still the plain, ungated button -- only the PR stack is gated.
    expect(screen.getByRole('button', { name: 'Push branch' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(publishPipenzo).toHaveBeenCalledWith({
        worktreeId: WORKTREE_ID,
        branch: 'issue-94',
        remote: undefined,
        operation: 'push_and_open_pull_request',
        pullRequest: { title: 'fix: sanitize env', body: 'Closes #94.' },
      }),
    );
  });

  it('gates a MEDIUM-graded push behind MediumApprovalInline, and Allow runs the real push', async () => {
    const { publishPipenzo } = installBridge();
    render(<PublishActions worktreeId={WORKTREE_ID} branch="issue-94" risk="medium" />);

    fireEvent.click(screen.getByRole('button', { name: 'Push branch' }));
    expect(publishPipenzo).not.toHaveBeenCalled();
    expect(screen.getByText('MEDIUM')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(publishPipenzo).toHaveBeenCalledWith({
        worktreeId: WORKTREE_ID,
        branch: 'issue-94',
        remote: undefined,
        operation: 'push',
      }),
    );
  });

  it('pushes directly, ungated, when risk is low', async () => {
    const { publishPipenzo } = installBridge();
    render(<PublishActions worktreeId={WORKTREE_ID} branch="issue-94" risk="low" />);

    fireEvent.click(screen.getByRole('button', { name: 'Push branch' }));
    await waitFor(() => expect(publishPipenzo).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('HIGH')).not.toBeInTheDocument();
  });

  it('pushes directly, ungated, when risk is absent', async () => {
    const { publishPipenzo } = installBridge();
    render(<PublishActions worktreeId={WORKTREE_ID} branch="issue-94" />);

    fireEvent.click(screen.getByRole('button', { name: 'Push branch' }));
    await waitFor(() => expect(publishPipenzo).toHaveBeenCalledTimes(1));
  });
});
