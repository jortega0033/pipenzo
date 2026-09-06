import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Conflict } from '../../src/components/primitives/Conflict.js';

describe('Conflict', () => {
  it('renders merge-conflict with named files and hunk counts', () => {
    const { container } = render(
      <Conflict
        icon="git-branch"
        head="Conflicts with main · PR #121"
        files={[
          { path: 'ticket-orchestrator.ts', hunks: '2 hunks' },
          { path: 'worktree-manager.ts', hunks: '1 hunk' },
        ]}
      >
        <b>Nothing failed and no commit is lost.</b> #105 landed on main while this branch sat at
        the push gate.
      </Conflict>,
    );
    expect(container.querySelector('.conflict-head')).toBeInTheDocument();
    expect(screen.getByText('Conflicts with main · PR #121')).toBeInTheDocument();
    const files = container.querySelectorAll('.conflict-file');
    expect(files).toHaveLength(2);
    expect(screen.getByText('ticket-orchestrator.ts')).toBeInTheDocument();
    expect(screen.getByText('2 hunks')).toBeInTheDocument();
    expect(screen.getByText('Nothing failed and no commit is lost.')).toBeInTheDocument();
  });

  it('renders claim conflict with no files section, one family with merge-conflict', () => {
    const { container } = render(
      <Conflict icon="user" head="claimed by @someone-else">
        <b>Nothing here is yours to resolve.</b> The uncached re-check immediately before dispatch
        found the issue already assigned.
      </Conflict>,
    );
    expect(container.querySelector('.conflict-files')).not.toBeInTheDocument();
    expect(screen.getByText('claimed by @someone-else')).toBeInTheDocument();
  });
});
