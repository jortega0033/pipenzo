import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppearancePanel } from '../../src/pipenzo/AppearancePanel.js';
import { THEME_PREFERENCE_STORAGE_KEY, ThemeProvider } from '../../src/theme.js';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  cleanup();
});

function renderPanel() {
  return render(
    <ThemeProvider>
      <AppearancePanel />
    </ThemeProvider>,
  );
}

describe('AppearancePanel', () => {
  it('renders System/Light/Dark with System selected by default', () => {
    renderPanel();
    const group = screen.getByRole('group', { name: 'Theme' });
    expect(within(group).getByText('System').getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByText('Light').getAttribute('aria-pressed')).toBe('false');
    expect(within(group).getByText('Dark').getAttribute('aria-pressed')).toBe('false');
  });

  it('picking Light updates the shared theme state and the applied attribute', async () => {
    renderPanel();
    await act(async () => {
      screen.getByText('Light').click();
    });

    expect(screen.getByText('Light').getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY)).toBe('light');
  });
});
