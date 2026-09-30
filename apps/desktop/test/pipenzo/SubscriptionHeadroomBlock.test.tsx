import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PipenzoTicketAttemptV1, PipenzoTicketBudgetV1 } from '@agent-dock/shared';
import { SubscriptionHeadroomBlock } from '../../src/pipenzo/SubscriptionHeadroomBlock.js';

const ATTEMPT = (n: number): PipenzoTicketAttemptV1 => ({
  sessionId: `implement-session-${n}`,
  tier: 'mid',
  model: 'sonnet',
  outcome: 'running',
});

describe('SubscriptionHeadroomBlock', () => {
  it('renders inside a RailBlock labelled "Subscription headroom" with the estimate self-tag', () => {
    const budget: PipenzoTicketBudgetV1 = { tokensUsed: 0, limit: 0 };
    const { container } = render(<SubscriptionHeadroomBlock attempts={[]} budget={budget} />);
    const block = container.querySelector('.rail-block')!;
    expect(block.querySelector('.label')).toHaveTextContent('Subscription headroom');
    expect(block.querySelector('.label .self-tag')).toHaveTextContent('estimate');
  });

  it('renders real sessions and tokens-used rows from the ticket budget', () => {
    const budget: PipenzoTicketBudgetV1 = { tokensUsed: 412_000, limit: 0 };
    const { container } = render(
      <SubscriptionHeadroomBlock attempts={[ATTEMPT(1), ATTEMPT(2)]} budget={budget} />,
    );
    const rows = Array.from(container.querySelectorAll('.kv'));
    expect(rows[0]?.querySelector('.k')).toHaveTextContent('Sessions');
    expect(rows[0]?.querySelector('.v')).toHaveTextContent('2');
    expect(rows[1]?.querySelector('.k')).toHaveTextContent('Tokens used');
    expect(rows[1]?.querySelector('.v')).toHaveTextContent('~412k');
  });

  it('renders the Est. remaining row only when an estimate is computable', () => {
    const budget: PipenzoTicketBudgetV1 = { tokensUsed: 40_000, limit: 200_000 };
    const { container } = render(
      <SubscriptionHeadroomBlock attempts={[ATTEMPT(1), ATTEMPT(2)]} budget={budget} />,
    );
    const rows = Array.from(container.querySelectorAll('.kv'));
    expect(rows).toHaveLength(3);
    expect(rows[2]?.querySelector('.k')).toHaveTextContent('Est. remaining');
    expect(rows[2]?.querySelector('.v')).toHaveTextContent('~8 sessions remaining');
  });

  it('omits the Est. remaining row when no limit is configured', () => {
    const budget: PipenzoTicketBudgetV1 = { tokensUsed: 40_000, limit: 0 };
    const { container } = render(
      <SubscriptionHeadroomBlock attempts={[ATTEMPT(1)]} budget={budget} />,
    );
    expect(container.querySelectorAll('.kv')).toHaveLength(2);
    expect(screen.queryByText('Est. remaining')).not.toBeInTheDocument();
  });

  it('always renders the honest no-quota line', () => {
    const budget: PipenzoTicketBudgetV1 = { tokensUsed: 0, limit: 0 };
    render(<SubscriptionHeadroomBlock attempts={[]} budget={budget} />);
    expect(
      screen.getByText(
        "Counted locally from this app's own runs — no provider reports a quota, so there is no percentage and no reset to show.",
      ),
    ).toBeInTheDocument();
  });
});
