import type { ReactNode, SelectHTMLAttributes } from 'react';
import { FormField } from './FormField.js';
import { Icon } from './Icon.js';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'id' | 'children'> {
  label: string;
  help?: ReactNode;
  error?: ReactNode;
  requiredNote?: string;
  mono?: boolean;
  options: readonly SelectOption[];
}

/** The native <select>, styled to match .field with a caret icon overlaid via .select-wrap -- see the "Run budget" example. */
export function Select({
  label,
  help,
  error,
  requiredNote,
  mono,
  options,
  ...selectProps
}: SelectProps) {
  return (
    <FormField label={label} help={help} error={error} requiredNote={requiredNote}>
      {({ fieldId, describedBy }) => (
        <span className="select-wrap">
          <select
            id={fieldId}
            className={['field', mono && 'mono', error && 'invalid'].filter(Boolean).join(' ')}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            {...selectProps}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Icon name="caret-down" />
        </span>
      )}
    </FormField>
  );
}
