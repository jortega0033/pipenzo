import { useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from './Button.js';
import { RiskChip } from './Chip.js';
import { Icon } from './Icon.js';
import { Textarea } from './Textarea.js';

/**
 * The HIGH full approval card from Foundations.dc.html's "Risk-graded approval" section --
 * "ApprovalPrompt as a dialog, or inline at the end of the stream" per the canvas's own note, so
 * this renders the `.dialog`-classed content itself rather than assuming a modal shell: drop it
 * straight into the activity stream, or hand it to Dialog/Popover's `children` for the modal
 * case.
 *
 * Anatomy, top to bottom: the danger-tinted `.hi-ic` icon, "Approval needed" title, a mono kind
 * line (`external_side_effect · publish gate · issue-94`), the HIGH risk chip; a prose sentence;
 * the command block; the pre-commitment record (pass a `<PreCommitment status="pending">` --
 * required at HIGH, same as MEDIUM); a mandatory reason textarea (rejecting a HIGH action always
 * needs a reason, unlike MEDIUM's optional one); a split Reject/Approve row; and `.hi-foot`, the
 * rules line that is always true at this risk level -- no Undo, no auto-allow, ever.
 */
export function HighApprovalCard({
  title = 'Approval needed',
  kindLine,
  description,
  command,
  precommit,
  reasonPlaceholder = 'Fed back into the next attempt. A rejected HIGH action is never retried on its own.',
  onReject,
  onApprove,
  footNote,
  width,
}: {
  title?: ReactNode;
  /** The mono line under the title, e.g. `external_side_effect · publish gate · issue-94`. */
  kindLine: ReactNode;
  description: ReactNode;
  /** The command block's raw text -- one or more lines, rendered `white-space: pre-wrap`. */
  command: string;
  /** A `<PreCommitment status="pending">…</PreCommitment>` (or a resolved status, for a card
   * shown after the fact). */
  precommit: ReactNode;
  reasonPlaceholder?: string;
  onReject: (reason: string) => void;
  onApprove: () => void;
  /** The `.hi-foot` rules line, e.g. "OS notification sent 14:02 · no Undo at HIGH · no
   * auto-allow, ever". */
  footNote: ReactNode;
  width?: CSSProperties['width'];
}) {
  const [reason, setReason] = useState('');

  return (
    <div className="dialog" style={width !== undefined ? { width } : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div className="hi-ic">
          <Icon name="warning" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.3 }}>{title}</div>
          <div
            className="mono"
            style={{ fontSize: 12, color: 'var(--color-text-faint)', marginTop: 4 }}
          >
            {kindLine}
          </div>
        </div>
        <RiskChip level="high">HIGH</RiskChip>
      </div>
      <div style={{ fontSize: 13, color: 'var(--color-text-soft)', lineHeight: 1.45 }}>
        {description}
      </div>
      <pre className="codeblock" style={{ background: 'var(--color-surface-4)' }}>
        {command}
      </pre>
      {precommit}
      <Textarea
        label="Reason, if rejecting"
        requiredNote="required at HIGH"
        rows={2}
        placeholder={reasonPlaceholder}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="row-gap" style={{ flexWrap: 'nowrap' }}>
        <Button variant="danger" icon="x" style={{ flex: 1 }} onClick={() => onReject(reason)}>
          Reject
        </Button>
        <Button variant="primary" icon="check" style={{ flex: 1 }} onClick={onApprove}>
          Approve
        </Button>
      </div>
      <div className="hi-foot">
        <Icon name="notified" size="sm" />
        <span>{footNote}</span>
      </div>
    </div>
  );
}
