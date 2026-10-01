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

/** Issue #108: bidirectional keyboard support across a findings list, the same roving-focus shape
 * `ActivityTimeline.tsx` already uses for its own cards. */
describe('FindingsList keyboard navigation', () => {
  function renderThree() {
    return render(
      <FindingsList>
        <Finding severity="critical" loc="a:1">
          first
        </Finding>
        <Finding severity="warning" loc="b:2">
          second
        </Finding>
        <Finding severity="info" loc="c:3">
          third
        </Finding>
      </FindingsList>,
    );
  }

  it('moves focus to the next finding on ArrowDown, and the previous on ArrowUp', () => {
    renderThree();
    const [first, second, third] = screen.getAllByRole('button');
    first!.focus();
    fireEvent.keyDown(first!, { key: 'ArrowDown' });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second!, { key: 'ArrowDown' });
    expect(third).toHaveFocus();
    fireEvent.keyDown(third!, { key: 'ArrowUp' });
    expect(second).toHaveFocus();
  });

  it('clamps at the first and last finding rather than wrapping', () => {
    renderThree();
    const [first, , third] = screen.getAllByRole('button');
    first!.focus();
    fireEvent.keyDown(first!, { key: 'ArrowUp' });
    expect(first).toHaveFocus();
    third!.focus();
    fireEvent.keyDown(third!, { key: 'ArrowDown' });
    expect(third).toHaveFocus();
  });

  it('jumps to the first/last finding on Home/End', () => {
    renderThree();
    const [first, second, third] = screen.getAllByRole('button');
    second!.focus();
    fireEvent.keyDown(second!, { key: 'End' });
    expect(third).toHaveFocus();
    fireEvent.keyDown(third!, { key: 'Home' });
    expect(first).toHaveFocus();
  });

  it('ignores other keys and keydowns from outside a finding row', () => {
    renderThree();
    const [first, second] = screen.getAllByRole('button');
    first!.focus();
    fireEvent.keyDown(first!, { key: 'Tab' });
    expect(first).toHaveFocus();
    // A keydown bubbling up from something other than a `.finding` row (e.g. the count line) must
    // not move focus either -- this list's own container is not itself a navigable row.
    const container = first!.closest('.findings')!;
    fireEvent.keyDown(container, { key: 'ArrowDown' });
    expect(first).toHaveFocus();
    expect(second).not.toHaveFocus();
  });
});
