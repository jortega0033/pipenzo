import { z } from 'zod';
import { providerIdSchema } from './schemas.js';
import {
  EARS_KINDS,
  refineAcceptanceCriterionV1Schema,
  refineEstimateV1Schema,
} from './pipenzo-refine-v1.js';

/**
 * "New from idea": free text in, a drafted issue out (Pipenzo issue #84).
 *
 * Main.dc.html's plan dialog states the rule this schema exists to make true, in the help text
 * under the draft itself:
 *
 * > Written by a cheap-tier style pass over prose only. Every number, gate result and check below
 * > it is rendered from data and never rewritten.
 *
 * So the draft is **structured**, not a blob of markdown a model wrote. `title` is prose — the one
 * thing a humanising pass is for. Everything else is data: EARS acceptance criteria, an explicit
 * out-of-scope list, and the same numeric estimate `RefineSpecV1` carries. The issue body a human
 * eventually files is assembled from those fields by a pure function on the renderer side, which
 * is what makes "rendered from data and never rewritten" checkable rather than aspirational — a
 * model that returned a beautifully written body would have nowhere to put it.
 *
 * Reusing `refineAcceptanceCriterionV1Schema` and `refineEstimateV1Schema` is deliberate: a
 * drafted issue that Refine will later re-specify should be expressed in the vocabulary Refine
 * already speaks, or the two would drift into different ideas of what an acceptance criterion is.
 */

export const pipenzoIdeaDraftRequestV1Schema = z
  .object({
    /** The operator's own words. The one free-text field in the whole flow. */
    idea: z.string().min(1).max(8_000),
    /** The repository the idea is about — read-only, for grounding the draft. */
    repositoryPath: z.string().min(1).max(4_096),
    provider: providerIdSchema,
    /** Walking skeleton: the caller's single choice. Routing classes to tiers is build step 4+. */
    model: z.string().min(1).max(256).optional(),
  })
  .strict();

export const pipenzoIssueDraftV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    /** The prose half, and the only part a style pass may have touched. */
    title: z.string().min(1).max(256),
    acceptanceCriteria: z.array(refineAcceptanceCriterionV1Schema).min(1).max(20),
    /**
     * Required and non-empty, for the same reason `RefineSpecV1` requires it: what a ticket is
     * *not* is the half that bounds a diff, and a draft with no bounds has not scoped anything.
     */
    outOfScope: z.array(z.string().min(1).max(500)).min(1).max(20),
    estimate: refineEstimateV1Schema,
    /**
     * What the drafter could not decide from the idea alone. Rendered as open questions on the
     * issue, so a human filing it can see what it guessed at.
     */
    openQuestions: z.array(z.string().min(1).max(1_000)).max(10),
  })
  .strict();

export const pipenzoIdeaDraftResultV1Schema = z
  .object({
    sessionId: z.string().min(1).max(128),
    draft: pipenzoIssueDraftV1Schema,
  })
  .strict();

export type PipenzoIdeaDraftRequestV1 = z.infer<typeof pipenzoIdeaDraftRequestV1Schema>;
export type PipenzoIssueDraftV1 = z.infer<typeof pipenzoIssueDraftV1Schema>;
export type PipenzoIdeaDraftResultV1 = z.infer<typeof pipenzoIdeaDraftResultV1Schema>;

/** The structured-output contract the drafting session runs under. Re-validated with Zod after. */
export const PIPENZO_ISSUE_DRAFT_V1_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'title', 'acceptanceCriteria', 'outOfScope', 'estimate', 'openQuestions'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    title: { type: 'string', minLength: 1, maxLength: 256 },
    acceptanceCriteria: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
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
      maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 500 },
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
      maxItems: 10,
      items: { type: 'string', minLength: 1, maxLength: 1000 },
    },
  },
} as const);
