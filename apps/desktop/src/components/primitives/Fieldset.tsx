import type { ReactNode } from 'react';

/** Groups a set of choice controls (Checkbox, or a hand-rolled list) under one label. */
export function Fieldset({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="fieldset">
      {label && <span className="f-lbl">{label}</span>}
      {children}
    </div>
  );
}
