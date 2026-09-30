import { z } from 'zod';
import { pipenzoTicketIdV1Schema } from './schemas.js';
import { refineProposedSplitPartV1Schema } from './pipenzo-refine-v1.js';

/**
 * Wire contracts for the stack approval panel (Pipenzo issue #99) -- the human-facing half of the
 * diff-size gate's `stack` verdict (`apps/daemon/src/refine-gate.ts`'s `evaluateDiffSizeGate`),
 * which `refine-gate.ts`'s own doc comment names as "not built by this ticket [#270]; #100's panel
 * and whatever builds the stack-approval flow own it." This is that flow.
 *
 * ## Where the proposed split comes from
 *
 * `RefineSpecV1.proposedSplit` (`pipenzo-refine-v1.ts`, issue #271 widened for #99) is the same
 * decomposition shape the refusal panel renders, now also produced on a `stack` verdict.
 * `PipenzoPhaseService`'s `refine()` persists the whole spec onto the ticket record (`ticket.spec`)
 * the moment a `stack` verdict is reached, specifically so the parts a human decides on later --
 * possibly after a daemon restart -- are the daemon's own record, not something a caller has to
 * re-supply. `capture` reads them back off that record; nothing about capture or decide ever trusts
 * a client-supplied part.
 *
 * ## `capture`/`decide`, mirroring HIGH's own two-step shape (issue #98)
 *
 * Same "block run" property `pipenzoHighApprovalCaptureRequestV1Schema`'s own doc comment gives:
 * `capture` snapshots exactly which parts a human is about to see and mints an id server-side,
 * before a card is ever shown; `decide` can only ever act on that same frozen snapshot. This is the
 * property the security review for this ticket cared about most -- a request that references parts
 * capture never captured, or more of them than capture ever had, cannot reach the code that creates
 * worktrees and GitHub issues. `order` on `decide` is a **permutation of the captured parts'
 * indices**, not a second copy of the parts themselves: the wire schema below only bounds its shape
 * (length, range, no duplicates checked at this layer are a cheap first filter); the exact-length,
 * true-permutation check against *this approval's own captured length* happens in
 * `StackApprovalStore.decide()` (`apps/daemon/src/stack-approval-store.ts`), because only that store
 * knows how many parts this particular approval actually captured. That is also the property that
 * makes an accept bounded: the number of child tickets created is always exactly the captured parts
 * count (already capped at 20 by `refineProposedSplitPartV1Schema`), never a number a malformed
 * request could inflate.
 *
 * ## Mandatory reason on reject, optional repository path split by decision
 *
 * Same discipline HIGH's `pipenzoHighApprovalDecideRequestV1Schema` established: a reject with no
 * (or blank) reason is refused by this schema's own `superRefine`, before `StackApprovalStore
 * .decide()` is ever called -- see that module's own re-check for why this is defense in depth, not
 * the only gate. `repositoryPath` is the mirror image: required only for `accept`, because that is
 * the one decision that provisions real worktrees and needs a real trusted-workspace path to
 * provision them in (the same caller-supplied path every other phase call in this codebase takes --
 * `PipenzoImplementRequestV1.repositoryPath` is the precedent, resolved by the desktop from
 * `/v2/pipenzo/repos/checkout` before either call). A reject never touches a worktree, so it never
 * needs one.
 */

export const PIPENZO_STACK_APPROVAL_DECISIONS = ['accept', 'reject'] as const;
export const pipenzoStackApprovalDecisionV1Schema = z.enum(PIPENZO_STACK_APPROVAL_DECISIONS);

export const pipenzoStackApprovalCaptureRequestV1Schema = z
  .object({
    ticketId: pipenzoTicketIdV1Schema,
  })
  .strict();

export const pipenzoStackApprovalCaptureResultV1Schema = z
  .object({
    approvalId: z.string().uuid(),
    /** The frozen snapshot a human is shown and can reorder -- read back off `ticket.spec
     * .proposedSplit` at capture time, in the order Refine originally proposed it. */
    parts: z.array(refineProposedSplitPartV1Schema).min(1).max(20),
  })
  .strict();

/**
 * `order[i]` is the captured-parts index that ends up at stack position `i` -- a permutation of
 * `[0, parts.length)`, not a second copy of the parts. Bounded to the same `[0, 20)` range
 * `refineProposedSplitPartV1Schema`'s own array caps at; `StackApprovalStore.decide()` re-checks
 * that it is an exact-length, true permutation of *this approval's own* captured parts, which this
 * wire-level bound alone cannot know.
 */
const stackApprovalOrderSchema = z
  .array(z.number().int().nonnegative().max(19))
  .min(1)
  .max(20);

export const pipenzoStackApprovalDecideRequestV1Schema = z
  .object({
    ticketId: pipenzoTicketIdV1Schema,
    approvalId: z.string().uuid(),
    decision: pipenzoStackApprovalDecisionV1Schema,
    order: stackApprovalOrderSchema.optional(),
    reason: z.string().max(2_000).optional(),
    /** Required for `accept` only -- see the module comment. */
    repositoryPath: z.string().min(1).max(4_096).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === 'reject' && (!value.reason || value.reason.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'a reason is required to reject a proposed stack',
      });
    }
    if (value.decision === 'accept') {
      if (!value.order || value.order.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['order'],
          message: 'accepting a stack requires the approved order',
        });
      }
      if (!value.repositoryPath || value.repositoryPath.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repositoryPath'],
          message: 'accepting a stack requires the repository path to provision each child worktree in',
        });
      }
    }
  });

export const pipenzoStackApprovalDecideChildV1Schema = z
  .object({
    ticketId: pipenzoTicketIdV1Schema,
    issueNumber: z.number().int().positive(),
    title: z.string().min(1).max(512),
  })
  .strict();

export const pipenzoStackApprovalDecideResultV1Schema = z
  .object({
    decision: pipenzoStackApprovalDecisionV1Schema,
    /** Present only for `decision: 'accept'`, in the same dependency order the human approved. */
    children: z.array(pipenzoStackApprovalDecideChildV1Schema).max(20).optional(),
  })
  .strict();

/**
 * A closed union of what these two routes can answer with. `materialization_failed` is the one code
 * with no HIGH/MEDIUM analogue: an accept that fails partway through (a GitHub issue create, or a
 * worktree provision, fails on child 2 of 3) is a real, distinct failure mode neither approval-store
 * error code names -- see `pipenzo-stack-materializer.ts`'s own doc comment for what the daemon does
 * with the children that were already created before that happened.
 */
export const PIPENZO_STACK_APPROVAL_ERROR_CODES = [
  'invalid_request',
  'ticket_not_found',
  'approval_not_found',
  'materialization_failed',
  'store_failed',
] as const;

export const pipenzoStackApprovalErrorV1Schema = z
  .object({
    code: z.enum(PIPENZO_STACK_APPROVAL_ERROR_CODES),
    error: z.string().min(1).max(4_096),
  })
  .strict();

export type PipenzoStackApprovalDecisionV1 = z.infer<typeof pipenzoStackApprovalDecisionV1Schema>;
export type PipenzoStackApprovalCaptureRequestV1 = z.infer<
  typeof pipenzoStackApprovalCaptureRequestV1Schema
>;
export type PipenzoStackApprovalCaptureResultV1 = z.infer<
  typeof pipenzoStackApprovalCaptureResultV1Schema
>;
export type PipenzoStackApprovalDecideRequestV1 = z.infer<
  typeof pipenzoStackApprovalDecideRequestV1Schema
>;
export type PipenzoStackApprovalDecideChildV1 = z.infer<
  typeof pipenzoStackApprovalDecideChildV1Schema
>;
export type PipenzoStackApprovalDecideResultV1 = z.infer<
  typeof pipenzoStackApprovalDecideResultV1Schema
>;
export type PipenzoStackApprovalErrorCodeV1 = (typeof PIPENZO_STACK_APPROVAL_ERROR_CODES)[number];
export type PipenzoStackApprovalErrorV1 = z.infer<typeof pipenzoStackApprovalErrorV1Schema>;
