import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LlmReviewPassV1, PipenzoTicketAttemptV1, VerifierPassV1 } from '@agent-dock/shared';
import { ModelRoutingBlock } from '../../src/pipenzo/ModelRoutingBlock.js';

const IMPLEMENT_ATTEMPT: PipenzoTicketAttemptV1 = {
  sessionId: 'implement-session',
  tier: 'mid',
  model: 'sonnet',
  outcome: 'running',
};

const REVIEWER: LlmReviewPassV1 = {
  sessionId: 'reviewer-session',
  tier: 'mid',
  model: 'sonnet',
  findings: [],
};

const VERIFIER: VerifierPassV1 = {
  sessionId: 'verifier-session',
  tier: 'frontier',
  model: 'opus',
  findings: [],
  verdict: 'approved',
  vendorDiversityUnavailable: true,
};

describe('ModelRoutingBlock', () => {
  it('renders inside a RailBlock labelled "Model routing"', () => {
    const { container } = render(<ModelRoutingBlock attempts={[]} />);
    const block = container.querySelector('.rail-block')!;
    expect(block.querySelector('.label')).toHaveTextContent('Model routing');
  });

  it('shows an honest empty state when no session has run yet', () => {
    render(<ModelRoutingBlock attempts={[]} />);
    expect(screen.getByText('No session has run against this ticket yet.')).toBeInTheDocument();
  });

  it('renders one row per phase with real data, in Implement/Reviewer/Verifier order', () => {
    const { container } = render(
      <ModelRoutingBlock attempts={[IMPLEMENT_ATTEMPT]} reviewer={REVIEWER} verifier={VERIFIER} />,
    );
    const rows = Array.from(container.querySelectorAll('.kv'));
    expect(rows.map((row) => row.querySelector('.k')?.textContent)).toEqual([
      'Implement',
      'Reviewer',
      'Verifier',
    ]);
    expect(rows.map((row) => row.querySelector('.v')?.textContent)).toEqual([
      'sonnet',
      'sonnet',
      'opus',
    ]);
  });

  it('marks the Verifier row warn when vendor diversity was unavailable', () => {
    const { container } = render(
      <ModelRoutingBlock attempts={[IMPLEMENT_ATTEMPT]} reviewer={REVIEWER} verifier={VERIFIER} />,
    );
    const verifierRow = Array.from(container.querySelectorAll('.kv')).find(
      (row) => row.querySelector('.k')?.textContent === 'Verifier',
    );
    expect(verifierRow?.querySelector('.v')).toHaveClass('v', 'warn');
  });

  it('never renders a Refine row', () => {
    render(<ModelRoutingBlock attempts={[IMPLEMENT_ATTEMPT]} reviewer={REVIEWER} verifier={VERIFIER} />);
    expect(screen.queryByText('Refine')).not.toBeInTheDocument();
  });
});
