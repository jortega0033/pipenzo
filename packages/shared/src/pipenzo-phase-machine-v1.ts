import { z } from 'zod';
import { pipenzoIssueNumberV1Schema, pipenzoRepoRefV1Schema } from './pipenzo-phase-v1.js';
import { riskGradeV1Schema } from './pipenzo-review-v1.js';
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
 * The Working lane's file-overlap-serialisation state (issue #85, a UI-surfacing layer over #164's
 * `evaluateFileOverlapGate` — see `apps/daemon/src/working-lane-concurrency.ts`). Present only on a
 * ticket the ticket-list route has evaluated against every other `working`-lane ticket; a ticket in
 * any other lane, or read through the single-ticket `read`/`transition` routes (which do not have
 * the whole board to compare against), simply omits it — `undefined` there means "not evaluated",
 * never "definitely running".
 */
export const pipenzoTicketConcurrencyV1Schema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('running') }).strict(),
  z
    .object({
      state: z.literal('held'),
      /** The running ticket this one shares a predicted file with. */
      overlapTicketId: pipenzoTicketIdV1Schema,
      overlapIssueNumber: pipenzoIssueNumberV1Schema,
      /** The first (deduplicated) repo-relative path both tickets predict touching. */
      overlapFile: z.string().min(1).max(4_096),
    })
    .strict(),
]);

export type PipenzoTicketConcurrencyV1 = z.infer<typeof pipenzoTicketConcurrencyV1Schema>;

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
    /**
     * The issue title, when this record has cached one (issue #255). Optional for the same reason
     * `pipenzoTicketRecordV1Schema.title` is: a ticket read before this field existed, or before its
     * first reconciling `read()`, has none yet. A board card falls back to `#<issueNumber>` rather
     * than treating an absent title as an error.
     */
    title: z.string().min(1).max(512).optional(),
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
    concurrency: pipenzoTicketConcurrencyV1Schema.optional(),
    attempts: z.array(pipenzoTicketAttemptV1Schema).max(50),
    budget: pipenzoTicketBudgetV1Schema,
    risk: pipenzoTicketRiskV1Schema,
    precommits: z.array(pipenzoTicketPrecommitV1Schema).max(200),
    etags: pipenzoTicketEtagsV1Schema,
    /** See `pipenzoTicketRecordV1Schema.updatedAt` (issue #116) — crosses this boundary unchanged,
     *  it is not a filesystem path and carries no worktree-boundary concern. */
    updatedAt: z.string().min(1).max(64).optional(),
  })
  .strict();

/**
 * The bound on how many tickets one board listing can carry (issue #255). Wire safety, not a
 * design limit -- there is no per-repo ticket cap the way `PIPENZO_MAX_CONNECTED_REPOS` bounds the
 * repo picker, so this is set far above any plausible real backlog rather than derived from one.
 */
export const PIPENZO_MAX_LISTED_TICKETS = 5_000;

/**
 * The board's list route (issue #255): every ticket the daemon's local store knows about, already
 * label-wins reconciled by the polling reconciler (#231) -- never a fan-out of one live GitHub read
 * per ticket, which is exactly what `routes/pipenzo-tickets.ts` used to refuse to serve before that
 * reconciler existed. Flat rather than grouped by lane: `board-lanes.ts`'s `ticketsByLane` already
 * does that client-side, and a wire shape that pre-grouped would be a second place the lane-to-
 * column mapping could drift from `BOARD_LANES`.
 */
export const pipenzoTicketListV1Schema = z
  .object({
    tickets: z.array(pipenzoTicketViewV1Schema).max(PIPENZO_MAX_LISTED_TICKETS),
    /**
     * README's bounded-concurrency default (2 tickets at once, hard cap 4) — the Working lane
     * header's capacity pill denominator (issue #85). Optional, matching `title`'s own reasoning
     * just above: a caller (a hand-built test fixture, an older cached response) that predates this
     * field simply has not answered the question this asks, which is different from the daemon
     * reporting a real cap of zero. Not yet operator-configurable — `NumberStepper.tsx`'s 1-4
     * settings control isn't wired to anything real yet — so every real response carries the same
     * fixed constant (`apps/daemon/src/working-lane-concurrency.ts`'s
     * `PIPENZO_DEFAULT_WORKING_CAPACITY`) until a settings ticket makes it real per-repo state.
     */
    workingLaneCapacity: z.number().int().positive().max(4).optional(),
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

/** Issue #119: opening the ticket's Activity view. No other field -- the reset is unconditional. */
export const pipenzoTicketRiskActivityOpenedRequestV1Schema = z
  .object({ ticketId: pipenzoTicketIdV1Schema })
  .strict();

/**
 * Issues #95/#97/#98: a human approved a MEDIUM- or HIGH-graded action. `effectiveGrade` is the
 * grade actually approved -- for a promoted MEDIUM, that is `'high'`, matching
 * `GradeActionResult.effectiveGrade` (`apps/daemon/src/risk-score.ts`), never the pre-promotion
 * grade.
 */
export const pipenzoTicketRiskApprovalOutcomeRequestV1Schema = z
  .object({
    ticketId: pipenzoTicketIdV1Schema,
    effectiveGrade: riskGradeV1Schema,
  })
  .strict();

/** The response both risk-mutation routes share: the ticket's risk record after the write. */
export const pipenzoTicketRiskResponseV1Schema = z
  .object({ risk: pipenzoTicketRiskV1Schema })
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
  /**
   * The daemon's local ticket store refused a write. Separate from `github_failed` because by the
   * time a transition can hit it the GitHub label is already written: reporting a disk failure as an
   * upstream one would send an operator to check their network for a filesystem problem, and would
   * hide that the authoritative side has already moved.
   */
  'store_failed',
  /**
   * The issue carries a `pipenzo:schema-vN` marker newer than this build understands (issue #74,
   * split of #20's "Label-schema versioning and migration path"). Mirrors
   * `PipenzoPhaseMachineErrorCode`'s own `schema_read_only` -- see
   * `apps/daemon/src/pipenzo-phase-machine.ts` for where it is actually raised. Both `read` and
   * `transition` can report it: the guard trips before either route's own GitHub call.
   */
  'schema_read_only',
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
export type PipenzoTicketListV1 = z.infer<typeof pipenzoTicketListV1Schema>;
export type PipenzoTicketDivergenceV1 = z.infer<typeof pipenzoTicketDivergenceV1Schema>;
export type PipenzoTicketReconciliationV1 = z.infer<typeof pipenzoTicketReconciliationV1Schema>;
export type PipenzoTicketReadRequestV1 = z.infer<typeof pipenzoTicketReadRequestV1Schema>;
export type PipenzoTicketTransitionRequestV1 = z.infer<
  typeof pipenzoTicketTransitionRequestV1Schema
>;
export type PipenzoTicketRiskActivityOpenedRequestV1 = z.infer<
  typeof pipenzoTicketRiskActivityOpenedRequestV1Schema
>;
export type PipenzoTicketRiskApprovalOutcomeRequestV1 = z.infer<
  typeof pipenzoTicketRiskApprovalOutcomeRequestV1Schema
>;
export type PipenzoTicketRiskResponseV1 = z.infer<typeof pipenzoTicketRiskResponseV1Schema>;
export type PipenzoTicketErrorCodeV1 = (typeof PIPENZO_TICKET_ERROR_CODES)[number];
