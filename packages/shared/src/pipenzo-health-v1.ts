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
 *
 * **No separate rate-limited state**, and the mapping is stated here so a producer does not have to
 * guess. `github-client.ts` raises `rate_limited` as its own error kind, but a poll that fails on a
 * quota window has not lost the connection and has not lost the credential: it is `retrying`,
 * carrying a `quota` whose `degraded` flag says the interval widened. A fifth failing state would
 * give #70 and #71 a case neither renders differently, while the fact a consumer actually wants —
 * "we slowed down on purpose" — is already on the quota.
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
    /** `remaining / limit`, so `0.12` is the headroom #75 describes as "syncing slowly". */
    remainingFraction: z.number().min(0).max(1),
    /** When the window refills. After this instant the fraction above says nothing. */
    resetAt: timestampV1Schema,
    /**
     * Whether the producer actually widened its poll interval because of this reading.
     *
     * The *decision*, not the input to it, and that is deliberate: epic #4's "~15%" is
     * approximate, and if #75 re-derived the threshold from `remainingFraction` there would be two
     * places that decide what "degraded" means, free to disagree the moment either is tuned. The
     * reconciler (#231) owns the threshold because it owns the interval; this reports what it did.
     * A consumer renders a state rather than recomputing one.
     */
    degraded: z.boolean(),
  })
  .strict();

export type PipenzoGitHubQuotaV1 = z.infer<typeof pipenzoGitHubQuotaV1Schema>;

/**
 * The one field every variant shares.
 *
 * Spread rather than intersected so each variant stays a plain `ZodObject` and the union below can
 * stay a `discriminatedUnion` — which is what makes an unknown `state` a parse error naming the
 * discriminator, instead of one stacked "did not match" report per member.
 */
const quotaField = { quota: pipenzoGitHubQuotaV1Schema.optional() };

/**
 * Nothing observed yet.
 *
 * The state a producer is in before its first poll settles, and the state it stays in when the
 * connected-repos list is empty — which #231 makes a legitimate steady state, not an error. Without
 * this variant a starting daemon could fill no member of the union at all: `healthy` demands a
 * clean poll it has never made, and the three failing states demand a failure run it has not had.
 * Its only options would be inventing a `lastCleanPollAt` — exactly what the `healthy` variant
 * below says a producer must never be made to do — or publishing nothing, which silently makes
 * "absent" a fifth state that five separate banner tickets would each have to invent handling for.
 *
 * The same argument the quota above makes: "no information" is not "everything is fine", and a
 * consumer has to be able to tell them apart.
 *
 * It deliberately does not distinguish *not polled yet* from *nothing to poll*. No banner renders
 * either, so splitting them now would be shape without a consumer; a ticket that needs the
 * difference can add the variant then.
 */
const unknownV1Schema = z
  .object({
    state: z.literal('unknown'),
    /** Present after a restart only if the producer persisted one. Usually absent. */
    lastCleanPollAt: timestampV1Schema.optional(),
    ...quotaField,
  })
  .strict();

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
 * `nextAttemptAt` is **optional** here, unlike on `retrying`, and the difference is a deliberate
 * refusal to decide something this ticket does not own. Whether a reconciler that has exhausted its
 * ladder keeps polling at a base interval or waits for a human is #231's call — #70 and #71 both
 * carry a manual retry affordance, which is what a stopped ladder looks like from the UI side.
 * Requiring the field would have pinned that decision from the consumer's side and made it
 * unfillable if #231 chose the other answer; its absence means "nothing is scheduled, only a human
 * moves this", which is a state a banner can render.
 */
const unreachableV1Schema = z
  .object({
    state: z.literal('unreachable'),
    consecutiveFailures: z.number().int().positive(),
    firstFailureAt: timestampV1Schema,
    /** Absent when nothing is scheduled and only a human retry moves this on. */
    nextAttemptAt: timestampV1Schema.optional(),
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
const healthUnionV1Schema = z.discriminatedUnion('state', [
  unknownV1Schema,
  healthyV1Schema,
  retryingV1Schema,
  unreachableV1Schema,
  credentialRejectedV1Schema,
]);

/**
 * The cross-field rules the object shapes above cannot express.
 *
 * Applied to the union rather than to its members because `z.discriminatedUnion` rejects a member
 * that is not a plain object — a refined option throws at construction. Refining the union instead
 * keeps the discriminator behaviour intact: an unknown `state` still reports one issue at
 * `['state']` rather than five near-misses, because the union parses first and a failed parse never
 * reaches this.
 *
 * These are here rather than left to the producer because each one is a *rendered* number. "Attempt
 * 7 of 5" is a banner a user can read, and a wire contract whose job is to stop a consumer seeing
 * `undefined` has no reason to let it see nonsense instead.
 */
export const pipenzoGitHubHealthV1Schema = healthUnionV1Schema.superRefine((health, ctx) => {
  if (health.state === 'retrying' && health.attempt > health.maxAttempts) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['attempt'],
      message: 'must not exceed maxAttempts',
    });
  }
  if (
    (health.state === 'retrying' || health.state === 'unreachable') &&
    health.nextAttemptAt !== undefined &&
    health.nextAttemptAt < health.firstFailureAt
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nextAttemptAt'],
      message: 'must not precede firstFailureAt',
    });
  }
  // A clean poll recorded *after* the current failure run began would mean the run should have
  // been reset. #73 subtracts these two to say "working again after N minutes down".
  const failedAt =
    health.state === 'retrying' || health.state === 'unreachable'
      ? health.firstFailureAt
      : health.state === 'credential_rejected'
        ? health.rejectedAt
        : undefined;
  if (failedAt !== undefined && health.lastCleanPollAt !== undefined && health.lastCleanPollAt > failedAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lastCleanPollAt'],
      message: 'must not follow the failure it precedes',
    });
  }
});

export type PipenzoGitHubHealthV1 = z.infer<typeof pipenzoGitHubHealthV1Schema>;

/**
 * The state alone, for a banner that switches on it.
 *
 * Derived from the union rather than written out again as a `z.enum`. A second list of the same
 * four literals is two representations of one fact and free to disagree with the first — the same
 * reason the quota carries a fraction instead of a fraction plus the numbers it came from.
 */
export type PipenzoGitHubHealthStateV1 = PipenzoGitHubHealthV1['state'];
