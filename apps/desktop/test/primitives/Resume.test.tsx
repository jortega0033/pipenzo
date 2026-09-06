import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Resume } from '../../src/components/primitives/Resume.js';

const kv = [
  { k: 'last phase', v: 'Refine — spec approved, 2 criteria, 1 file in scope' },
  { k: 'worktree', v: '.worktrees/issue-92 · branch issue-92 · dirty' },
  { k: 'session', v: 'providerSessionId and continuationScope both present' },
];

describe('Resume', () => {
  it('renders the head, kv rows and why paragraph, with Resume enabled', () => {
    render(
      <Resume head="Daemon restarted mid-implement" kv={kv} canResume>
        <b>Nothing was resumed on its own.</b> A MEDIUM or HIGH action can be mid-approval.
      </Resume>,
    );
    expect(screen.getByText('Daemon restarted mid-implement')).toBeInTheDocument();
    expect(screen.getByText('last phase')).toBeInTheDocument();
    expect(
      screen.getByText('Refine — spec approved, 2 criteria, 1 file in scope'),
    ).toBeInTheDocument();
    expect(screen.getByText('Nothing was resumed on its own.')).toBeInTheDocument();

    const resumeBtn = screen.getByRole('button', { name: /Resume/ });
    expect(resumeBtn).not.toBeDisabled();
  });

  it('disables Resume and sets its title when canResume is false', () => {
    render(
      <Resume
        head="Daemon restarted mid-implement"
        kv={kv}
        canResume={false}
        resumeDisabledReason="No continuationScope — the provider thread cannot be continued"
      >
        <b>Resume is not offered here.</b>
      </Resume>,
    );
    const resumeBtn = screen.getByRole('button', { name: /Resume/ });
    expect(resumeBtn).toBeDisabled();
    expect(resumeBtn).toHaveAttribute(
      'title',
      'No continuationScope — the provider thread cannot be continued',
    );
  });

  it('always keeps Discard and restart enabled and calls onDiscard/onResume', () => {
    const onResume = vi.fn();
    const onDiscard = vi.fn();
    render(
      <Resume
        head="Daemon restarted mid-implement"
        kv={kv}
        canResume
        onResume={onResume}
        onDiscard={onDiscard}
      >
        why
      </Resume>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    fireEvent.click(screen.getByRole('button', { name: /Discard and restart/ }));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('renders one resume-kv row pair per entry', () => {
    const { container } = render(
      <Resume head="head" kv={kv} canResume>
        why
      </Resume>,
    );
    const kvEl = container.querySelector('.resume-kv')!;
    expect(kvEl.querySelectorAll('b')).toHaveLength(3);
    expect(kvEl.querySelectorAll('span')).toHaveLength(3);
  });
});
