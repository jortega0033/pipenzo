import { z } from 'zod';
import { modelTierSchema } from './pipenzo-review-v1.js';

/**
 * Spec-generated test adjudication (Pipenzo issue #146).
 *
 * README's rule, in full:
 *
 * > a failing spec-generated test is not automatically the code's fault — it is adjudicated once,
 * > by the verifier tier, into test-wrong or code-wrong.
 *
 * `review-gates.ts` deliberately did not implement this, and said why: settling a deterministic
 * gate by running an LLM would invert the ordering that module exists to establish. So a run whose
 * only deterministic failure is `spec_tests` returns the distinct outcome
 * `awaiting_test_adjudication` — "a generated test failed and nobody has ruled on whose fault that
 * is" — and the ruling happens in a **separate, explicit step** afterwards. This schema is that
 * step's output.
 *
 * ## Three properties the shape enforces
 *
 * 1. **Ruled once.** A ruling names a test, and `specTestAdjudicationV1Schema` refuses duplicate
 *    test ids. "Adjudicated once" is not a promise about how often somebody calls a function; it
 *    is a property of the record, so a second opinion cannot be appended and quietly preferred.
 * 2. **Ruled by the verifier tier.** `ruledBy.tier` is on the record, and the daemon asserts it
 *    against the implementer's tier before running anything. A ruling made by a weaker model is
 *    exactly the cross-tier regression README's evidence is about, and it must not be possible to
 *    read this record without seeing what made it.
 * 3. **Never silently deleted.** A `test_wrong` ruling *drops* a test, and the record carries the
 *    ruling and its rationale. There is no representable state where a test disappeared and the
 *    reason did not: `rationale` is required on every ruling, including `code_wrong` ones where
 *    nothing is dropped at all.
 */

/**
 * The two verdicts, and only these two.
 *
 * "Flaky", "unclear" and "needs a human" are deliberately absent. This exists to force a decision
 * that would otherwise default to blaming the code, and a third option that means "we did not
 * decide" would restore that default while looking like an answer. If the adjudicator genuinely
 * cannot tell, `code_wrong` is the honest ruling — it keeps the test and blocks the diff.
 */
export const SPEC_TEST_VERDICTS = ['test_wrong', 'code_wrong'] as const;
export type SpecTestVerdictV1 = (typeof SPEC_TEST_VERDICTS)[number];

export const specTestRulingV1Schema = z
  .object({
    /** The generated test this ruling is about, as its repo-relative path plus test name. */
    testId: z.string().min(1).max(1_024),
    verdict: z.enum(SPEC_TEST_VERDICTS),
    /**
     * Required on both verdicts. A dropped test whose reason is missing is a silently deleted
     * test wearing a record, which is the one outcome README names as unacceptable.
     */
    rationale: z.string().min(1).max(4_000),
    /** The acceptance criterion the generated test was written from, when it cited one. */
    criterionId: z
      .string()
      .regex(/^AC-\d{1,3}$/)
      .optional(),
  })
  .strict();

export const specTestAdjudicationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    /**
     * The exact diff this ruling settles.
     *
     * A sibling record rather than a field on `ReviewReportV1`, on purpose: a report whose
     * deterministic gates failed must not be able to carry an LLM pass (the report schema refuses
     * it), and folding the adjudication in would have meant either weakening that rule or
     * pretending an adjudication is not an LLM pass. Pinning the commit pair instead keeps the two
     * records joinable without either one having to bend.
     */
    adjudicates: z
      .object({
        baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
        headCommit: z.string().regex(/^[0-9a-f]{40}$/),
      })
      .strict(),
    ruledBy: z
      .object({
        sessionId: z.string().min(1).max(128),
        tier: modelTierSchema,
        model: z.string().min(1).max(256),
      })
      .strict(),
    rulings: z.array(specTestRulingV1Schema).min(1).max(200),
  })
  .strict()
  .superRefine((adjudication, ctx) => {
    const seen = new Set<string>();
    for (const [index, ruling] of adjudication.rulings.entries()) {
      if (seen.has(ruling.testId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rulings', index, 'testId'],
          message: 'each generated test is adjudicated exactly once',
        });
      }
      seen.add(ruling.testId);
    }
  });

export type SpecTestRulingV1 = z.infer<typeof specTestRulingV1Schema>;
export type SpecTestAdjudicationV1 = z.infer<typeof specTestAdjudicationV1Schema>;

/** The tests a `test_wrong` ruling drops. Derived, never stored separately, so the two agree. */
export function droppedSpecTests(
  adjudication: SpecTestAdjudicationV1,
): readonly SpecTestRulingV1[] {
  return adjudication.rulings.filter((ruling) => ruling.verdict === 'test_wrong');
}

/**
 * The same contract as a JSON Schema, for the adjudicating session's structured output — same
 * reasoning as the refine spec's: the provider sees this, the daemon re-validates with Zod.
 */
export const SPEC_TEST_ADJUDICATION_V1_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  // The provider is asked for the rulings only. `adjudicates` and `ruledBy` are the daemon's own
  // facts about the run, and asking a model to restate them would let it get them wrong.
  required: ['schemaVersion', 'rulings'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    rulings: {
      type: 'array',
      minItems: 1,
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['testId', 'verdict', 'rationale'],
        properties: {
          testId: { type: 'string', minLength: 1, maxLength: 1024 },
          verdict: { type: 'string', enum: [...SPEC_TEST_VERDICTS] },
          rationale: { type: 'string', minLength: 1, maxLength: 4000 },
          criterionId: { type: 'string', pattern: '^AC-[0-9]{1,3}$' },
        },
      },
    },
  },
} as const);
