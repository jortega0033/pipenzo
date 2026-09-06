import type { KeyboardEvent, ReactNode } from 'react';
import { Icon } from './Icon.js';

/**
 * Box-first choice control: box, then label, then an optional caption (.sub, caption-sized,
 * never bold) -- see the "Checkbox group" example ("Include timestamps · local time zone").
 * A WAI-ARIA custom checkbox (role="checkbox" on the focusable element itself, Space/Enter to
 * toggle) rather than a <label> around a hidden native input, matching the canvas giving .check
 * its own focus-visible ring directly.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  sub,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  sub?: ReactNode;
  disabled?: boolean;
}) {
  const toggle = () => {
    if (!disabled) onChange(!checked);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      toggle();
    }
  };

  return (
    <span
      className="check"
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={toggle}
      onKeyDown={onKeyDown}
    >
      <span className={checked ? 'box on' : 'box'}>{checked && <Icon name="check" size="sm" />}</span>
      <span>
        {label}
        {sub && <span className="sub"> {sub}</span>}
      </span>
    </span>
  );
}
