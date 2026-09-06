import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LowLine, RiskStrip } from '../../src/components/primitives/Risk.js';

describe('LowLine', () => {
  it('renders a timestamp, the passive text and a trailing tag', () => {
    render(
      <LowLine time="14:03" tag="LOW · auto">
        Read stdio-mcp-connection.ts:60–90 and base-environment.ts
      </LowLine>,
    );
    expect(screen.getByText('14:03')).toBeInTheDocument();
    expect(
      screen.getByText('Read stdio-mcp-connection.ts:60–90 and base-environment.ts'),
    ).toBeInTheDocument();
    expect(screen.getByText('LOW · auto')).toBeInTheDocument();
  });
});

describe('RiskStrip', () => {
  it('fills one plain segment for a calm score of 1.0', () => {
    const { container } = render(
      <RiskStrip score={1}>
        <b>Calm</b> — 2 low-risk actions (1.0) since your last look
      </RiskStrip>,
    );
    const segs = container.querySelectorAll('.risk-seg');
    expect(segs).toHaveLength(10);
    const on = container.querySelectorAll('.risk-seg.on');
    expect(on).toHaveLength(1);
    expect(on[0]!.className).toBe('risk-seg on');
    expect(screen.getByText('1.0 / 10')).toBeInTheDocument();
  });

  it('fills base + warm segments for a moderate score of 6.0', () => {
    const { container } = render(
      <RiskStrip score={6}>
        <b>Moderate</b> — 6 low-risk actions (3.0) and 1 mismatch (3.0) since your last look
      </RiskStrip>,
    );
    const on = container.querySelectorAll('.risk-seg.on');
    expect(on).toHaveLength(6);
    const warm = container.querySelectorAll('.risk-seg.on.warm');
    expect(warm).toHaveLength(2);
    expect(container.querySelectorAll('.risk-seg.on.hot')).toHaveLength(0);
    expect(screen.getByText('6.0 / 10')).toBeInTheDocument();
  });

  it('fills base + warm + hot segments and shows the promo note at the threshold', () => {
    const { container } = render(
      <RiskStrip
        score={10}
        promo={
          <>
            <b>Next MEDIUM asks as HIGH.</b> 14 unreviewed low-risk actions at +0.5 each.
          </>
        }
      >
        <b>High</b> — 14 low-risk actions (7.0) and 1 mismatch (3.0) since your last look
      </RiskStrip>,
    );
    expect(container.querySelectorAll('.risk-seg.on')).toHaveLength(10);
    expect(container.querySelectorAll('.risk-seg.on.hot')).toHaveLength(3);
    expect(container.querySelector('.risk-promo')).toBeInTheDocument();
    expect(screen.getByText('Next MEDIUM asks as HIGH.')).toBeInTheDocument();
  });

  it('omits the promo note by default', () => {
    const { container } = render(<RiskStrip score={0}>Quiet</RiskStrip>);
    expect(container.querySelector('.risk-promo')).not.toBeInTheDocument();
  });
});
