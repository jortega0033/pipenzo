import { z } from 'zod';
import { providerIdSchema } from './schemas.js';
import { refineSpecV1Schema } from './pipenzo-refine-v1.js';
import { modelTierSchema, reviewReportV1Schema } from './pipenzo-review-v1.js';

/**
 * Wire contracts for the Refine / Implement / Review phases and the two GitHub issue write
 * operations (Pipenzo issue #184).
 *
 * `pipenzo-publish-v1.ts` already established the shape these follow: a strict request schema, a
 * strict result schema, and a closed error-code union routes map onto statuses. The reason for a
 * separate file rather than more fields on the publish contract is the trust boundary — publish is
 * the one surface that writes to the world through `git push`, and keeping its schema a small
 * closed thing a human can read in full is the point of it.
 *
 * ## What is deliberately not on these schemas
 *
 * **No worktree filesystem path, in either direction.** `OwnedWorktreeManager.ownedLocation()` is
 * daemon-internal, and every route here addresses a worktree by its id exactly as
 * `pipenzoPublishRequestV1Schema` does. The implement result carries a `worktreeId`, a branch and
 * two commit shas, and the renderer starts a session inside that worktree by id — it is never told
 * where the worktree lives, so it cannot ask the daemon to run anything in a directory of its own
 * choosing.
 *
 * **No prompt, and no free-form model instructions.** The phase prompts are composed daemon-side
 * from the issue and from the refine spec (`buildRefinePrompt`, `buildImplementPrompt`,
 * `buildReviewerPrompt`). A caller-supplied prompt field would make the phase boundary advisory.
 * `extraInstructions` on the implement request is the one caller-authored string that reaches a
 * prompt, it is bounded and control-character-free, and it is appended to the spec-derived prompt
 * rather than replacing any of it (issue #83's "extra instructions" field).
 */

const noControlCharacters = (value: string): boolean =>
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 || code === 0x0a || code === 0x09;
  });

/** `owner/name`, matching `parseRepoRef()`'s rules so the daemon and the wire agree. */
export const pipenzoRepoRefV1Schema = z
  .string()
  .min(3)
  .max(140)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/, 'must be owner/name');

export const pipenzoIssueNumberV1Schema = z.number().int().positive().max(2_147_483_647);

/* ------------------------------------------------------------------ refine */

export const pipenzoRefineRequestV1Schema = z
  .object({
    /** Omitted means the daemon's configured repository pin (`PIPENZO_GITHUB_REPO`). */
    repo: pipenzoRepoRefV1Schema.optional(),
    issueNumber: pipenzoIssueNumberV1Schema,
    /**
     * The repository checkout Refine reads. Refine writes nothing, so it never gets a worktree —
     * it reads the operator's own clone, which the renderer already knows the path of because it
     * is the path the operator chose.
     */
    repositoryPath: z.string().min(1).max(4_096),
    provider: providerIdSchema,
    model: z.string().min(1).max(256).optional(),
  })
  .strict();

export const pipenzoRefineResultV1Schema = z
  .object({
    sessionId: z.string().min(1).max(128),
    spec: refineSpecV1Schema,
    /** Every tool the session actually used, as the daemon observed it. Always inside the allowlist. */
    toolsUsed: z.array(z.string().min(1).max(128)).max(64),
  })
  .strict();

/* --------------------------------------------------------------- implement */

export const pipenzoImplementRequestV1Schema = z
  .object({
    spec: refineSpecV1Schema,
    repositoryPath: z.string().min(1).max(4_096),
    provider: providerIdSchema,
    model: z.string().min(1).max(256).optional(),
    baseRef: z.string().min(1).max(255).optional(),
    /**
     * Issue #83's field. Appended to the spec-derived prompt, never substituted for it, and
     * bounded so a "prompt" cannot arrive through it in disguise.
     */
    extraInstructions: z
      .string()
      .max(4_000)
      .refine(noControlCharacters, 'must not contain control characters')
      .optional(),
    /** Explicit human acknowledgement that `.worktreeinclude` may copy a secret-shaped file. */
    acknowledgeIncludeSecretRisk: z.boolean().optional(),
  })
  .strict();

export const pipenzoImplementResultV1Schema = z
  .object({
    worktreeId: z.string().uuid(),
    branch: z.string().min(1).max(255),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    /**
     * The dispatched implement session. The renderer streams it through the session routes it
     * already speaks — which is how "start a session in this ticket's worktree" happens without
     * the renderer ever learning where that worktree is.
     */
    sessionId: z.string().min(1).max(128),
  })
  .strict();

/** Collects what the dispatched session actually committed, addressed by worktree id. */
export const pipenzoImplementResultQueryV1Schema = z
  .object({
    worktreeId: z.string().uuid(),
    branch: z.string().min(1).max(255),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

export const pipenzoImplementCommitsV1Schema = z
  .object({
    worktreeId: z.string().uuid(),
    branch: z.string().min(1).max(255),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    headCommit: z.string().regex(/^[0-9a-f]{40}$/),
    /** Oldest first. Empty means the session committed nothing. */
    commits: z.array(z.string().regex(/^[0-9a-f]{40}$/)).max(1_000),
  })
  .strict();

/* ------------------------------------------------------------------ review */

const pipenzoModelChoiceV1Schema = z
  .object({
    provider: providerIdSchema,
    model: z.string().min(1).max(256),
    tier: modelTierSchema,
  })
  .strict();

export const pipenzoReviewRequestV1Schema = z
  .object({
    spec: refineSpecV1Schema,
    /** By id, never by path — same rule as publish. */
    worktreeId: z.string().uuid(),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    headCommit: z.string().regex(/^[0-9a-f]{40}$/),
    implementerTier: modelTierSchema,
    /**
     * The vendor the implementer ran on (issue #147). Optional, and its absence is not neutral:
     * the daemon records the run as `vendorDiversityUnavailable` when it cannot show the verifier
     * was a different vendor from the implementer.
     */
    implementerProvider: providerIdSchema.optional(),
    reviewer: pipenzoModelChoiceV1Schema,
    verifier: pipenzoModelChoiceV1Schema,
  })
  .strict();

export const pipenzoReviewResultV1Schema = reviewReportV1Schema;

/* ------------------------------------------------- GitHub issue write ops */

/**
 * The claim pre-flight (issue #83). README's Team-usage rule: assign, then re-read the issue
 * *uncached* immediately before dispatch, and refuse if somebody else is on it. Both halves are
 * daemon-side so the renderer cannot skip the second one.
 */
export const pipenzoIssueClaimRequestV1Schema = z
  .object({
    repo: pipenzoRepoRefV1Schema.optional(),
    issueNumber: pipenzoIssueNumberV1Schema,
    /** The login claiming the ticket. Compared against the issue's assignees after the write. */
    assignee: z
      .string()
      .min(1)
      .max(39)
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'must be a GitHub login'),
  })
  .strict();

export const pipenzoIssueClaimResultV1Schema = z
  .object({
    repo: pipenzoRepoRefV1Schema,
    issueNumber: pipenzoIssueNumberV1Schema,
    /** `claimed` means this login now holds it; `claimed_elsewhere` means the race was lost. */
    outcome: z.enum(['claimed', 'claimed_elsewhere']),
    assignees: z.array(z.string().min(1).max(39)).max(50),
    title: z.string().min(1).max(512),
    htmlUrl: z.string().url(),
  })
  .strict();

/** The "New from idea" create step (issue #84). Drafted by an agent, created by a human's click. */
export const pipenzoIssueCreateRequestV1Schema = z
  .object({
    repo: pipenzoRepoRefV1Schema.optional(),
    title: z
      .string()
      .min(1)
      .max(256)
      .refine(noControlCharacters, 'must not contain control characters'),
    body: z.string().max(65_536),
    labels: z.array(z.string().min(1).max(50)).max(20).optional(),
  })
  .strict();

export const pipenzoIssueCreateResultV1Schema = z
  .object({
    repo: pipenzoRepoRefV1Schema,
    issueNumber: pipenzoIssueNumberV1Schema,
    title: z.string().min(1).max(512),
    htmlUrl: z.string().url(),
  })
  .strict();

/* ------------------------------------------------------------ error codes */

/**
 * One closed union across every phase route, mapped to statuses in
 * `apps/daemon/src/routes/pipenzo-phases.ts`. A single union rather than one per route because the
 * renderer's error handling is one switch: every one of these arrives through the same
 * `DaemonError` path.
 */
export const PIPENZO_PHASE_ERROR_CODES = [
  'invalid_request',
  // refine
  'invalid_issue',
  'read_only_violation',
  'spec_invalid',
  'spec_missing',
  // implement
  'invalid_spec',
  'workspace_untrusted',
  'worktree_failed',
  'worktree_secret_risk',
  'worktree_not_found',
  'branch_failed',
  // review
  'verifier_tier_too_low',
  'diff_unavailable',
  'reviewer_failed',
  'verifier_failed',
  // shared session failure
  'session_failed',
  // github
  'token_missing',
  'repository_not_configured',
  'issue_not_found',
  'claimed_elsewhere',
  'github_unauthorized',
  'github_forbidden',
  'github_rate_limited',
  'github_failed',
] as const;

export const pipenzoPhaseErrorV1Schema = z
  .object({
    code: z.enum(PIPENZO_PHASE_ERROR_CODES),
    error: z.string().min(1).max(4_096),
    /** Bounded machine-readable evidence, e.g. which tools violated the read-only allowlist. */
    details: z.array(z.string().min(1).max(500)).max(20).optional(),
  })
  .strict();

export type PipenzoRefineRequestV1 = z.infer<typeof pipenzoRefineRequestV1Schema>;
export type PipenzoRefineResultV1 = z.infer<typeof pipenzoRefineResultV1Schema>;
export type PipenzoImplementRequestV1 = z.infer<typeof pipenzoImplementRequestV1Schema>;
export type PipenzoImplementResultV1 = z.infer<typeof pipenzoImplementResultV1Schema>;
export type PipenzoImplementResultQueryV1 = z.infer<typeof pipenzoImplementResultQueryV1Schema>;
export type PipenzoImplementCommitsV1 = z.infer<typeof pipenzoImplementCommitsV1Schema>;
export type PipenzoReviewRequestV1 = z.infer<typeof pipenzoReviewRequestV1Schema>;
export type PipenzoReviewResultV1 = z.infer<typeof pipenzoReviewResultV1Schema>;
export type PipenzoIssueClaimRequestV1 = z.infer<typeof pipenzoIssueClaimRequestV1Schema>;
export type PipenzoIssueClaimResultV1 = z.infer<typeof pipenzoIssueClaimResultV1Schema>;
export type PipenzoIssueCreateRequestV1 = z.infer<typeof pipenzoIssueCreateRequestV1Schema>;
export type PipenzoIssueCreateResultV1 = z.infer<typeof pipenzoIssueCreateResultV1Schema>;
export type PipenzoPhaseErrorCodeV1 = (typeof PIPENZO_PHASE_ERROR_CODES)[number];
