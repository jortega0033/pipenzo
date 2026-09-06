import type { InputHTMLAttributes, ReactNode } from 'react';
import { FormField } from './FormField.js';

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id'> {
  label: string;
  help?: ReactNode;
  error?: ReactNode;
  requiredNote?: string;
  /** Mono face for an id, path or branch-name-shaped value -- see the "Branch name override" example. */
  mono?: boolean;
}

/** A filled single-line text input on the label-above/helper-below/error-replaces-helper anatomy. */
export function TextField({
  label,
  help,
  error,
  requiredNote,
  mono,
  ...inputProps
}: TextFieldProps) {
  return (
    <FormField label={label} help={help} error={error} requiredNote={requiredNote}>
      {({ fieldId, describedBy }) => (
        <input
          id={fieldId}
          className={['field', mono && 'mono', error && 'invalid'].filter(Boolean).join(' ')}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...inputProps}
        />
      )}
    </FormField>
  );
}
