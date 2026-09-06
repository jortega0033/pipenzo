export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /**
   * Always-on and not user-changeable (e.g. a notification channel the app requires rather than
   * offers). Not shown as a distinct example in the canvas -- there's no disabled/locked toggle
   * in Foundations.dc.html to copy exactly -- so this reuses the disabled treatment already
   * established for other controls (opacity 0.6, default cursor) rather than inventing a new
   * one. A locked toggle still renders `on` (it forces `checked`) but can't be interacted with.
   */
  locked?: boolean;
  'aria-label': string;
}

/** The pill switch -- see the "Notifications" example (tray badge / OS notification / sound). */
export function Toggle({ checked, onChange, disabled, locked, ...rest }: ToggleProps) {
  const isDisabled = disabled || locked;
  const isChecked = locked ? true : checked;

  return (
    <button
      type="button"
      className={isChecked ? 'toggle on' : 'toggle'}
      role="switch"
      aria-checked={isChecked}
      disabled={isDisabled}
      onClick={() => onChange(!checked)}
      {...rest}
    />
  );
}
