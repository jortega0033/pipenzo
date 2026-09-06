import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunControls } from '../../src/components/primitives/RunControls.js';

describe('RunControls', () => {
  it('renders the live state with a pulsing dot, phase/meta text and Steer/Stop actions', () => {
    const onSteer = vi.fn();
    const onStop = vi.fn();
    const { container } = render(
      <RunControls
        state="live"
        phaseLabel="Implement is running"
        meta="sonnet · 4m 12s · 2 commits on issue-94, nothing pushed"
        onSteer={onSteer}
        onStop={onStop}
      />,
    );
    expect(container.querySelector('.run-dot')).toBeInTheDocument();
    expect(screen.getByText('Implement is running')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Steer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onSteer).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('renders the steer panel, sending the typed instruction', () => {
    const onCancel = vi.fn();
    const onSend = vi.fn();
    render(<RunControls state="steer" onCancel={onCancel} onSend={onSend} />);
    const textarea = screen.getByPlaceholderText('e.g. leave the legacy fixture alone for now');
    fireEvent.change(textarea, { target: { value: 'leave the legacy fixture alone for now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('leave the legacy fixture alone for now');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('starts the steer panel from a default value', () => {
    render(
      <RunControls
        state="steer"
        defaultValue="keep it until #97 lands"
        onCancel={vi.fn()}
        onSend={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue('keep it until #97 lands')).toBeInTheDocument();
  });

  it('renders the stop-confirm panel naming the commit count, branch and worktree', () => {
    const onKeepRunning = vi.fn();
    const onStop = vi.fn();
    render(
      <RunControls
        state="stop-confirm"
        commitCount={2}
        branch="issue-94"
        worktreePath=".worktrees/issue-94"
        onKeepRunning={onKeepRunning}
        onStop={onStop}
      />,
    );
    expect(screen.getByText('Stop this run?')).toBeInTheDocument();
    expect(screen.getByText('Stop preserves commits.')).toBeInTheDocument();
    expect(screen.getByText('issue-94')).toBeInTheDocument();
    expect(screen.getByText('.worktrees/issue-94')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop and keep commits' }));
    expect(onKeepRunning).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('renders the stopped state with no action buttons', () => {
    const { container } = render(
      <RunControls
        state="stopped"
        time="14:11"
        commitCount={2}
        branch="issue-94"
        worktreePath=".worktrees/issue-94"
        label="pipenzo:needs-human"
      />,
    );
    expect(screen.getByText(/Stopped at 14:11/)).toBeInTheDocument();
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
