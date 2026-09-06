import type { ReactNode, TextareaHTMLAttributes } from 'react';
import { FormField } from './FormField.js';

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className' | 'id'> {
  label: string;
  help?: ReactNode;
  error?: ReactNode;
  requiredNote?: string;
}

/** A filled multi-line field on the same label-above/helper-below/error-replaces-helper anatomy as TextField. */
export function Textarea({ label, help, error, requiredNote, rows = 3, ...textareaProps }: TextareaProps) {
  return (
    <FormField label={label} help={help} error={error} requiredNote={requiredNote}>
      {({ fieldId, describedBy }) => (
        <textarea
          id={fieldId}
          rows={rows}
          className={['field', error && 'invalid'].filter(Boolean).join(' ')}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...textareaProps}
        />
      )}
    </FormField>
  );
}
