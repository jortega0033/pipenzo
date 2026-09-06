import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LessonPrompt, LessonSaved } from '../../src/components/primitives/LessonCard.js';

describe('LessonPrompt', () => {
  it('renders the pre-filled field and the local-storage note', () => {
    render(
      <LessonPrompt
        value="On Windows the host sets Path, not PATH."
        onChange={vi.fn()}
        onSkip={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(
      screen.getByDisplayValue('On Windows the host sets Path, not PATH.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Stays in this repo's local ticket store. Nothing is written unless you save it."),
    ).toBeInTheDocument();
  });

  it('calls onChange, onSkip and onSave', () => {
    const onChange = vi.fn();
    const onSkip = vi.fn();
    const onSave = vi.fn();
    render(<LessonPrompt value="" onChange={onChange} onSkip={onSkip} onSave={onSave} />);
    fireEvent.change(screen.getByPlaceholderText('One line, in your words.'), {
      target: { value: 'new lesson' },
    });
    expect(onChange).toHaveBeenCalledWith('new lesson');
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    fireEvent.click(screen.getByRole('button', { name: /Save lesson/ }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe('LessonSaved', () => {
  it('renders the saved sentence, human-gated tag, and calls onUndo', () => {
    const onUndo = vi.fn();
    render(
      <LessonSaved onUndo={onUndo}>Saved locally — 1 lesson on jortega0033/agentdock</LessonSaved>,
    );
    expect(
      screen.getByText('Saved locally — 1 lesson on jortega0033/agentdock'),
    ).toBeInTheDocument();
    expect(screen.getByText('human-gated')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Undo'));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
