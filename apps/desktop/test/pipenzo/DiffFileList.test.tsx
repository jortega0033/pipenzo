import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
});
