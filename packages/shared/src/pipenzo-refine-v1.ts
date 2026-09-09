import { z } from 'zod';

/**
 * The Refine phase's output contract (Pipenzo issue #179).
 *
 * Lives in `@agent-dock/shared` because it crosses the daemon/client boundary in both directions:
 * the ticket detail and Simple-mode screens render it, and build step 4's diff-size gate is
 * enforced against the `estimate` block in it.
 *
 * README is precise about what is actually additive in Pipenzo's Refine step versus Kiro's more
 * complete spec-driven flow, and it is not the notation: it is that the subagent is **read-only by
 * construction**, and that it emits a **numeric diff-size estimate a refusal policy is enforced
 * against**. This schema is the second half of that. The shape is already what step 4 will gate
 * on — `changedLines`, `filesTouched`, `layered` map one-to-one onto README's threshold table —
 * so nothing here needs redoing when the gate is switched on.
 */

/**
 * EARS clause kinds, and the templates that make "EARS notation" a checkable property rather than
 * a label on free prose. A criterion declares its kind and its text must match that kind's
 * template — `refineAcceptanceCriterionV1Schema` enforces it.
 */
export const EARS_KINDS = ['ubiquitous', 'event', 'state', 'option', 'unwanted', 'complex'] as const;
export type EarsKind = (typeof EARS_KINDS)[number];

export const EARS_TEMPLATES: Record<EarsKind, { readonly template: string; readonly pattern: RegExp }> =
  Object.freeze({
    ubiquitous: {
      template: 'The <system> shall <response>',
      pattern: /^The\s+\S.*\s+shall\s+\S.*$/,
    },
    event: {
      template: 'When <trigger>, the <system> shall <response>',
      pattern: /^When\s+\S.*,\s*the\s+\S.*\s+shall\s+\S.*$/,
    },
    state: {
      template: 'While <state>, the <system> shall <response>',
      pattern: /^While\s+\S.*,\s*the\s+\S.*\s+shall\s+\S.*$/,
    },
    option: {
      template: 'Where <feature>, the <system> shall <response>',
      pattern: /^Where\s+\S.*,\s*the\s+\S.*\s+shall\s+\S.*$/,
    },
    unwanted: {
      template: 'If <trigger>, then the <system> shall <response>',
      pattern: /^If\s+\S.*,\s*then\s+the\s+\S.*\s+shall\s+\S.*$/,
    },
    complex: {
      // A combination clause: a state qualifier followed by a trigger, e.g.
      // "While <state>, when <trigger>, the <system> shall <response>".
      template: 'While <state>, when <trigger>, the <system> shall <response>',
      pattern: /^(While|Where)\s+\S.*,\s*(when|if)\s+\S.*,\s*then?\s*the\s+\S.*\s+shall\s+\S.*$/i,
    },
  });

export const refineAcceptanceCriterionV1Schema = z
  .object({
    /** Stable within one spec, so a review finding or a generated test can cite a criterion. */
    id: z.string().regex(/^AC-\d{1,3}$/, 'must be AC-<number>'),
    kind: z.enum(EARS_KINDS),
    text: z.string().min(1).max(1_000),
  })
  .strict()
  .superRefine((criterion, ctx) => {
    if (!EARS_TEMPLATES[criterion.kind].pattern.test(criterion.text)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: `must follow the ${criterion.kind} EARS template: ${EARS_TEMPLATES[criterion.kind].template}`,
      });
    }
  });

/**
 * The numeric prediction the refusal policy is enforced against.
 *
 * `changedLines` is additions + deletions and `filesTouched` is a count — the one unit README's
 * threshold table is a clean total order on. `layered` answers the second question that table asks
 * ("is there a clean 2-4 PR decomposition?"), which is what separates the stack-approval row from
 * the outright refusal row. Step 4 reads these; nothing in the walking skeleton gates on them.
 */
export const refineEstimateV1Schema = z
  .object({
    changedLines: z.number().int().nonnegative().max(1_000_000),
    filesTouched: z.number().int().nonnegative().max(10_000),
    layered: z.boolean(),
  })
  .strict();

/**
 * README's own numbers for the diff-size gate (issue #270), in one place both sides of the
 * boundary read from — `apps/daemon/src/refine-gate.ts`'s `evaluateDiffSizeGate` (the decision)
 * and `apps/desktop/src/pipenzo/RefusalPanel.tsx`'s `trippedBy` (the display of that decision)
 * both import these rather than each hardcoding README's 100/10/400/20. Two literal copies of a
 * product rule in two different packages is exactly the "two places free to disagree" shape this
 * codebase avoids elsewhere (see `PipenzoGitHubQuotaV1.degraded`, #230); a shared constant closes
 * that gap with a compiled import instead of a comment asking two files to stay in sync by hand.
 */
export const PIPENZO_DIFF_SIZE_THRESHOLDS = Object.freeze({
  /** At or under both: one PR, proceed normally. */
  onePrMaxLines: 100,
  onePrMaxFiles: 10,
  /** At or under both (with `layered: true`): a dependency-ordered stack of 2–4 PRs. Past either,
   * or inside this band without `layered`: refuse. */
  stackMaxLines: 400,
  stackMaxFiles: 20,
});

/** A repo-relative POSIX path. Never absolute, never a traversal — this is a prediction, not a target. */
const repoRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith('/') && !/^[A-Za-z]:/.test(value), 'must be repo-relative')
  .refine((value) => !value.split('/').includes('..'), 'must not traverse upward')
  .refine((value) => !value.includes('\\'), 'must use POSIX separators');

/**
 * One part of a decomposition offered when Refine declines a ticket outright (issue #271). README's
 * refusal bullet says the ticket is handed to a human "with the estimate and a proposed split," and
 * `apps/desktop/src/pipenzo/RefusalPanel.tsx` already renders exactly this shape in its optional
 * `proposedSplit` prop -- this schema is that shape's producer-side declaration, not a new one
 * invented to match it.
 */
export const refineProposedSplitPartV1Schema = z
  .object({
    /** One line a human reads to see what this part of the split would cover. */
    summary: z.string().min(1).max(500),
    changedLines: z.number().int().nonnegative().max(1_000_000),
    filesTouched: z.number().int().nonnegative().max(10_000),
  })
  .strict();

export type RefineProposedSplitPartV1 = z.infer<typeof refineProposedSplitPartV1Schema>;

export const refineSpecV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    issue: z
      .object({
        repo: z.string().min(1).max(256),
        number: z.number().int().positive(),
        title: z.string().min(1).max(512),
      })
      .strict(),
    /** One paragraph a human reads before deciding whether the agent understood the ticket. */
    summary: z.string().min(1).max(4_000),
    acceptanceCriteria: z.array(refineAcceptanceCriterionV1Schema).min(1).max(50),
    /**
     * Required and non-empty on purpose. "What this ticket is not" is the half of a spec that
     * actually bounds a diff, and a Refine pass that produced none has not refined anything.
     */
    outOfScope: z.array(z.string().min(1).max(500)).min(1).max(50),
    filesLikelyTouched: z.array(repoRelativePathSchema).max(200),
    estimate: refineEstimateV1Schema,
    /**
     * What the subagent could not answer from the repository. README's Refine step stops and asks
     * a human while it is still cheap; this is the list that stop is built from. Empty means
     * nothing was ambiguous.
     */
    openQuestions: z.array(z.string().min(1).max(1_000)).max(20),
    /**
     * A decomposition into independently-shippable, roughly-estimated parts, offered only when the
     * ticket was too big for even a dependency-ordered stack (issue #271). Optional and absent by
     * default: nothing in `refine-subagent.ts`'s prompt asks for one yet -- deciding whether that is
     * the same Refine session's own output, a second pass, and what a cheap-tier read-only session
     * can honestly claim about a multi-PR decomposition it never wrote any of, is real product
     * judgment this schema addition does not make for it. Until that lands, every spec omits this
     * field, `RefusalPanel.tsx`'s `Split` block stays unrendered, and `refusalCommentBody` posts the
     * estimate alone -- exactly today's behavior, unchanged by this field existing.
     */
    proposedSplit: z.array(refineProposedSplitPartV1Schema).min(1).max(20).optional(),
  })
  .strict();

export type RefineAcceptanceCriterionV1 = z.infer<typeof refineAcceptanceCriterionV1Schema>;
export type RefineEstimateV1 = z.infer<typeof refineEstimateV1Schema>;
export type RefineSpecV1 = z.infer<typeof refineSpecV1Schema>;

/**
 * The same contract as a JSON Schema, for agentdock's `outputSchema` structured-output capability.
 *
 * Two representations of one shape is a real duplication risk, so `refine-subagent.test.ts`
 * asserts they agree: a spec that satisfies the Zod schema validates against this, and the
 * required-key lists match. The provider sees this one; the daemon re-validates with Zod, because
 * a provider's structured-output guarantee is not a thing to take on trust at a phase boundary.
 */
export const REFINE_SPEC_V1_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'issue',
    'summary',
    'acceptanceCriteria',
    'outOfScope',
    'filesLikelyTouched',
    'estimate',
    'openQuestions',
  ],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    issue: {
      type: 'object',
      additionalProperties: false,
      required: ['repo', 'number', 'title'],
      properties: {
        repo: { type: 'string', minLength: 1, maxLength: 256 },
        number: { type: 'integer', minimum: 1 },
        title: { type: 'string', minLength: 1, maxLength: 512 },
      },
    },
    summary: { type: 'string', minLength: 1, maxLength: 4000 },
    acceptanceCriteria: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'text'],
        properties: {
          id: { type: 'string', pattern: '^AC-[0-9]{1,3}$' },
          kind: { type: 'string', enum: [...EARS_KINDS] },
          text: { type: 'string', minLength: 1, maxLength: 1000 },
        },
      },
    },
    outOfScope: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: { type: 'string', minLength: 1, maxLength: 500 },
    },
    filesLikelyTouched: {
      type: 'array',
      maxItems: 200,
      items: { type: 'string', minLength: 1, maxLength: 1024 },
    },
    estimate: {
      type: 'object',
      additionalProperties: false,
      required: ['changedLines', 'filesTouched', 'layered'],
      properties: {
        changedLines: { type: 'integer', minimum: 0, maximum: 1000000 },
        filesTouched: { type: 'integer', minimum: 0, maximum: 10000 },
        layered: { type: 'boolean' },
      },
    },
    openQuestions: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    // Not in `required` above: optional on both sides, and absent from every spec today since
    // nothing in `refine-subagent.ts`'s prompt asks a provider to populate it yet (issue #271).
    proposedSplit: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'changedLines', 'filesTouched'],
        properties: {
          summary: { type: 'string', minLength: 1, maxLength: 500 },
          changedLines: { type: 'integer', minimum: 0, maximum: 1000000 },
          filesTouched: { type: 'integer', minimum: 0, maximum: 10000 },
        },
      },
    },
  },
} as const);
