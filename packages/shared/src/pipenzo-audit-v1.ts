import { z } from 'zod';
import { pipenzoTicketIdV1Schema } from './schemas.js';
import { PIPENZO_LABELS, pipenzoLabelV1Schema, pipenzoLaneV1Schema } from './pipenzo-ticket-v1.js';
import { pipenzoTicketDivergenceV1Schema } from './pipenzo-phase-machine-v1.js';

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
 * `kind` is a discriminated union on purpose. Two entries are already known to be coming --
 * #160 (an audit entry for every publish/gate result) and #269 (a blown-estimate-miss record) --
 * and neither is built here: each adds its own branch when it lands, rather than this one widening
 * with optional fields most entries would leave unset. What every branch shares is the minimum
 * this ticket actually needs recorded: what happened (`kind`), when (`recordedAt`), which ticket
 * (`ticketId`), and an `outcome`.
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

export const pipenzoAuditEntryV1Schema = z.discriminatedUnion('kind', [
  pipenzoAuditDivergenceEntryV1Schema,
]);

/** What a caller supplies to append a divergence entry; the store fills in the envelope fields
 * (`schemaVersion`/`sequence`/`entryId`/`recordedAt`). A union of one today, growing by one member
 * per future `kind` (#160, #269) rather than this file guessing their shape now. */
export type NewPipenzoAuditEntryV1 = Omit<
  PipenzoAuditDivergenceEntryV1,
  'schemaVersion' | 'sequence' | 'entryId' | 'recordedAt'
>;

export type PipenzoAuditDivergenceEntryV1 = z.infer<typeof pipenzoAuditDivergenceEntryV1Schema>;
export type PipenzoAuditEntryV1 = z.infer<typeof pipenzoAuditEntryV1Schema>;
