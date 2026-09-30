import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UI_MODE_STORAGE_KEY, UiModeProvider, readStoredUiMode, useUiMode } from '../src/ui-mode.js';

/** A minimal consumer that renders the current mode as text, and a button per option to drive
 * `setMode` -- enough surface to test the provider without needing `SimpleModeShell`'s own markup
 * along for the ride, mirroring `theme.test.tsx`'s own `ThemeProbe`. */
function ModeProbe() {
  const { mode, setMode } = useUiMode();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      {(['expert', 'simple'] as const).map((option) => (
        <button key={option} onClick={() => setMode(option)}>
          {option}
        </button>
      ))}
    </div>
  );
}

function renderProbe() {
  return render(
    <UiModeProvider>
      <ModeProbe />
    </UiModeProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('readStoredUiMode', () => {
  it('defaults to expert when nothing is stored', () => {
    expect(readStoredUiMode()).toBe('expert');
  });

  it('reads back a validly stored mode', () => {
    window.localStorage.setItem(UI_MODE_STORAGE_KEY, 'simple');
    expect(readStoredUiMode()).toBe('simple');
  });

  it('ignores a corrupted stored value and falls back to expert', () => {
    window.localStorage.setItem(UI_MODE_STORAGE_KEY, 'sepia');
    expect(readStoredUiMode()).toBe('expert');
  });
});

describe('UiModeProvider / useUiMode', () => {
  it('defaults to expert mode for a fresh install -- unchanged behaviour from before this ticket', () => {
    renderProbe();
    expect(screen.getByTestId('mode').textContent).toBe('expert');
  });

  it('toggling actually changes the applied mode', async () => {
    renderProbe();
    expect(screen.getByTestId('mode').textContent).toBe('expert');

    await act(async () => {
      screen.getByText('simple').click();
    });

    expect(screen.getByTestId('mode').textContent).toBe('simple');
  });

  it('persists an explicit choice across a remount', async () => {
    const first = renderProbe();
    await act(async () => {
      screen.getByText('simple').click();
    });
    expect(window.localStorage.getItem(UI_MODE_STORAGE_KEY)).toBe('simple');
    first.unmount();

    renderProbe();
    expect(screen.getByTestId('mode').textContent).toBe('simple');
  });
});
