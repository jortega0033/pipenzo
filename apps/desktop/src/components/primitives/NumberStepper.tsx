import { Icon } from './Icon.js';

/**
 * The 1-4 concurrency-limit stepper -- see "concurrency limit · stepper, 1–4, pill-shaped like
 * every other control". Both arrows disable at their bound (min/max) rather than wrapping or
 * clamping silently, matching the "At the cap" example where the plus button is `disabled` once
 * value === max.
 */
export function NumberStepper({
  value,
  min,
  max,
  onChange,
  'aria-label': ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  'aria-label': string;
}) {
  return (
    <div className="numctl" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        aria-label="Decrease"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <Icon name="minus" size="sm" />
      </button>
      <span className="val">
        {value} <small>/ {max}</small>
      </span>
      <button
        type="button"
        aria-label="Increase"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <Icon name="plus" size="sm" />
      </button>
    </div>
  );
}
