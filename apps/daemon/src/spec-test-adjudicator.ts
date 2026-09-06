import {
  SPEC_TEST_ADJUDICATION_V1_JSON_SCHEMA,
  specTestAdjudicationV1Schema,
  type CreateSessionV2Request,
  type ModelTier,
  type RefineSpecV1,
  type ReviewReportV1,
  type SpecTestAdjudicationV1,
  type SpecTestRulingV1,
} from '@agent-dock/shared';
import { ReviewGateError, assertVerifierTierAllowed, type ModelChoice } from './review-gates.js';

/**
 * Spec-generated test adjudication (Pipenzo issue #146).
 *
 * README: *"a failing spec-generated test is not automatically the code's fault — it is
 * adjudicated once, by the verifier tier, into test-wrong or code-wrong."*
 *
 * `review-gates.ts` left this out on purpose and said why: settling a deterministic gate by
 * running an LLM inverts the ordering that module exists to establish. So the ordering is
 * preserved by making this a **separate step that runs after** a review returned
 * `awaiting_test_adjudication` — the one outcome that means "a generated test failed and nobody has
 * ruled on whose fault that is". This module is that step, and it refuses to run on any other
 * outcome, which is what stops it becoming a way to re-litigate a real deterministic failure.
 *
 * ## What "ruled once" is enforced by
 *
 * Not by discipline. Three things:
 *
 * - The record refuses duplicate test ids (`specTestAdjudicationV1Schema`).
 * - `adjudicate()` refuses to run against a report that already has an adjudication for the same
 *   commit pair — `already_adjudicated`, not a silent second opinion.
 * - A ruling must name a test that actually failed. A model that rules on a test it invented, or
 *   on one that passed, fails the step rather than having its extra ruling dropped — a ruling
 *   about a test nobody ran is evidence that the adjudicator was not looking at this run.
 *
 * ## What "never silently deleted" is enforced by
 *
 * `dropTests()` returns the paths a `test_wrong` ruling drops, and it can only be called with the
 * adjudication in hand. There is no path from "this test failed" to "this test is gone" that does
 * not produce a ruling with a rationale, because the drop list is *derived from the rulings*
 * rather than accumulated alongside them.
 */

export type SpecTestAdjudicationErrorCode =
  | 'not_awaiting_adjudication'
  | 'already_adjudicated'
  | 'invalid_request'
  | 'adjudicator_tier_too_low'
  | 'adjudicator_failed'
  | 'ruling_invalid';

export class SpecTestAdjudicationError extends Error {
  readonly code: SpecTestAdjudicationErrorCode;
  readonly details: readonly string[];

  constructor(
    code: SpecTestAdjudicationErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'SpecTestAdjudicationError';
    this.code = code;
    this.details = details.slice(0, 20).map((detail) => detail.slice(0, 500));
  }
}

export interface AdjudicationSessionOutcome {
  readonly sessionId: string;
  /** Whatever the session returned as structured output. Re-validated here, never trusted. */
  readonly output: unknown;
}

/** The seam onto agentdock's session machinery, mirroring the other phases' ports. */
export interface AdjudicationSessionPort {
  run(request: CreateSessionV2Request): Promise<AdjudicationSessionOutcome>;
}

/** One generated test that failed, as the test run reported it. */
export interface FailingSpecTest {
  /** Repo-relative path plus test name. Must sit under the generated-test prefix. */
  readonly testId: string;
  /** The failure output. Bounded — this reaches a prompt. */
  readonly failure: string;
  readonly criterionId?: string;
}

export interface AdjudicateRequest {
  readonly spec: RefineSpecV1;
  /** The review that stopped at `awaiting_test_adjudication`. */
  readonly report: ReviewReportV1;
  readonly failingTests: readonly FailingSpecTest[];
  /** The implementation diff, so a ruling can be checked against the code it is about. */
  readonly diff: string;
  /** The tier the implementer ran at. The adjudicator is never below it. */
  readonly implementerTier: ModelTier;
  readonly adjudicator: ModelChoice;
  /** An adjudication already on file for this commit pair. Present means: refuse. */
  readonly existing?: SpecTestAdjudicationV1;
}

const MAX_FAILURE_CHARS = 8_000;
const MAX_DIFF_CHARS = 200_000;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated]`;
}

export class SpecTestAdjudicator {
  readonly #sessions: AdjudicationSessionPort;

  constructor(sessions: AdjudicationSessionPort) {
    this.#sessions = sessions;
  }

  async adjudicate(request: AdjudicateRequest): Promise<SpecTestAdjudicationV1> {
    if (request.report.outcome !== 'awaiting_test_adjudication') {
      // The narrow entry condition is the whole reason this does not invert the review ordering.
      // A report that failed `build` is not waiting for anybody's opinion about a test.
      throw new SpecTestAdjudicationError(
        'not_awaiting_adjudication',
        'only a review awaiting test adjudication can be adjudicated',
        [request.report.outcome],
      );
    }
    if (request.existing) {
      throw new SpecTestAdjudicationError(
        'already_adjudicated',
        'these generated tests have already been ruled on once',
      );
    }
    if (request.failingTests.length === 0) {
      throw new SpecTestAdjudicationError(
        'invalid_request',
        'adjudication requires at least one failing generated test',
      );
    }
    const ids = request.failingTests.map((test) => test.testId);
    if (new Set(ids).size !== ids.length) {
      throw new SpecTestAdjudicationError(
        'invalid_request',
        'the same failing test was submitted twice',
      );
    }

    // README's same-or-higher rule, reused rather than restated. The adjudicator *is* the verifier
    // tier, and a weaker model ruling a test invalid is the cross-tier regression that evidence is
    // about — with the added sting that its mistake deletes a check rather than adding a comment.
    try {
      assertVerifierTierAllowed(request.implementerTier, request.adjudicator.tier);
    } catch (error) {
      throw new SpecTestAdjudicationError(
        'adjudicator_tier_too_low',
        error instanceof ReviewGateError
          ? error.message
          : 'the adjudicator is weaker than the implementer',
      );
    }

    let outcome: AdjudicationSessionOutcome;
    try {
      outcome = await this.#sessions.run({
        provider: request.adjudicator.provider,
        cwd: '',
        prompt: buildAdjudicationPrompt(
          request.spec,
          request.failingTests,
          truncate(request.diff, MAX_DIFF_CHARS),
        ),
        model: request.adjudicator.model,
        outputSchema:
          SPEC_TEST_ADJUDICATION_V1_JSON_SCHEMA as unknown as CreateSessionV2Request['outputSchema'],
      });
    } catch (error) {
      throw new SpecTestAdjudicationError(
        'adjudicator_failed',
        error instanceof Error ? error.message : 'the adjudication session failed',
      );
    }

    return this.#validate(request, outcome);
  }

  #validate(
    request: AdjudicateRequest,
    outcome: AdjudicationSessionOutcome,
  ): SpecTestAdjudicationV1 {
    const raw = outcome.output;
    if (raw === undefined || raw === null) {
      throw new SpecTestAdjudicationError(
        'ruling_invalid',
        'the adjudication session produced no rulings',
      );
    }
    const parsed = specTestAdjudicationV1Schema.safeParse({
      schemaVersion: 1,
      adjudicates: {
        baseCommit: request.report.baseCommit,
        headCommit: request.report.headCommit,
      },
      ruledBy: {
        sessionId: outcome.sessionId,
        tier: request.adjudicator.tier,
        model: request.adjudicator.model,
      },
      rulings: (raw as { rulings?: unknown }).rulings,
    });
    if (!parsed.success) {
      throw new SpecTestAdjudicationError(
        'ruling_invalid',
        'the adjudication did not match the v1 schema',
        parsed.error.issues
          .slice(0, 20)
          .map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`),
      );
    }

    const failing = new Set(request.failingTests.map((test) => test.testId));
    const ruled = new Set(parsed.data.rulings.map((ruling) => ruling.testId));
    const invented = parsed.data.rulings
      .map((ruling) => ruling.testId)
      .filter((testId) => !failing.has(testId));
    if (invented.length > 0) {
      // Not dropped as noise. A ruling about a test nobody ran is evidence the adjudicator was not
      // looking at this run, which makes its other rulings worth no more than a guess.
      throw new SpecTestAdjudicationError(
        'ruling_invalid',
        'the adjudicator ruled on a test that did not fail in this run',
        invented,
      );
    }
    const unruled = [...failing].filter((testId) => !ruled.has(testId));
    if (unruled.length > 0) {
      // Every failing test gets a ruling. An unruled failure would silently keep its old status —
      // which, before this module existed, meant "the code's fault" by default.
      throw new SpecTestAdjudicationError(
        'ruling_invalid',
        'the adjudicator left a failing generated test unruled',
        unruled,
      );
    }
    return parsed.data;
  }
}

/**
 * The tests a `test_wrong` ruling drops, paired with the ruling that dropped each one.
 *
 * Returning pairs rather than paths is the point: a caller cannot obtain the drop list without
 * also holding the reason for each drop, so "dropped without a recorded ruling" has no shape a
 * caller could accidentally produce.
 */
export function dropTests(
  adjudication: SpecTestAdjudicationV1,
): readonly { readonly testId: string; readonly ruling: SpecTestRulingV1 }[] {
  return adjudication.rulings
    .filter((ruling) => ruling.verdict === 'test_wrong')
    .map((ruling) => ({ testId: ruling.testId, ruling }));
}

/**
 * Whether the diff is still blocked after the ruling.
 *
 * A single `code_wrong` keeps the block: the generated tests exist to check the spec, and one of
 * them found something. Only an adjudication that ruled *every* failure test-wrong clears the way,
 * and even then the drops are recorded and visible in the pull request.
 */
export function isBlockedAfterAdjudication(adjudication: SpecTestAdjudicationV1): boolean {
  return adjudication.rulings.some((ruling) => ruling.verdict === 'code_wrong');
}

/**
 * The adjudicator's prompt.
 *
 * It states the asymmetry rather than leaving it to be inferred: dropping a test removes a check
 * from the ticket permanently, and keeping a wrong test costs one implement retry. A model asked
 * to "decide which is wrong" with no stated cost will split the difference; a model told which
 * mistake is expensive will not.
 */
export function buildAdjudicationPrompt(
  spec: RefineSpecV1,
  failingTests: readonly FailingSpecTest[],
  diff: string,
): string {
  const criteria = spec.acceptanceCriteria.map(
    (criterion) => `  ${criterion.id}: ${criterion.text}`,
  );
  const failures = failingTests.map((test) =>
    [
      `  ${test.testId}${test.criterionId ? ` (from ${test.criterionId})` : ''}`,
      ...truncate(test.failure, MAX_FAILURE_CHARS)
        .split(/\r?\n/)
        .map((line) => `    ${line}`),
    ].join('\n'),
  );
  return [
    'A spec-generated test failed against this diff. Those tests were written from the spec by a',
    'separate pass, not by the implementer, so a failure means one of two things and you are here',
    'to decide which:',
    '',
    '  test_wrong — the generated test misreads the acceptance criterion it came from, or asserts',
    '               something the spec never required. The test is dropped.',
    '  code_wrong — the diff genuinely does not satisfy the criterion. The test stays and the',
    '               implementer tries again.',
    '',
    'These two mistakes do not cost the same. Ruling test_wrong removes a check from this ticket',
    'permanently; ruling code_wrong costs one more implement attempt. When you cannot tell, rule',
    'code_wrong — that is the recoverable error.',
    '',
    'Rule on every test listed below, exactly once each, and on no other test. Give a rationale for',
    'each ruling, including the code_wrong ones: your rationale is what a human reads in the pull',
    'request to check your reasoning.',
    '',
    `Ticket: ${spec.issue.repo}#${spec.issue.number} — ${spec.issue.title}`,
    '',
    'Acceptance criteria the generated tests were written from',
    ...criteria,
    '',
    'Explicitly out of scope',
    ...spec.outOfScope.map((entry) => `  - ${entry}`),
    '',
    'Failing generated tests',
    ...failures,
    '',
    'Diff',
    diff,
  ].join('\n');
}
