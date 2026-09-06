import { useState, type ReactNode } from 'react';
import { Button } from './Button.js';
import { Icon } from './Icon.js';

/**
 * Live run controls from Foundations.dc.html's "Live run controls" section. Near-term post-MVP:
 * they sit under the phase stepper on the ticket, and only while a phase is genuinely running --
 * at the publish gate the run has already stopped on its own, so callers render nothing at all
 * rather than a disabled RunControls (a disabled control would imply a session exists to steer or
 * stop). There is deliberately no "absent" state on this component; that decision belongs to
 * whatever renders it, conditionally, based on whether a session is actually live.
 *
 * Four states, one per `state`:
 * - `live`: the pulsing run-dot row, phase/model/elapsed/commit summary, Steer + Stop.
 * - `steer`: one instruction delivered at the next tool boundary. It never rewrites the approved
 *   spec -- the turn is recorded on the ticket and reads in the stream as a human turn.
 * - `stop-confirm`: the only destructive-sounding control here, so it takes a second click and
 *   spends that click explaining what survives -- the commits already made and the worktree.
 * - `stopped`: a stopped run is a human decision with a clean outcome, not a failure -- amber,
 *   not red, and the resulting card is a parked ticket rather than an error.
 */
export type RunControlsProps =
  | {
      state: 'live';
      /** e.g. "Implement is running". */
      phaseLabel: ReactNode;
      /** e.g. "sonnet · 4m 12s · 2 commits on issue-94, nothing pushed". */
      meta: ReactNode;
      onSteer: () => void;
      onStop: () => void;
    }
  | {
      state: 'steer';
      defaultValue?: string;
      placeholder?: string;
      note?: ReactNode;
      onCancel: () => void;
      onSend: (instruction: string) => void;
    }
  | {
      state: 'stop-confirm';
      commitCount: number;
      branch: string;
      worktreePath: string;
      note?: ReactNode;
      onKeepRunning: () => void;
      onStop: () => void;
    }
  | {
      state: 'stopped';
      time: string;
      commitCount: number;
      branch: string;
      worktreePath: string;
      /** The label the ticket parks under, e.g. "pipenzo:needs-human". */
      label: string;
    };

export function RunControls(props: RunControlsProps) {
  switch (props.state) {
    case 'live':
      return (
        <div className="run-controls">
          <div className="run-row">
            <span className="run-live">
              <span className="run-dot" />
              <span>
                <b>{props.phaseLabel}</b> — {props.meta}
              </span>
            </span>
            <span className="run-acts">
              <Button size="sm" icon="message" onClick={props.onSteer}>
                Steer
              </Button>
              <Button size="sm" variant="danger" icon="hand" onClick={props.onStop}>
                Stop
              </Button>
            </span>
          </div>
        </div>
      );

    case 'steer':
      return <SteerPanel {...props} />;

    case 'stop-confirm':
      return <StopConfirmPanel {...props} />;

    case 'stopped':
      return (
        <div className="run-controls">
          <div className="run-row">
            <span className="run-live">
              <WarnIcon />
              <span>
                <b>
                  Stopped at {props.time} — {props.commitCount} commits kept on {props.branch}.
                </b>{' '}
                Worktree <span className="mono">{props.worktreePath}</span> retained, nothing
                pushed. <span className="mono">{props.label}</span>
              </span>
            </span>
          </div>
        </div>
      );
  }
}

function WarnIcon() {
  return (
    <span style={{ color: 'var(--color-warn)', display: 'inline-flex', flexShrink: 0 }}>
      <Icon name="warning" size="sm" />
    </span>
  );
}

function SteerPanel({
  defaultValue = '',
  placeholder = 'e.g. leave the legacy fixture alone for now',
  note = 'The session keeps its context and its spec. Steering is recorded on the ticket and appears in the stream as a human turn — it never rewrites the approved spec or the acceptance criteria.',
  onCancel,
  onSend,
}: Extract<RunControlsProps, { state: 'steer' }>) {
  const [value, setValue] = useState(defaultValue);

  return (
    <div className="run-controls">
      <div className="run-panel">
        <div className="run-row">
          <span className="run-live">
            <span className="run-dot" />
            <span>
              <b>Steer the run</b> — one instruction, delivered at the next tool boundary
            </span>
          </span>
        </div>
        <textarea
          className="field"
          rows={2}
          placeholder={placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="run-foot">
          <span className="run-note">
            <Icon name="info" size="sm" />
            <span>{note}</span>
          </span>
          <span className="run-acts">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" icon="check" onClick={() => onSend(value)}>
              Send
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}

function StopConfirmPanel({
  commitCount,
  branch,
  worktreePath,
  note = 'Nothing is pushed and the branch is not deleted. Picking the ticket up again is a fresh Implement seeded with the same spec, not a continuation.',
  onKeepRunning,
  onStop,
}: Extract<RunControlsProps, { state: 'stop-confirm' }>) {
  return (
    <div className="run-controls">
      <div className="run-panel">
        <div className="run-row">
          <span className="run-live">
            <WarnIcon />
            <span>
              <b>Stop this run?</b>
            </span>
          </span>
        </div>
        <span className="run-note warn">
          <Icon name="warning" size="sm" />
          <span>
            <b>Stop preserves commits.</b> The {commitCount} commits already on{' '}
            <span className="mono">{branch}</span> stay exactly where they are, and the worktree
            at <span className="mono">{worktreePath}</span> is kept. Only the in-flight tool call
            is abandoned.
          </span>
        </span>
        <div className="run-foot">
          <span className="run-note">
            <Icon name="info" size="sm" />
            <span>{note}</span>
          </span>
          <span className="run-acts">
            <Button size="sm" variant="ghost" onClick={onKeepRunning}>
              Keep running
            </Button>
            <Button size="sm" variant="danger" icon="hand" onClick={onStop}>
              Stop and keep commits
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
