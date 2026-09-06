import type { KeyboardEvent, ReactNode } from 'react';

export interface RadioOption<T extends string> {
  value: T;
  label: ReactNode;
  sub?: ReactNode;
}

/**
 * Box-first radio group -- see the "Radio group" example (Newest first / Oldest first /
 * Alphabetical). Real WAI-ARIA radiogroup semantics: role="radiogroup" on the .fieldset,
 * role="radio" + aria-checked on each option, and roving tabindex (only the selected option is
 * in the tab order; arrow keys move selection between the rest) rather than every option being
 * independently tabbable, matching how a native radio group behaves.
 */
export function RadioGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label?: string;
  options: readonly RadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const move = (delta: number) => {
    const currentIndex = options.findIndex((option) => option.value === value);
    const nextIndex = (currentIndex + delta + options.length) % options.length;
    const next = options[nextIndex];
    if (next) onChange(next.value);
  };

  const onKeyDown = (event: KeyboardEvent, optionValue: T) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      onChange(optionValue);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      move(-1);
    }
  };

  return (
    <div className="fieldset" role="radiogroup" aria-label={label}>
      {label && <span className="f-lbl">{label}</span>}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <span
            key={option.value}
            className="radio"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, option.value)}
          >
            <span className={selected ? 'box on' : 'box'} />
            <span>
              {option.label}
              {option.sub && <span className="sub"> {option.sub}</span>}
            </span>
          </span>
        );
      })}
    </div>
  );
}
