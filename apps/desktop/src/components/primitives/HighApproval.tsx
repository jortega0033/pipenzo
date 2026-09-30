import { useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from './Button.js';
import { RiskChip } from './Chip.js';
import { Icon } from './Icon.js';
import { Textarea } from './Textarea.js';
import { ApprovalCard, ApprovalP } from './ApprovalCard.js';

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

/**
 * `.approval-card` -- `TicketDetail.dc.html`'s own HIGH card, "inline at the end of the stream"
 * (Pipenzo issue #98, the ticket `ApprovalCard.tsx`'s own doc comment reserved this exact shell
 * for: "the inline HIGH approval card in that same panel ... this ticket only covers the
 * TicketDetail shell"). A different shell from `HighApprovalCard` above, which ports
 * Foundations.dc.html's `.dialog` sample -- the canvas genuinely draws HIGH two ways depending on
 * where it appears, and this is the one that actually sits at the foot of a ticket's own activity
 * stream.
 *
 * **The one reason field is mandatory to Reject, never to Approve.** The canvas's own label reads
 * "Reason, if rejecting … required at HIGH", not "required to decide either way" -- approving a
 * HIGH action needs no written justification, only the human's own unambiguous click on Approve
 * (CLAUDE.md hard rule 3's actual requirement is "never an auto-allow", not "never an unexplained
 * allow"). Reject stays disabled until the *trimmed* reason is non-empty -- there is no way to click
 * through it with a blank or whitespace-only reason -- and the same emptiness rule is re-applied
 * server-side (`pipenzoHighApprovalDecideRequestV1Schema`'s own `superRefine`, and
 * `HighApprovalStore.decide()` again independently), so a caller cannot route around this disabled
 * button by calling the bridge directly with an empty string.
 */
export function HighApprovalStreamCard({
  title = 'Approval needed',
  sub,
  description,
  command,
  precommit,
  reasonPlaceholder = 'Fed back to the next attempt. A rejected HIGH action is never retried on its own.',
  onReject,
  onApprove,
  footNote,
}: {
  title?: ReactNode;
  /** The mono `.approval-sub` line, e.g. `external_side_effect · publish gate · issue-94`. */
  sub: ReactNode;
  description: ReactNode;
  /** The command block's raw text -- one or more lines, rendered `white-space: pre-wrap`. */
  command: string;
  /** A `<PreCommitment status="pending">…</PreCommitment>` -- required at HIGH, same as MEDIUM. */
  precommit: ReactNode;
  reasonPlaceholder?: string;
  /** Called with the trimmed, guaranteed-non-empty reason -- never called at all while the reason
   * is blank, since the Reject button is disabled until then. */
  onReject: (reason: string) => void;
  onApprove: () => void;
  /** The `.approval-foot` rules line, e.g. "OS notification sent 14:02 · no Undo at HIGH · no
   * auto-allow, ever". */
  footNote: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const trimmedReason = reason.trim();

  return (
    <ApprovalCard
      icon="warning"
      title={title}
      sub={sub}
      chip={<RiskChip level="high">HIGH</RiskChip>}
      actions={
        <>
          <Button
            variant="danger"
            icon="x"
            disabled={trimmedReason.length === 0}
            onClick={() => onReject(trimmedReason)}
          >
            Reject
          </Button>
          <Button variant="primary" icon="check" onClick={onApprove}>
            Approve
          </Button>
        </>
      }
      foot={
        <>
          <Icon name="notified" size="sm" />
          <span>{footNote}</span>
        </>
      }
    >
      <ApprovalP>{description}</ApprovalP>
      <pre className="approval-cmd">{command}</pre>
      {precommit}
      <Textarea
        label="Reason, if rejecting"
        requiredNote="required at HIGH"
        rows={2}
        placeholder={reasonPlaceholder}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
    </ApprovalCard>
  );
}

/**
 * The HIGH card's two resolved states (issue #98's own "both resolved states"), `TicketDetail.
 * dc.html`'s `showApprovalAllowed`/`showApprovalRejected` blocks: `outcome: 'approved'` keeps the
 * `ok` (green) tone and a check icon, with the "runs now — there is no Undo at HIGH" sentence;
 * `'rejected'` keeps the card's default (danger/red) tone with an X icon and the "nothing pushed,
 * fed to the next attempt" sentence. Neither ever renders an Undo affordance -- there is no such
 * prop here at all, unlike `MediumApprovalResolved` -- because none exists for HIGH, full stop.
 */
export function HighApprovalResolved({
  outcome,
  title = 'Approval needed',
  sub,
  children,
}: {
  outcome: 'approved' | 'rejected';
  title?: ReactNode;
  sub: ReactNode;
  /** The `.ai-done` sentence, e.g. `<><b>Approved</b> — {cmd} runs now. …</>`. */
  children: ReactNode;
}) {
  return (
    <ApprovalCard
      icon={outcome === 'approved' ? 'check' : 'x'}
      tone={outcome === 'approved' ? 'ok' : 'danger'}
      title={title}
      sub={sub}
      chip={<RiskChip level="high">HIGH</RiskChip>}
    >
      <div className="ai-done">
        <span
          className="d-ic"
          style={
            outcome === 'rejected'
              ? { background: 'var(--color-surface-4)', color: 'var(--color-text)' }
              : undefined
          }
        >
          <Icon name={outcome === 'approved' ? 'check' : 'x'} size="xs" />
        </span>
        <span className="grow">{children}</span>
      </div>
    </ApprovalCard>
  );
}
