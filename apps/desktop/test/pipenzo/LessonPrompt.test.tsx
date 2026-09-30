import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoLessonListV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { LessonPrompt } from '../../src/pipenzo/LessonPrompt.js';

const REPO = 'jortega0033/pipenzo';
const ISSUE_NUMBER = 94;

function lessonList(text: string, count = 1): PipenzoLessonListV1 {
  return {
    lessons: Array.from({ length: count }, (_, index) => ({
      schemaVersion: 1 as const,
      id: `lesson-${index + 1}`,
      repo: REPO,
      issueNumber: ISSUE_NUMBER,
      text,
      savedAt: '2026-09-06T14:14:00.000Z',
    })),
  };
}

afterEach(() => {
  clearBridgeOverride();
});

describe('LessonPrompt', () => {
  it('renders the offer state pre-filled from real run data, editable', () => {
    render(
      <LessonPrompt
        repo={REPO}
        issueNumber={ISSUE_NUMBER}
        prefill="On Windows the host sets Path, not PATH."
      />,
    );
    const field = screen.getByLabelText('Lesson text') as HTMLInputElement;
    expect(field.value).toBe('On Windows the host sets Path, not PATH.');
    expect(field).not.toHaveAttribute('readonly');
    expect(field).not.toBeDisabled();
  });

  it('Skip leaves no lesson saved and the prompt does not come back', () => {
    const pipenzoCreateLesson = vi.fn();
    setBridgeOverride({ pipenzoCreateLesson } as never);

    render(<LessonPrompt repo={REPO} issueNumber={ISSUE_NUMBER} prefill="a real finding" />);
    fireEvent.click(screen.getByRole('button', { name: /^skip$/i }));

    expect(screen.queryByLabelText('Lesson text')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save lesson/i })).not.toBeInTheDocument();
    expect(pipenzoCreateLesson).not.toHaveBeenCalled();
  });

  it('Save lesson calls the real pipenzoCreateLesson route with the edited text, and shows the daemon-answered per-repo count', async () => {
    const pipenzoCreateLesson = vi.fn().mockResolvedValue(lessonList('a rewritten lesson', 3));
    setBridgeOverride({ pipenzoCreateLesson } as never);

    render(<LessonPrompt repo={REPO} issueNumber={ISSUE_NUMBER} prefill="a first draft" />);
    fireEvent.change(screen.getByLabelText('Lesson text'), {
      target: { value: 'a rewritten lesson' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save lesson/i }));
    });

    expect(pipenzoCreateLesson).toHaveBeenCalledWith({
      repo: REPO,
      issueNumber: ISSUE_NUMBER,
      text: 'a rewritten lesson',
    });
    await waitFor(() =>
      expect(screen.getByText(`Saved locally — 3 lessons on ${REPO}`)).toBeInTheDocument(),
    );
    // The offer field is gone -- there is exactly one prompt state on screen at a time.
    expect(screen.queryByLabelText('Lesson text')).not.toBeInTheDocument();
  });

  it('disables Save lesson for an empty field rather than sending a save nothing can persist', () => {
    render(<LessonPrompt repo={REPO} issueNumber={ISSUE_NUMBER} prefill="" />);
    expect(screen.getByRole('button', { name: /save lesson/i })).toBeDisabled();
  });

  it('Undo calls the real pipenzoDeleteLesson route and returns to the editable offer state', async () => {
    const pipenzoCreateLesson = vi.fn().mockResolvedValue(lessonList('kept lesson', 1));
    const pipenzoDeleteLesson = vi.fn().mockResolvedValue({ lessons: [] });
    setBridgeOverride({ pipenzoCreateLesson, pipenzoDeleteLesson } as never);

    render(<LessonPrompt repo={REPO} issueNumber={ISSUE_NUMBER} prefill="kept lesson" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save lesson/i }));
    });
    await waitFor(() => expect(screen.getByText(/saved locally/i)).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    });

    expect(pipenzoDeleteLesson).toHaveBeenCalledWith({ id: 'lesson-1' });
    expect(screen.getByLabelText('Lesson text')).toBeInTheDocument();
  });
});
