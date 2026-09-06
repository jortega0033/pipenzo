import { Fragment, type ReactNode } from 'react';
import { Button } from './Button.js';
import { Icon } from './Icon.js';

export interface ResumeKv {
  k: ReactNode;
  v: ReactNode;
}

/**
 * The `.resume` card block from Foundations.dc.html's "pipenzo:interrupted" sample -- the daemon
 * died mid-run. `kv` is the mono last-phase/worktree-path/session-continuability readout
 * (`.resume-kv`); `children` is the `.resume-why` paragraph explaining why nothing auto-resumed.
 *
 * Resume is enabled only when `canResume` is true (a `providerSessionId` AND a
 * `continuationScope` both exist on the interrupted session) -- the button is never a guess that
 * fails after it's pressed. When disabled, `resumeDisabledReason` becomes its `title` so the
 * reason is inspectable rather than just inferred from the greyed-out state. Discard and restart
 * is always enabled: it removes the worktree and starts a fresh session from the same spec: the
 * two actions the canvas's own anatomy note calls out, no third option.
 */
export function Resume({
  head,
  kv,
  children,
  canResume,
  resumeDisabledReason,
  onResume,
  onDiscard,
}: {
  head: ReactNode;
  kv: ResumeKv[];
  /** The `.resume-why` paragraph. */
  children: ReactNode;
  canResume: boolean;
  /** `title` on the Resume button when `canResume` is false. */
  resumeDisabledReason?: string;
  onResume?: () => void;
  onDiscard?: () => void;
}) {
  return (
    <div className="resume">
      <span className="resume-head">
        <Icon name="warning" size="sm" />
        {head}
      </span>
      <div className="resume-kv">
        {kv.map((row, i) => (
          <Fragment key={i}>
            <b>{row.k}</b>
            <span>{row.v}</span>
          </Fragment>
        ))}
      </div>
      <span className="resume-why">{children}</span>
      <div className="resume-acts">
        <Button
          variant="primary"
          size="sm"
          icon="play"
          disabled={!canResume}
          title={!canResume ? resumeDisabledReason : undefined}
          onClick={onResume}
        >
          Resume
        </Button>
        <Button size="sm" icon="undo" onClick={onDiscard}>
          Discard and restart
        </Button>
      </div>
    </div>
  );
}
