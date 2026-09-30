import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Simple/Expert mode (issue #133). `'expert'` is the default and the only mode a fresh install has
 * ever shown -- `PipenzoAppShell`'s own sidebar/board frame, unchanged. `'simple'` is the
 * plain-language shell `SimpleModeShell.tsx` renders instead: no sidebar, just a topbar carrying
 * this same preference's own switch.
 *
 * ## Persistence
 *
 * `localStorage`, the same `pipenzo:`-prefixed key pattern `theme.tsx`'s
 * `THEME_PREFERENCE_STORAGE_KEY` already established for a per-install UI preference: read once up
 * front, written on every explicit change, wrapped in try/catch since a profile with storage
 * disabled should degrade to "asks again next launch", not throw.
 *
 * ## Why a context and not a bare hook
 *
 * The control that changes this (the `Segmented` switch inside `SimpleModeShell`'s own topbar) and
 * the place that decides which top-level shell to mount (`AppRoot.tsx`) are far apart in the tree --
 * the exact reason `theme.tsx`'s own doc comment gives for making `ThemeProvider` a context instead
 * of a bare hook. A single provider instance, mounted once near the root (alongside `ThemeProvider`,
 * outside the demo-mode `key`-remounted subtree so entering/exiting a demo session can't reset it
 * either), is what keeps both sides looking at the same state.
 *
 * ## What this does not do (issue #151, #129)
 *
 * This module only ever holds *which* shell to show, never *which ticket* Simple mode is showing --
 * that has to come from a tray-badge click or a notification click, and both are still open,
 * unscoped tickets today. `AppRoot.tsx`'s own doc comment names this as the honest gap this ticket
 * leaves rather than fabricates: nothing here invents a routed ticket to make the crossover links
 * reachable end to end before either of those exists.
 */
export type UiMode = 'expert' | 'simple';

export const UI_MODE_STORAGE_KEY = 'pipenzo:ui-mode';

function isUiMode(value: unknown): value is UiMode {
  return value === 'expert' || value === 'simple';
}

/** Best-effort read -- corrupt/missing storage and a disabled storage API both fall back to
 * `'expert'`, never to a thrown error, matching `readStoredThemePreference`'s own fallback shape. */
export function readStoredUiMode(): UiMode {
  try {
    const stored = window.localStorage.getItem(UI_MODE_STORAGE_KEY);
    return isUiMode(stored) ? stored : 'expert';
  } catch {
    return 'expert';
  }
}

interface UiModeContextValue {
  mode: UiMode;
  setMode: (mode: UiMode) => void;
}

const UiModeContext = createContext<UiModeContextValue | undefined>(undefined);

export function UiModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<UiMode>(readStoredUiMode);

  const setMode = useCallback((next: UiMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(UI_MODE_STORAGE_KEY, next);
    } catch {
      // Best-effort, matching theme.tsx's identical write to THEME_PREFERENCE_STORAGE_KEY: a user
      // profile with storage disabled just gets asked again next launch.
    }
  }, []);

  const value = useMemo<UiModeContextValue>(() => ({ mode, setMode }), [mode, setMode]);

  return <UiModeContext.Provider value={value}>{children}</UiModeContext.Provider>;
}

export function useUiMode(): UiModeContextValue {
  const context = useContext(UiModeContext);
  if (context === undefined) {
    throw new Error('useUiMode must be used within a UiModeProvider');
  }
  return context;
}
