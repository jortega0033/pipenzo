import { z } from 'zod';
import { pipenzoTicketIdV1Schema } from './schemas.js';
import { pipenzoTicketRiskV1Schema } from './pipenzo-ticket-v1.js';

/**
 * Wire contracts for the HIGH full publish-gate card (Pipenzo issue #98), the HIGH-risk sibling of
 * the MEDIUM inline approval flow (`pipenzo-medium-approval-v1.ts`, issue #97). Two routes, not
 * four -- see `high-approval-store.ts`'s own module comment for why HIGH has no `status`/`undo`
 * pair at all: CLAUDE.md hard rule #3 ("HIGH-risk actions ... never get an auto-allow, at any
 * point, for any reason") is paired here with the equally absolute rule that a HIGH action never
 * gets an Undo either (`isUndoAvailable` in `undo-snapshot.ts` is an allowlist of exactly
 * `'low' | 'medium'`), so there is nothing for a third or fourth route to poll or restore.
 *
 * ## Why `capture` still exists, with nothing to snapshot
 *
 * The same "block run" property MEDIUM's `capture`/`decide` split buys (a caller cannot dispatch
 * the gated action without first holding an id this store issued) is worth keeping for HIGH too,
 * even though there is no pre-action file content to read here -- `capture` records which ticket
 * and branch this decision is about, server-side, before a human ever sees the card, so `decide`
 * can refuse an id it never issued rather than trust whatever a caller claims. `worktreeId` crosses
 * on `capture` only, exactly like MEDIUM's own contract: the daemon resolves and validates it
 * itself (`OwnedWorktreeManager.ownedLocation`), and the id it hands back (`approvalId`) is
 * deliberately not called `snapshotId` -- there is no snapshot, and a distinct field name makes it
 * structurally obvious at every call site that a HIGH `approvalId` and a MEDIUM `snapshotId` are
 * never interchangeable, even though both happen to be UUIDs.
 *
 * ## Mandatory reason, enforced on the wire itself
 *
 * The issue's own text, and the design canvas both agree on the shape: `TicketDetail.dc.html`'s
 * HIGH card renders exactly one reason field, labelled "Reason, if rejecting … required at HIGH" --
 * mandatory for a Reject, never asked of an Approve (approving needs no justification; the human's
 * own explicit click on "Approve" is the one thing CLAUDE.md hard rule 3 actually requires -- a
 * *human*, not a default, made this call). Unlike MEDIUM's `reason` (optional for either decision,
 * `pipenzo-medium-approval-v1.ts`'s own doc comment), this schema's `.superRefine` refuses a
 * `reject` whose `reason` is missing or blank *before* the request ever reaches
 * `HighApprovalStore.decide()` -- so "no way to submit a HIGH reject without a reason" is a
 * property of the wire contract every caller shares, not just a client-side disabled button one
 * particular UI happens to add. `HighApprovalStore.decide()` re-checks the same rule independently
 * (defense in depth, the same reasoning `restoreUndoSnapshot` re-checks `isUndoAvailable` even
 * though `captureUndoSnapshot` already refused to produce a HIGH snapshot) -- a caller cannot reach
 * an approve-shaped default by constructing a request this schema alone would accept.
 */

export const PIPENZO_HIGH_APPROVAL_DECISIONS = ['approve', 'reject'] as const;
export const pipenzoHighApprovalDecisionV1Schema = z.enum(PIPENZO_HIGH_APPROVAL_DECISIONS);

export const pipenzoHighApprovalCaptureRequestV1Schema = z
  .object({
    ticketId: pipenzoTicketIdV1Schema,
    worktreeId: z.string().uuid(),
    /** The branch the worktree is on right now -- recorded for the audit trail this decision
     * eventually feeds (epic #6's "an audit entry for every publish and gate result"), the same
     * reasoning `pipenzoMediumApprovalCaptureRequestV1Schema.branch` gives. */
    branch: z.string().min(1).max(255),
  })
  .strict();

export const pipenzoHighApprovalCaptureResultV1Schema = z
  .object({ approvalId: z.string().uuid() })
  .strict();

/** A reason is required at the wire level once `decision` is `'reject'` -- see the module comment.
 * `.trim().length > 0` (not merely "present") so a caller cannot satisfy the requirement with an
 * all-whitespace string; the same emptiness test `HighApprovalStore.decide()` applies again
 * server-side. */
export const pipenzoHighApprovalDecideRequestV1Schema = z
  .object({
    ticketId: pipenzoTicketIdV1Schema,
    approvalId: z.string().uuid(),
    decision: pipenzoHighApprovalDecisionV1Schema,
    reason: z.string().max(2_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === 'reject' && (!value.reason || value.reason.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'a reason is required to reject a HIGH-risk action',
      });
    }
  });

export const pipenzoHighApprovalDecideResultV1Schema = z
  .object({
    decision: pipenzoHighApprovalDecisionV1Schema,
    /** Present only for `decision: 'approve'` -- an approved HIGH action always resets the
     * cumulative-risk strip to zero (`risk-score.ts`'s asymmetric reset rule), so there is always a
     * fresh risk record to report back for it; a `'reject'` never touches the score, matching
     * MEDIUM's own reject-never-scores rule. */
    risk: pipenzoTicketRiskV1Schema.optional(),
  })
  .strict();

/**
 * A closed union of what these two routes can answer with. No `snapshot_not_found` here --
 * `approval_not_found` names the thing this store actually holds -- but otherwise mirrors
 * `PIPENZO_MEDIUM_APPROVAL_ERROR_CODES` deliberately, including collapsing "unknown id", "wrong
 * ticket", and "already decided" into the same code: a caller cannot legitimately need to tell
 * those apart to do the right thing next (stop, do not retry -- CLAUDE.md hard rule #4).
 */
export const PIPENZO_HIGH_APPROVAL_ERROR_CODES = [
  'invalid_request',
  'ticket_not_found',
  'worktree_not_found',
  'approval_not_found',
  'store_failed',
] as const;

export const pipenzoHighApprovalErrorV1Schema = z
  .object({
    code: z.enum(PIPENZO_HIGH_APPROVAL_ERROR_CODES),
    error: z.string().min(1).max(4_096),
  })
  .strict();

export type PipenzoHighApprovalDecisionV1 = z.infer<typeof pipenzoHighApprovalDecisionV1Schema>;
export type PipenzoHighApprovalCaptureRequestV1 = z.infer<
  typeof pipenzoHighApprovalCaptureRequestV1Schema
>;
export type PipenzoHighApprovalCaptureResultV1 = z.infer<
  typeof pipenzoHighApprovalCaptureResultV1Schema
>;
export type PipenzoHighApprovalDecideRequestV1 = z.infer<
  typeof pipenzoHighApprovalDecideRequestV1Schema
>;
export type PipenzoHighApprovalDecideResultV1 = z.infer<
  typeof pipenzoHighApprovalDecideResultV1Schema
>;
export type PipenzoHighApprovalErrorCodeV1 = (typeof PIPENZO_HIGH_APPROVAL_ERROR_CODES)[number];
export type PipenzoHighApprovalErrorV1 = z.infer<typeof pipenzoHighApprovalErrorV1Schema>;
