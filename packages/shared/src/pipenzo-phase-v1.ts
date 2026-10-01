import { z } from 'zod';
import { pipenzoTicketIdV1Schema, providerIdSchema } from './schemas.js';
import { GITHUB_LOGIN_PATTERN } from './pipenzo-credential-v1.js';
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
 * title and a one-line instruction, where a carriage return is a caller bug. A comment body and an
 * issue-create body are the multi-line fields on this surface, and the bodies #100 and #144
 * compose are stitched out of captured command and git output on Windows — which is CRLF.
 * Refusing that would fail the operator with a flat 400 for a line ending they never typed, on
 * this product's primary platform.
 *
 * Until issue #232, the other public-markdown payload on this surface,
 * `pipenzoIssueCreateRequestV1Schema.body`, carried no control-character rule at all and bounded
 * its length in UTF-16 units rather than code points — a real divergence from the comment body's
 * rule rather than a deliberate one. #232 put both fields on this one predicate, via
 * `proseBodyProblem`.
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
     * it reads the source checkout directly: for a board ticket, the managed checkout
     * `POST /v2/pipenzo/repos/checkout` resolved for its connected repository (#342/#344).
     */
    repositoryPath: z.string().min(1).max(4_096),
    provider: providerIdSchema,
    model: z.string().min(1).max(256).optional(),
    /**
     * Which ticket this refine is for (issue #270). Optional, the same way the review request's
     * `ticketId` is (#144/#266): every existing caller and test omits it, and a refine run without
     * one still reports its spec exactly as before. Its only effect is consequential — when the
     * diff-size gate (`refine-gate.ts`) refuses and a ticket id is present, the daemon transitions
     * that ticket to `pipenzo:needs-pre-scoping` and posts the estimate as a comment.
     */
    ticketId: pipenzoTicketIdV1Schema.optional(),
  })
  .strict();

/**
 * The diff-size gate's own verdict (issue #270), reported on the wire rather than left for a
 * renderer to re-derive from `spec.estimate` against README's thresholds -- the same reason
 * `PipenzoGitHubQuotaV1.degraded` (#230) carries the reconciler's decision instead of a fraction a
 * consumer would have to compare against a threshold of its own: two places computing the same
 * verdict are two places free to disagree the moment either one is tuned. `refine-gate.ts` is the
 * one place that decides; this is that decision, reported.
 */
export const REFINE_GATE_VERDICTS = ['single', 'stack', 'refuse'] as const;
export const refineGateVerdictV1Schema = z.enum(REFINE_GATE_VERDICTS);
export type RefineGateVerdictV1 = (typeof REFINE_GATE_VERDICTS)[number];

export const pipenzoRefineResultV1Schema = z
  .object({
    sessionId: z.string().min(1).max(128),
    spec: refineSpecV1Schema,
    /** Every tool the session actually used, as the daemon observed it. Always inside the allowlist. */
    toolsUsed: z.array(z.string().min(1).max(128)).max(64),
    gateVerdict: refineGateVerdictV1Schema,
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
    /**
     * Which ticket this implement dispatch is for. Optional the same way `refine`'s and `review`'s
     * `ticketId` are: every existing caller and test omits it, and a dispatch without one still
     * starts the session exactly as before. Two independent consequential effects hang off it now:
     * the daemon appends a `PipenzoTicketAttemptV1` to the ticket's `attempts[]` once the session is
     * confirmed started, which is what gives crash recovery's session-to-ticket matching
     * (`pipenzo-crash-recovery.ts`, issue #201) real data instead of only what a test hand-seeds; and
     * (issue #159) it best-effort records the worktree id/branch the dispatch just cut onto the
     * ticket record, which is what lets a later terminal-state transition (PR merged, closed,
     * abandoned) find the worktree to clean up without the renderer ever having to remember and
     * resend it.
     */
    ticketId: pipenzoTicketIdV1Schema.optional(),
    /**
     * The model tier this dispatch runs at, for the same `attempts[]` entry. Optional: model
     * routing (`Models.dc.html`'s task-type-aware table) is stated as post-MVP and nothing computes
     * a tier yet, so a caller that has not been given one gets `'mid'` -- `implement-standard`'s
     * routing class in README's own table, and the same tier the crash-recovery fixtures already
     * use as their default attempt. A real router overrides this the moment it exists; until then
     * an attempt still needs *a* value, because `pipenzoTicketAttemptV1Schema.tier` is required.
     */
    tier: modelTierSchema.optional(),
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

/**
 * Whether the dispatched implement session has reached a terminal state, and which one (issue
 * #192). `implement/result` is a poll, and an empty `commits` array means two different things
 * depending on this field: `'running'` is an ordinary "check back later", every other member means
 * the session already stopped and `commits` is everything it is ever going to hold. `'completed'`
 * with an empty `commits` array (equivalently, `headCommit === baseCommit`) is exactly the failure
 * #191 hid — see `routes/pipenzo-phases.ts` for how that combination is reported as
 * `implement_empty_diff` rather than as an ordinary success.
 *
 * `'failed'` and `'cancelled'` mirror `ImplementSessionEnd` in
 * `apps/daemon/src/implement-orchestrator.ts` (daemon-internal, not itself on the wire): the daemon
 * never commits a session's work unless it ended `'completed'`, so either one also always carries an
 * empty `commits` array, for the same underlying reason as `'completed'` with nothing to commit —
 * one symptom, several causes, which is the whole point of detecting the symptom.
 */
export const IMPLEMENT_SESSION_STATES = ['running', 'completed', 'failed', 'cancelled'] as const;
export const implementSessionStateV1Schema = z.enum(IMPLEMENT_SESSION_STATES);
export type ImplementSessionStateV1 = (typeof IMPLEMENT_SESSION_STATES)[number];

export const pipenzoImplementCommitsV1Schema = z
  .object({
    worktreeId: z.string().uuid(),
    branch: z.string().min(1).max(255),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    headCommit: z.string().regex(/^[0-9a-f]{40}$/),
    /** Oldest first. Empty means the session committed nothing (yet, if `sessionState` reads
     * `'running'`). */
    commits: z.array(z.string().regex(/^[0-9a-f]{40}$/)).max(1_000),
    /**
     * Optional, and every existing caller and test omits it — the same rollout shape as
     * `ticketId` elsewhere on this surface. Its only effect is consequential (issue #192): once the
     * daemon starts populating it, `'completed'`/`'failed'`/`'cancelled'` with an empty `commits`
     * array makes `/v2/pipenzo/implement/result` respond `implement_empty_diff` instead of this
     * success shape, and `'running'` is what lets a caller tell "not committed yet" apart from "will
     * never commit."
     */
    sessionState: implementSessionStateV1Schema.optional(),
  })
  .strict();

/**
 * The longest diff text this route will put on the wire (issue #90's follow-on stack: mounting the
 * Review/Diff/Publish hand-off surfaced that no route returned a diff at all -- `ReviewReportV1`
 * carries a verdict and findings, never the patch itself, and `review-gates.ts` computes one only
 * to hand it to an LLM pass and discard it).
 *
 * Chosen independently from (and happening to equal) `MAX_DIFF_CHARS` in
 * `apps/daemon/src/review-gates.ts` -- that bound protects an LLM pass's context window; this one
 * protects the renderer's own memory and render time from an unbounded string crossing the wire.
 * Two different reasons to cap a diff, not one rule with two names, so a future change to either
 * should not be assumed to move the other (the same caution `MAX_ISSUE_BODY_CHARS` states next to
 * `MAX_ISSUE_COMMENT_CHARS` above).
 */
export const MAX_IMPLEMENT_DIFF_CHARS = 400_000;

/** Reads the unified diff for a commit range inside an owned worktree, by id (issue #90's stack,
 * step 2) -- never by path, the same rule every route on this surface already follows. */
export const pipenzoImplementDiffRequestV1Schema = z
  .object({
    worktreeId: z.string().uuid(),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    headCommit: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

export const pipenzoImplementDiffResultV1Schema = z
  .object({
    worktreeId: z.string().uuid(),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    headCommit: z.string().regex(/^[0-9a-f]{40}$/),
    /** `git diff --patch --no-color` over `baseCommit..headCommit`, truncated at
     * `MAX_IMPLEMENT_DIFF_CHARS` -- the same shape `DiffFileList.tsx` already parses, whether the
     * text came from this route or from a GitHub PR diff. */
    diffText: z.string().max(MAX_IMPLEMENT_DIFF_CHARS),
    /** True when the real diff was longer than `MAX_IMPLEMENT_DIFF_CHARS` and `diffText` is a
     * prefix of it, never the whole thing. */
    truncated: z.boolean(),
    /** From `git diff --numstat` over the same range -- computed once here rather than re-derived
     * by parsing `diffText` a second time client-side, and correct even when `diffText` itself was
     * truncated. */
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    filesChanged: z.number().int().nonnegative(),
  })
  .strict();

export type PipenzoImplementDiffRequestV1 = z.infer<typeof pipenzoImplementDiffRequestV1Schema>;
export type PipenzoImplementDiffResultV1 = z.infer<typeof pipenzoImplementDiffResultV1Schema>;

/* ------------------------------------------------------------- run controls (issue #103) */

/**
 * Steer and Stop for a ticket's dispatched Implement session (issue #103). Both are addressed by
 * `ticketId`, never by `sessionId` or worktree id: `PipenzoPhaseService` resolves the ticket's
 * current attempt itself, the same "the renderer names the thing it is looking at, the daemon
 * resolves what that maps to" rule `pipenzoTicketTransitionRequestV1Schema` already follows for a
 * label move. A renderer that could name a session id directly could steer or stop a session that
 * is not this ticket's own dispatched attempt.
 *
 * Neither call is gated on the ticket's `lane`/label here — `PipenzoPhaseService` gates on whether
 * the attempt's session is genuinely still running right now (a fresh check, not a cached one),
 * which is the real thing `RunControls.tsx`'s own "no absent state" doc comment asks a caller to
 * know for certain, and a `pipenzo:working` label alone cannot promise that (the reconciler polls
 * on its own cadence and cannot observe a session ending between polls).
 */
export const pipenzoSteerRequestV1Schema = z
  .object({
    ticketId: pipenzoTicketIdV1Schema,
    /**
     * One instruction, delivered at the running session's next tool boundary — it is appended as a
     * fresh turn, never folded into or replacing the approved Refine spec. Same shape as
     * `extraInstructions` above: a caller-authored string that reaches a prompt, bounded and
     * control-character-free.
     */
    instruction: z
      .string()
      .min(1)
      .max(4_000)
      .refine(noControlCharacters, 'must not contain control characters'),
  })
  .strict();

export const pipenzoSteerResultV1Schema = z
  .object({
    /** The session the instruction was actually delivered to, so a caller can tell this apart from
     *  a steer that landed against a since-replaced attempt. */
    sessionId: z.string().min(1).max(128),
  })
  .strict();

export const pipenzoStopRequestV1Schema = z
  .object({ ticketId: pipenzoTicketIdV1Schema })
  .strict();

export const pipenzoStopResultV1Schema = z
  .object({
    worktreeId: z.string().uuid(),
    branch: z.string().min(1).max(255),
    /**
     * Commits already on `branch` at the moment the in-flight tool call was abandoned. Never
     * fewer than a `git log` on the worktree would show right now — nothing this call does touches
     * a commit, only the session's own in-flight turn.
     */
    commitCount: z.number().int().nonnegative(),
    /**
     * The label the ticket parked under. A literal rather than the full label vocabulary — Stop has
     * exactly one outcome label today — spelled as a label string rather than a bare `true` for the
     * same reason `pipenzoTicketTransitionRequestV1Schema.label` names a label and not a lane.
     */
    label: z.literal('pipenzo:needs-human'),
  })
  .strict();

/**
 * A read-only poll for whether a ticket's most recent Implement attempt is a session genuinely
 * live right now (issue #103). `RunControls.tsx` renders nothing at all rather than a disabled
 * control when no session is live, so a caller has to know this for certain rather than infer it
 * from `ticket.attempts` — that array's `outcome` is written once, at dispatch, and nothing
 * rewrites it when the session actually ends (see `pipenzoTicketAttemptV1Schema`'s own doc
 * comment on why `outcome` stays an open, sparsely-written string).
 */
export const pipenzoRunStatusRequestV1Schema = z
  .object({ ticketId: pipenzoTicketIdV1Schema })
  .strict();

export const pipenzoRunStatusResultV1Schema = z.discriminatedUnion('live', [
  z
    .object({
      live: z.literal(true),
      sessionId: z.string().min(1).max(128),
      tier: modelTierSchema,
      model: z.string().min(1).max(256),
      branch: z.string().min(1).max(255),
      commitCount: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ live: z.literal(false) }).strict(),
]);

export type PipenzoSteerRequestV1 = z.infer<typeof pipenzoSteerRequestV1Schema>;
export type PipenzoSteerResultV1 = z.infer<typeof pipenzoSteerResultV1Schema>;
export type PipenzoStopRequestV1 = z.infer<typeof pipenzoStopRequestV1Schema>;
export type PipenzoStopResultV1 = z.infer<typeof pipenzoStopResultV1Schema>;
export type PipenzoRunStatusRequestV1 = z.infer<typeof pipenzoRunStatusRequestV1Schema>;
export type PipenzoRunStatusResultV1 = z.infer<typeof pipenzoRunStatusResultV1Schema>;

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
      .regex(GITHUB_LOGIN_PATTERN, 'must be a GitHub login')
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
    // No `.max()` here, for the same reason the comment body has none: a zod string check that
    // fails marks the result *dirty*, not aborted, so the `superRefine` below runs regardless and
    // a `.max()` would cap nothing except at a number (131,072) that is not the documented limit.
    // The walk is capped inside `issueCreateBodyProblem`, which is also the guard
    // `assertIssueDraft` in the daemon's GitHub client uses (issue #232).
    body: z.string().superRefine((value, ctx) => {
      const problem = issueCreateBodyProblem(value);
      if (problem !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: ISSUE_CREATE_BODY_MESSAGES[problem] });
      }
    }),
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

/** What is wrong with a prose body, or `undefined` if nothing is. */
export type ProseBodyProblem = 'blank' | 'too_long' | 'control_characters';

/**
 * The one prose-body rule, in one place, for every field on this surface whose payload is public
 * markdown (issue #228, generalized to the issue-create body by issue #232).
 *
 * `issueCommentBodyProblem` and `issueCreateBodyProblem` below both call this rather than each
 * carrying their own copy, which is what #232 found: the two had quietly drifted apart (the
 * create body allowed control characters and measured length in UTF-16 units, not code points) as
 * a shipped-route oversight rather than a documented choice. One predicate cannot drift from
 * itself.
 *
 * Emptiness is tested on the *trimmed* string but the untrimmed value is what gets sent. Blankness
 * is a per-field choice (`allowBlank`): a blank *comment* is a caller bug — it renders as an empty
 * box on the issue under the operator's name — while a blank issue *body* is an ordinary, valid
 * GitHub issue with no description, and #84's shipped "New from idea" route has always allowed
 * one. Either way, leading or trailing whitespace inside a real body is the caller's formatting to
 * keep, and a client that silently rewrote what gets published would be a client whose output
 * nobody can predict from its input.
 *
 * Length is counted in code points, not UTF-16 units, because that is what GitHub's 65,536 counts
 * on both the comment and the issue-body endpoint. `'x'.repeat(70_000).length` and
 * `[...'🙂'.repeat(70_000)].length` disagree by a factor of two, and measuring in units would
 * refuse an emoji-heavy body at roughly half GitHub's real allowance — inverting the whole purpose
 * of refusing early.
 */
function proseBodyProblem(
  body: string,
  maxChars: number,
  { allowBlank }: { allowBlank: boolean },
): ProseBodyProblem | undefined {
  if (typeof body !== 'string') return 'blank';
  if (!allowBlank && body.trim().length === 0) return 'blank';
  // Cheap first: a string over twice the cap in UTF-16 units cannot be under it in code points.
  if (body.length > maxChars * 2) return 'too_long';
  if ([...body].length > maxChars) return 'too_long';
  if (!noProseControlCharacters(body)) return 'control_characters';
  return undefined;
}

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

/** What is wrong with a comment body, or `undefined` if nothing is. Kept as its own alias (rather
 * than a bare use of `ProseBodyProblem`) because it is part of this package's public API. */
export type IssueCommentBodyProblem = ProseBodyProblem;

/**
 * The comment-body rule (issue #228).
 *
 * The wire schema below and `assertCommentBody` in the daemon's GitHub client both call this, and
 * the client is the floor: the HTTP route is not the only way in, because a daemon-side caller
 * (#100's refusal panel, #144's blown-estimate record) reaches `PipenzoPhaseService` and the client
 * directly and would otherwise get no validation at all. A predicate returning *which* rule failed,
 * rather than a boolean, is what lets each caller render its own message without a second copy of
 * the rule drifting behind it.
 */
export function issueCommentBodyProblem(body: string): IssueCommentBodyProblem | undefined {
  return proseBodyProblem(body, MAX_ISSUE_COMMENT_CHARS, { allowBlank: false });
}

/** Wire-facing wording for each problem. The daemon client phrases its own, with its operation. */
const ISSUE_COMMENT_BODY_MESSAGES: Record<IssueCommentBodyProblem, string> = {
  blank: 'must not be blank',
  too_long: `must be at most ${MAX_ISSUE_COMMENT_CHARS} characters`,
  control_characters: 'must not contain control characters',
};

/**
 * The longest issue body Pipenzo will create, in Unicode code points (issue #232).
 *
 * Kept as its own constant rather than reused from `MAX_ISSUE_COMMENT_CHARS`: the two happen to
 * agree today because GitHub bounds both an issue body and an issue comment at 65,536 characters,
 * but that is two of GitHub's rules for two different endpoints agreeing, not one rule with two
 * names — a future change to either limit should not silently move the other.
 */
export const MAX_ISSUE_BODY_CHARS = 65_536;

/** What is wrong with a "New from idea" issue body (issue #84), or `undefined` if nothing is. */
export type IssueCreateBodyProblem = ProseBodyProblem;

/**
 * The issue-create body rule (issue #232), the create-body sibling of `issueCommentBodyProblem`.
 *
 * Unlike a comment, a blank body is allowed: a created issue with no description is a normal,
 * valid GitHub issue, and #84's shipped route has always permitted one. `assertIssueDraft` in the
 * daemon's GitHub client calls this too, for the same reason `assertCommentBody` calls the comment
 * version — `PipenzoPhaseService.createIssue` reaches the client directly.
 */
export function issueCreateBodyProblem(body: string): IssueCreateBodyProblem | undefined {
  return proseBodyProblem(body, MAX_ISSUE_BODY_CHARS, { allowBlank: true });
}

/** Wire-facing wording for each problem. The daemon client phrases its own, with its operation. */
const ISSUE_CREATE_BODY_MESSAGES: Record<IssueCreateBodyProblem, string> = {
  blank: 'must not be blank',
  too_long: `must be at most ${MAX_ISSUE_BODY_CHARS} characters`,
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
 * Control characters are refused for the same reason the title fields here refuse them, under
 * `noProseControlCharacters`'s carriage-return exception to the newline and tab ones — the two
 * multi-line fields on this surface, this one and the issue-create body, share that exception and
 * nothing else here needs it.
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
  /** Issue #318: git rev-parse/status itself failed. Never reported as clean/unchanged. */
  'baseline_unavailable',
  /** Issue #318: the source checkout has uncommitted changes before Refine ever starts. */
  'dirty_checkout',
  /** Issue #318: HEAD moved or the checkout became dirty while Refine was running. */
  'baseline_changed',
  // implement
  'invalid_spec',
  'workspace_untrusted',
  'worktree_failed',
  'worktree_secret_risk',
  'worktree_not_found',
  'branch_failed',
  /** The daemon's own post-session `git commit` of the implement worktree failed or was refused. */
  'commit_failed',
  /**
   * Issue #192: the implement session reached a terminal state with nothing on the ticket branch —
   * `headCommit === baseCommit`. Reported instead of a success result so this never again looks like
   * the completed, working run it is not (see #191, the incident that named this ticket). Never
   * reported while the session is still running — see `ImplementSessionStateV1` in
   * `pipenzo-phase-v1.ts` for how a caller tells the two apart.
   */
  'implement_empty_diff',
  // review
  'verifier_tier_too_low',
  'diff_unavailable',
  'reviewer_failed',
  'verifier_failed',
  // shared session failure
  'session_failed',
  /**
   * Issue #103: Steer/Stop was asked for a ticket with no dispatched Implement attempt at all --
   * never reached Implement, or its attempt lineage is empty. Distinct from `run_not_active` below,
   * which means an attempt exists but its session already ended.
   */
  'run_not_found',
  /**
   * Issue #103: the ticket's most recent Implement attempt is not a session genuinely live right
   * now — already completed, failed, cancelled or interrupted. Steer/Stop both refuse cleanly
   * rather than dispatching a command against a session that can no longer act on it; nothing this
   * code names ever discards a commit or a worktree, because neither call reaches that far.
   */
  'run_not_active',
  /**
   * Issue #143, slice 2: this ticket's `budget.limit` is real (non-zero) and `budget.tokensUsed`
   * has already reached or passed it. Refused before a new session is dispatched -- README's own
   * stated behaviour is "parks the ticket in Needs human instead of retrying", and a route that
   * dispatched anyway on a retried request would be exactly the retry that line refuses.
   */
  'budget_exhausted',
  /**
   * Issue #126: the workspace's configured execution limit (Settings, default 2, hard cap 4) is
   * already at capacity when a new Implement dispatch is attempted. Refused outright, the same
   * "never queue past the limit" shape `SessionCapacityError` already uses one layer down (see
   * `pipenzo-execution-limiter.ts`) -- a ticket that hits this is left exactly where it was, free
   * to be retried (by a human, or by whatever later build step adds automatic retry) once another
   * ticket's session ends and frees a slot.
   */
  'execution_limit_exceeded',
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
