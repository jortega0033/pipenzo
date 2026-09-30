import { Fieldset } from '../components/primitives/Fieldset.js';
import { FormRow } from '../components/primitives/FormRow.js';
import { Segmented } from '../components/primitives/Segmented.js';
import { useTheme } from '../theme.js';
import type { ThemePreference } from '../theme.js';

const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * Settings' Appearance panel (issue #155) — the light-mode roadmap item Foundations.dc.html
 * chips as "dark only · light on roadmap". Not one of the canvas's own numbered settings panels
 * (Concurrency #126, Default mode #127, Notifications #129 all slot into `SettingsPage.tsx`'s
 * left/right columns per its own doc comment), so this one is additive rather than filling a
 * pre-drawn slot: same `.form-panel`/`Fieldset`/`FormRow` shell every other panel here uses, a
 * `Segmented` three-way switch (the same primitive Simple/Expert and the filter tabs use) rather
 * than a plain `.toggle`, since the real choice is System/Light/Dark, not a boolean.
 *
 * `useTheme()` is the single `ThemeProvider` instance mounted once in `AppRoot.tsx` — this panel
 * only ever reads/writes that shared state, never applies the `data-theme` attribute itself.
 */
export function AppearancePanel() {
  const { preference, setPreference } = useTheme();

  return (
    <div className="form-panel">
      <Fieldset label="Appearance">
        <FormRow label="Theme">
          <Segmented
            options={THEME_OPTIONS}
            value={preference}
            onChange={setPreference}
            aria-label="Theme"
          />
        </FormRow>
        <span className="f-help">
          System matches your OS setting and switches automatically if it changes. Light and dark
          stay fixed until you change this again.
        </span>
      </Fieldset>
    </div>
  );
}
