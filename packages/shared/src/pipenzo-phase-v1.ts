import { z } from 'zod';
import { pipenzoTicketIdV1Schema, providerIdSchema } from './schemas.js';
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

/**
 * The same rule for a field that is *many* lines of prose rather than one.
 *
 * `\r` (0x0d) is permitted here and nowhere else. The fields `noControlCharacters` guards are a
 * title and a one-line instruction, where a carriage return is a caller bug. A comment body is the
 * first multi-line field on this surface, and the bodies #100 and #144 compose are stitched out of
 * captured command and git output on Windows — which is CRLF. Refusing that would fail the
 * operator with a flat 400 for a line ending they never typed, on this product's primary platform.
 *
 * The other public-markdown payload on this surface, `pipenzoIssueCreateRequestV1Schema.body`,
 * carries no control-character rule at all and bounds its length in UTF-16 units rather than code
 * points. That is a real divergence and not a shared rule this one is being kept in step with;
 * bringing it into line changes a shipped route (#84) and is filed as issue #232.
 */
const noProseControlCharacters = (value: string): boolean =>
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
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
    /**
     * Which ticket this review is for (issue #144). Optional, deliberately: a review is a
     * worktree-scoped operation that has never needed a ticket to run, and every existing caller
     * (and every existing test posting to `/v2/pipenzo/review`) omits it. Its only effect is
     * consequential — when the outcome is `estimate_blown` (#265) and a ticket id is present, the
     * daemon transitions that ticket to `pipenzo:awaiting-stack-approval` and posts the real-vs-
     * predicted numbers as a comment (`PipenzoPhaseService.review()`). A review run without one
     * still reports its outcome exactly as before; it simply has nowhere to attach the consequence.
     */
    ticketId: pipenzoTicketIdV1Schema.optional(),
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
    /**
     * The login claiming the ticket, compared against the issue's assignees after the write.
     *
     * **Optional, and normally omitted.** The daemon holds the token, so the daemon is the only
     * thing that actually knows who "I" is; when this is absent it resolves the authenticated
     * login itself. A renderer that supplied someone else's login could claim a ticket *as* them,
     * which defeats the point of the race — the loser has to be able to trust that the name on the
     * ticket is the person who took it.
     */
    assignee: z
      .string()
      .min(1)
      .max(39)
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'must be a GitHub login')
      .optional(),
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

/**
 * The longest comment body Pipenzo will send, in Unicode code points (issue #228).
 *
 * GitHub's own limit on an issue comment is 65,536 characters and it answers a longer one with a
 * 422. Refusing before that is what makes the failure legible: the caller composing a comment out
 * of an estimate and a proposed split (#100) learns it was too long, instead of learning that
 * GitHub rejected an unspecified field of an unspecified request.
 *
 * It lives here rather than in the daemon because both ends need it and there is nothing else to
 * pin them together: raise it on one side only and you get either a body the wire accepts and the
 * client refuses (a 502 where a 400 belonged) or the reverse.
 *
 * Refused, never truncated. A truncated comment is a *wrong* comment — the half of a proposed split
 * that survived reads as the whole proposal — and it would be posted publicly under the operator's
 * name with nothing marking it as incomplete.
 */
export const MAX_ISSUE_COMMENT_CHARS = 65_536;

/** What is wrong with a comment body, or `undefined` if nothing is. */
export type IssueCommentBodyProblem = 'blank' | 'too_long' | 'control_characters';

/**
 * The one comment-body rule, in one place (issue #228).
 *
 * The wire schema below and `assertCommentBody` in the daemon's GitHub client both call this, and
 * the client is the floor: the HTTP route is not the only way in, because a daemon-side caller
 * (#100's refusal panel, #144's blown-estimate record) reaches `PipenzoPhaseService` and the client
 * directly and would otherwise get no validation at all. A predicate returning *which* rule failed,
 * rather than a boolean, is what lets each caller render its own message without a second copy of
 * the rule drifting behind it.
 *
 * Emptiness is tested on the *trimmed* string but the untrimmed value is what gets sent. A comment
 * of pure whitespace is a caller bug — it renders as an empty box on the issue under the
 * operator's name — while leading or trailing whitespace inside a real body is the caller's
 * formatting to keep, and a client that silently rewrote what gets published would be a client
 * whose output nobody can predict from its input.
 *
 * Length is counted in code points, not UTF-16 units, because that is what GitHub's 65,536 counts.
 * `'x'.repeat(70_000).length` and `[...'🙂'.repeat(70_000)].length` disagree by a factor of two,
 * and measuring in units would refuse an emoji-heavy body at roughly half GitHub's real allowance —
 * inverting the whole purpose of refusing early.
 */
export function issueCommentBodyProblem(body: string): IssueCommentBodyProblem | undefined {
  if (typeof body !== 'string' || body.trim().length === 0) return 'blank';
  // Cheap first: a string over twice the cap in UTF-16 units cannot be under it in code points.
  if (body.length > MAX_ISSUE_COMMENT_CHARS * 2) return 'too_long';
  if ([...body].length > MAX_ISSUE_COMMENT_CHARS) return 'too_long';
  if (!noProseControlCharacters(body)) return 'control_characters';
  return undefined;
}

/** Wire-facing wording for each problem. The daemon client phrases its own, with its operation. */
const ISSUE_COMMENT_BODY_MESSAGES: Record<IssueCommentBodyProblem, string> = {
  blank: 'must not be blank',
  too_long: `must be at most ${MAX_ISSUE_COMMENT_CHARS} characters`,
  control_characters: 'must not contain control characters',
};

/**
 * Posting one comment on an issue (issue #228).
 *
 * Two rows of epic #4's diff-size gate end in a comment rather than in a lane move: the
 * "no clean layering at any size" row posts the estimate and the proposed split before handing to
 * a human (#100), and a blown estimate records real-versus-predicted numbers where a human will
 * see them (#144). Labels cannot express either, so this is the first write on this surface whose
 * payload is prose.
 *
 * `body` is the one caller-authored string here, and unlike `extraInstructions` it does not reach
 * a prompt — it reaches the public internet, under the operator's GitHub identity. That is why the
 * route behind it carries the same human-paced rate limit as the rest of this surface and is not
 * reachable from any agent-facing tool: a model that could call it could publish arbitrary text as
 * a human.
 *
 * Control characters are refused for the same reason the title fields here refuse them, but under
 * a rule of this field's own: `noProseControlCharacters` adds a carriage-return exception to the
 * newline and tab ones, because this is the only multi-line field on the surface. No other field
 * has that exception, and the issue-create body has no such rule at all — see
 * `noProseControlCharacters` for why the divergence is deliberate rather than an oversight.
 */
export const pipenzoIssueCommentRequestV1Schema = z
  .object({
    repo: pipenzoRepoRefV1Schema.optional(),
    issueNumber: pipenzoIssueNumberV1Schema,
    // No `.max()` here on purpose. A zod string check that fails marks the result *dirty*, not
    // aborted, so the `superRefine` below runs regardless and a `.max()` would cap nothing — it
    // would only add a second issue naming a number (131,072) that is not the documented limit.
    // The walk is capped inside `issueCommentBodyProblem`, which is also the only guard the
    // daemon-internal callers get, since they never reach zod at all.
    body: z
      .string()
      .min(1)
      .superRefine((value, ctx) => {
        const problem = issueCommentBodyProblem(value);
        if (problem !== undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: ISSUE_COMMENT_BODY_MESSAGES[problem] });
        }
      }),
  })
  .strict();

/**
 * The comment's identity, and nothing else.
 *
 * The body is deliberately **not** echoed back. The caller already has it, it can be 64KB, and a
 * response that repeats a request's largest field is a response whose size doubles for no reader.
 * What a caller cannot construct for itself is the comment's id and its permalink, so those are
 * what comes back.
 */
export const pipenzoIssueCommentResultV1Schema = z
  .object({
    repo: pipenzoRepoRefV1Schema,
    issueNumber: pipenzoIssueNumberV1Schema,
    commentId: z.number().int().positive(),
    htmlUrl: z.string().url(),
    createdAt: z.string().min(1).max(64),
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
export type PipenzoIssueCommentRequestV1 = z.infer<typeof pipenzoIssueCommentRequestV1Schema>;
export type PipenzoIssueCommentResultV1 = z.infer<typeof pipenzoIssueCommentResultV1Schema>;
export type PipenzoPhaseErrorCodeV1 = (typeof PIPENZO_PHASE_ERROR_CODES)[number];
