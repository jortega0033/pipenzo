import type { ReactNode } from 'react';

/** Label-left/control-right row, e.g. a single toggle inside a fieldset -- see "Notifications". */
export function FormRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="f-row">
      <span style={{ fontSize: 13 }}>{label}</span>
      {children}
    </div>
  );
}
