import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Light mode (issue #155). `'system'` tracks the OS via `prefers-color-scheme` and is the
 * default for a user who has never chosen explicitly; `'light'`/`'dark'` are an explicit,
 * persisted override that always wins over the OS.
 *
 * ## How this reaches the CSS
 *
 * `pipenzo-theme.css`'s own light-mode block explains the selector side of this; this module
 * only ever writes one thing to the DOM: the `data-theme` attribute on `<html>`. `'system'`
 * removes the attribute entirely (so the stylesheet's `@media (prefers-color-scheme: light)`
 * block decides, and tracks the OS live with no JS involved); `'light'`/`'dark'` set it, which
 * both picks the palette directly and — via that same stylesheet's `:not([data-theme='dark'])`
 * guard — stops the OS from overriding an explicit choice.
 *
 * ## Persistence
 *
 * `localStorage`, following `App.tsx`'s own `WORKSPACE_PREFERENCES_KEY` pattern: read once up
 * front, written on every explicit change, wrapped in try/catch since a user profile with
 * storage disabled should degrade to "asks again next launch", not throw.
 *
 * ## Why a context and not a bare hook
 *
 * The document-level effect (the thing that actually repaints the app) and the Settings toggle
 * that changes it are far apart in the tree. Two independent `useState`s each reading
 * `localStorage` on mount would each show the right value on their own first render, but a
 * change made through one would never reach the other in the same window — `storage` events
 * only fire in *other* tabs. A single provider instance, mounted once near the root, is what
 * keeps the applied theme and the control that changes it looking at the same state.
 */
export type ThemePreference = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

export const THEME_PREFERENCE_STORAGE_KEY = 'pipenzo:theme-preference';

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Best-effort read -- corrupt/missing storage and a disabled storage API both fall back to
 * `'system'`, never to a thrown error. */
export function readStoredThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function systemPrefersLight(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)').matches
    : false;
}

/** Pure so it's trivial to test independently of the DOM/matchMedia plumbing above it. */
export function resolveEffectiveTheme(
  preference: ThemePreference,
  systemIsLight: boolean,
): EffectiveTheme {
  if (preference === 'system') return systemIsLight ? 'light' : 'dark';
  return preference;
}

interface ThemeContextValue {
  /** The stored preference -- what the Settings toggle should reflect as selected. */
  preference: ThemePreference;
  /** The theme actually applied right now, `'system'` already resolved against the OS. */
  effective: EffectiveTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredThemePreference);
  const [systemLight, setSystemLight] = useState(systemPrefersLight);

  // Live system-preference tracking. Only matters while `preference === 'system'` -- the
  // stylesheet's own `@media` query already repaints without this on its own, but `effective`
  // (read by the Settings toggle / tests) needs to stay in sync with it too.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setSystemLight(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const effective = resolveEffectiveTheme(preference, systemLight);

  useEffect(() => {
    // 'system' removes the attribute rather than setting it to the resolved value -- see the
    // module doc comment for why that (not a computed 'light'/'dark') is what lets the OS keep
    // driving it live via the stylesheet's own @media query, with no listener needed here at all.
    if (preference === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', preference);
    }
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, next);
    } catch {
      // Best-effort, matching App.tsx's identical write to WORKSPACE_PREFERENCES_KEY: a user
      // profile with storage disabled just gets asked again next launch.
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, effective, setPreference }),
    [preference, effective, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
