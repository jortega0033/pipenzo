import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Finding, FindingsCount, FindingsList } from '../../src/components/primitives/FindingsList.js';

describe('FindingsCount', () => {
  it('renders the critical/warning/info tally', () => {
    render(<FindingsCount critical={0} warning={2} info={1} />);
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('warning')).toBeInTheDocument();
  });
});

describe('Finding', () => {
  it('renders the severity chip, text and file:line location', () => {
    render(
      <FindingsList>
        <Finding severity="warning" loc="stdio-mcp-connection.ts:76">
          The sanitized floor is spread first, so an env key can still put a host value back.
        </Finding>
      </FindingsList>,
    );
    expect(screen.getByText('warning')).toBeInTheDocument();
    expect(
      screen.getByText(/The sanitized floor is spread first/),
    ).toBeInTheDocument();
    expect(screen.getByText('stdio-mcp-connection.ts:76')).toBeInTheDocument();
  });

  it('maps critical/warning/info to the danger/warn/neutral chip tones', () => {
    const { container, rerender } = render(
      <Finding severity="critical" loc="a:1">
        x
      </Finding>,
    );
    expect(container.querySelector('.chip')?.className).toBe('chip chip-danger');
    rerender(
      <Finding severity="warning" loc="a:1">
        x
      </Finding>,
    );
    expect(container.querySelector('.chip')?.className).toBe('chip chip-warn');
    rerender(
      <Finding severity="info" loc="a:1">
        x
      </Finding>,
    );
    expect(container.querySelector('.chip')?.className).toBe('chip chip-neutral');
  });

  it('applies the active accent-rail class', () => {
    const { container } = render(
      <Finding severity="warning" active loc="a:1">
        x
      </Finding>,
    );
    expect(container.querySelector('.finding')?.className).toBe('finding active');
  });

  it('is keyboard-actionable: tabIndex 0, calls onClick on click and Enter/Space', () => {
    const onClick = vi.fn();
    render(
      <Finding severity="info" loc="a:1" onClick={onClick}>
        x
      </Finding>,
    );
    const row = screen.getByRole('button');
    expect(row).toHaveAttribute('tabIndex', '0');
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    fireEvent.keyDown(row, { key: 'a' });
    expect(onClick).toHaveBeenCalledTimes(3);
  });
});
