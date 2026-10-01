import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DiffFileList } from '../../src/pipenzo/DiffFileList.js';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -3,3 +3,4 @@',
  ' const a = 1;',
  '+const b = 2;',
  ' const c = 3;',
].join('\n');

const TWO_HUNK_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' one',
  '-two',
  '+TWO',
  '@@ -10,2 +10,2 @@',
  ' ten',
  '-eleven',
  '+ELEVEN',
].join('\n');

describe('DiffFileList', () => {
  it('renders one file card per file with the path split into a dimmed dir and the bare name', () => {
    render(<DiffFileList diffText={DIFF} />);
    expect(screen.getByText('src/')).toHaveClass('dir');
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });

  it('renders the per-file +N/-N stat', () => {
    render(<DiffFileList diffText={DIFF} />);
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('−0')).toBeInTheDocument();
  });

  it('renders the hunk header verbatim', () => {
    render(<DiffFileList diffText={DIFF} />);
    expect(screen.getByText('@@ -3,3 +3,4 @@')).toBeInTheDocument();
  });

  it('renders context, add and del rows with the canvas row classes', () => {
    render(<DiffFileList diffText={DIFF} />);
    expect(screen.getByText('const a = 1;').closest('tr')).toHaveClass('ctx');
    expect(screen.getByText('const b = 2;').closest('tr')).toHaveClass('add');
  });

  it('collapses a hunk on toggle, hiding its lines, and expands it again on a second toggle', () => {
    render(<DiffFileList diffText={TWO_HUNK_DIFF} />);
    expect(screen.getByText('TWO')).toBeInTheDocument();

    const toggles = screen.getAllByRole('button');
    fireEvent.click(toggles[0]!);
    expect(screen.queryByText('TWO')).not.toBeInTheDocument();
    // The second hunk is untouched -- collapsing is per hunk, not per file.
    expect(screen.getByText('ELEVEN')).toBeInTheDocument();

    fireEvent.click(toggles[0]!);
    expect(screen.getByText('TWO')).toBeInTheDocument();
  });

  it('marks the gutter of the line a finding points at with the hit class, and no other line', () => {
    render(<DiffFileList diffText={DIFF} hitLocation={{ path: 'src/a.ts', line: 4 }} />);
    expect(screen.getByText('const b = 2;').closest('tr')).toHaveClass('add', 'hit');
    expect(screen.getByText('const c = 3;').closest('tr')).not.toHaveClass('hit');
  });

  it('renders nothing for an empty diff rather than throwing', () => {
    render(<DiffFileList diffText="" />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  /** Issue #108: a finding click has to actually move the reader's eye, not just mark a row that
   * may already be off-screen. jsdom has no real layout, so `scrollIntoView` is stubbed on the
   * prototype and asserted on, the standard way to test it under jsdom. */
  it('scrolls the hit row into view when a hitLocation is supplied', () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;

    render(<DiffFileList diffText={DIFF} hitLocation={{ path: 'src/a.ts', line: 4 }} />);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    const scrolledRow = scrollIntoView.mock.instances[0] as unknown as HTMLElement;
    expect(scrolledRow).toBe(screen.getByText('const b = 2;').closest('tr'));
  });

  it('does not scroll when no hitLocation is supplied', () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;

    render(<DiffFileList diffText={DIFF} />);

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  /** A finding pointing into a hunk the reader had collapsed must reopen it -- scrolling to a row
   * that was never rendered would be a silent no-op from the reader's point of view. */
  it('expands a collapsed hunk that contains the hit line, and leaves an unrelated hunk alone', () => {
    const { rerender } = render(<DiffFileList diffText={TWO_HUNK_DIFF} />);
    const toggles = screen.getAllByRole('button');
    fireEvent.click(toggles[0]!); // collapse the first hunk (TWO lives at new-line 2)
    fireEvent.click(toggles[1]!); // collapse the second hunk too (ELEVEN lives at new-line 11)
    expect(screen.queryByText('TWO')).not.toBeInTheDocument();
    expect(screen.queryByText('ELEVEN')).not.toBeInTheDocument();

    // A finding at new-line 2 lives in the first hunk only -- reopening it must not touch the
    // second hunk's own, independent collapsed state.
    rerender(<DiffFileList diffText={TWO_HUNK_DIFF} hitLocation={{ path: 'src/a.ts', line: 2 }} />);
    expect(screen.getByText('TWO')).toBeInTheDocument();
    expect(screen.queryByText('ELEVEN')).not.toBeInTheDocument();
  });
});
