import type { ReactNode } from 'react';
import { Icon } from './Icon.js';

/**
 * `upcoming` (no modifier class -- a step not yet reached, showing its plain number) is added on
 * top of the four the canvas names explicitly, since a stepper with more than one step ahead of
 * `active` needs some way to render them.
 */
export type StepStatus = 'upcoming' | 'done' | 'active' | 'await' | 'fail';

export interface StepSpec {
  id: string;
  label: string;
  status: StepStatus;
  /** The plain step number shown by `active` and `upcoming` -- `done`/`await`/`fail` replace it
   * with an icon instead. */
  number: number;
}

/**
 * The phase stepper from TicketDetail.dc.html's header (`.stepper`/`.step`; the reduced-motion
 * override for `.step.await` was already ported into this theme by an earlier ticket, ahead of
 * the base rule this ticket adds). A variable-length row of pill buttons -- the standard run is
 * Refine/Plan review/Implement/Review/Publish, and a ci-failed ticket grows a 5th step after
 * Publish -- each showing a number until it resolves to a check (`done`), a bell (`await`,
 * amber and pulsing -- the one state that pings the human), or an x (`fail`).
 *
 * Every step is a real `<button>`, clickable regardless of its own status -- the canvas's own
 * markup wires `onClick` unconditionally, and jumping to a past or future phase to look at it is
 * a legitimate action even while a different phase is active.
 *
 * `hint` is the optional trailing `.step-hint` -- a bell-prefixed warn note next to the stepper
 * itself (e.g. "awaiting input"), or its `quiet` (text-faint, no bell by default) variant for a
 * lower-emphasis status line.
 */
export function PhaseStepper({
  steps,
  onSelect,
  hint,
}: {
  steps: StepSpec[];
  onSelect?: (id: string) => void;
  hint?: { text: ReactNode; quiet?: boolean; bell?: boolean };
}) {
  return (
    <div className="stepper">
      {steps.map((step) => (
        <button
          key={step.id}
          type="button"
          className={step.status === 'upcoming' ? 'step' : `step ${step.status}`}
          onClick={() => onSelect?.(step.id)}
        >
          <span className="step-n">{stepNumberContent(step)}</span>
          {step.label}
        </button>
      ))}
      {hint && (
        <span className={hint.quiet ? 'step-hint quiet' : 'step-hint'}>
          {(hint.bell ?? !hint.quiet) && <Icon name="notified" size="sm" />}
          {hint.text}
        </span>
      )}
    </div>
  );
}

function stepNumberContent(step: StepSpec) {
  switch (step.status) {
    case 'done':
      return <Icon name="check" size="sm" />;
    case 'await':
      return <Icon name="notified" size="sm" />;
    case 'fail':
      return <Icon name="x" size="sm" />;
    default:
      return step.number;
  }
}
