import { z } from 'zod';
import { pipenzoTicketIdV1Schema } from './schemas.js';
import { pipenzoTicketRiskV1Schema } from './pipenzo-ticket-v1.js';

/**
 * Wire contracts for the MEDIUM inline approval flow (Pipenzo issue #97).
 *
 * Four routes, one lifecycle, always addressed by `ticketId` + a server-issued `snapshotId` --
 * never by a worktree filesystem path (the same rule `pipenzo-phase-machine-v1.ts` states for the
 * ticket routes: "no worktree filesystem path, in either direction"). `worktreeId` crosses on
 * `capture` only, exactly like `PipenzoImplementDiffRequestV1`'s own `worktreeId` field -- the
 * daemon resolves it to a real path itself (`OwnedWorktreeManager.ownedLocation`), the caller
 * never learns where the worktree lives.
 *
 * ## Why capture and decide are two calls, not one
 *
 * "Render pre-commitment" (the issue's own wording) has to happen *before* a human sees Allow/
 * Reject, and issue #148's undo snapshot has to be taken from the worktree's pre-action state --
 * both of which are only true if the snapshot exists before the approval card is even shown, not
 * at the moment Allow is clicked. Splitting the two calls is what makes "block run" real: the
 * action this gate protects cannot be dispatched until `capture` has already returned a
 * `snapshotId`, and `decide` is the one human-driven answer to it, matching CLAUDE.md hard rule #4
 * (a decision is never auto-retried) by construction -- there is exactly one `decide` call per
 * `snapshotId`, enforced daemon-side (`MediumApprovalStore`), not just by convention here.
 *
 * ## Why `reason` is optional here but the vocabulary is still closed elsewhere
 *
 * The issue's own text: "optional reason" -- a human MAY explain a Reject or an Allow, never must.
 * `decision` itself, by contrast, is a closed two-value enum: there is no third answer a MEDIUM
 * gate can receive that would not just be a slower way of not answering (`session_manager.ts`'s own
 * `ApprovalDecisionV2` allows `allow_session`/`allow_once`/`deny`, a persistent-grant vocabulary
 * that operates on live agent-session tool calls the phase-session dispatch model in this codebase
 * does not use -- see `pipenzo-phase-sessions.ts`'s own module comment on why phase sessions run on
 * the legacy dispatch with no live per-call permission callback yet).
 */

export const PIPENZO_MEDIUM_APPROVAL_DECISIONS = ['allow', 'reject'] as const;
export const pipenzoMediumApprovalDecisionV1Schema = z.enum(PIPENZO_MEDIUM_APPROVAL_DECISIONS);

/**
 * A path relative to the worktree root (or absolute inside it) that the gated action is about to
 * touch -- forwarded verbatim to `captureUndoSnapshot`'s own `touchedPaths`, which validates
 * containment itself. Bounded the same way `pipenzoTicketConcurrencyV1Schema.overlapFile` is: a
 * generous but finite ceiling on both count and length, not a design limit.
 */
const touchedPathV1Schema = z.string().min(1).max(4_096);

export const pipenzoMediumApprovalCaptureRequestV1Schema = z
  .object({
    ticketId: pipenzoTicketIdV1Schema,
    worktreeId: z.string().uuid(),
    /** The branch the worktree is on right now -- recorded on the snapshot so `#148`'s "valid
     * until the next commit on that branch" check has something to compare `HEAD` against later. */
    branch: z.string().min(1).max(255),
    touchedPaths: z.array(touchedPathV1Schema).max(500),
  })
  .strict();

export const pipenzoMediumApprovalCaptureResultV1Schema = z
  .object({ snapshotId: z.string().uuid() })
  .strict();

export const pipenzoMediumApprovalDecideRequestV1Schema = z
  .object({
    ticketId: pipenzoTicketIdV1Schema,
    snapshotId: z.string().uuid(),
    decision: pipenzoMediumApprovalDecisionV1Schema,
    reason: z.string().max(2_000).optional(),
  })
  .strict();

export const pipenzoMediumApprovalDecideResultV1Schema = z
  .object({
    decision: pipenzoMediumApprovalDecisionV1Schema,
    /** Present only for `decision: 'allow'` -- `risk-score.ts`'s own asymmetric reset rule means a
     * `'reject'` never touches the score, so there is nothing to report back for it. */
    risk: pipenzoTicketRiskV1Schema.optional(),
  })
  .strict();

export const pipenzoMediumApprovalStatusRequestV1Schema = z
  .object({ ticketId: pipenzoTicketIdV1Schema, snapshotId: z.string().uuid() })
  .strict();

export const PIPENZO_MEDIUM_APPROVAL_UNAVAILABLE_REASONS = ['expired', 'not_found'] as const;
export const pipenzoMediumApprovalUnavailableReasonV1Schema = z.enum(
  PIPENZO_MEDIUM_APPROVAL_UNAVAILABLE_REASONS,
);

/**
 * The live status poll's own response -- deliberately a boolean plus a closed reason, never a
 * countdown. `#148`'s expiry is "has a commit landed on this branch since capture", checked fresh
 * against real `git rev-parse HEAD` on every call; there is no seconds-remaining value to report
 * because none exists (see `PublishActions.tsx`'s own module comment on why this ticket renders an
 * honest state indicator here instead of forcing a fake timer through `MediumApprovalDone`'s
 * seconds-based prop, which a *different*, already-shipped call site owns).
 */
export const pipenzoMediumApprovalStatusResultV1Schema = z
  .object({
    available: z.boolean(),
    reason: pipenzoMediumApprovalUnavailableReasonV1Schema.optional(),
  })
  .strict();

export const pipenzoMediumApprovalUndoRequestV1Schema = pipenzoMediumApprovalStatusRequestV1Schema;

export const PIPENZO_MEDIUM_APPROVAL_UNDO_FAILURE_REASONS = [
  'expired',
  'not_found',
  'high_risk_blocked',
] as const;
export const pipenzoMediumApprovalUndoFailureReasonV1Schema = z.enum(
  PIPENZO_MEDIUM_APPROVAL_UNDO_FAILURE_REASONS,
);

export const pipenzoMediumApprovalUndoResultV1Schema = z
  .object({
    restored: z.boolean(),
    reason: pipenzoMediumApprovalUndoFailureReasonV1Schema.optional(),
  })
  .strict();

/**
 * A closed union of what these four routes can actually answer with -- deliberately not including
 * a separate `already_decided`: `MediumApprovalStore.decide()` (`apps/daemon/src/medium-
 * approval-store.ts`) reports an unknown id, a wrong ticket, and an already-decided snapshot
 * identically (`undefined`), all three of which the route maps to `snapshot_not_found`. That is a
 * deliberate refusal to distinguish "already decided" from "never existed" on the wire -- the same
 * reasoning `worktree_not_found` vs `ticket_not_found` does *not* apply here on purpose, since a
 * caller cannot legitimately need to tell "this decision was already made" apart from "this id was
 * never real" to do the right thing next (in both cases: stop, do not retry).
 */
export const PIPENZO_MEDIUM_APPROVAL_ERROR_CODES = [
  'invalid_request',
  'ticket_not_found',
  'worktree_not_found',
  'snapshot_not_found',
  'git_unavailable',
  'store_failed',
] as const;

export const pipenzoMediumApprovalErrorV1Schema = z
  .object({
    code: z.enum(PIPENZO_MEDIUM_APPROVAL_ERROR_CODES),
    error: z.string().min(1).max(4_096),
  })
  .strict();

export type PipenzoMediumApprovalDecisionV1 = z.infer<typeof pipenzoMediumApprovalDecisionV1Schema>;
export type PipenzoMediumApprovalCaptureRequestV1 = z.infer<
  typeof pipenzoMediumApprovalCaptureRequestV1Schema
>;
export type PipenzoMediumApprovalCaptureResultV1 = z.infer<
  typeof pipenzoMediumApprovalCaptureResultV1Schema
>;
export type PipenzoMediumApprovalDecideRequestV1 = z.infer<
  typeof pipenzoMediumApprovalDecideRequestV1Schema
>;
export type PipenzoMediumApprovalDecideResultV1 = z.infer<
  typeof pipenzoMediumApprovalDecideResultV1Schema
>;
export type PipenzoMediumApprovalStatusRequestV1 = z.infer<
  typeof pipenzoMediumApprovalStatusRequestV1Schema
>;
export type PipenzoMediumApprovalStatusResultV1 = z.infer<
  typeof pipenzoMediumApprovalStatusResultV1Schema
>;
export type PipenzoMediumApprovalUndoRequestV1 = z.infer<
  typeof pipenzoMediumApprovalUndoRequestV1Schema
>;
export type PipenzoMediumApprovalUndoResultV1 = z.infer<
  typeof pipenzoMediumApprovalUndoResultV1Schema
>;
export type PipenzoMediumApprovalErrorCodeV1 = (typeof PIPENZO_MEDIUM_APPROVAL_ERROR_CODES)[number];
export type PipenzoMediumApprovalErrorV1 = z.infer<typeof pipenzoMediumApprovalErrorV1Schema>;
