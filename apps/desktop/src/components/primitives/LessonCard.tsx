import type { ReactNode } from 'react';
import { RLink } from './ApprovalCard.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';

/**
 * `.lesson` prompt state -- from Foundations.dc.html's "Lesson memory" section: local,
 * human-gated, offered once when a ticket resolves. Never written on its own and never sent to a
 * provider; skipping is the default. `value` is pre-filled from something the run actually hit
 * (here, its one pre-commitment mismatch) so the person edits a fact instead of facing a blank
 * box -- the caller owns that pre-fill, this component only renders the field.
 */
export function LessonPrompt({
  value,
  onChange,
  placeholder = 'One line, in your words.',
  onSkip,
  onSave,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onSkip?: () => void;
  onSave?: () => void;
}) {
  return (
    <div className="lesson">
      <div className="lesson-head">
        <Icon name="idea" size="sm" />
        <span className="grow">Worth remembering for next time?</span>
        <span className="mono">optional · you decide</span>
      </div>
      <input
        className="field"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="lesson-foot">
        <span className="lesson-note">
          <Icon name="info" size="sm" />
          <span>Stays in this repo's local ticket store. Nothing is written unless you save it.</span>
        </span>
        <span className="run-acts">
          <Button variant="ghost" size="sm" onClick={onSkip}>
            Skip
          </Button>
          <Button size="sm" icon="check" onClick={onSave}>
            Save lesson
          </Button>
        </span>
      </div>
    </div>
  );
}

/** `.lesson` saved state -- one lesson landed locally on the repo, with a short `RLink` Undo
 * instead of a hard delete (deleting a saved lesson for good is Settings' job). */
export function LessonSaved({
  children,
  onUndo,
}: {
  /** The `.grow` head sentence, e.g. `"Saved locally — 1 lesson on jortega0033/agentdock"`. */
  children: ReactNode;
  onUndo?: () => void;
}) {
  return (
    <div className="lesson">
      <div className="lesson-head">
        <span style={{ color: 'var(--color-ok)' }}>
          <Icon name="check" size="sm" />
        </span>
        <span className="grow">{children}</span>
        <span className="mono">human-gated</span>
      </div>
      <div className="lesson-foot">
        <span className="lesson-note">
          <Icon name="info" size="sm" />
          <span>
            Handed to the next Refine on this repo as context, never as an instruction, and
            deletable in Settings.
          </span>
        </span>
        <span className="run-acts">
          <RLink faint onClick={onUndo}>
            Undo
          </RLink>
        </span>
      </div>
    </div>
  );
}
