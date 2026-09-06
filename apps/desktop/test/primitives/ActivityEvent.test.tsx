import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Evt, EvtHead, EvtTitle, SubLines, SubRow } from '../../src/components/primitives/ActivityEvent.js';
import { LowLine } from '../../src/components/primitives/Risk.js';
import { RiskChip } from '../../src/components/primitives/Chip.js';

describe('Evt', () => {
  it('renders the icon well and connecting line by default', () => {
    const { container } = render(
      <Evt icon="implement">
        <EvtHead tool="implement" meta="14:06" />
        <EvtTitle>Sanitize environment for MCP stdio server subprocesses</EvtTitle>
      </Evt>,
    );
    expect(container.querySelector('.evt-ic')?.className).toBe('evt-ic');
    expect(container.querySelector('.evt-line')?.className).toBe('evt-line');
    expect(screen.getByText('implement')).toBeInTheDocument();
    expect(
      screen.getByText('Sanitize environment for MCP stdio server subprocesses'),
    ).toBeInTheDocument();
  });

  it('applies the live and bad icon tones', () => {
    const { container, rerender } = render(
      <Evt icon="implement" iconTone="live">
        x
      </Evt>,
    );
    expect(container.querySelector('.evt-ic')?.className).toBe('evt-ic live');
    rerender(
      <Evt icon="implement" iconTone="bad">
        x
      </Evt>,
    );
    expect(container.querySelector('.evt-ic')?.className).toBe('evt-ic bad');
  });

  it('renders the transparent end line for the last row', () => {
    const { container } = render(
      <Evt icon="git-pull-request" end>
        x
      </Evt>,
    );
    expect(container.querySelector('.evt-line')?.className).toBe('evt-line end');
  });

  it('renders the compact low variant with a LowLine child', () => {
    const { container } = render(
      <Evt icon="implement" low>
        <LowLine time="14:02" tag="LOW · auto">
          Read the current MCP config
        </LowLine>
      </Evt>,
    );
    expect(container.querySelector('.evt')?.className).toBe('evt low');
    expect(container.querySelector('.low-line')).toBeInTheDocument();
  });
});

describe('EvtHead', () => {
  it('renders tool, an optional risk chip and meta, tinting meta when live', () => {
    const { container, rerender } = render(<EvtHead tool="implement" meta="14:06" />);
    expect(container.querySelector('.evt-meta')?.className).toBe('evt-meta');
    expect(container.querySelector('.chip')).not.toBeInTheDocument();

    rerender(
      <EvtHead
        tool="implement"
        risk={<RiskChip level="medium">MEDIUM</RiskChip>}
        meta="waiting on you"
        metaLive
      />,
    );
    expect(screen.getByText('MEDIUM')).toBeInTheDocument();
    expect(container.querySelector('.evt-meta')?.className).toBe('evt-meta live');
  });
});

describe('SubRow/SubLines', () => {
  it('toggles the open class and rotates on click/Enter/Space', () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(
      <SubRow open={false} onToggle={onToggle}>
        3 tool calls · 210 tokens
      </SubRow>,
    );
    const row = screen.getByRole('button');
    expect(row.className).toBe('sub-row');
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onToggle).toHaveBeenCalledTimes(3);

    rerender(
      <SubRow open onToggle={onToggle}>
        3 tool calls · 210 tokens
      </SubRow>,
    );
    expect(container.querySelector('.sub-row')?.className).toBe('sub-row open');
  });

  it('renders the expanded transcript body', () => {
    render(<SubLines>read file: mcp-config.json</SubLines>);
    expect(screen.getByText('read file: mcp-config.json')).toBeInTheDocument();
  });
});
