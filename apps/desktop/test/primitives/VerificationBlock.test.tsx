import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VerificationBlock, VRow } from '../../src/components/primitives/VerificationBlock.js';

describe('VerificationBlock', () => {
  it('renders the plain machine-verified zone with no self-tag', () => {
    const { container } = render(
      <VerificationBlock
        headLabel="Machine-verified"
        headSub="Deterministic gates. Each one ran on this machine and either passed or blocked the ticket."
      >
        <VRow>
          Build and typecheck passed <span className="m">pnpm build · 9s</span>
        </VRow>
        <VRow>vitest: 21 passed, 0 failed</VRow>
      </VerificationBlock>,
    );
    expect(container.querySelector('.v-block')?.className).toBe('v-block');
    expect(container.querySelector('.self-tag')).not.toBeInTheDocument();
    expect(screen.getByText('Machine-verified')).toBeInTheDocument();
    expect(container.querySelectorAll('.v-row')).toHaveLength(2);
    expect(container.querySelectorAll('.v-ic.self')).toHaveLength(0);
  });

  it('renders the darker agent-captured zone with the self-reported tag and grey icons', () => {
    const { container } = render(
      <VerificationBlock
        agent
        headLabel="Agent-captured"
        headSub="Evidence the agent gathered about its own work. Shown for context; none of it can satisfy a gate."
      >
        <VRow self>3/3 acceptance criteria met, by its own reading</VRow>
        <VRow self>Pre-commitments: 1 matched, 1 mismatch (recovered)</VRow>
      </VerificationBlock>,
    );
    expect(container.querySelector('.v-block')?.className).toBe('v-block agent');
    expect(screen.getByText('self-reported — not verified by a human')).toBeInTheDocument();
    expect(container.querySelectorAll('.v-ic.self')).toHaveLength(2);
  });
});
