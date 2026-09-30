import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { ActivityFilterBar } from '../../src/pipenzo/ActivityFilterBar.js';

const REPO = 'jortega0033/pipenzo';

function makeTicket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: '00000000-0000-4000-8000-000000000001',
    repo: REPO,
    issueNumber: 1,
    lane: 'queued',
    phase: 'refine',
    labels: ['pipenzo:queued'],
    estimate: { lines: 0, files: 0, layered: false },
    taskType: 'chore',
    stack: { parentId: null, childIds: [], index: null },
    attempts: [],
    budget: { tokensUsed: 0, limit: 0 },
    risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
    precommits: [],
    etags: {},
    ...overrides,
  };
}

describe('ActivityFilterBar', () => {
  it('renders all five tabs with a real N/total count next to each label', () => {
    const tickets = [
      makeTicket({ ticketId: 'merged', lane: 'ready-for-review', labels: [] }),
      makeTicket({ ticketId: 'queued', lane: 'queued' }),
    ];
    render(<ActivityFilterBar tickets={tickets} active="all" onChange={() => {}} />);

    expect(screen.getByRole('button', { name: 'All 2/2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publishes 1/2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gates 1/2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Risk 0/2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Worktrees 0/2' })).toBeInTheDocument();
  });

  it('marks the active tab pressed, from a real prop, not internal state', () => {
    render(<ActivityFilterBar tickets={[]} active="risk" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Risk 0/0' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All 0/0' })).toHaveAttribute('aria-pressed', 'false');
  });

  it("reports a click on a different tab via onChange, with that tab's own key", () => {
    const onChange = vi.fn();
    const tickets = [makeTicket({ ticketId: 'a', lane: 'ready-for-review', labels: [] })];
    render(<ActivityFilterBar tickets={tickets} active="all" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Publishes 1/1' }));
    expect(onChange).toHaveBeenCalledWith('publish');
  });

  it('counts against an empty ticket list as 0/0 everywhere, never NaN or a crash', () => {
    render(<ActivityFilterBar tickets={[]} active="all" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'All 0/0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Worktrees 0/0' })).toBeInTheDocument();
  });
});
