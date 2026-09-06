import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GradeCell, GradeHeader, GradeTable } from '../../src/components/primitives/GradeTable.js';
import { RiskChip } from '../../src/components/primitives/Chip.js';

describe('GradeTable', () => {
  it('renders the default grid-template-columns unless overridden', () => {
    const { container, rerender } = render(
      <GradeTable>
        <GradeHeader />
      </GradeTable>,
    );
    let table = container.querySelector('.grade-table') as HTMLElement;
    expect(table.style.gridTemplateColumns).toBe('');

    rerender(
      <GradeTable columns="96px 110px minmax(0,1fr)">
        <GradeHeader />
      </GradeTable>,
    );
    table = container.querySelector('.grade-table') as HTMLElement;
    expect(table.style.gridTemplateColumns).toBe('96px 110px minmax(0,1fr)');
  });

  it('renders the LOW/MEDIUM/HIGH behaviour matrix as flat header + data cells', () => {
    render(
      <GradeTable>
        <GradeHeader />
        <GradeHeader>
          <RiskChip level="low">LOW</RiskChip>
        </GradeHeader>
        <GradeHeader>
          <RiskChip level="medium">MEDIUM</RiskChip>
        </GradeHeader>
        <GradeHeader>
          <RiskChip level="high">HIGH</RiskChip>
        </GradeHeader>
        <GradeCell>Blocks the run</GradeCell>
        <GradeCell deemphasize>No — proceeds, logged</GradeCell>
        <GradeCell>
          <b>Yes</b> — compact inline card
        </GradeCell>
        <GradeCell>
          <b>Yes</b> — full card
        </GradeCell>
      </GradeTable>,
    );
    expect(screen.getByText('LOW')).toBeInTheDocument();
    expect(screen.getByText('Blocks the run')).toBeInTheDocument();
    expect(screen.getByText('No — proceeds, logged').className).toBe('no');
    expect(screen.getAllByText('Yes')).toHaveLength(2);
  });

  it('renders an unemphasized cell with no class attribute', () => {
    const { container } = render(
      <GradeTable>
        <GradeCell>plain</GradeCell>
      </GradeTable>,
    );
    const cell = container.querySelector('.grade-table > div')!;
    expect(cell.className).toBe('');
  });
});
