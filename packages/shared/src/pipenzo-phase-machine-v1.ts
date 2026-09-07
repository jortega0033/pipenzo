import { z } from 'zod';
import { pipenzoIssueNumberV1Schema, pipenzoRepoRefV1Schema } from './pipenzo-phase-v1.js';
import {
  PIPENZO_LABELS,
  pipenzoLabelV1Schema,
  pipenzoLaneV1Schema,
  pipenzoPhaseV1Schema,
  pipenzoTaskTypeV1Schema,
  pipenzoTicketAttemptV1Schema,
  pipenzoTicketBudgetV1Schema,
  pipenzoTicketEstimateV1Schema,
  pipenzoTicketEtagsV1Schema,
  pipenzoTicketIdV1Schema,
  pipenzoTicketPrecommitV1Schema,
  pipenzoTicketRiskV1Schema,
  pipenzoTicketStackV1Schema,
} from './pipenzo-ticket-v1.js';

/**
 * Wire contracts for the phase machine's routes (Pipenzo issue #188).
 *
 * Same shape rules as `pipenzo-phase-v1.ts`, for the same reasons: a strict request schema, a strict
 * result schema, and a closed error-code union the routes map onto statuses. Two things about this
 * surface are worth stating rather than inferring.
 *
 * ## The wire ticket is not the stored ticket
 *
 * `pipenzoTicketRecordV1Schema` (the persisted record) carries `worktree.path` — a real filesystem
 * path, which the daemon needs because it has to find the worktree it owns. That field cannot cross
 * this boundary. `pipenzo-phase-v1.ts` states the rule for the phase routes already:
 *
 * > **No worktree filesystem path, in either direction.** [...] the renderer starts a session inside
 * > that worktree by id — it is never told where the worktree lives, so it cannot ask the daemon to
 * > run anything in a directory of its own choosing.
 *
 * A ticket route that returned the stored record verbatim would hand the renderer exactly the path
 * the phase routes were careful never to give it, and it would do so through a route nobody thinks
 * of as the worktree surface. So `pipenzoTicketViewV1Schema` below is the record minus that one
 * field: worktree **id** and **branch** cross, the path does not.
 *
 * ## A transition names a label, not a lane
 *
 * Five labels share the Needs-human lane. A caller that could only name a lane could not say *why*
 * a ticket needs a human, and the authoritative value — the label — would have to be guessed from
 * the lane. See `apps/daemon/src/pipenzo-phase-machine.ts`.
 */

/* ------------------------------------------------------------------ the view */

/**
 * The worktree, as the renderer is allowed to see it: addressed by id, never by path. `branch` is
 * safe to send (it is a git ref the operator already sees on the diff screen and in the PR) and is
 * what the ticket detail view actually renders.
 */
export const pipenzoTicketWorktreeViewV1Schema = z
  .object({
    id: z.string().uuid(),
    branch: z.string().min(1).max(255),
  })
  .strict();

/**
 * The ticket as it crosses the wire: `pipenzoTicketRecordV1Schema` with `worktree.path` removed.
 *
 * Spelled out field by field rather than derived with `.omit()` on a nested object, because a
 * `.omit()` deep inside a nested schema is exactly the kind of thing a later refactor silently
 * undoes — and the field it would re-admit is a filesystem path the trust boundary above exists to
 * withhold. Listing the fields makes adding one a deliberate edit.
 */
export const pipenzoTicketViewV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    ticketId: pipenzoTicketIdV1Schema,
    repo: pipenzoRepoRefV1Schema,
    issueNumber: pipenzoIssueNumberV1Schema,
    lane: pipenzoLaneV1Schema,
    phase: pipenzoPhaseV1Schema,
    labels: z
      .array(pipenzoLabelV1Schema)
      .max(PIPENZO_LABELS.length)
      .refine((labels) => new Set(labels).size === labels.length, 'labels must not repeat'),
    estimate: pipenzoTicketEstimateV1Schema,
    taskType: pipenzoTaskTypeV1Schema,
    stack: pipenzoTicketStackV1Schema,
    worktree: pipenzoTicketWorktreeViewV1Schema.optional(),
    attempts: z.array(pipenzoTicketAttemptV1Schema).max(50),
    budget: pipenzoTicketBudgetV1Schema,
    risk: pipenzoTicketRiskV1Schema,
    precommits: z.array(pipenzoTicketPrecommitV1Schema).max(200),
    etags: pipenzoTicketEtagsV1Schema,
  })
  .strict();

/* --------------------------------------------------------- reconciliation */

/**
 * What the machine found when it compared the local record against the issue's labels.
 *
 * - `none` — the two agree.
 * - `lane_reconciled` — they disagreed, the label won, the local record was rewritten.
 * - `ambiguous_labels` — the issue carried more than one lane-bearing label and one had to be
 *   chosen. The renderer should say so: a human put that second label there.
 * - `unlabelled` — the issue carries no lane-bearing `pipenzo:` label, so there was nothing to
 *   reconcile to and the local lane was kept.
 */
export const PIPENZO_TICKET_DIVERGENCE_KINDS = [
  'none',
  'lane_reconciled',
  'ambiguous_labels',
  'unlabelled',
] as const;

export const pipenzoTicketDivergenceV1Schema = z.enum(PIPENZO_TICKET_DIVERGENCE_KINDS);

export const pipenzoTicketReconciliationV1Schema = z
  .object({
    ticket: pipenzoTicketViewV1Schema,
    divergence: pipenzoTicketDivergenceV1Schema,
    /** The lane the local record held before this read. */
    previousLane: pipenzoLaneV1Schema,
    /** Every lane-bearing `pipenzo:` label observed on the issue. */
    observedLabels: z.array(pipenzoLabelV1Schema).max(PIPENZO_LABELS.length),
    /** True when the local record was rewritten as a result of this call. */
    changed: z.boolean(),
  })
  .strict();

/* ------------------------------------------------------------------ requests */

export const pipenzoTicketReadRequestV1Schema = z
  .object({ ticketId: pipenzoTicketIdV1Schema })
  .strict();

/**
 * `label` rather than `lane`, and closed to the vocabulary. The machine additionally refuses
 * `pipenzo:schema-v1` at runtime — it is a marker, not a state — which the schema cannot express
 * without duplicating the lane table here.
 */
export const pipenzoTicketTransitionRequestV1Schema = z
  .object({
    ticketId: pipenzoTicketIdV1Schema,
    label: pipenzoLabelV1Schema,
  })
  .strict();

/* -------------------------------------------------------------- error codes */

/**
 * One closed union for both routes, mapped to statuses in `routes/pipenzo-tickets.ts`. Deliberately
 * a separate union from `PIPENZO_PHASE_ERROR_CODES`: that one covers running a session, cutting a
 * worktree and the review gates, none of which this surface can do, and a union that named all of
 * them would advertise failure modes these two routes cannot produce.
 */
export const PIPENZO_TICKET_ERROR_CODES = [
  'invalid_request',
  'ticket_not_found',
  'illegal_transition',
  'token_missing',
  'invalid_repository',
  'issue_not_found',
  'github_unauthorized',
  'github_forbidden',
  'github_rate_limited',
  'github_failed',
] as const;

export const pipenzoTicketErrorV1Schema = z
  .object({
    code: z.enum(PIPENZO_TICKET_ERROR_CODES),
    error: z.string().min(1).max(4_096),
    details: z.array(z.string().min(1).max(500)).max(20).optional(),
  })
  .strict();

export type PipenzoTicketWorktreeViewV1 = z.infer<typeof pipenzoTicketWorktreeViewV1Schema>;
export type PipenzoTicketViewV1 = z.infer<typeof pipenzoTicketViewV1Schema>;
export type PipenzoTicketDivergenceV1 = z.infer<typeof pipenzoTicketDivergenceV1Schema>;
export type PipenzoTicketReconciliationV1 = z.infer<typeof pipenzoTicketReconciliationV1Schema>;
export type PipenzoTicketReadRequestV1 = z.infer<typeof pipenzoTicketReadRequestV1Schema>;
export type PipenzoTicketTransitionRequestV1 = z.infer<
  typeof pipenzoTicketTransitionRequestV1Schema
>;
export type PipenzoTicketErrorCodeV1 = (typeof PIPENZO_TICKET_ERROR_CODES)[number];
