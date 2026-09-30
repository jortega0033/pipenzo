import { z } from 'zod';
import { pipenzoTicketIdV1Schema } from './schemas.js';
import { PIPENZO_LABELS, pipenzoLabelV1Schema, pipenzoLaneV1Schema } from './pipenzo-ticket-v1.js';
import { pipenzoTicketDivergenceV1Schema } from './pipenzo-phase-machine-v1.js';
import { PIPENZO_PUBLISH_ERROR_CODES, pipenzoPublishedPullRequestV1Schema } from './pipenzo-publish-v1.js';
import { REVIEW_OUTCOMES, riskGradeV1Schema } from './pipenzo-review-v1.js';

/**
 * Pipenzo's own append-only audit log (issue #149).
 *
 * Deliberately not a field on `auditEntryV2Schema` (`policy-v2.ts`). That schema is agentdock's
 * own inherited permission-approval record -- `.strict()` and closed to
 * `action`/`permissionKey`/`decision`/`actor` -- and a ticket's local lane disagreeing with its
 * GitHub label is not a permission decision. Per `CLAUDE.md`'s "Repo layout note", code under
 * `apps/daemon`/`packages/shared` that came from the agentdock merge is not Pipenzo's to extend for
 * a concept it was never built to hold; this file and `apps/daemon/src/pipenzo-audit-store.ts` are
 * versioned and owned separately from that surface.
 *
 * ## Shape
 *
 * `kind` is a discriminated union on purpose. #160 (an audit entry for every publish/gate result)
 * adds the two branches below; #269 (a blown-estimate-miss record) is still not built here -- it
 * adds its own branch when it lands, rather than this one widening with optional fields most
 * entries would leave unset. What every branch shares is the minimum this ticket actually needs
 * recorded: what happened (`kind`), when (`recordedAt`), which ticket (`ticketId`), and an
 * `outcome`.
 */

export const PIPENZO_AUDIT_SCHEMA_VERSION = 1 as const;

/** Epoch milliseconds, matching `PipenzoReconcilerScheduler.now()` -- the reconciler is today's
 * only writer, and its clock is already epoch-ms rather than an ISO string. */
const timestampSchema = z.number().int().positive();

const pipenzoAuditEntryBaseV1Schema = z.object({
  schemaVersion: z.literal(PIPENZO_AUDIT_SCHEMA_VERSION),
  /** Position in the log, assigned by the store. Lets a reader detect a truncated/corrupt file the
   * same way `audit-store.ts`'s `AuditEntryV2.sequence` does. */
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  entryId: z.string().uuid(),
  recordedAt: timestampSchema,
  ticketId: pipenzoTicketIdV1Schema,
});

/**
 * A lane/label divergence the phase machine's `read()` found and reconciled (README's precedence
 * rule: the label always wins). Written only when the reconciliation actually rewrote the local
 * record -- see `apps/daemon/src/pipenzo-reconciler.ts`'s call site for why a steady-state
 * `ambiguous_labels`/`unlabelled` ticket that has *already* been reconciled does not get a fresh
 * entry on every poll.
 */
export const pipenzoAuditDivergenceEntryV1Schema = pipenzoAuditEntryBaseV1Schema
  .extend({
    kind: z.literal('ticket_divergence'),
    divergence: pipenzoTicketDivergenceV1Schema.exclude(['none']),
    /** The lane the local record held before this reconciliation. */
    previousLane: pipenzoLaneV1Schema,
    /** The lane the local record was reconciled to -- the label GitHub reported won. */
    reconciledLane: pipenzoLaneV1Schema,
    /** Every lane-bearing `pipenzo:` label observed on the issue at reconciliation time. */
    observedLabels: z.array(pipenzoLabelV1Schema).max(PIPENZO_LABELS.length),
    /**
     * Always `'reconciled_to_label'` today: README's precedence rule gives a detected divergence
     * exactly one outcome. Its own field, not folded into `divergence`, because every `kind` this
     * union grows needs an `outcome` and this is the first to establish that it is never left
     * implicit.
     */
    outcome: z.literal('reconciled_to_label'),
  })
  .strict();

/**
 * A completed publish attempt (issue #160), success or failure. Written by `PublishService` for
 * every attempt it can attribute to a ticket -- see that module's own call site for why an attempt
 * against a worktree no ticket record currently claims (never provisioned, or already cleaned up)
 * is silently not written rather than logged with a fabricated `ticketId`, which this schema's
 * `ticketId` (inherited from the base envelope) requires to be real.
 *
 * `outcome` splits the two shapes a publish attempt can take, the same way `reviewReportV1Schema`
 * splits its own outcome-conditional fields -- enforced below, not left as independently optional
 * fields a caller could mismatch.
 */
export const pipenzoAuditPublishEntryV1Schema = pipenzoAuditEntryBaseV1Schema
  .extend({
    kind: z.literal('publish_result'),
    outcome: z.enum(['succeeded', 'failed']),
    operation: z.enum(['push', 'push_and_open_pull_request']),
    worktreeId: z.string().uuid(),
    remote: z.string().min(1).max(100),
    branch: z.string().min(1).max(255),
    /** Present only when `outcome` is `succeeded` -- the commit that actually reached the remote. */
    headSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    /** Present only when `outcome` is `succeeded`. False for an already-up-to-date no-op push. */
    updatedRemote: z.boolean().optional(),
    /** Present only when `outcome` is `succeeded` and the operation opened a pull request. */
    pullRequest: pipenzoPublishedPullRequestV1Schema.optional(),
    /** Present only when `outcome` is `failed` -- `PublishService`'s own closed failure union. */
    errorCode: z.enum(PIPENZO_PUBLISH_ERROR_CODES).optional(),
    /** Present only when `outcome` is `failed`. Already redacted by `PublishServiceError` before
     * this is ever assembled, the same guarantee every other surface that reads that message gets. */
    error: z.string().min(1).max(4_096).optional(),
  })
  .strict();

/**
 * A completed review-gate evaluation (issue #160) -- `ReviewGatesRunner.run()`'s own returned
 * `ReviewReportV1`, written once it exists. Only a run that actually reached an outcome is
 * recorded here; `ReviewGateError` (a malformed spec, a verifier below the implementer's tier, an
 * unreadable diff) means no report was ever produced, and there is nothing to audit-log -- the same
 * "a report exists or nothing happened" property `review-gates.ts`'s own module comment already
 * guarantees the caller.
 *
 * Deliberately narrower than the full `ReviewReportV1`: the deterministic-gate list and the two LLM
 * passes' findings already live on the review report itself (returned to, and rendered by, the
 * diff-review screen) and duplicating them here would be a second, driftable copy of data the audit
 * log does not need in order to answer "what did this review-gate run decide, and when".
 */
export const pipenzoAuditReviewGateEntryV1Schema = pipenzoAuditEntryBaseV1Schema
  .extend({
    kind: z.literal('review_gate_result'),
    outcome: z.enum(REVIEW_OUTCOMES),
    risk: riskGradeV1Schema,
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    headCommit: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

export const pipenzoAuditEntryV1Schema = z
  .discriminatedUnion('kind', [
    pipenzoAuditDivergenceEntryV1Schema,
    pipenzoAuditPublishEntryV1Schema,
    pipenzoAuditReviewGateEntryV1Schema,
  ])
  .superRefine((entry, ctx) => {
    // A publish entry's own outcome-conditional fields (a `ZodEffects` cannot itself be a member of
    // a `z.discriminatedUnion`, so this lives here instead of on `pipenzoAuditPublishEntryV1Schema`
    // directly) -- the same split `reviewReportV1Schema` enforces for its own outcome, just applied
    // one level up.
    if (entry.kind !== 'publish_result') return;
    if (entry.outcome === 'succeeded') {
      if (entry.headSha === undefined || entry.updatedRemote === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['headSha'],
          message: 'a succeeded publish entry requires headSha and updatedRemote',
        });
      }
      if (entry.errorCode !== undefined || entry.error !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['errorCode'],
          message: 'a succeeded publish entry cannot carry an error',
        });
      }
    } else {
      if (entry.errorCode === undefined || entry.error === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['errorCode'],
          message: 'a failed publish entry requires errorCode and error',
        });
      }
      if (
        entry.headSha !== undefined ||
        entry.updatedRemote !== undefined ||
        entry.pullRequest !== undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['headSha'],
          message: 'a failed publish entry cannot carry a push/pull-request result',
        });
      }
    }
  });

/** What a caller supplies to append an entry; the store fills in the envelope fields
 * (`schemaVersion`/`sequence`/`entryId`/`recordedAt`). Grows by one member per future `kind`
 * (#269 next) rather than this file guessing their shape now. */
export type NewPipenzoAuditEntryV1 =
  | Omit<PipenzoAuditDivergenceEntryV1, 'schemaVersion' | 'sequence' | 'entryId' | 'recordedAt'>
  | Omit<PipenzoAuditPublishEntryV1, 'schemaVersion' | 'sequence' | 'entryId' | 'recordedAt'>
  | Omit<PipenzoAuditReviewGateEntryV1, 'schemaVersion' | 'sequence' | 'entryId' | 'recordedAt'>;

export type PipenzoAuditDivergenceEntryV1 = z.infer<typeof pipenzoAuditDivergenceEntryV1Schema>;
export type PipenzoAuditPublishEntryV1 = z.infer<typeof pipenzoAuditPublishEntryV1Schema>;
export type PipenzoAuditReviewGateEntryV1 = z.infer<typeof pipenzoAuditReviewGateEntryV1Schema>;
export type PipenzoAuditEntryV1 = z.infer<typeof pipenzoAuditEntryV1Schema>;
