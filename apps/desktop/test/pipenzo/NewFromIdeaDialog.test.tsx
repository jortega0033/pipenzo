import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoIssueDraftV1 } from '@agent-dock/shared';
import { NewFromIdeaDialog } from '../../src/pipenzo/NewFromIdeaDialog.js';
import { renderDraftSummary, renderDraftedIssueBody } from '../../src/pipenzo/issue-draft.js';
import type { AgentDockBridge } from '../../src/window.js';

/**
 * Issue #84, against Main.dc.html's plan dialog.
 *
 * Two properties carry the ticket, and both get their own tests: nothing is created until a human
 * clicks, and the prose is one field while everything else is rendered from data.
 */

const DRAFT: PipenzoIssueDraftV1 = {
  schemaVersion: 1,
  title: 'Show an unread badge on the tray icon when a ticket reaches "ready for review"',
  acceptanceCriteria: [
    {
      id: 'AC-1',
      kind: 'event',
      text: 'When a ticket reaches ready-for-review, the tray icon shall show an unread badge',
    },
  ],
  outOfScope: ['sounds', 'per-repo settings'],
  estimate: { changedLines: 40, filesTouched: 1, layered: false },
  openQuestions: [],
};

function installBridge(overrides: Partial<AgentDockBridge> = {}) {
  const draftPipenzoIssue = vi.fn().mockResolvedValue({ sessionId: 's1', draft: DRAFT });
  const createPipenzoIssue = vi.fn().mockResolvedValue({
    repo: 'jortega0033/agentdock',
    issueNumber: 901,
    title: DRAFT.title,
    htmlUrl: 'https://github.com/jortega0033/agentdock/issues/901',
  });
  (window as unknown as { agentDock: Partial<AgentDockBridge> }).agentDock = {
    draftPipenzoIssue,
    createPipenzoIssue,
    ...overrides,
  };
  return { draftPipenzoIssue, createPipenzoIssue };
}

function open(props: Partial<Parameters<typeof NewFromIdeaDialog>[0]> = {}) {
  return render(
    <NewFromIdeaDialog
      open
      onClose={() => undefined}
      repositoryPath="/repo"
      repo="jortega0033/agentdock"
      provider="claude"
      {...props}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe('NewFromIdeaDialog', () => {
  it('says up front that nothing is created until the operator confirms', () => {
    installBridge();
    open();
    expect(screen.getByText(/nothing is created until you confirm/i)).toBeInTheDocument();
  });

  it('will not draft from an empty idea', () => {
    installBridge();
    open();
    expect(screen.getByRole('button', { name: 'Draft issue' })).toBeDisabled();
  });

  it('drafts from the operator’s own words and previews the result', async () => {
    const { draftPipenzoIssue, createPipenzoIssue } = installBridge();
    open();
    fireEvent.change(screen.getByLabelText(/what’s the problem/i), {
      target: { value: 'the tray icon never tells me a PR is ready' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Draft issue' }));

    await screen.findByText(DRAFT.title);
    expect(draftPipenzoIssue).toHaveBeenCalledWith({
      idea: 'the tray icon never tells me a PR is ready',
      repositoryPath: '/repo',
      provider: 'claude',
    });
    // The whole point of the ticket: drafting creates nothing.
    expect(createPipenzoIssue).not.toHaveBeenCalled();
  });

  /**
   * The claim in the canvas's own help text. It is true here by construction — the draft has no
   * field a model could put markdown in, and the body is a pure function over the fields it does
   * have.
   */
  it('files a body rendered from the draft’s fields, not from anything the model wrote', async () => {
    const { createPipenzoIssue } = installBridge();
    const onCreated = vi.fn();
    open({ onCreated });
    fireEvent.change(screen.getByLabelText(/what’s the problem/i), {
      target: { value: 'tray badge' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Draft issue' }));
    await screen.findByText(DRAFT.title);

    fireEvent.click(screen.getByRole('button', { name: 'Create issue' }));
    await waitFor(() => expect(createPipenzoIssue).toHaveBeenCalled());
    expect(createPipenzoIssue).toHaveBeenCalledWith({
      repo: 'jortega0033/agentdock',
      title: DRAFT.title,
      body: renderDraftedIssueBody(DRAFT),
    });
    expect(onCreated).toHaveBeenCalledWith({
      issueNumber: 901,
      htmlUrl: 'https://github.com/jortega0033/agentdock/issues/901',
    });
  });

  /**
   * Keep chatting is not Cancel. An operator who disagrees with a draft wants to edit the idea and
   * try again, and throwing away what they typed makes that worse.
   */
  it('Keep chatting returns to the idea with the words still there, creating nothing', async () => {
    const { createPipenzoIssue } = installBridge();
    open();
    fireEvent.change(screen.getByLabelText(/what’s the problem/i), {
      target: { value: 'tray badge' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Draft issue' }));
    await screen.findByText(DRAFT.title);

    fireEvent.click(screen.getByRole('button', { name: 'Keep chatting' }));
    expect(screen.queryByText(DRAFT.title)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/what’s the problem/i)).toHaveValue('tray badge');
    expect(screen.getByRole('button', { name: 'Draft issue' })).toBeInTheDocument();
    expect(createPipenzoIssue).not.toHaveBeenCalled();
  });

  it('surfaces a drafting failure instead of showing a preview', async () => {
    installBridge({ draftPipenzoIssue: vi.fn().mockRejectedValue(new Error('provider offline')) });
    open();
    fireEvent.change(screen.getByLabelText(/what’s the problem/i), {
      target: { value: 'tray badge' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Draft issue' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('provider offline');
    expect(screen.queryByRole('button', { name: 'Create issue' })).not.toBeInTheDocument();
  });

  it('carries the provenance help text the canvas puts under the draft', async () => {
    installBridge();
    open();
    fireEvent.change(screen.getByLabelText(/what’s the problem/i), {
      target: { value: 'tray badge' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Draft issue' }));
    await screen.findByText(DRAFT.title);
    expect(screen.getByText(/style pass over prose only/i)).toBeInTheDocument();
    expect(screen.getByText(/rendered from data and never rewritten/i)).toBeInTheDocument();
  });
});

describe('renderDraftSummary', () => {
  it('reads acceptance, then out of scope, then the estimate — the decision order', () => {
    const summary = renderDraftSummary(DRAFT);
    expect(summary).toContain('Acceptance: When a ticket reaches ready-for-review');
    expect(summary).toContain('Out of scope: sounds, per-repo settings.');
    expect(summary).toContain('Est. ≤ 40 lines across 1 file.');
  });
});

describe('renderDraftedIssueBody', () => {
  it('lays out every field, with the criterion ids and kinds intact', () => {
    const body = renderDraftedIssueBody(DRAFT);
    expect(body).toContain('## Acceptance criteria');
    expect(body).toContain('- **AC-1** (event) When a ticket reaches ready-for-review');
    expect(body).toContain('## Out of scope');
    expect(body).toContain('- sounds');
    expect(body).toContain('- 40 changed lines across 1 files');
    expect(body).toContain('Splits into 2-4 dependency-ordered pull requests: no');
  });

  /**
   * A reader of a filed issue has to be able to tell "the drafter had no open questions" from
   * "this tool does not record open questions". A heading that vanishes when empty destroys that.
   */
  it('keeps the open-questions heading and says none were recorded', () => {
    expect(renderDraftedIssueBody(DRAFT)).toContain('## Open questions\n\nNone recorded.');
  });

  it('records that a model drafted it and a human filed it', () => {
    expect(renderDraftedIssueBody(DRAFT)).toContain('filed by a human');
  });
});
