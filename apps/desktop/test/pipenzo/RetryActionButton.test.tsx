import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoTicketApprovalRejectionV1, PipenzoTicketAttemptV1, PipenzoTicketViewV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { RetryActionButton } from '../../src/pipenzo/RetryActionButton.js';

/**
 * Issue #105, CLAUDE.md hard rule 4's renderer-side half: `RetryActionButton` must render nothing
 * at all -- never a disabled button -- for every one of the three states a retry does not apply to
 * (not parked, a denied approval on file, already at the max-retries threshold), the same
 * "no absent state" rule `RunControlsPanel`'s own doc comment already establishes for live run
 * controls. The daemon re-checks every one of these itself; this suite only proves the button does
 * not even offer the choice.
 */
const TICKET_ID = '00000000-0000-4000-8000-000000000001';

function attempt(overrides: Partial<PipenzoTicketAttemptV1> = {}): PipenzoTicketAttemptV1 {
  return { sessionId: 's-1', tier: 'mid', model: 'claude-sonnet', outcome: 'dispatched', ...overrides };
}

function rejection(
  overrides: Partial<PipenzoTicketApprovalRejectionV1> = {},
): PipenzoTicketApprovalRejectionV1 {
  return { kind: 'high', reason: 'not ready', decidedAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

function makeTicket(overrides: Partial<PipenzoTicketViewV1> = {}): PipenzoTicketViewV1 {
  return {
    schemaVersion: 1,
    ticketId: TICKET_ID,
    repo: 'jortega0033/pipenzo',
    issueNumber: 105,
    lane: 'needs-human',
    phase: 'implement',
    labels: ['pipenzo:needs-human'],
    estimate: { lines: 0, files: 0, layered: false },
    taskType: 'feature',
    stack: { parentId: null, childIds: [], index: null },
    attempts: [attempt()],
    budget: { tokensUsed: 0, limit: 0 },
    risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
    precommits: [],
    etags: {},
    ...overrides,
  };
}

function installBridge(retryPipenzo = vi.fn().mockResolvedValue({ sessionId: 's-2', mode: 'fresh', tier: 'frontier' })) {
  setBridgeOverride({ retryPipenzo } as never);
  return retryPipenzo;
}

afterEach(() => {
  clearBridgeOverride();
});

describe('RetryActionButton (issue #105, CLAUDE.md hard rule 4)', () => {
  it('renders the header action for a ticket parked on pipenzo:needs-human with one failed attempt', () => {
    installBridge();
    render(<RetryActionButton ticket={makeTicket()} />);
    expect(screen.getByText('Retry phase')).toBeInTheDocument();
  });

  it('renders nothing for a ticket that is not parked on pipenzo:needs-human', () => {
    installBridge();
    const { container } = render(
      <RetryActionButton ticket={makeTicket({ lane: 'working', labels: ['pipenzo:working'] })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a ticket with no dispatched attempts', () => {
    installBridge();
    const { container } = render(<RetryActionButton ticket={makeTicket({ attempts: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing -- never a disabled button -- when the ticket’s last approval was rejected', () => {
    installBridge();
    const { container } = render(
      <RetryActionButton ticket={makeTicket({ lastApprovalRejection: rejection() })} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Retry phase')).not.toBeInTheDocument();
  });

  it('renders nothing once the ticket has reached the max-retries threshold', () => {
    installBridge();
    const { container } = render(
      <RetryActionButton
        ticket={makeTicket({
          attempts: [attempt(), attempt({ sessionId: 's-2' }), attempt({ sessionId: 's-3' })],
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('dispatches a retry through the bridge, addressed by ticket id, when clicked', async () => {
    const retryPipenzo = installBridge();
    render(<RetryActionButton ticket={makeTicket()} />);

    screen.getByText('Retry phase').click();

    await waitFor(() => expect(retryPipenzo).toHaveBeenCalledWith({ ticketId: TICKET_ID }));
  });

  it('shows the daemon’s own refusal message rather than assuming success', async () => {
    const retryPipenzo = vi.fn().mockRejectedValue(new Error('this ticket has already made its maximum number of retry attempts'));
    installBridge(retryPipenzo);
    render(<RetryActionButton ticket={makeTicket()} />);

    screen.getByText('Retry phase').click();

    await waitFor(() =>
      expect(
        screen.getByText('this ticket has already made its maximum number of retry attempts'),
      ).toBeInTheDocument(),
    );
  });
});
