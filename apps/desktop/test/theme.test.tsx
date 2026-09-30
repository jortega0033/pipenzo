import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  THEME_PREFERENCE_STORAGE_KEY,
  ThemeProvider,
  resolveEffectiveTheme,
  useTheme,
} from '../src/theme.js';
import type { ThemePreference } from '../src/theme.js';

/** Installs a fake `window.matchMedia` reporting a fixed `(prefers-color-scheme: light)` match,
 * with enough of the listener API for theme.tsx's `change` subscription not to throw. */
function mockSystemPrefersLight(prefersLight: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches: query === '(prefers-color-scheme: light)' ? prefersLight : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      // Unused by theme.tsx, present only so this satisfies MediaQueryList's shape.
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
      onchange: null,
    }) as MediaQueryList;
}

/** A minimal consumer that renders the current preference/effective theme as text, and a button
 * per option to drive `setPreference` — enough surface to test the provider without needing
 * AppearancePanel's own markup along for the ride. */
function ThemeProbe() {
  const { preference, effective, setPreference } = useTheme();
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <span data-testid="effective">{effective}</span>
      {(['system', 'light', 'dark'] as const).map((option) => (
        <button key={option} onClick={() => setPreference(option)}>
          {option}
        </button>
      ))}
    </div>
  );
}

function renderProbe() {
  return render(
    <ThemeProvider>
      <ThemeProbe />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  mockSystemPrefersLight(false);
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  cleanup();
});

describe('resolveEffectiveTheme', () => {
  it('resolves an explicit preference regardless of the system', () => {
    expect(resolveEffectiveTheme('light', false)).toBe('light');
    expect(resolveEffectiveTheme('dark', true)).toBe('dark');
  });

  it('follows the system only for "system"', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('light');
    expect(resolveEffectiveTheme('system', false)).toBe('dark');
  });
});

describe('ThemeProvider / useTheme', () => {
  it('defaults to the system preference when no explicit choice exists', () => {
    mockSystemPrefersLight(true);
    renderProbe();

    expect(screen.getByTestId('preference').textContent).toBe('system');
    expect(screen.getByTestId('effective').textContent).toBe('light');
    // 'system' never sets the attribute -- the stylesheet's own @media query is what applies the
    // palette in that case, not this attribute.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('toggling actually changes the applied theme', async () => {
    renderProbe();
    expect(screen.getByTestId('effective').textContent).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();

    await act(async () => {
      screen.getByText('light').click();
    });

    expect(screen.getByTestId('preference').textContent).toBe('light');
    expect(screen.getByTestId('effective').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    await act(async () => {
      screen.getByText('dark').click();
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    await act(async () => {
      screen.getByText('system').click();
    });

    // Reverting to 'system' removes the attribute again rather than leaving it pinned to a
    // computed value.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('persists an explicit choice across a remount', async () => {
    const first = renderProbe();
    await act(async () => {
      screen.getByText('light').click();
    });
    expect(window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY)).toBe('light');
    first.unmount();

    renderProbe();
    expect(screen.getByTestId('preference').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('ignores a corrupted stored value and falls back to system', () => {
    window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, 'sepia' as ThemePreference);
    renderProbe();
    expect(screen.getByTestId('preference').textContent).toBe('system');
  });
});
