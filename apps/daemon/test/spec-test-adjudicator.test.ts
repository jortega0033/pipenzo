import { describe, expect, it } from 'vitest';
import {
  droppedSpecTests,
  specTestAdjudicationV1Schema,
  type CreateSessionV2Request,
  type RefineSpecV1,
  type ReviewReportV1,
  type SpecTestAdjudicationV1,
} from '@agent-dock/shared';
import {
  SpecTestAdjudicationError,
  SpecTestAdjudicator,
  buildAdjudicationPrompt,
  dropTests,
  isBlockedAfterAdjudication,
  type AdjudicationSessionPort,
  type FailingSpecTest,
} from '../src/spec-test-adjudicator.js';

/**
 * Issue #146. README: *"a failing spec-generated test is not automatically the code's fault — it
 * is adjudicated once, by the verifier tier, into test-wrong or code-wrong."* Every test here is
 * about one of the three words that carry weight: **once**, **verifier tier**, and the fact that a
 * dropped test is never silently deleted.
 */

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

const SPEC: RefineSpecV1 = {
  schemaVersion: 1,
  issue: { repo: 'jortega0033/pipenzo', number: 146, title: 'Spec-generated test adjudication' },
  summary: 'Rule a failing generated test test-wrong or code-wrong, once.',
  acceptanceCriteria: [
    { id: 'AC-1', kind: 'ubiquitous', text: 'The daemon shall rule each failing test once' },
  ],
  outOfScope: ['Retry ladders'],
  filesLikelyTouched: [],
  estimate: { changedLines: 300, filesTouched: 5, layered: false },
  openQuestions: [],
};

function report(outcome: ReviewReportV1['outcome'] = 'awaiting_test_adjudication'): ReviewReportV1 {
  return {
    schemaVersion: 1,
    outcome,
    baseCommit: BASE,
    headCommit: HEAD,
    implementerTier: 'mid',
    deterministic: [
      { id: 'spec_tests', status: 'failed', summary: 'pnpm test exited 1', durationMs: 900 },
    ],
  };
}

const FAILING: readonly FailingSpecTest[] = [
  {
    testId: 'test/pipenzo-generated/ac-1.test.ts > rules once',
    failure: 'expected 1 ruling, received 2',
    criterionId: 'AC-1',
  },
];

function adjudicator(
  rulings: unknown,
  options: { onRequest?: (request: CreateSessionV2Request) => void; throws?: unknown } = {},
): SpecTestAdjudicator {
  const sessions: AdjudicationSessionPort = {
    run: async (request) => {
      options.onRequest?.(request);
      if (options.throws) throw options.throws;
      return { sessionId: 'adjudicator-session', output: { schemaVersion: 1, rulings } };
    },
  };
  return new SpecTestAdjudicator(sessions);
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    spec: SPEC,
    report: report(),
    failingTests: FAILING,
    diff: 'diff --git a/src/a.ts b/src/a.ts',
    implementerTier: 'mid' as const,
    adjudicator: { provider: 'codex' as const, model: 'verifier-model', tier: 'frontier' as const },
    ...overrides,
  };
}

async function rejection(fn: () => Promise<unknown>): Promise<SpecTestAdjudicationError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof SpecTestAdjudicationError) return error;
    throw error;
  }
  throw new Error('expected a SpecTestAdjudicationError');
}

describe('SpecTestAdjudicator', () => {
  const goodRuling = [
    {
      testId: FAILING[0]!.testId,
      verdict: 'test_wrong',
      rationale: 'AC-1 says once per test; the generated test asserted once per criterion.',
      criterionId: 'AC-1',
    },
  ];

  it('records the ruling with the tier and model that made it', async () => {
    const adjudication = await adjudicator(goodRuling).adjudicate(base());
    expect(adjudication).toMatchObject({
      adjudicates: { baseCommit: BASE, headCommit: HEAD },
      ruledBy: { tier: 'frontier', model: 'verifier-model', sessionId: 'adjudicator-session' },
    });
    expect(specTestAdjudicationV1Schema.safeParse(adjudication).success).toBe(true);
  });

  /**
   * The ordering `review-gates.ts` exists to establish: an LLM never settles a deterministic gate.
   * The narrow entry condition is what keeps this from becoming a way to re-litigate a real
   * deterministic failure.
   */
  it('refuses to run on any outcome but awaiting_test_adjudication', async () => {
    for (const outcome of ['approved', 'deterministic_failed', 'verifier_rejected'] as const) {
      const error = await rejection(() =>
        adjudicator(goodRuling).adjudicate(base({ report: report(outcome) })),
      );
      expect(error.code, outcome).toBe('not_awaiting_adjudication');
    }
  });

  /** "Ruled once" is a refusal, not a convention — a second opinion cannot be obtained at all. */
  it('refuses to rule a second time on tests that already have a ruling', async () => {
    const first = await adjudicator(goodRuling).adjudicate(base());
    const error = await rejection(() =>
      adjudicator(goodRuling).adjudicate(base({ existing: first })),
    );
    expect(error.code).toBe('already_adjudicated');
  });

  it('refuses duplicate rulings for one test inside a single adjudication', async () => {
    const error = await rejection(() =>
      adjudicator([...goodRuling, ...goodRuling]).adjudicate(base()),
    );
    expect(error.code).toBe('ruling_invalid');
    expect(error.details.join(' ')).toContain('exactly once');
  });

  /**
   * README's same-or-higher rule, with an extra sting here: the adjudicator's mistake deletes a
   * check rather than adding a comment.
   */
  it('refuses an adjudicator weaker than the implementer, before running anything', async () => {
    let ran = false;
    const error = await rejection(() =>
      adjudicator(goodRuling, { onRequest: () => (ran = true) }).adjudicate(
        base({
          implementerTier: 'frontier',
          adjudicator: { provider: 'claude', model: 'cheap-model', tier: 'cheap' },
        }),
      ),
    );
    expect(error.code).toBe('adjudicator_tier_too_low');
    expect(ran).toBe(false);
  });

  it('refuses a ruling about a test that did not fail in this run', async () => {
    const error = await rejection(() =>
      adjudicator([
        ...goodRuling,
        {
          testId: 'test/pipenzo-generated/invented.test.ts > nope',
          verdict: 'test_wrong',
          rationale: 'made this one up',
        },
      ]).adjudicate(base()),
    );
    expect(error.code).toBe('ruling_invalid');
    expect(error.details).toContain('test/pipenzo-generated/invented.test.ts > nope');
  });

  /**
   * An unruled failure would silently keep its old status — which, before this module existed,
   * meant "the code's fault" by default. That default is the thing the ticket removes.
   */
  it('refuses an adjudication that left a failing test unruled', async () => {
    const twoFailures = [
      ...FAILING,
      { testId: 'test/pipenzo-generated/ac-1.test.ts > second', failure: 'boom' },
    ];
    const error = await rejection(() =>
      adjudicator(goodRuling).adjudicate(base({ failingTests: twoFailures })),
    );
    expect(error.code).toBe('ruling_invalid');
    expect(error.details).toContain('test/pipenzo-generated/ac-1.test.ts > second');
  });

  it('requires a rationale on every ruling, including the ones that drop nothing', async () => {
    const error = await rejection(() =>
      adjudicator([{ testId: FAILING[0]!.testId, verdict: 'code_wrong' }]).adjudicate(base()),
    );
    expect(error.code).toBe('ruling_invalid');
  });

  it('reports a session failure as an adjudicator failure, not as a ruling', async () => {
    const error = await rejection(() =>
      adjudicator(goodRuling, { throws: new Error('provider died') }).adjudicate(base()),
    );
    expect(error.code).toBe('adjudicator_failed');
  });

  it('treats a missing payload as no rulings rather than as an empty adjudication', async () => {
    const sessions: AdjudicationSessionPort = {
      run: async () => ({ sessionId: 's', output: undefined }),
    };
    const error = await rejection(() => new SpecTestAdjudicator(sessions).adjudicate(base()));
    expect(error.code).toBe('ruling_invalid');
  });
});

describe('the consequences of a ruling', () => {
  const adjudication: SpecTestAdjudicationV1 = {
    schemaVersion: 1,
    adjudicates: { baseCommit: BASE, headCommit: HEAD },
    ruledBy: { sessionId: 's', tier: 'frontier', model: 'verifier-model' },
    rulings: [
      { testId: 'a > one', verdict: 'test_wrong', rationale: 'asserts what the spec never said' },
      { testId: 'b > two', verdict: 'code_wrong', rationale: 'AC-1 genuinely does not hold' },
    ],
  };

  /**
   * The drop list is *derived from the rulings* rather than accumulated alongside them, so
   * "dropped without a recorded reason" has no shape a caller could accidentally produce.
   */
  it('cannot produce a dropped test without the ruling that dropped it', () => {
    const dropped = dropTests(adjudication);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.testId).toBe('a > one');
    expect(dropped[0]?.ruling.rationale).toContain('never said');
    expect(droppedSpecTests(adjudication).map((ruling) => ruling.testId)).toEqual(['a > one']);
  });

  /** One code_wrong keeps the block: a generated test found something, and it was believed. */
  it('stays blocked while any ruling is code_wrong', () => {
    expect(isBlockedAfterAdjudication(adjudication)).toBe(true);
    expect(
      isBlockedAfterAdjudication({
        ...adjudication,
        rulings: [adjudication.rulings[0]!],
      }),
    ).toBe(false);
  });
});

describe('buildAdjudicationPrompt', () => {
  /**
   * A model asked to "decide which is wrong" with no stated cost will split the difference. The
   * two mistakes are not symmetric — one deletes a check permanently, the other costs a retry —
   * and the prompt says so and names the tie-break.
   */
  it('states the asymmetry between the two mistakes and the tie-break', () => {
    const prompt = buildAdjudicationPrompt(SPEC, FAILING, 'diff');
    expect(prompt).toContain('removes a check from this ticket');
    expect(prompt).toContain('costs one more implement attempt');
    expect(prompt).toContain('When you cannot tell');
    expect(prompt).toContain('recoverable error');
  });

  it('carries the criteria the generated tests came from, and the failures themselves', () => {
    const prompt = buildAdjudicationPrompt(SPEC, FAILING, 'diff --git a/x b/x');
    expect(prompt).toContain('AC-1');
    expect(prompt).toContain('expected 1 ruling, received 2');
    expect(prompt).toContain('diff --git a/x b/x');
  });

  it('asks for a rationale on every ruling, not only on the drops', () => {
    expect(buildAdjudicationPrompt(SPEC, FAILING, '')).toContain('including the code_wrong ones');
  });
});
