import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimpleModeShell } from '../../src/pipenzo/SimpleModeShell.js';
import { UI_MODE_STORAGE_KEY, UiModeProvider } from '../../src/ui-mode.js';

function renderShell(
  activeTicket?: { ticketId: string; issueNumber: number; title?: string },
  onOpenTechnicalDetails = vi.fn(),
) {
  render(
    <UiModeProvider>
      <SimpleModeShell activeTicket={activeTicket} onOpenTechnicalDetails={onOpenTechnicalDetails} />
    </UiModeProvider>,
  );
  return { onOpenTechnicalDetails };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('SimpleModeShell (issue #133)', () => {
  it('renders with no sidebar at all', () => {
    renderShell();
    expect(document.querySelector('.sidebar')).not.toBeInTheDocument();
    expect(document.querySelector('.simple-shell')).toBeInTheDocument();
    expect(document.querySelector('.topbar')).toBeInTheDocument();
  });

  it('shows the honest empty state when no ticket has been routed in', () => {
    renderShell(undefined);
    expect(screen.getByText('Nothing to show in Simple mode yet')).toBeInTheDocument();
    expect(screen.queryByText('Ask a follow-up')).not.toBeInTheDocument();
    expect(screen.queryByText('See the technical details')).not.toBeInTheDocument();
  });

  it('shows the crossover links once a real ticket is routed in', () => {
    renderShell({ ticketId: 'a', issueNumber: 42, title: 'Fix the tray badge' });
    expect(screen.getByText('Fix the tray badge')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('Ask a follow-up')).toBeInTheDocument();
    expect(screen.getByText('See the technical details')).toBeInTheDocument();
  });

  it('"Ask a follow-up" is present but genuinely inert -- no destination exists for it yet', () => {
    const { onOpenTechnicalDetails } = renderShell({ ticketId: 'a', issueNumber: 42 });
    const askLink = screen.getByText('Ask a follow-up').closest('.link')!;

    expect(askLink).toHaveAttribute('aria-disabled', 'true');
    expect(askLink).not.toHaveAttribute('tabindex');
    fireEvent.click(askLink);
    expect(onOpenTechnicalDetails).not.toHaveBeenCalled();
  });

  it('"See the technical details" reports the real ticket id upward, for real navigation', () => {
    const { onOpenTechnicalDetails } = renderShell({ ticketId: 'real-ticket-id', issueNumber: 42 });

    fireEvent.click(screen.getByText('See the technical details'));

    expect(onOpenTechnicalDetails).toHaveBeenCalledTimes(1);
    expect(onOpenTechnicalDetails).toHaveBeenCalledWith('real-ticket-id');
  });

  it('the Simple/Expert switch actually toggles and persists the mode preference', async () => {
    // `useUiMode()`'s own default is 'expert' (unchanged behaviour for every install that has never
    // touched this preference) -- reaching this shell at all already means something set it to
    // 'simple' by some other means (see AppRoot.tsx's own honest-gap doc comment), so the switch
    // itself starts on 'expert' pressed here, exactly as `UiModeProvider`'s default says it should.
    renderShell();
    const group = screen.getByRole('group', { name: 'Simple or Expert mode' });
    expect(within(group).getByText('Expert')).toHaveAttribute('aria-pressed', 'true');

    await act(async () => {
      fireEvent.click(within(group).getByText('Simple'));
    });

    expect(within(group).getByText('Simple')).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem(UI_MODE_STORAGE_KEY)).toBe('simple');
  });
});
