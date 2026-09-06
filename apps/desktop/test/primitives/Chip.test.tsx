import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Chip, RiskChip, SelfTag } from '../../src/components/primitives/Chip.js';

describe('Chip', () => {
  it.each([
    ['ok', 'chip chip-ok'],
    ['warn', 'chip chip-warn'],
    ['danger', 'chip chip-danger'],
    ['neutral', 'chip chip-neutral'],
    ['ci', 'chip chip-ci'],
    ['wait', 'chip chip-wait'],
  ] as const)('renders the %s tone', (tone, expectedClass) => {
    render(<Chip tone={tone}>Queued</Chip>);
    expect(screen.getByText('Queued').className).toBe(expectedClass);
  });

  it('renders an optional leading icon, e.g. the "Needs human" chip', () => {
    render(
      <Chip tone="danger" icon="needs-human">
        Needs human
      </Chip>
    );
    expect(screen.getByText('Needs human').querySelector('svg')).toBeInTheDocument();
  });
});

describe('RiskChip', () => {
  it.each([
    ['low', 'chip chip-risk low'],
    ['medium', 'chip chip-risk medium'],
    ['high', 'chip chip-risk high'],
  ] as const)('renders the %s grade with the tinted-mono risk class, not a status chip class', (level, expectedClass) => {
    render(<RiskChip level={level}>{level.toUpperCase()}</RiskChip>);
    const el = screen.getByText(level.toUpperCase());
    expect(el.className).toBe(expectedClass);
    // A risk grade must never carry chip-ok/warn/danger/neutral -- those are reserved for the
    // filled status chip so the two can never be confused.
    expect(el.className).not.toMatch(/chip-(ok|warn|danger|neutral|ci|wait)\b/);
  });
});

describe('SelfTag', () => {
  it('renders the self marker', () => {
    render(<SelfTag>you</SelfTag>);
    expect(screen.getByText('you')).toHaveClass('self-tag');
  });
});
