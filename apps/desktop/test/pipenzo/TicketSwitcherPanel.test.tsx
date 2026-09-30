import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PipenzoPhaseEventV1,
  PipenzoTicketListV1,
  PipenzoTicketViewV1,
} from '@agent-dock/shared';
import type { DaemonStatus } from '../../src/window.js';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { LessonPrompt } from '../../src/pipenzo/LessonPrompt.js';
import { TicketSwitcherPanel } from '../../src/pipenzo/TicketSwitcherPanel.js';

afterEach(() => {
  clearBridgeOverride();
});

function ticket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: '00000000-0000-4000-8000-000000000001',
    repo: 'jortega0033/pipenzo',
    issueNumber: 94,
    lane: 'needs-human',
    phase: 'implement',
    labels: ['pipenzo:needs-human'],
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

function installBridge(listTickets: () => Promise<PipenzoTicketListV1>) {
  setBridgeOverride({
    pipenzoListTickets: listTickets,
    onDaemonStatus: (_callback: (status: DaemonStatus) => void) => vi.fn(),
    onPipenzoPhaseEvent: (_callback: (event: PipenzoPhaseEventV1) => void) => vi.fn(),
  } as never);
}

const TICKET_94 = ticket({ ticketId: 'ticket-94', issueNumber: 94, lane: 'needs-human' });
const TICKET_98 = ticket({ ticketId: 'ticket-98', issueNumber: 98, lane: 'needs-human' });
const TICKET_108 = ticket({ ticketId: 'ticket-108', issueNumber: 108, lane: 'needs-human' });
const WORKING_TICKET = ticket({ ticketId: 'ticket-70', issueNumber: 70, lane: 'working' });

describe('TicketSwitcherPanel', () => {
  it('shows a loading placeholder before the board answers', async () => {
    installBridge(() => new Promise(() => {}));
    render(<TicketSwitcherPanel activeTicketId="ticket-94" onSwitch={vi.fn()} />);

    expect(screen.getByTestId('ticket-switcher-loading')).toBeInTheDocument();
    expect(screen.getByText('Needs you')).toBeInTheDocument();
  });

  it('renders nothing once the daemon refuses the read -- there is nothing real to switch to', async () => {
    installBridge(vi.fn().mockRejectedValue(new Error('daemon is not ready yet')));
    const { container } = render(
      <TicketSwitcherPanel activeTicketId="ticket-94" onSwitch={vi.fn()} />,
    );

    await waitFor(() => expect(screen.queryByTestId('ticket-switcher-loading')).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the needs-human lane is genuinely empty', async () => {
    installBridge(vi.fn().mockResolvedValue({ tickets: [WORKING_TICKET] }));
    const { container } = render(
      <TicketSwitcherPanel activeTicketId="ticket-94" onSwitch={vi.fn()} />,
    );

    await waitFor(() => expect(screen.queryByTestId('ticket-switcher-loading')).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });

  it('lists only tickets genuinely in the needs-human lane, never a queued/working/ready ticket', async () => {
    installBridge(
      vi.fn().mockResolvedValue({ tickets: [TICKET_94, WORKING_TICKET, TICKET_98] }),
    );
    render(<TicketSwitcherPanel activeTicketId="ticket-94" onSwitch={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('group', { name: 'Needs you' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '#94' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '#98' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '#70' })).not.toBeInTheDocument();
  });

  it('highlights the active ticket and marks the rest inactive', async () => {
    installBridge(vi.fn().mockResolvedValue({ tickets: [TICKET_94, TICKET_98] }));
    render(<TicketSwitcherPanel activeTicketId="ticket-98" onSwitch={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '#98' })).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(screen.getByRole('button', { name: '#94' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the clicked ticket id through onSwitch, in the order the board lists them', async () => {
    installBridge(vi.fn().mockResolvedValue({ tickets: [TICKET_94, TICKET_98, TICKET_108] }));
    const onSwitch = vi.fn();
    render(<TicketSwitcherPanel activeTicketId="ticket-94" onSwitch={onSwitch} />);

    await waitFor(() => expect(screen.getByRole('button', { name: '#98' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '#98' }));
    expect(onSwitch).toHaveBeenLastCalledWith('ticket-98');

    fireEvent.click(screen.getByRole('button', { name: '#108' }));
    expect(onSwitch).toHaveBeenLastCalledWith('ticket-108');

    fireEvent.click(screen.getByRole('button', { name: '#94' }));
    expect(onSwitch).toHaveBeenLastCalledWith('ticket-94');

    expect(onSwitch).toHaveBeenCalledTimes(3);
  });
});

/**
 * The reset guarantee issue #92 actually asks for: switching tickets through this control must
 * reset per-ticket interaction state in whatever the caller renders below it, not just change which
 * ticket id is passed around. `TicketSwitcherPanel` itself owns no such state (see its own doc
 * comment) -- the caller does, by keying the ticket-scoped subtree it renders by `activeTicketId`.
 *
 * This harness is that composition, built from a real stateful component already in this codebase
 * (`LessonPrompt.tsx`, whose own doc comment calls for exactly this: "a fresh resolution is a fresh
 * mount, keyed by whatever identifies that resolution at the call site"), not a fake test double --
 * proving the pattern this panel's doc comment recommends genuinely resets real interaction state,
 * such as an in-progress draft, rather than merely asserting a prop changed.
 */
function TicketDetailHarness() {
  const [activeTicketId, setActiveTicketId] = useState('ticket-94');
  const ticketsById: Record<string, PipenzoTicketViewV1> = {
    'ticket-94': TICKET_94,
    'ticket-98': TICKET_98,
  };
  const active = ticketsById[activeTicketId]!;

  return (
    <>
      <TicketSwitcherPanel activeTicketId={activeTicketId} onSwitch={setActiveTicketId} />
      <LessonPrompt
        key={activeTicketId}
        repo={active.repo}
        issueNumber={active.issueNumber}
        prefill=""
      />
    </>
  );
}

describe('TicketSwitcherPanel composed with a keyed ticket-scoped subtree', () => {
  it('resets a real per-ticket draft when the switch moves to a different ticket', async () => {
    installBridge(vi.fn().mockResolvedValue({ tickets: [TICKET_94, TICKET_98] }));
    render(<TicketDetailHarness />);

    await waitFor(() => expect(screen.getByRole('button', { name: '#98' })).toBeInTheDocument());

    // A human starts drafting a lesson on ticket #94 -- genuine per-ticket interaction state, never
    // saved yet.
    const draft = screen.getByLabelText('Lesson text');
    fireEvent.change(draft, { target: { value: 'ticket #94 draft, unsaved' } });
    expect(screen.getByLabelText('Lesson text')).toHaveValue('ticket #94 draft, unsaved');

    // Switching to #98 through the real control remounts the keyed subtree below it.
    fireEvent.click(screen.getByRole('button', { name: '#98' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '#98' })).toHaveAttribute('aria-pressed', 'true'),
    );
    // #94's draft is gone, not carried over onto #98 -- a fresh mount, not the same input reused.
    expect(screen.getByLabelText('Lesson text')).toHaveValue('');

    // And switching back to #94 does not resurrect the old draft either -- it really was reset, not
    // preserved off-screen.
    fireEvent.click(screen.getByRole('button', { name: '#94' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '#94' })).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(screen.getByLabelText('Lesson text')).toHaveValue('');
  });
});
