import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoLessonV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { LessonsPanel } from '../../src/pipenzo/LessonsPanel.js';

const lesson = (overrides: Partial<PipenzoLessonV1> = {}): PipenzoLessonV1 => ({
  schemaVersion: 1,
  id: '12345678-1234-4234-8234-123456789abc',
  repo: 'jortega0033/agentdock',
  issueNumber: 94,
  text: 'On Windows the host sets Path, not PATH.',
  savedAt: '2026-09-06T14:14:00.000Z',
  ...overrides,
});

function installBridge(
  options: {
    lessons?: readonly PipenzoLessonV1[];
    readRejects?: boolean;
    deleteLesson?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const pipenzoDeleteLesson =
    options.deleteLesson ??
    vi.fn(async (input: { id: string }) => ({
      lessons: (options.lessons ?? []).filter((entry) => entry.id !== input.id),
    }));
  const bridge = {
    pipenzoLessons: options.readRejects
      ? vi.fn().mockRejectedValue(new Error('daemon is not ready yet'))
      : vi.fn().mockResolvedValue({ lessons: options.lessons ?? [] }),
    pipenzoDeleteLesson,
  };
  setBridgeOverride(bridge as never);
  return bridge;
}

afterEach(() => {
  cleanup();
  clearBridgeOverride();
});

const loaded = () => screen.findByText('On Windows the host sets Path, not PATH.');

describe('LessonsPanel', () => {
  it('lists a saved lesson with its repo/date meta', async () => {
    installBridge({ lessons: [lesson()] });
    render(<LessonsPanel />);
    await loaded();

    const rows = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('On Windows the host sets Path, not PATH.');
    expect(rows[0]).toHaveTextContent('jortega0033/agentdock');
    expect(rows[0]).toHaveTextContent('saved from #94');
  });

  it('says no lessons are saved yet when the list is empty', async () => {
    installBridge({ lessons: [] });
    render(<LessonsPanel />);

    expect(await screen.findByText(/no lessons saved yet/i)).toBeInTheDocument();
  });

  /** Matches `ConnectedReposPanel`'s own rule: a failed read is "we could not read it", never an
   *  empty list that would tell a person nothing has ever been saved. */
  it('reports a failed read as unread, never as an empty list', async () => {
    installBridge({ readRejects: true });
    render(<LessonsPanel />);

    expect(await screen.findByText(/could not read your saved lessons/i)).toBeVisible();
    expect(screen.queryByText(/no lessons saved yet/i)).not.toBeInTheDocument();
  });

  it('retries the read', async () => {
    const bridge = installBridge({ readRejects: true });
    render(<LessonsPanel />);
    await screen.findByText(/could not read your saved lessons/i);

    bridge.pipenzoLessons.mockResolvedValue({ lessons: [lesson()] });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await loaded();
    expect(bridge.pipenzoLessons).toHaveBeenCalledTimes(2);
  });

  it('deletes exactly the named lesson and renders the daemon-provided list afterward', async () => {
    const first = lesson();
    const second = lesson({
      id: '87654321-4321-4234-8234-abcdef123456',
      text: 'A second lesson.',
      issueNumber: 100,
    });
    const bridge = installBridge({ lessons: [first, second] });
    render(<LessonsPanel />);
    await loaded();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Delete this lesson: On Windows the host sets Path, not PATH.',
      }),
    );

    await waitFor(() => expect(bridge.pipenzoDeleteLesson).toHaveBeenCalledTimes(1));
    expect(bridge.pipenzoDeleteLesson).toHaveBeenCalledWith({ id: first.id });
    await waitFor(() =>
      expect(
        screen.queryByText('On Windows the host sets Path, not PATH.'),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText('A second lesson.')).toBeInTheDocument();
  });

  it('keeps the lesson when the delete fails, and says so', async () => {
    const deleteLesson = vi.fn().mockRejectedValue(new Error('the daemon refused the delete.'));
    installBridge({ lessons: [lesson()], deleteLesson });
    render(<LessonsPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /delete this lesson/i }));

    expect(await screen.findByText(/could not delete that lesson/i)).toBeVisible();
    expect(screen.getByText('On Windows the host sets Path, not PATH.')).toBeInTheDocument();
  });

  /**
   * The one race this panel actually guards against: a double click on the *same* row landing
   * before `removing` state has committed. Unlike `ConnectedReposPanel`, a second click on a
   * *different* row would be perfectly safe (the daemon computes each removal independently), so
   * this only needs to prove the same-row case, not a cross-row one.
   */
  it('will not start a second delete of the same row while one is in flight', async () => {
    let release: ((value: { lessons: PipenzoLessonV1[] }) => void) | undefined;
    const deleteLesson = vi.fn(
      () =>
        new Promise<{ lessons: PipenzoLessonV1[] }>((resolve) => {
          release = resolve;
        }),
    );
    installBridge({ lessons: [lesson()], deleteLesson });
    render(<LessonsPanel />);
    await loaded();

    const button = screen.getByRole('button', { name: /delete this lesson/i });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(deleteLesson).toHaveBeenCalledTimes(1);
    release?.({ lessons: [] });
    await waitFor(() => expect(screen.queryByRole('listitem')).not.toBeInTheDocument());
  });
});
