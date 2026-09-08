import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RefusalPanel } from '../../src/pipenzo/RefusalPanel.js';

const REPO = 'jortega0033/pipenzo';
const ISSUE_NUMBER = 113;

describe('RefusalPanel', () => {
  it('renders the declined title, the pipenzo:needs-pre-scoping sub, and the finished chip', () => {
    render(
      <RefusalPanel
        repo={REPO}
        issueNumber={ISSUE_NUMBER}
        estimate={{ changedLines: 1750, filesTouched: 31, layered: false }}
      />,
    );
    expect(screen.getByText('Declined at Refine — needs pre-scoping')).toBeInTheDocument();
    expect(screen.getByText('pipenzo:needs-pre-scoping')).toBeInTheDocument();
    expect(screen.getByText('finished')).toBeInTheDocument();
  });

  it('never invents a "posted as a comment" or OS-notification clause -- no timestamp data exists for either', () => {
    render(
      <RefusalPanel
        repo={REPO}
        issueNumber={ISSUE_NUMBER}
        estimate={{ changedLines: 1750, filesTouched: 31, layered: false }}
      />,
    );
    expect(screen.queryByText(/posted as a comment/)).not.toBeInTheDocument();
    expect(screen.queryByText(/OS notification/)).not.toBeInTheDocument();
  });

  it('renders the estimate cell with the changed-line count and file count', () => {
    render(
      <RefusalPanel
        repo={REPO}
        issueNumber={ISSUE_NUMBER}
        estimate={{ changedLines: 1750, filesTouched: 31, layered: false }}
      />,
    );
    expect(screen.getByText('1,750 lines')).toBeInTheDocument();
    expect(screen.getByText('31 files · no clean layering')).toBeInTheDocument();
  });

  it('renders the static one-PR budget cell -- a product constant, not per-ticket data', () => {
    render(
      <RefusalPanel
        repo={REPO}
        issueNumber={ISSUE_NUMBER}
        estimate={{ changedLines: 1750, filesTouched: 31, layered: false }}
      />,
    );
    expect(screen.getByText('≤ 100 · ≤ 10')).toBeInTheDocument();
    expect(screen.getByText(/Stacks cover 100–400, layered/)).toBeInTheDocument();
  });

  describe('what tripped the gate', () => {
    it('names the ceiling when past 400 lines or 20 files', () => {
      render(
        <RefusalPanel
          repo={REPO}
          issueNumber={ISSUE_NUMBER}
          estimate={{ changedLines: 1750, filesTouched: 31, layered: false }}
        />,
      );
      expect(screen.getByText('> 400 changed lines')).toBeInTheDocument();
      expect(screen.getByText(/also > 20 files/)).toBeInTheDocument();
    });

    it('names the layering reason inside the 100-400/10-20 band', () => {
      render(
        <RefusalPanel
          repo={REPO}
          issueNumber={ISSUE_NUMBER}
          estimate={{ changedLines: 250, filesTouched: 15, layered: false }}
        />,
      );
      expect(screen.getByText('no clean layering')).toBeInTheDocument();
    });

    /**
     * Regression: an earlier version of this component always named the *lines* ceiling in both
     * headline and detail, even when only the file count actually tripped it -- a files-only
     * overrun (lines well within budget) must not claim the lines ceiling was breached.
     */
    it('names the files ceiling, not the lines ceiling, for a files-only overrun', () => {
      render(
        <RefusalPanel
          repo={REPO}
          issueNumber={ISSUE_NUMBER}
          estimate={{ changedLines: 50, filesTouched: 21, layered: true }}
        />,
      );
      expect(screen.getByText('> 20 files')).toBeInTheDocument();
      expect(screen.queryByText(/> 400 changed lines/)).not.toBeInTheDocument();
      expect(screen.getByText(/50 lines · 21 files/)).toBeInTheDocument();
    });
  });

  it('links "Open on GitHub" to the real issue, as a plain external anchor', () => {
    render(
      <RefusalPanel
        repo={REPO}
        issueNumber={ISSUE_NUMBER}
        estimate={{ changedLines: 1750, filesTouched: 31, layered: false }}
      />,
    );
    const link = screen.getByRole('link', { name: 'Open on GitHub' });
    expect(link).toHaveAttribute('href', 'https://github.com/jortega0033/pipenzo/issues/113');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    // Matches the canvas's own leading icon on this button -- the same one DeviceCodeStep.tsx
    // already uses for its "opens in your browser" GitHub link.
    expect(link.querySelector('svg')).toBeInTheDocument();
  });

  describe('the proposed split', () => {
    it('renders nothing when no split was given -- #271 does not exist yet', () => {
      const { container } = render(
        <RefusalPanel
          repo={REPO}
          issueNumber={ISSUE_NUMBER}
          estimate={{ changedLines: 1750, filesTouched: 31, layered: false }}
        />,
      );
      expect(container.querySelector('.split')).not.toBeInTheDocument();
    });

    it('renders every row, numbered, when a split is given', () => {
      render(
        <RefusalPanel
          repo={REPO}
          issueNumber={ISSUE_NUMBER}
          estimate={{ changedLines: 1750, filesTouched: 31, layered: false }}
          proposedSplit={[
            { summary: 'Introduce a storage interface', changedLines: 90, filesTouched: 4 },
            { summary: 'Adapter behind that interface', changedLines: 320, filesTouched: 6 },
          ]}
        />,
      );
      expect(screen.getByText(/Proposed split · 2 tickets, in this order/)).toBeInTheDocument();
      expect(screen.getByText('Introduce a storage interface')).toBeInTheDocument();
      expect(screen.getByText('≈ 90 lines · 4 files')).toBeInTheDocument();
      expect(screen.getByText('Adapter behind that interface')).toBeInTheDocument();
    });

    it('uses the singular "ticket" for a one-row split', () => {
      render(
        <RefusalPanel
          repo={REPO}
          issueNumber={ISSUE_NUMBER}
          estimate={{ changedLines: 1750, filesTouched: 31, layered: false }}
          proposedSplit={[{ summary: 'One piece', changedLines: 90, filesTouched: 4 }]}
        />,
      );
      expect(screen.getByText(/Proposed split · 1 ticket, in this order/)).toBeInTheDocument();
    });
  });

  describe('retry refine', () => {
    it('renders no retry action or its help line when onRetryRefine is not supplied', () => {
      render(
        <RefusalPanel
          repo={REPO}
          issueNumber={ISSUE_NUMBER}
          estimate={{ changedLines: 1750, filesTouched: 31, layered: false }}
        />,
      );
      expect(screen.queryByRole('button', { name: 'Retry refine' })).not.toBeInTheDocument();
      expect(screen.queryByText(/Retry only runs when you click it/)).not.toBeInTheDocument();
    });

    it('renders the retry action and its manual-only disclaimer, and calls back on click', () => {
      const onRetryRefine = vi.fn();
      render(
        <RefusalPanel
          repo={REPO}
          issueNumber={ISSUE_NUMBER}
          estimate={{ changedLines: 1750, filesTouched: 31, layered: false }}
          onRetryRefine={onRetryRefine}
        />,
      );
      const button = screen.getByRole('button', { name: 'Retry refine' });
      expect(screen.getByText(/It is never automatic/)).toBeInTheDocument();
      fireEvent.click(button);
      expect(onRetryRefine).toHaveBeenCalledTimes(1);
    });
  });
});
