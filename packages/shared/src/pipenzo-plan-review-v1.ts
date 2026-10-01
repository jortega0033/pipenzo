import { z } from 'zod';
import { pipenzoTicketIdV1Schema, providerIdSchema } from './schemas.js';
import {
  refineAcceptanceCriterionV1Schema,
  refineEstimateV1Schema,
} from './pipenzo-refine-v1.js';

/**
 * Wire contracts for the plan-review gate (Pipenzo issue #15, UI half #101): the real blocking
 * checkpoint between Refine completing and Implement starting that README's near-term list and
 * `TicketDetail.dc.html`'s ticket #98 mockup both describe -- "the human sees the spec ... and
 * explicitly approves, requests changes, or rejects -- rather than Implement starting
 * automatically the moment Refine finishes."
 *
 * ## Why this is a separate file from `pipenzo-stack-approval-v1.ts`, not a widened copy of it
 *
 * The *shape* mirrors stack approval's own capture/decide split (issue #99) for the same "block
 * run" reason that module's doc comment gives: a caller cannot dispatch the gated action (here,
 * `PipenzoPhaseService.implement()`) without first holding an id this flow's store issued for
 * exactly the spec it captured. But the *content* is different in a way that matters: stack
 * approval captures a `proposedSplit` (an array of parts a human reorders); this captures the
 * whole plan a human is being asked to approve as a unit -- EARS acceptance criteria, the
 * out-of-scope list, files likely touched, and the diff-size estimate, i.e. almost all of
 * `RefineSpecV1` minus the bookkeeping fields (`schemaVersion`, `issue`) a ticket's own
 * `repo`/`issueNumber` already carry, and `proposedSplit`, which only ever accompanies a
 * `refuse`/`stack` verdict and therefore never coexists with a clean verdict's plan-review gate.
 *
 * ## Three decisions, not two
 *
 * `PIPENZO_PLAN_REVIEW_DECISIONS` has three members where stack approval's own
 * `PIPENZO_STACK_APPROVAL_DECISIONS` has two, because the issue body names three real consequences:
 * `approve` (Implement actually starts -- the real dispatch call that used to fire the moment
 * Refine finished now waits here instead), `request_changes` (the ticket goes back to
 * `pipenzo:queued` carrying the human's feedback text, which the next `refine()` call for this
 * ticket reads back and feeds to the Refine subagent -- see `PipenzoPhaseService
 * .requestPlanReviewChanges()`'s own doc comment for exactly how), and `reject` (the ticket parks
 * under the bare `pipenzo:needs-human` label -- README's own existing "a denied approval" reading
 * of that label, not a new one invented for this ticket).
 *
 * `approve` needs the same dispatch inputs `pipenzoImplementRequestV1Schema` takes (minus `spec`
 * and `ticketId`, both already known server-side once a ticket's local `awaitingPlanReview` marker
 * is set -- see `pipenzo-ticket-v1.ts`'s own `awaitingPlanReview` field doc comment for why the
 * cached spec, not a client-resent copy, is what `decide()` dispatches with). `request_changes`
 * needs the feedback text. `reject` needs the reason. `superRefine` below enforces exactly one of
 * those three shapes
 * per decision, the same defense-in-depth stack approval's own schema already establishes --
 * `PlanReviewStore.decide()` re-checks the same invariants independently, because a wire-level
 * check alone is advisory the moment anything calls the store directly.
 */

export const PIPENZO_PLAN_REVIEW_DECISIONS = ['approve', 'request_changes', 'reject'] as const;
export const pipenzoPlanReviewDecisionV1Schema = z.enum(PIPENZO_PLAN_REVIEW_DECISIONS);

/**
 * The narrow, wire-safe slice of `RefineSpecV1` a plan-review decision is judged against --
 * everything the issue body asks the human to see ("EARS-notation acceptance criteria, out-of-scope
 * list, files likely touched, diff-size estimate") plus `summary` and `openQuestions` for the same
 * reason `ImplementDialog.tsx`'s own `RefineSpecReview` renders them: a human approving a plan reads
 * the same plan an implementer would be handed, not a trimmed summary of it.
 */
export const pipenzoPlanReviewSpecV1Schema = z
  .object({
    summary: z.string().min(1).max(4_000),
    acceptanceCriteria: z.array(refineAcceptanceCriterionV1Schema).min(1).max(50),
    outOfScope: z.array(z.string().min(1).max(500)).min(1).max(50),
    filesLikelyTouched: z.array(z.string().min(1).max(1_024)).max(200),
    estimate: refineEstimateV1Schema,
    openQuestions: z.array(z.string().min(1).max(1_000)).max(20),
  })
  .strict();

export const pipenzoPlanReviewCaptureRequestV1Schema = z
  .object({
    ticketId: pipenzoTicketIdV1Schema,
  })
  .strict();

export const pipenzoPlanReviewCaptureResultV1Schema = z
  .object({
    approvalId: z.string().uuid(),
    /** The frozen plan a human is shown -- read back off `ticket.spec` at capture time, never
     * re-derived from a client-supplied copy. */
    spec: pipenzoPlanReviewSpecV1Schema,
  })
  .strict();

const noControlCharacters = (value: string): boolean =>
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
  });

export const pipenzoPlanReviewDecideRequestV1Schema = z
  .object({
    ticketId: pipenzoTicketIdV1Schema,
    approvalId: z.string().uuid(),
    decision: pipenzoPlanReviewDecisionV1Schema,
    /** Required for `request_changes` only. */
    feedback: z
      .string()
      .max(4_000)
      .refine(noControlCharacters, 'must not contain control characters')
      .optional(),
    /** Required for `reject` only -- posted to the issue, mirroring `reason` on the stack-approval
     * and HIGH decide requests. */
    reason: z.string().max(2_000).optional(),
    /**
     * Required for `approve` only -- the same `PipenzoImplementRequestV1` inputs the dispatch
     * needs beyond `spec`/`ticketId`, both of which the daemon already has cached once a ticket's
     * local `awaitingPlanReview` marker was set. Nested rather than flattened so this schema's own
     * field list stays a visibly closed, small thing even as the implement request itself grows.
     */
    implement: z
      .object({
        repositoryPath: z.string().min(1).max(4_096),
        provider: providerIdSchema,
        model: z.string().min(1).max(256).optional(),
        baseRef: z.string().min(1).max(255).optional(),
        extraInstructions: z
          .string()
          .max(4_000)
          .refine(noControlCharacters, 'must not contain control characters')
          .optional(),
        acknowledgeIncludeSecretRisk: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === 'request_changes' && (!value.feedback || value.feedback.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['feedback'],
        message: 'requesting changes requires feedback for the next Refine pass',
      });
    }
    if (value.decision === 'reject' && (!value.reason || value.reason.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'a reason is required to reject a plan review',
      });
    }
    if (value.decision === 'approve' && !value.implement) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['implement'],
        message: 'approving a plan review requires the inputs Implement will dispatch with',
      });
    }
  });

export const pipenzoPlanReviewDecideResultV1Schema = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('approve'),
      worktreeId: z.string().uuid(),
      branch: z.string().min(1).max(255),
      baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
      sessionId: z.string().min(1).max(128),
    })
    .strict(),
  z.object({ decision: z.literal('request_changes') }).strict(),
  z.object({ decision: z.literal('reject') }).strict(),
]);

/**
 * A closed union of what these two routes can answer with, matching `PipenzoStackApprovalErrorCodeV1`'s
 * own shape -- `ticket_not_found` deliberately collapses "no such ticket" with "ticket's local
 * `awaitingPlanReview` marker is not genuinely set", the same way HIGH's and stack approval's own
 * error codes already collapse distinct not-found cases a caller cannot legitimately need to tell
 * apart to do the right thing next.
 */
export const PIPENZO_PLAN_REVIEW_ERROR_CODES = [
  'invalid_request',
  'ticket_not_found',
  'approval_not_found',
  'implement_failed',
  'store_failed',
] as const;

export const pipenzoPlanReviewErrorV1Schema = z
  .object({
    code: z.enum(PIPENZO_PLAN_REVIEW_ERROR_CODES),
    error: z.string().min(1).max(4_096),
  })
  .strict();

export type PipenzoPlanReviewDecisionV1 = z.infer<typeof pipenzoPlanReviewDecisionV1Schema>;
export type PipenzoPlanReviewSpecV1 = z.infer<typeof pipenzoPlanReviewSpecV1Schema>;
export type PipenzoPlanReviewCaptureRequestV1 = z.infer<
  typeof pipenzoPlanReviewCaptureRequestV1Schema
>;
export type PipenzoPlanReviewCaptureResultV1 = z.infer<
  typeof pipenzoPlanReviewCaptureResultV1Schema
>;
export type PipenzoPlanReviewDecideRequestV1 = z.infer<
  typeof pipenzoPlanReviewDecideRequestV1Schema
>;
export type PipenzoPlanReviewDecideResultV1 = z.infer<typeof pipenzoPlanReviewDecideResultV1Schema>;
export type PipenzoPlanReviewErrorCodeV1 = (typeof PIPENZO_PLAN_REVIEW_ERROR_CODES)[number];
export type PipenzoPlanReviewErrorV1 = z.infer<typeof pipenzoPlanReviewErrorV1Schema>;
