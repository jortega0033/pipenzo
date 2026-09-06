import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Split } from '../../src/components/primitives/Split.js';

describe('Split', () => {
  it('renders a warn head with an icon, a kv line and numbered rows for a proposed stack', () => {
    const { container } = render(
      <Split
        icon="pr-stack"
        head="Proposed stack · 3 PRs · est. +212 −40"
        rows={[
          { n: '1/3', children: 'Extract a ProviderCapabilities interface' },
          { n: '2/3', children: 'Negotiate over stdio and http' },
          { n: '3/3', children: 'Negotiate over websocket, remove fallbacks' },
        ]}
      />,
    );
    expect(container.querySelector('.split-head')?.className).toBe('split-head');
    expect(container.querySelector('.split-head svg')).toBeInTheDocument();
    expect(screen.getByText('Proposed stack · 3 PRs · est. +212 −40')).toBeInTheDocument();
    expect(container.querySelectorAll('.split-row')).toHaveLength(3);
    expect(screen.getByText('2/3')).toBeInTheDocument();
  });

  it('renders the quiet declined-at-Refine variant with a kv summary line', () => {
    const { container } = render(
      <Split
        icon="prohibit"
        quiet
        head="Declined at Refine · nothing written"
        kv={
          <>
            <span>
              est. <b>+1,340 −410</b>
            </span>
            <span>
              <b>31</b> files
            </span>
          </>
        }
        rows={[{ n: 1, children: 'Storage interface in front of the JSON store' }]}
      />,
    );
    expect(container.querySelector('.split-head')?.className).toBe('split-head quiet');
    expect(container.querySelector('.split-kv')).toBeInTheDocument();
    expect(screen.getByText('31')).toBeInTheDocument();
  });

  it('renders a compact plan-review summary with no kv line', () => {
    const { container } = render(
      <Split
        quiet
        head="Out of scope · written down so it cannot drift"
        rows={[{ n: '—', children: 'The poll interval and the "syncing slowly" degradation.' }]}
      />,
    );
    expect(container.querySelector('.split-kv')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.split-row')).toHaveLength(1);
  });
});
