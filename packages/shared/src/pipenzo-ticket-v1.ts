import { z } from 'zod';
import { pipenzoIssueNumberV1Schema, pipenzoRepoRefV1Schema } from './pipenzo-phase-v1.js';
import { modelTierSchema } from './pipenzo-review-v1.js';
import { pipenzoTicketIdV1Schema } from './schemas.js';

export { pipenzoTicketIdV1Schema } from './schemas.js';

/**
 * The ticket-store schema and the `pipenzo:` label vocabulary (build step 3, Pipenzo issue #187).
 *
 * README's *Ticket store — what it actually holds* states the precedence rule this file exists to
 * make checkable rather than remembered: **GitHub labels are authoritative for a ticket's `lane`;
 * this store is authoritative for everything GitHub can't hold** — worktree id and path, session
 * and attempt lineage, budget consumed, the risk score, pre-commitment events, poll ETags. Two
 * stores, one precedence rule, and this schema is the shape of the second one.
 *
 * The ten `pipenzo:` labels live here too, not sprinkled as string literals across the daemon and
 * the desktop renderer (README: "every label Pipenzo writes is `pipenzo:`-prefixed — no bare
 * names"). One copy of the vocabulary is what turns that rule from something a reviewer checks by
 * eye into something the type checker enforces: a label typo becomes a compile error instead of a
 * silently-dead lane transition.
 *
 * ## What this file deliberately does not build
 *
 * No phase machine (state-transition logic between `lane`/`phase` values lives in #188), no
 * migration path for a schema bump (README's *rename-on-bump* rule is #162), and no crash-recovery
 * marking (mapping an interrupted session back onto a ticket is #190). This is the record shape and
 * the vocabulary two later tickets read and write — not the behavior that reads and writes it.
 */

/* -------------------------------------------------------------- label namespace and vocabulary */

/**
 * The one label namespace Pipenzo owns.
 *
 * This constant used to live only in `apps/daemon/src/github-client.ts`, next to the write guard
 * that refuses to touch a label outside it. It moved here — and the daemon now imports it back —
 * because the guard and the vocabulary are two different concerns that happened to share a string.
 * `github-client.ts` decides *what a write is allowed to touch* (a daemon-only, network-adjacent
 * concern); this module decides *which labels exist and what they mean* (a vocabulary both the
 * daemon and the desktop renderer need, since `packages/shared` is the one package both can import
 * without the layering violation of a renderer reaching into `apps/daemon`). Keeping the guard in
 * `github-client.ts` and moving only the string plus the vocabulary here means neither copy can
 * drift from the other: there is exactly one `'pipenzo:'` literal in the whole codebase now.
 */
export const PIPENZO_LABEL_NAMESPACE = 'pipenzo:';

/** True for a label Pipenzo is allowed to add, remove, or reason about as its own state. */
export function isPipenzoLabel(name: string): boolean {
  return name.startsWith(PIPENZO_LABEL_NAMESPACE);
}

/**
 * All ten labels, copied verbatim from README's label table so this is the one place a name can be
 * gotten wrong and caught. Order matches the table: the four lane-bearing states in their normal
 * forward progression, the four Needs-human variants, and the two labels with no lane at all.
 */
export const PIPENZO_LABELS = [
  'pipenzo:queued',
  'pipenzo:working',
  'pipenzo:ready-for-review',
  'pipenzo:needs-human',
  'pipenzo:needs-pre-scoping',
  'pipenzo:awaiting-stack-approval',
  'pipenzo:ci-failed',
  'pipenzo:merge-conflict',
  'pipenzo:interrupted',
  'pipenzo:schema-v1',
] as const;

export type PipenzoLabelV1 = (typeof PIPENZO_LABELS)[number];
export const pipenzoLabelV1Schema = z.enum(PIPENZO_LABELS);

/**
 * The marker README's *Schema versioning* section names: an issue carrying this label was written
 * by a v1-schema Pipenzo, so an instance that meets a newer marker on the same repo knows to go
 * read-only rather than write v1 semantics over v2 state. Checked against `PipenzoLabelV1` rather
 * than declared as a bare string so it cannot drift from the entry in `PIPENZO_LABELS` above.
 *
 * `as const satisfies` rather than the `: PipenzoLabelV1` annotation this used to carry. The
 * annotation widened the constant from its literal type to the whole ten-member union, which made
 * `Exclude<PipenzoLabelV1, typeof PIPENZO_SCHEMA_V1_MARKER_LABEL>` — how the phase machine (#188)
 * names "a label that actually carries a lane" — exclude the union from itself and quietly evaluate
 * to `never`. `satisfies` keeps the drift check this comment is about and leaves the literal intact.
 */
export const PIPENZO_SCHEMA_V1_MARKER_LABEL = 'pipenzo:schema-v1' as const satisfies PipenzoLabelV1;

/**
 * The four real lanes a ticket can occupy on the board. Smaller than `PIPENZO_LABELS` on purpose:
 * README's label table lists four *Needs human* variants (`needs-human`, `needs-pre-scoping`,
 * `awaiting-stack-approval`, the crash marker `interrupted`, and the CI-failure marker
 * `merge-conflict`) that all render in the same kanban column. `lane` is the column; `labels` is
 * which of the ten actually put the card there and why.
 */
export const PIPENZO_LANES = ['queued', 'working', 'ready-for-review', 'needs-human'] as const;

export type PipenzoLaneV1 = (typeof PIPENZO_LANES)[number];
export const pipenzoLaneV1Schema = z.enum(PIPENZO_LANES);

/**
 * The static label→lane mapping from README's table. `pipenzo:schema-v1` maps to `null` — it is a
 * marker, never a lane, and a ticket can carry it alongside any of the other nine.
 *
 * **`pipenzo:ci-failed` is deliberately mapped to `needs-human`, not to a conditional value.**
 * README's table row reads "Needs human → Ready for review once the fix commits": the *label*
 * stays on the ticket through that whole lifecycle, but the *lane* a ticket carrying it renders in
 * changes the moment the forked fix attempt commits. That transition is state-transition behavior —
 * exactly what the phase machine (#188) owns — and encoding it here as a lookup table would mean
 * guessing at logic this ticket does not build. This map states the one fact that is static: which
 * lane a bare label belongs to before any phase-machine reasoning is applied.
 */
export const PIPENZO_LABEL_LANES: Readonly<Record<PipenzoLabelV1, PipenzoLaneV1 | null>> =
  Object.freeze({
    'pipenzo:queued': 'queued',
    'pipenzo:working': 'working',
    'pipenzo:ready-for-review': 'ready-for-review',
    'pipenzo:needs-human': 'needs-human',
    'pipenzo:needs-pre-scoping': 'needs-human',
    'pipenzo:awaiting-stack-approval': 'needs-human',
    'pipenzo:ci-failed': 'needs-human',
    'pipenzo:merge-conflict': 'needs-human',
    'pipenzo:interrupted': 'needs-human',
    'pipenzo:schema-v1': null,
  });

/* ---------------------------------------------------------------------------------- ticket phase */

/**
 * Which of the three built phase contracts (`pipenzo-refine-v1.ts`, this implement flow, and
 * `pipenzo-review-v1.ts`) a ticket is in or last completed. Distinct from `lane`, which mirrors the
 * GitHub label and is the thing a human reads on the board — `phase` is what the daemon reads to
 * decide which session type to dispatch next.
 *
 * Deliberately three values, not four. The design canvas's ticket-detail stepper shows a fourth
 * step, "Approve" (`awaiting_approval`) — but that step is not a distinct unit of agent work the
 * way Refine/Implement/Review are: it is the human push gate, and a ticket sitting at it has
 * `phase: 'review'` (Review is what last ran) with `lane: 'ready-for-review'` (the label already
 * says a human is being waited on). Adding a fourth phase for a lane that already carries this
 * information would be the two stores disagreeing about which of them owns it.
 */
export const PIPENZO_PHASES = ['refine', 'implement', 'review'] as const;

export type PipenzoPhaseV1 = (typeof PIPENZO_PHASES)[number];
export const pipenzoPhaseV1Schema = z.enum(PIPENZO_PHASES);

/* ---------------------------------------------------------------------------------- task type */

/**
 * Refine's classification of the ticket, emitted alongside the size estimate (`Models.dc.html`'s
 * task-type-aware-routing table; README lists it under near-term post-MVP). The five values and
 * their measured merge rates come from that table, not from this ticket: 7,156 agent PRs, MSR 2026
 * mining challenge.
 *
 * The field is in the schema now even though *routing* on it is stated as post-MVP, because Refine
 * already narrates a classification today (`TicketDetail.dc.html`: "Classified this as fix…",
 * "Classified this as chore…") and a ticket record needs somewhere to keep what Refine already
 * says before the router that reads it exists.
 */
export const PIPENZO_TASK_TYPES = ['chore', 'docs', 'feature', 'fix', 'perf'] as const;

export type PipenzoTaskTypeV1 = (typeof PIPENZO_TASK_TYPES)[number];
export const pipenzoTaskTypeV1Schema = z.enum(PIPENZO_TASK_TYPES);

/* ---------------------------------------------------------------------------------- sub-shapes */

/**
 * The diff-size prediction, persisted under the field names README's own ticket-store JSON uses —
 * `lines` / `files` — rather than `refineEstimateV1Schema`'s `changedLines` / `filesTouched`.
 *
 * This is not an oversight; the two schemas are for different boundaries. `refineEstimateV1Schema`
 * is the Refine phase's *wire* contract (issue #179), already shipped with those names, and
 * changing them would be a breaking change to a contract this ticket does not own. The persisted
 * ticket record is a separate boundary — README's own worked example spells the field names
 * `lines`/`files` — and a strict schema has to pick one spelling for a field that cannot legally
 * have both `lines` and `changedLines` present at once. The values mean the same thing; only the
 * boundary they cross, and therefore the name they cross it under, differs.
 */
export const pipenzoTicketEstimateV1Schema = z
  .object({
    lines: z.number().int().nonnegative().max(1_000_000),
    files: z.number().int().nonnegative().max(10_000),
    layered: z.boolean(),
  })
  .strict();

/**
 * The decomposition a ticket belongs to, when README's `awaiting-stack-approval` split produced
 * one. `parentId`/`index` are `null` (not just absent) for a standalone ticket, matching README's
 * own worked example — a stack position that is *unknown* would be `undefined`, but a ticket
 * outside any stack has a position that is definitively nothing, which `null` says and `undefined`
 * only implies.
 */
export const pipenzoTicketStackV1Schema = z
  .object({
    parentId: pipenzoTicketIdV1Schema.nullable().optional(),
    /** Materialised child tickets, one per stack entry. README caps a stack at 2-4 entries; the
     *  bound below is generous rather than exact so a re-decomposition is never the thing that
     *  makes a valid ticket unrepresentable. */
    childIds: z
      .array(pipenzoTicketIdV1Schema)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, 'childIds must not repeat'),
    /** This ticket's 0-based position within its stack. */
    index: z.number().int().nonnegative().max(50).nullable().optional(),
  })
  .strict();

/**
 * Where the ticket's work happens on disk. Present once Implement has provisioned a worktree, and
 * absent before that — the design canvas's own ticket-detail specimens show tickets still at Refine
 * with "no worktree yet" in their subtitle, so a record cannot require this and still describe
 * every real ticket.
 *
 * **Carrying `path` here is not a contradiction of `pipenzo-phase-v1.ts`'s "no worktree filesystem
 * path, in either direction" rule.** That rule is about the *wire* contracts the renderer can read —
 * the renderer starts sessions by worktree id precisely so it never learns a real filesystem path.
 * This schema is the daemon's own on-disk record, the trust boundary that rule exists to protect,
 * not a payload that crosses it. README's worked example persists a real `path` for exactly this
 * reason: the daemon needs to find the worktree it already owns.
 */
export const pipenzoTicketWorktreeV1Schema = z
  .object({
    id: z.string().uuid(),
    path: z.string().min(1).max(4_096),
    branch: z.string().min(1).max(255),
  })
  .strict();

/**
 * One dispatched session against this ticket. `attempts[]` is what carries lineage across a tier
 * escalation, where the provider thread does not (README, *Model routing*: "tier escalations start
 * a fresh session because a fork's model is frozen") — without this array, an escalated retry would
 * look to the ticket store like an unrelated session that happened to touch the same issue.
 *
 * **`outcome` is a bounded string, not a closed enum.** It looks like it should be one — README's
 * own worked example writes `"outcome": "gate_failed"` — but the attempt-outcome vocabulary is the
 * phase machine's to define (#188), which does not exist in this codebase yet. The closest thing
 * that *does* exist, `REVIEW_OUTCOMES` in `pipenzo-review-v1.ts`, uses `'deterministic_failed'` for
 * the same event README's example calls `gate_failed` — two different names for one event, from two
 * pieces of this same epic, is direct evidence the vocabulary is still moving. Inventing a closed
 * union here would mean guessing which of those two (or a third) name wins, which is exactly the
 * kind of forward-incompatibility this ticket's schema-refusal rule exists to avoid — just at the
 * field level instead of the manifest level.
 */
export const pipenzoTicketAttemptV1Schema = z
  .object({
    sessionId: z.string().min(1).max(128),
    tier: modelTierSchema,
    model: z.string().min(1).max(256),
    outcome: z.string().min(1).max(64),
  })
  .strict();

/**
 * Token spend against this ticket. `limit: 0` is README's worked example and means "no limit
 * configured" rather than "zero tokens allowed" — a ticket with a real zero-token budget could never
 * dispatch a single session, which is not a state anything in this design produces.
 */
export const pipenzoTicketBudgetV1Schema = z
  .object({
    tokensUsed: z.number().int().nonnegative().max(2_147_483_647),
    limit: z.number().int().nonnegative().max(2_147_483_647),
  })
  .strict();

/**
 * README's cumulative-risk strip, persisted. `score` is bounded to `[0, 10]` — README states the
 * threshold is 10 and the strip is explicitly "capped at the threshold" past it, so a score above
 * ten is not a bigger risk, it is a bug in whatever wrote it. `lastResetAt` records the one event
 * that zeroes the counter: "only a HIGH approval, or an explicit 'I've looked'… resets the score to
 * zero" — a MEDIUM approval deliberately does not touch this field.
 */
export const pipenzoTicketRiskV1Schema = z
  .object({
    score: z.number().min(0).max(10),
    lastResetAt: z.string().min(1).max(64),
  })
  .strict();

/** The real-versus-predicted comparison README's pre-commitment records reduce to. */
export const PIPENZO_PRECOMMIT_VERDICTS = ['match', 'mismatch'] as const;
export type PipenzoPrecommitVerdictV1 = (typeof PIPENZO_PRECOMMIT_VERDICTS)[number];
export const pipenzoPrecommitVerdictV1Schema = z.enum(PIPENZO_PRECOMMIT_VERDICTS);

/**
 * One pre-commitment record (README: "before every MEDIUM/HIGH action the implementer posts what
 * it is about to run, what it expects to happen, and what it will do if wrong; the real outcome is
 * appended and diffed against the prediction"). `action`/`expect`/`ifWrong`/`outcome` are prose —
 * the implementer's own words, not a fixed vocabulary, which is why they stay bounded strings while
 * `verdict` is the one field a machine actually decides.
 */
export const pipenzoTicketPrecommitV1Schema = z
  .object({
    action: z.string().min(1).max(2_000),
    expect: z.string().min(1).max(2_000),
    ifWrong: z.string().min(1).max(2_000),
    outcome: z.string().min(1).max(2_000),
    verdict: pipenzoPrecommitVerdictV1Schema,
  })
  .strict();

/**
 * Per-`(repo, resource)` conditional-request ETags (README's *Stack* table row on GitHub rate
 * limits: "a `304` costs no quota at all"). All three are optional because a fresh ticket has
 * polled its issue but has neither a PR nor checks yet.
 */
export const pipenzoTicketEtagsV1Schema = z
  .object({
    issues: z.string().min(1).max(512).optional(),
    pr: z.string().min(1).max(512).optional(),
    checks: z.string().min(1).max(512).optional(),
  })
  .strict();

/* --------------------------------------------------------------------------------- the record */

/**
 * The persisted ticket record (build step 3's schema, from the epic body verbatim:
 * `ticketId, repo, issueNumber, lane, phase, labels[], estimate, taskType, stack, worktree,
 * attempts[], budget, risk, precommits[], etags, schemaVersion`).
 *
 * `schemaVersion` is a real field on the record itself, not a wrapper key the store bolts on from
 * outside. That is different from how agentdock's `FileSessionStore` persists a `StoredSessionV1`
 * wrapper around a bare `AgentSession` — `AgentSession` is agent-runtime's shape and was never
 * given a version field of its own, so the session store had to add one at the boundary. A ticket
 * record is Pipenzo's own shape from the start, and README's own worked example already writes
 * `schemaVersion` as a sibling of every other field, so this schema follows suit: the version
 * travels with the data, not around it.
 *
 * `labels` is closed to `PIPENZO_LABELS` — the `pipenzo:` labels currently on the GitHub issue —
 * not the issue's full label set. A human's `bug` or `good first issue` is GitHub's business, not
 * this store's: README's precedence rule makes GitHub authoritative for the label set as a whole,
 * and this store only needs to remember the slice of it that is Pipenzo's own state.
 */
export const pipenzoTicketRecordV1Schema = z
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
    worktree: pipenzoTicketWorktreeV1Schema.optional(),
    attempts: z.array(pipenzoTicketAttemptV1Schema).max(50),
    budget: pipenzoTicketBudgetV1Schema,
    risk: pipenzoTicketRiskV1Schema,
    precommits: z.array(pipenzoTicketPrecommitV1Schema).max(200),
    etags: pipenzoTicketEtagsV1Schema,
  })
  .strict();

export type PipenzoTicketEstimateV1 = z.infer<typeof pipenzoTicketEstimateV1Schema>;
export type PipenzoTicketStackV1 = z.infer<typeof pipenzoTicketStackV1Schema>;
export type PipenzoTicketWorktreeV1 = z.infer<typeof pipenzoTicketWorktreeV1Schema>;
export type PipenzoTicketAttemptV1 = z.infer<typeof pipenzoTicketAttemptV1Schema>;
export type PipenzoTicketBudgetV1 = z.infer<typeof pipenzoTicketBudgetV1Schema>;
export type PipenzoTicketRiskV1 = z.infer<typeof pipenzoTicketRiskV1Schema>;
export type PipenzoTicketPrecommitV1 = z.infer<typeof pipenzoTicketPrecommitV1Schema>;
export type PipenzoTicketEtagsV1 = z.infer<typeof pipenzoTicketEtagsV1Schema>;
export type PipenzoTicketRecordV1 = z.infer<typeof pipenzoTicketRecordV1Schema>;
