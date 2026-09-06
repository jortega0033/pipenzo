import { useId, type ReactNode } from 'react';
import { Icon } from './Icon.js';

/**
 * The shared label-above / control / helper-below anatomy from Foundations.dc.html's "Forms"
 * section (after Primer's FormControl): a label (with an optional `.req` note, e.g. "required
 * at HIGH", rather than a bare asterisk), the control itself, then validation -- `error`
 * replaces `help` rather than the two showing together. TextField/Textarea/Select build on this
 * instead of each re-implementing it.
 *
 * The control is a render prop because it needs the id this component generates (for the
 * label's `htmlFor` and the input's own `id`) and the describedBy id (for `aria-describedby`,
 * pointing at whichever of help/error is currently shown) -- neither the canvas markup itself
 * carries, since a static artboard has no reason to, but which are exactly what keeping this
 * accessible in a real app requires.
 */
export function FormField({
  label,
  requiredNote,
  help,
  error,
  children,
}: {
  label: string;
  requiredNote?: string;
  help?: ReactNode;
  error?: ReactNode;
  children: (field: { fieldId: string; describedBy: string | undefined }) => ReactNode;
}) {
  const fieldId = useId();
  const helpId = `${fieldId}-help`;
  const errorId = `${fieldId}-err`;
  const describedBy = error ? errorId : help ? helpId : undefined;

  return (
    <div>
      <label className="f-lbl" htmlFor={fieldId}>
        {label}
        {requiredNote && <span className="req">{requiredNote}</span>}
      </label>
      {children({ fieldId, describedBy })}
      {error ? (
        <span className="f-err" id={errorId}>
          <Icon name="warning" size="sm" />
          {error}
        </span>
      ) : help ? (
        <span className="f-help" id={helpId}>
          {help}
        </span>
      ) : null}
    </div>
  );
}
