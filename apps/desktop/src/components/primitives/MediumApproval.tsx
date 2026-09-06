import type { ReactNode } from 'react';
import { Button } from './Button.js';
import { RiskChip } from './Chip.js';
import { Icon } from './Icon.js';

/**
 * `.approval-inline` -- the MEDIUM approval card from Foundations.dc.html's "Risk-graded
 * approval" section: compact, lives inline in the activity stream rather than a dialog (that's
 * HighApprovalCard's `.dialog` shell, for HIGH). Anatomy top to bottom: `.ai-head` (the MEDIUM
 * risk chip, the question, and a mono "blocks the run" note), `.ai-cmd` (the command block),
 * `precommit` (a `<PreCommitment status="pending">`, same requirement as HIGH), an optional
 * single-line reason field -- no visible label in the canvas markup, unlike HIGH's mandatory
 * textarea, so this uses `aria-label` for the accessible name instead of a `.f-lbl` -- and
 * `.ai-foot` (the 60s-notification note plus Reject/Allow).
 */
export function MediumApprovalInline({
  question = 'Allow this step?',
  blocksLabel = 'blocks the run',
  command,
  precommit,
  reason,
  onReasonChange,
  reasonPlaceholder = 'Reason, if rejecting (optional — fed back to the agent)',
  notificationNote,
  onReject,
  onAllow,
}: {
  question?: ReactNode;
  /** The mono note next to the question, e.g. `"blocks the run"`. */
  blocksLabel?: ReactNode;
  /** The command block's raw text, rendered `white-space: pre-wrap`. */
  command: string;
  /** A `<PreCommitment status="pending">…</PreCommitment>`. */
  precommit: ReactNode;
  /** Omit both `reason`/`onReasonChange` to render without the reason field entirely. */
  reason?: string;
  onReasonChange?: (value: string) => void;
  reasonPlaceholder?: string;
  /** The `.ai-note` line, e.g. `"OS pinged after 60 s without an answer (38 s)"`. */
  notificationNote: ReactNode;
  onReject: () => void;
  onAllow: () => void;
}) {
  return (
    <div className="approval-inline">
      <div className="ai-head">
        <RiskChip level="medium">MEDIUM</RiskChip>
        <span className="grow">{question}</span>
        <span className="mono">{blocksLabel}</span>
      </div>
      <div className="ai-cmd">{command}</div>
      {precommit}
      {onReasonChange && (
        <input
          className="field"
          placeholder={reasonPlaceholder}
          aria-label="Reason, if rejecting"
          value={reason ?? ''}
          onChange={(event) => onReasonChange(event.target.value)}
        />
      )}
      <div className="ai-foot">
        <span className="ai-note">
          <Icon name="info" size="sm" />
          <span>{notificationNote}</span>
        </span>
        <span className="ai-acts">
          <Button variant="ghost" size="sm" onClick={onReject}>
            Reject
          </Button>
          <Button variant="primary" size="sm" icon="check" onClick={onAllow}>
            Allow
          </Button>
        </span>
      </div>
    </div>
  );
}

/**
 * `.ai-done` -- the resolved MEDIUM line, once Allow (or an unattended auto-allow) has landed:
 * one row instead of the whole card, with Undo instead of a hard reject -- HIGH offers no
 * equivalent, ever (see HighApprovalCard's `.hi-foot`). `undoSeconds` is the live countdown
 * shown in mono next to the Undo label; the caller owns ticking it down and unmounting/disabling
 * Undo once the window closes.
 */
export function MediumApprovalDone({
  children,
  undoSeconds,
  onUndo,
}: {
  /** The `.ai-done` sentence, e.g. `<><b>Allowed</b> — removing the fixture…</>`. */
  children: ReactNode;
  undoSeconds: number;
  onUndo?: () => void;
}) {
  return (
    <div className="ai-done">
      <span className="d-ic">
        <Icon name="check" size="xs" />
      </span>
      <span className="grow">{children}</span>
      <button type="button" className="ai-undo" onClick={onUndo}>
        <Icon name="undo" size="sm" />
        Undo <span className="mono">{undoSeconds} s</span>
      </button>
    </div>
  );
}
