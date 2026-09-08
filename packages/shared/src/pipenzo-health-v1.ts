import { z } from 'zod';

/**
 * What the renderer is allowed to know about Pipenzo's *connection* to GitHub (issue #230).
 *
 * ## Why this is not part of `pipenzoGitHubConnectionV1Schema`
 *
 * That type answers a question about **this machine**: is a credential stored here, and can this
 * process read it. Every one of its `unavailable` reasons is a local-storage failure — no OS
 * credential store, a plaintext backend refused, a record that will not decrypt.
 *
 * It cannot answer the other question, and it never could: *does GitHub still accept the credential
 * we hold*. A token the user revoked on github.com is still stored, still decryptable, and still
 * reported `connected` forever. Those are two different claims and #72's "your token was revoked"
 * banner needs both of them — the vault's, to know a credential exists at all, and this one's, to
 * know GitHub refuses it. So this **composes with** `PipenzoGitHubConnectionV1` rather than
 * replacing it, and neither is derivable from the other.
 *
 * ## The 401 that must stay two different things
 *
 * `github-client.ts` maps GitHub's 401 to `unauthorized`, and the ticket and phase routes then
 * deliberately flatten it to a generic 502. The reason is written down in both route files: a 401
 * on the daemon's own surface means *the daemon's bearer token* was wrong, and letting an upstream
 * credential failure wear the same status sends an operator looking in entirely the wrong place.
 *
 * This type does not undo that, and must not be used to. A GitHub credential GitHub has rejected is
 * the `credential_rejected` **state on a health payload**, never an HTTP status on a daemon route.
 * The flattening stays exactly as it is.
 *
 * ## Every field is something a producer can actually compute
 *
 * The reconciler (#231) knows its own ladder position, its failure run and its last clean tick; the
 * quota capture (#229) knows the headroom and the reset. Nothing here is aspirational. That
 * restraint is the point of filing this before the banners rather than after: `SyncStatusPill`
 * shipped with the ~15% rule in its doc comment and zero consumers, because the shape came first
 * and nothing could populate it.
 *
 * ## Timestamps are unix milliseconds, all of them
 *
 * One representation, not two. #71 renders "5 polls failed since 14:02" and #70 counts down to the
 * next attempt, so two consumers subtract these values; a type that mixed epoch numbers with
 * ISO-8601 strings would make that a bug waiting for the second consumer to arrive. Milliseconds
 * rather than ISO because subtraction is the operation both of them perform, and
 * `pipenzoDeviceCodeV1Schema.expiresAt` already set that precedent for a field a UI counts against.
 *
 * ## What is deliberately not here
 *
 * **No transport.** Whether this arrives on the phase event stream, on a health route, or on both
 * is the reconciler's decision once it exists. Pinning the producer's shape from the consumer's
 * side is how a contract acquires a field nobody can fill.
 *
 * **No error message, and no upstream detail.** A health payload that carried GitHub's own response
 * text would be a redaction surface, and the states below are a closed set precisely so a renderer
 * switches on them rather than pattern-matching prose.
 */

/** Unix milliseconds. Positive, integral, and the only time representation on this type. */
const timestampV1Schema = z.number().int().positive();

/**
 * Remaining core-quota headroom (issue #229's capture is the producer).
 *
 * Optional wherever it appears, and that is a real state rather than a convenience: a daemon that
 * has made no request yet genuinely does not know its headroom, and so does one whose last reading
 * describes a window that has since refilled. "No information" is not "plenty of quota", and a
 * consumer has to be able to tell them apart.
 *
 * The fraction is carried rather than the raw counts because that is what epic #4's rule compares
 * against — *"below ~15% remaining quota: degrade, don't fail"* — and carrying both a fraction and
 * the two numbers it comes from is two representations of one fact, free to disagree. A consumer
 * that later needs "4,321 of 5,000" for a tooltip is a new requirement with its own ticket, not a
 * field added here on speculation.
 */
export const pipenzoGitHubQuotaV1Schema = z
  .object({
    /** `remaining / limit`, so `0.12` is the state #75 renders as "syncing slowly". */
    remainingFraction: z.number().min(0).max(1),
    /** When the window refills. After this instant the fraction above says nothing. */
    resetAt: timestampV1Schema,
  })
  .strict();

export type PipenzoGitHubQuotaV1 = z.infer<typeof pipenzoGitHubQuotaV1Schema>;

/**
 * The one field every variant shares.
 *
 * Spread rather than intersected so each variant stays a plain `ZodObject` and the union below can
 * stay a `discriminatedUnion` — which is what makes an unknown `state` a parse error naming the
 * discriminator, instead of four stacked "did not match" reports.
 */
const quotaField = { quota: pipenzoGitHubQuotaV1Schema.optional() };

/**
 * Reaching GitHub fine.
 *
 * `lastCleanPollAt` is required here and optional everywhere else, which is the shape of the fact:
 * a healthy poll *is* a clean poll, so the producer always has the value, while a daemon that has
 * failed from its very first tick has never had one and must not be made to invent it.
 */
const healthyV1Schema = z
  .object({
    state: z.literal('healthy'),
    lastCleanPollAt: timestampV1Schema,
    ...quotaField,
  })
  .strict();

/**
 * Failing, and still working through the retry ladder. #70's *"attempt 2 of 5"*.
 *
 * `attempt` and `maxAttempts` are required, not optional, because #70 renders both numbers: an
 * optional one becomes an `undefined` in the banner, and a banner that says "attempt undefined of
 * 5" is worse than no banner. Criterion by criterion, that is the difference between a state's
 * companion fields being *required* and merely being *allowed*.
 */
const retryingV1Schema = z
  .object({
    state: z.literal('retrying'),
    /** 1-based position in the reconciler's current ladder. */
    attempt: z.number().int().positive(),
    /** The ladder's ceiling, so a renderer can say "of 5" without knowing the reconciler. */
    maxAttempts: z.number().int().positive(),
    /** When the next attempt is scheduled. #70 counts down against this. */
    nextAttemptAt: timestampV1Schema,
    /** How many polls have failed in a row. #71 renders this once the ladder is exhausted. */
    consecutiveFailures: z.number().int().positive(),
    /** When the current run of failures began. #71's "since 14:02". */
    firstFailureAt: timestampV1Schema,
    /** Absent when this daemon has never completed a clean poll. */
    lastCleanPollAt: timestampV1Schema.optional(),
    ...quotaField,
  })
  .strict();

/**
 * The ladder is exhausted and GitHub is still unreachable. #71's blocking banner.
 *
 * `nextAttemptAt` is still required, because giving up on the *ladder* is not giving up on the
 * *loop* — the reconciler keeps polling at its base interval, which is the only way #73's recovery
 * banner ever gets something to fire on. A state that stopped carrying a next attempt would be
 * describing a daemon that had genuinely stopped trying, and this one has not.
 */
const unreachableV1Schema = z
  .object({
    state: z.literal('unreachable'),
    consecutiveFailures: z.number().int().positive(),
    firstFailureAt: timestampV1Schema,
    nextAttemptAt: timestampV1Schema,
    /** The ceiling that was exhausted, so #71 can say what was tried. */
    maxAttempts: z.number().int().positive(),
    lastCleanPollAt: timestampV1Schema.optional(),
    ...quotaField,
  })
  .strict();

/**
 * GitHub refused the credential. #72's expired-or-revoked banner.
 *
 * There is no `nextAttemptAt` and no attempt count, and their absence is the statement: retrying a
 * credential GitHub has rejected does not fix it, and a banner offering "retrying in 30s" for a
 * revoked token would be telling the user to wait for something that will never happen. The only
 * thing that resolves this state is a human reconnecting, which is why #72 is a call to action and
 * #70 is a status.
 *
 * `lastCleanPollAt` carries the more useful half of the story — "this worked until 14:02" — and is
 * still optional, because a credential can be rejected on the very first poll after a restart.
 */
const credentialRejectedV1Schema = z
  .object({
    state: z.literal('credential_rejected'),
    /** When GitHub answered 401. */
    rejectedAt: timestampV1Schema,
    lastCleanPollAt: timestampV1Schema.optional(),
    ...quotaField,
  })
  .strict();

/**
 * How Pipenzo's connection to GitHub is actually doing (issue #230).
 *
 * A discriminated union rather than one flat object with everything optional, because the whole
 * point is that a state's companion fields are *required*: `retrying` without an attempt number
 * must not parse, since #70 renders that number and an optional one reaches the UI as `undefined`.
 */
export const pipenzoGitHubHealthV1Schema = z.discriminatedUnion('state', [
  healthyV1Schema,
  retryingV1Schema,
  unreachableV1Schema,
  credentialRejectedV1Schema,
]);

export type PipenzoGitHubHealthV1 = z.infer<typeof pipenzoGitHubHealthV1Schema>;

/**
 * The state alone, for a banner that switches on it.
 *
 * Derived from the union rather than written out again as a `z.enum`. A second list of the same
 * four literals is two representations of one fact and free to disagree with the first — the same
 * reason the quota carries a fraction instead of a fraction plus the numbers it came from.
 */
export type PipenzoGitHubHealthStateV1 = PipenzoGitHubHealthV1['state'];
