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
  'spec_tests',
  'gitleaks',
  'semgrep',
  'diff_scope',
] as const;
export type DeterministicGateId = (typeof DETERMINISTIC_GATE_IDS)[number];

/**
 * A gate's outcome. `skipped` exists so an absent tool is recorded as an absent tool: a machine
 * check that did not run must never be reported as a machine check that passed, which is the
 * entire premise of the evidence block being trustworthy.
 */
export const gateStatusSchema = z.enum(['passed', 'failed', 'skipped', 'errored']);
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
    if (gate.status === 'skipped' && !gate.summary.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'a skipped gate must say why it was skipped',
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
    estimate: z
      .object({
        changedLines: z.number().int().nonnegative(),
        filesTouched: z.number().int().nonnegative(),
      })
      .strict(),
    /** True when implementation lines exceed the estimate by more than README's 50% tolerance. */
    exceededEstimate: z.boolean(),
    /** Implementation lines as a ratio of the estimate. 1 means exactly on prediction. */
    ratio: z.number().nonnegative(),
  })
  .strict();

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

export const reviewReportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    outcome: z.enum(REVIEW_OUTCOMES),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    headCommit: z.string().regex(/^[0-9a-f]{40}$/),
    implementerTier: modelTierSchema,
    deterministic: z.array(deterministicGateResultV1Schema).max(32),
    diffScope: diffScopeV1Schema.optional(),
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
  });

export type DeterministicGateResultV1 = z.infer<typeof deterministicGateResultV1Schema>;
export type DiffScopeV1 = z.infer<typeof diffScopeV1Schema>;
export type ReviewFindingV1 = z.infer<typeof reviewFindingV1Schema>;
export type LlmReviewPassV1 = z.infer<typeof llmReviewPassV1Schema>;
export type VerifierPassV1 = z.infer<typeof verifierPassV1Schema>;
export type ReviewReportV1 = z.infer<typeof reviewReportV1Schema>;
export type ReviewOutcomeV1 = (typeof REVIEW_OUTCOMES)[number];
