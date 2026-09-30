import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PipenzoTicketViewV1 } from '@agent-dock/shared';
import { ActivityRow } from '../../src/pipenzo/ActivityRow.js';

const REPO = 'jortega0033/pipenzo';

function makeTicket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: '00000000-0000-4000-8000-000000000001',
    repo: REPO,
    issueNumber: 94,
    title: 'Sanitize environment for MCP stdio server subprocesses',
    lane: 'needs-human',
    phase: 'implement',
    labels: ['pipenzo:ci-failed'],
    estimate: { lines: 0, files: 0, layered: false },
    taskType: 'chore',
    stack: { parentId: null, childIds: [], index: null },
    attempts: [{ sessionId: 's1', tier: 'mid', model: 'sonnet', outcome: 'typecheck failed' }],
    budget: { tokensUsed: 0, limit: 0 },
    risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
    precommits: [],
    etags: {},
    ...overrides,
  };
}

describe('ActivityRow', () => {
  it('renders the time, id, title, and state chip on the head line', () => {
    render(
      <ActivityRow entry={{ ticket: makeTicket(), timestamp: new Date('2026-09-06T14:12:00.000Z') }} />,
    );
    expect(screen.getByText('#94')).toBeInTheDocument();
    expect(
      screen.getByText('Sanitize environment for MCP stdio server subprocesses'),
    ).toBeInTheDocument();
    expect(screen.getByText('pipenzo:ci-failed')).toBeInTheDocument();
  });

  it('renders a real, non-placeholder detail paragraph and mono meta line', () => {
    render(<ActivityRow entry={{ ticket: makeTicket() }} />);
    expect(
      screen.getByText(/A fix attempt has been recorded \(mid tier, outcome "typecheck failed"\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 attempt · last mid · sonnet/)).toBeInTheDocument();
  });

  it('falls back to Issue #N when the ticket has no cached title', () => {
    render(<ActivityRow entry={{ ticket: makeTicket({ title: undefined, issueNumber: 200 }) }} />);
    expect(screen.getByText('Issue #200')).toBeInTheDocument();
  });

  it("renders '—' for a row with no recorded timestamp, never a fabricated time", () => {
    render(<ActivityRow entry={{ ticket: makeTicket() }} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('applies the bad tone icon class for a ci-failed ticket', () => {
    const { container } = render(<ActivityRow entry={{ ticket: makeTicket() }} />);
    expect(container.querySelector('.act-ic.bad')).toBeInTheDocument();
  });

  it('applies the ok tone icon class for a merged (label-less) ticket', () => {
    const { container } = render(
      <ActivityRow entry={{ ticket: makeTicket({ lane: 'ready-for-review', labels: [] }) }} />,
    );
    expect(container.querySelector('.act-ic.ok')).toBeInTheDocument();
    expect(screen.getByText('merged')).toBeInTheDocument();
  });

  it('applies no tone suffix for a neutral-toned ticket (a plain queued row)', () => {
    const { container } = render(
      <ActivityRow
        entry={{ ticket: makeTicket({ lane: 'queued', phase: 'refine', labels: ['pipenzo:queued'] }) }}
      />,
    );
    const icon = container.querySelector('.act-ic')!;
    expect(icon.className).toBe('act-ic');
  });

  it('is not interactive when no onOpenTicket is supplied', () => {
    const { container } = render(<ActivityRow entry={{ ticket: makeTicket() }} />);
    const row = container.querySelector('.act')!;
    expect(row).not.toHaveAttribute('role');
  });

  it('fires onOpenTicket with the exact ticket on click', () => {
    const onOpenTicket = vi.fn();
    const ticket = makeTicket();
    const { container } = render(<ActivityRow entry={{ ticket }} onOpenTicket={onOpenTicket} />);

    fireEvent.click(container.querySelector('.act')!);
    expect(onOpenTicket).toHaveBeenCalledTimes(1);
    expect(onOpenTicket).toHaveBeenCalledWith(ticket);
  });

  it('fires onOpenTicket on Enter and Space when the row is focused, per the Card.tsx keyboard convention', () => {
    const onOpenTicket = vi.fn();
    const ticket = makeTicket();
    const { container } = render(<ActivityRow entry={{ ticket }} onOpenTicket={onOpenTicket} />);
    const row = container.querySelector('.act')!;

    expect(row).toHaveAttribute('role', 'button');
    expect(row).toHaveAttribute('tabIndex', '0');

    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onOpenTicket).toHaveBeenCalledTimes(2);
    expect(onOpenTicket).toHaveBeenNthCalledWith(1, ticket);
    expect(onOpenTicket).toHaveBeenNthCalledWith(2, ticket);
  });

  it('does not fire onOpenTicket for an unrelated key press', () => {
    const onOpenTicket = vi.fn();
    const { container } = render(
      <ActivityRow entry={{ ticket: makeTicket() }} onOpenTicket={onOpenTicket} />,
    );
    fireEvent.keyDown(container.querySelector('.act')!, { key: 'Tab' });
    expect(onOpenTicket).not.toHaveBeenCalled();
  });
});
