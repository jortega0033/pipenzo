import { z } from 'zod';

/**
 * The Review phase's contract (Pipenzo issue #181).
 *
 * In `@agent-dock/shared` because the diff-review screen's verification-evidence block renders
 * exactly this, and README requires that block be split into two visually distinct zones —
 * machine-verified deterministic gates versus agent-reported findings, never merged into one
 * list. The type system carries that split rather than leaving it to a component's discretion:
 * `deterministic` and the two LLM passes are separate fields with different shapes, so there is
 * no single array a renderer could flatten them into by accident.
 */

/**
 * Model strength, distinct from a routing class (a *phase* of work) and from a kanban lane.
 * README keeps these three apart deliberately; this is the strength axis, and the only one the
 * verifier's same-or-higher rule is expressed in.
 */
export const MODEL_TIERS = ['cheap', 'mid', 'frontier'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const modelTierSchema = z.enum(MODEL_TIERS);

/** Ascending strength. Index comparison is what the same-or-higher rule is enforced with. */
export function modelTierRank(tier: ModelTier): number {
  return MODEL_TIERS.indexOf(tier);
}

/**
 * The deterministic gate set, in the order it runs. The order is part of the contract, not an
 * implementation detail: README is explicit that deterministic gates come first and are never
 * reordered or parallelized in a way that lets an LLM pass reach a verdict before they have.
 */
export const DETERMINISTIC_GATE_IDS = [
  'build',
  'typecheck',
  'lint',
  'spec_tests',
  'gitleaks',
  'semgrep',
  'diff_scope',
] as const;
export type DeterministicGateId = (typeof DETERMINISTIC_GATE_IDS)[number];

/**
 * A gate's outcome. `skipped` exists so an absent tool is recorded as an absent tool: a machine
 * check that did not run must never be reported as a machine check that passed, which is the
 * entire premise of the evidence block being trustworthy. `not_applicable` (issue #206) is the
 * same discipline applied to a different fact: `diff_scope` compares the diff against a
 * `RefineSpecV1` estimate that simply does not exist for an external PR review (no Refine ever
 * ran), which is neither a pass nor a fail -- reporting either would imply a comparison that was
 * never made.
 */
export const gateStatusSchema = z.enum(['passed', 'failed', 'skipped', 'errored', 'not_applicable']);
export type GateStatus = z.infer<typeof gateStatusSchema>;

export const deterministicGateResultV1Schema = z
  .object({
    id: z.enum(DETERMINISTIC_GATE_IDS),
    status: gateStatusSchema,
    /** One line a human reads on the card. Never a raw command dump. */
    summary: z.string().min(1).max(1_000),
    /** Bounded command output, for the expandable evidence pane. */
    detail: z.string().max(20_000).optional(),
    durationMs: z.number().int().nonnegative().max(86_400_000),
  })
  .strict()
  .superRefine((gate, ctx) => {
    if ((gate.status === 'skipped' || gate.status === 'not_applicable') && !gate.summary.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'a skipped or not_applicable gate must say why',
      });
    }
  });

/**
 * The implementation/test split README requires and issue #145 names.
 *
 * A large generated test file must never be able to blow a ticket's size estimate on its own, so
 * the estimate is compared against `implementation` only and `generatedTests` is counted and
 * reported alongside it. Both are always present: a report that omitted the test numbers would be
 * hiding the very thing the split exists to make visible.
 */
export const diffScopeV1Schema = z
  .object({
    implementation: z
      .object({
        changedLines: z.number().int().nonnegative(),
        filesTouched: z.number().int().nonnegative(),
      })
      .strict(),
    generatedTests: z
      .object({
        changedLines: z.number().int().nonnegative(),
        filesTouched: z.number().int().nonnegative(),
      })
      .strict(),
    /**
     * Absent for an external PR review (issue #206): no `RefineSpecV1` exists to estimate against,
     * so there is nothing for `exceededEstimate`/`ratio` to be computed from either. All three are
     * present together or absent together -- enforced below, not left as three independently
     * optional fields a caller could mismatch.
     */
    estimate: z
      .object({
        changedLines: z.number().int().nonnegative(),
        filesTouched: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /** True when implementation lines exceed the estimate by more than README's 50% tolerance. */
    exceededEstimate: z.boolean().optional(),
    /** Implementation lines as a ratio of the estimate. 1 means exactly on prediction. */
    ratio: z.number().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const present = [value.estimate, value.exceededEstimate, value.ratio].filter(
      (field) => field !== undefined,
    ).length;
    if (present !== 0 && present !== 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['estimate'],
        message: 'estimate, exceededEstimate and ratio must all be present or all be absent',
      });
    }
  });

export const reviewFindingSeverityV1Schema = z.enum(['info', 'low', 'medium', 'high']);

export const reviewFindingV1Schema = z
  .object({
    severity: reviewFindingSeverityV1Schema,
    /** Repo-relative POSIX path the finding is about, when it is about one. */
    path: z.string().min(1).max(1_024).optional(),
    line: z.number().int().positive().max(10_000_000).optional(),
    message: z.string().min(1).max(4_000),
    /** The acceptance criterion this finding relates to, when the pass cited one. */
    criterionId: z.string().regex(/^AC-\d{1,3}$/).optional(),
    /**
     * Whether `path`/`line` were cross-checked against the diff the pass was actually shown
     * (issue #319) — never model-reported. Optional so `llmPassPayloadSchema`
     * (`pipenzo-phase-sessions.ts`) still accepts a pass's raw, pre-verification payload; the
     * review-gates runner fills this in for every finding before it reaches a `ReviewReportV1`.
     */
    locationVerified: z.boolean().optional(),
  })
  .strict();

export const llmReviewPassV1Schema = z
  .object({
    sessionId: z.string().min(1).max(128),
    tier: modelTierSchema,
    model: z.string().min(1).max(256),
    findings: z.array(reviewFindingV1Schema).max(200),
  })
  .strict();

/**
 * The verifier is a gate; the reviewer is advisory. README states the asymmetry and the reason:
 * a weaker model reviewing a stronger one produced 3 fixes against 13 new bugs, and that evidence
 * is about *gating* review. So the verifier carries a verdict and the reviewer does not.
 */
export const verifierPassV1Schema = llmReviewPassV1Schema
  .extend({
    verdict: z.enum(['approved', 'rejected']),
    /** Recorded when a single-vendor install could not honour the cross-vendor tiebreak. */
    vendorDiversityUnavailable: z.boolean(),
  })
  .strict();

export const REVIEW_OUTCOMES = [
  'approved',
  'deterministic_failed',
  'awaiting_test_adjudication',
  /**
   * The complete diff patch (or, before verifier dispatch, the complete prompt envelope) could not
   * be supplied within the existing bounded input contract — issue #316. Distinct from
   * `deterministic_failed`: every deterministic gate passed, this fires purely on input size, and
   * neither LLM pass is ever dispatched for it. `inputCompleteness` below carries why.
   */
  'review_input_incomplete',
  /**
   * The final diff blew its Refine-time estimate by more than `DIFF_SCOPE_TOLERANCE` (README's
   * 50% rule) — issue #144. A lone `diff_scope` gate failure, distinct from `deterministic_failed`
   * so a consequence can be attached to it specifically (transition to
   * `pipenzo:awaiting-stack-approval`, real-vs-predicted numbers posted as a comment) without that
   * consequence also firing for a broken build, a typecheck error, or a gitleaks/semgrep hit. The
   * numbers themselves already travel on `diffScope` below; this outcome is the flag that says
   * which reason they belong to.
   */
  'estimate_blown',
  'verifier_rejected',
] as const;

/**
 * Daemon-derived evidence of whether the complete input reached both LLM passes (issue #316) —
 * never model-reported, the same discipline `locationVerified` (#319) applies to a finding's
 * location. `limitChars`/`actualChars` are UTF-16 code units (JavaScript string `.length`),
 * matching the unit `review-gates.ts`'s own pre-existing `truncate()` already measures in, not
 * bytes or model tokens.
 */
export const reviewInputCompletenessV1Schema = z
  .object({
    complete: z.boolean(),
    /** Present only when `complete` is false — what didn't fit and why. */
    reason: z.string().min(1).max(500).optional(),
    /** The real size that didn't fit, when it's known (e.g. not for a git-read failure). */
    actualChars: z.number().int().nonnegative().optional(),
    limitChars: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.complete && !value.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'an incomplete input must say why',
      });
    }
  });

export const reviewReportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    outcome: z.enum(REVIEW_OUTCOMES),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    headCommit: z.string().regex(/^[0-9a-f]{40}$/),
    implementerTier: modelTierSchema,
    deterministic: z.array(deterministicGateResultV1Schema).max(32),
    diffScope: diffScopeV1Schema.optional(),
    /** Present for `review_input_incomplete`, `approved`, and `verifier_rejected` — every outcome
     * where whether the LLM passes saw the complete diff is a meaningful question. Absent for a
     * deterministic-gate-failure outcome, where neither pass ran for an unrelated reason and
     * completeness of the input they didn't see is moot. */
    inputCompleteness: reviewInputCompletenessV1Schema.optional(),
    /** Absent when the deterministic gates stopped the run before any LLM pass could start. */
    reviewer: llmReviewPassV1Schema.optional(),
    verifier: verifierPassV1Schema.optional(),
  })
  .strict()
  .superRefine((report, ctx) => {
    const failed = report.deterministic.some((gate) => gate.status === 'failed' || gate.status === 'errored');
    if (failed && (report.reviewer || report.verifier)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewer'],
        message: 'an LLM pass cannot appear in a report whose deterministic gates did not pass',
      });
    }
    if (report.outcome === 'approved' && report.verifier?.verdict !== 'approved') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'an approved review requires an approving verifier verdict',
      });
    }
    if (report.outcome === 'review_input_incomplete' && (report.reviewer || report.verifier)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewer'],
        message: 'an LLM pass cannot appear in a report whose review input was incomplete',
      });
    }
    // The property #316 exists for: an incomplete input can never be reframed under any other
    // outcome, `approved` included -- the outcome enum is the one thing every caller already
    // switches on, so this is where "cannot move to review-approved" has to be structural.
    if (report.inputCompleteness?.complete === false && report.outcome !== 'review_input_incomplete') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'an incomplete review input must carry the review_input_incomplete outcome',
      });
    }
    // The reverse direction (code review of #331): without this, a report could claim
    // review_input_incomplete with no inputCompleteness evidence at all, or with complete: true --
    // a direct self-contradiction. #report() always pairs them correctly today, but the schema is
    // this module's own last line of defence for a report assembled by hand, same reasoning as the
    // ordering invariant above.
    if (report.outcome === 'review_input_incomplete' && report.inputCompleteness?.complete !== false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inputCompleteness'],
        message: 'review_input_incomplete requires inputCompleteness evidence with complete: false',
      });
    }
  });

export type DeterministicGateResultV1 = z.infer<typeof deterministicGateResultV1Schema>;
export type DiffScopeV1 = z.infer<typeof diffScopeV1Schema>;
export type ReviewInputCompletenessV1 = z.infer<typeof reviewInputCompletenessV1Schema>;
export type ReviewFindingV1 = z.infer<typeof reviewFindingV1Schema>;
export type LlmReviewPassV1 = z.infer<typeof llmReviewPassV1Schema>;
export type VerifierPassV1 = z.infer<typeof verifierPassV1Schema>;
export type ReviewReportV1 = z.infer<typeof reviewReportV1Schema>;
export type ReviewOutcomeV1 = (typeof REVIEW_OUTCOMES)[number];
