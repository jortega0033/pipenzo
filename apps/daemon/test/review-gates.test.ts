import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_GATE_IDS,
  MODEL_TIERS,
  reviewReportV1Schema,
  type CreateSessionV2Request,
  type ModelTier,
  type RefineSpecV1,
  type ReviewFindingV1,
} from '@agent-dock/shared';
import {
  DIFF_SCOPE_TOLERANCE,
  GENERATED_TEST_PREFIX,
  ReviewGateError,
  ReviewGatesRunner,
  assertVerifierTierAllowed,
  buildReviewerPrompt,
  buildVerifierPrompt,
  computeDiffScope,
  isGeneratedTestPath,
  type CommandResult,
  type GateCommandRunner,
  type LlmPassOutcome,
  type ModelChoice,
  type ReviewSessionPort,
  type SpecTestGeneratorPort,
} from '../src/review-gates.js';
import type { GitCommandResult, PipenzoGitRunner } from '../src/pipenzo-git.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const WORKTREE = process.platform === 'win32' ? 'C:\\owned\\issue-181' : '/owned/issue-181';

/** The implementer's transcript. Never handed to the runner — see the separation tests. */
const IMPLEMENTER_TRANSCRIPT = 'I decided to also refactor the session store while I was in here.';

function spec(overrides: Partial<RefineSpecV1> = {}): RefineSpecV1 {
  return {
    schemaVersion: 1,
    issue: { repo: 'jortega0033/pipenzo', number: 181, title: 'Backend: Review gates runner' },
    summary: 'Run deterministic gates, then an advisory reviewer, then an adversarial verifier.',
    acceptanceCriteria: [
      {
        id: 'AC-1',
        kind: 'ubiquitous',
        text: 'The runner shall run every deterministic gate before any LLM pass.',
      },
      {
        id: 'AC-2',
        kind: 'unwanted',
        text: 'If the verifier tier is below the implementer tier, then the runner shall refuse to run.',
      },
    ],
    outOfScope: ['Model-tier routing', 'Retry ladders'],
    filesLikelyTouched: ['apps/daemon/src/review-gates.ts'],
    estimate: { changedLines: 200, filesTouched: 3, layered: false },
    openQuestions: [],
    ...overrides,
  };
}

const tier = (t: ModelTier, provider: 'claude' | 'codex' = 'claude'): ModelChoice => ({
  provider,
  model: `${provider}-${t}`,
  tier: t,
});

const NUMSTAT = [
  '80\t20\tapps/daemon/src/review-gates.ts',
  '40\t10\tpackages/shared/src/pipenzo-review-v1.ts',
  `900\t0\t${GENERATED_TEST_PREFIX}ac-1.test.ts`,
].join('\n');

interface Harness {
  runner: ReviewGatesRunner;
  ran: string[];
  sessionPrompts: string[];
  commandRuns: string[][];
}

function harness(
  options: {
    commandResults?: Partial<Record<string, CommandResult>>;
    unavailable?: readonly string[];
    specTests?: boolean;
    numstat?: string;
    reviewerOutcome?: Partial<LlmPassOutcome>;
    verifierOutcome?: Partial<LlmPassOutcome>;
    sessionError?: unknown;
  } = {},
): Harness {
  const ran: string[] = [];
  const sessionPrompts: string[] = [];
  const commandRuns: string[][] = [];

  const commands: GateCommandRunner = {
    available: async (command) => !(options.unavailable ?? []).includes(command),
    run: async (command, args) => {
      ran.push(command);
      commandRuns.push([command, ...args]);
      return options.commandResults?.[command] ?? { stdout: '', stderr: '', code: 0 };
    },
  };

  let passIndex = 0;
  const sessions: ReviewSessionPort = {
    run: async (request: CreateSessionV2Request) => {
      ran.push(passIndex === 0 ? 'reviewer' : 'verifier');
      sessionPrompts.push(request.prompt);
      if (options.sessionError) throw options.sessionError;
      const outcome: LlmPassOutcome =
        passIndex === 0
          ? { sessionId: 'reviewer-session', findings: [], ...options.reviewerOutcome }
          : {
              sessionId: 'verifier-session',
              findings: [],
              verdict: 'approved',
              ...options.verifierOutcome,
            };
      passIndex += 1;
      return outcome;
    },
  };

  const specTests: SpecTestGeneratorPort | undefined = options.specTests
    ? {
        generate: async () => {
          ran.push('spec-test-generator');
          return { sessionId: 'generator-session', files: [`${GENERATED_TEST_PREFIX}ac-1.test.ts`] };
        },
      }
    : undefined;

  const gitResult = (stdout: string): GitCommandResult => ({ stdout, stderr: '', code: 0 });
  const runGit: PipenzoGitRunner = async (args) =>
    args.includes('--numstat')
      ? gitResult(options.numstat ?? NUMSTAT)
      : gitResult('diff --git a/x b/x\n+added line\n');

  return {
    ran,
    sessionPrompts,
    commandRuns,
    runner: new ReviewGatesRunner({
      commands,
      sessions,
      runGit,
      ...(specTests ? { specTests } : {}),
    }),
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    spec: spec(),
    worktreePath: WORKTREE,
    baseCommit: BASE,
    headCommit: HEAD,
    implementerTier: 'mid' as ModelTier,
    reviewer: tier('cheap'),
    verifier: tier('frontier', 'codex'),
    ...overrides,
  };
}

async function rejection(fn: () => Promise<unknown>): Promise<ReviewGateError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ReviewGateError) return error;
    throw error;
  }
  throw new Error('expected a ReviewGateError');
}

describe('assertVerifierTierAllowed', () => {
  it('allows a verifier at the implementer tier or above', () => {
    expect(() => assertVerifierTierAllowed('cheap', 'cheap')).not.toThrow();
    expect(() => assertVerifierTierAllowed('cheap', 'frontier')).not.toThrow();
    expect(() => assertVerifierTierAllowed('mid', 'frontier')).not.toThrow();
  });

  /**
   * README states this as a hard rule, not a preference, on the strength of cross-tier regression
   * evidence: a weaker model reviewing a stronger one produced 3 fixes against 13 new bugs.
   */
  it('refuses every weaker-verifier pairing', () => {
    const pairs: Array<[ModelTier, ModelTier]> = [
      ['mid', 'cheap'],
      ['frontier', 'cheap'],
      ['frontier', 'mid'],
    ];
    for (const [implementer, verifier] of pairs) {
      const error = (() => {
        try {
          assertVerifierTierAllowed(implementer, verifier);
        } catch (thrown) {
          return thrown as ReviewGateError;
        }
        throw new Error('expected a throw');
      })();
      expect(error.code).toBe('verifier_tier_too_low');
      expect(error.details).toEqual([`implementer=${implementer}`, `verifier=${verifier}`]);
    }
  });

  it('covers every tier pair the tier list defines', () => {
    for (const implementer of MODEL_TIERS) {
      for (const verifier of MODEL_TIERS) {
        const allowed = MODEL_TIERS.indexOf(verifier) >= MODEL_TIERS.indexOf(implementer);
        const throws = (() => {
          try {
            assertVerifierTierAllowed(implementer, verifier);
            return false;
          } catch {
            return true;
          }
        })();
        expect(throws).toBe(!allowed);
      }
    }
  });
});

describe('computeDiffScope — the implementation/test split (issue #145)', () => {
  it('counts generated tests separately so they cannot blow the estimate', () => {
    const scope = computeDiffScope(NUMSTAT, spec());
    expect(scope.implementation).toEqual({ changedLines: 150, filesTouched: 2 });
    expect(scope.generatedTests).toEqual({ changedLines: 900, filesTouched: 1 });
    // 900 generated-test lines against a 200-line estimate would be a 5x blow-out if they counted.
    expect(scope.exceededEstimate).toBe(false);
    expect(scope.ratio).toBeCloseTo(0.75, 4);
  });

  it('fails only when implementation lines exceed the estimate by more than the tolerance', () => {
    const onTolerance = computeDiffScope(`300\t0\tsrc/a.ts`, spec());
    expect(onTolerance.ratio).toBe(DIFF_SCOPE_TOLERANCE);
    expect(onTolerance.exceededEstimate).toBe(false);

    const over = computeDiffScope(`301\t0\tsrc/a.ts`, spec());
    expect(over.exceededEstimate).toBe(true);
  });

  it('treats a binary file as a touched file with no lines, rather than as NaN', () => {
    const scope = computeDiffScope('-\t-\tassets/logo.png', spec());
    expect(scope.implementation).toEqual({ changedLines: 0, filesTouched: 1 });
    expect(scope.ratio).toBe(0);
  });

  it('handles a zero estimate without dividing into Infinity', () => {
    const zero = spec({ estimate: { changedLines: 0, filesTouched: 0, layered: false } });
    expect(computeDiffScope('', zero).exceededEstimate).toBe(false);
    expect(computeDiffScope('10\t0\tsrc/a.ts', zero).exceededEstimate).toBe(true);
  });

  it('classifies by the daemon-chosen prefix, not by a filename heuristic', () => {
    // A heuristic over `*.test.ts` would let an implementer move its own diff out of the estimate
    // by naming a file well — precisely the accounting the size gate exists to prevent.
    expect(isGeneratedTestPath(`${GENERATED_TEST_PREFIX}ac-1.test.ts`)).toBe(true);
    expect(isGeneratedTestPath('apps/daemon/test/review-gates.test.ts')).toBe(false);
    expect(isGeneratedTestPath('src/sneaky.test.ts')).toBe(false);
    expect(isGeneratedTestPath(GENERATED_TEST_PREFIX.replaceAll('/', '\\') + 'ac-1.test.ts')).toBe(true);
  });
});

describe('ReviewGatesRunner — ordering', () => {
  it('runs every deterministic gate, in order, before either LLM pass', async () => {
    const h = harness({ specTests: true });
    const report = await h.runner.run(request());

    expect(report.outcome).toBe('approved');
    expect(report.deterministic.map((gate) => gate.id)).toEqual([...DETERMINISTIC_GATE_IDS]);

    const reviewerAt = h.ran.indexOf('reviewer');
    const verifierAt = h.ran.indexOf('verifier');
    const lastCommandAt = Math.max(
      h.ran.indexOf('pnpm'),
      h.ran.lastIndexOf('pnpm'),
      h.ran.indexOf('gitleaks'),
      h.ran.indexOf('semgrep'),
    );
    expect(lastCommandAt).toBeGreaterThanOrEqual(0);
    expect(reviewerAt).toBeGreaterThan(lastCommandAt);
    expect(verifierAt).toBeGreaterThan(reviewerAt);
    // The generated tests are written before the gate that runs them, and by their own pass.
    expect(h.ran.indexOf('spec-test-generator')).toBeLessThan(lastCommandAt);
  });

  it('returns on a deterministic failure without constructing either LLM pass', async () => {
    const h = harness({
      specTests: true,
      commandResults: { pnpm: { stdout: '', stderr: 'TS2304: Cannot find name', code: 2 } },
    });
    const report = await h.runner.run(request());

    expect(report.outcome).toBe('deterministic_failed');
    expect(report.reviewer).toBeUndefined();
    expect(report.verifier).toBeUndefined();
    expect(h.ran).not.toContain('reviewer');
    expect(h.ran).not.toContain('verifier');
  });

  /**
   * The inverse is unrepresentable, which is what makes the ordering hold even for a caller who
   * assembles a report by hand rather than going through the runner.
   */
  it('cannot be serialized out of order: the report schema refuses the combination', () => {
    const invalid = {
      schemaVersion: 1,
      outcome: 'approved',
      baseCommit: BASE,
      headCommit: HEAD,
      implementerTier: 'mid',
      deterministic: [{ id: 'build', status: 'failed', summary: 'build failed', durationMs: 10 }],
      reviewer: { sessionId: 's', tier: 'mid', model: 'm', findings: [] },
    };
    const parsed = reviewReportV1Schema.safeParse(invalid);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('deterministic gates did not pass');
  });

  it('exposes no way to run a pass on its own', () => {
    const surface = Object.getOwnPropertyNames(ReviewGatesRunner.prototype);
    expect(surface).toEqual(expect.arrayContaining(['constructor', 'run']));
    for (const name of surface) {
      expect(['constructor', 'run']).toContain(name);
    }
  });

  it('refuses a weaker verifier before running anything at all', async () => {
    const h = harness({ specTests: true });
    const error = await rejection(() =>
      h.runner.run(request({ implementerTier: 'frontier', verifier: tier('mid') })),
    );
    expect(error.code).toBe('verifier_tier_too_low');
    expect(h.ran).toEqual([]);
  });
});

describe('ReviewGatesRunner — honesty of the evidence', () => {
  it('records an absent scanner as skipped with a reason, never as passed', async () => {
    const h = harness({ specTests: true, unavailable: ['gitleaks', 'semgrep'] });
    const report = await h.runner.run(request());

    for (const id of ['gitleaks', 'semgrep'] as const) {
      const gate = report.deterministic.find((entry) => entry.id === id);
      expect(gate?.status).toBe('skipped');
      expect(gate?.summary).toContain('did not run');
    }
    expect(report.outcome).toBe('approved');
    expect(h.ran).not.toContain('gitleaks');
  });

  it('records a missing spec-test generator as skipped, saying the tests were never written', async () => {
    const h = harness({ specTests: false });
    const report = await h.runner.run(request());
    const gate = report.deterministic.find((entry) => entry.id === 'spec_tests');
    expect(gate?.status).toBe('skipped');
    expect(gate?.summary).toContain('never written');
    expect(h.ran).not.toContain('spec-test-generator');
  });

  /**
   * README: a failing spec-generated test is not automatically the code's fault. Adjudicating it
   * would mean running the verifier to settle a deterministic gate, inverting the very ordering
   * this ticket establishes — so the run stops with an outcome that says nobody has ruled yet.
   */
  it('separates a failing generated test from a failing build', async () => {
    const h = harness({
      specTests: true,
      // Only the test command fails; build and typecheck share the `pnpm` executable, so the
      // runner is driven through argv rather than executable name here.
      commandResults: {},
    });
    // Drive the failure through a dedicated test command so only `spec_tests` fails.
    const failing = new ReviewGatesRunner({
      commands: {
        available: async () => true,
        run: async (command) =>
          command === 'vitest'
            ? { stdout: '', stderr: 'AC-2 assertion failed', code: 1 }
            : { stdout: '', stderr: '', code: 0 },
      },
      sessions: { run: async () => ({ sessionId: 'never', findings: [] }) },
      specTests: {
        generate: async () => ({ sessionId: 'g', files: [`${GENERATED_TEST_PREFIX}ac-1.test.ts`] }),
      },
      runGit: async (args) => ({
        stdout: args.includes('--numstat') ? NUMSTAT : 'diff',
        stderr: '',
        code: 0,
      }),
      testCommand: ['vitest', 'run'],
    });
    const report = await failing.run(request());
    expect(report.outcome).toBe('awaiting_test_adjudication');
    expect(report.reviewer).toBeUndefined();
    void h;
  });

  it('reports the diff-scope numbers with the two halves separate', async () => {
    const h = harness({ specTests: true });
    const report = await h.runner.run(request());
    const gate = report.deterministic.find((entry) => entry.id === 'diff_scope');
    expect(gate?.status).toBe('passed');
    expect(gate?.detail).toContain('implementation: 150 lines / 2 files');
    expect(gate?.detail).toContain('generated tests: 900 lines / 1 files');
    expect(report.diffScope?.exceededEstimate).toBe(false);
  });

  it('fails the diff-scope gate on a blown estimate, and stops there', async () => {
    const h = harness({ specTests: true, numstat: '900\t0\tsrc/enormous.ts' });
    const report = await h.runner.run(request());
    expect(report.outcome).toBe('deterministic_failed');
    expect(report.deterministic.find((entry) => entry.id === 'diff_scope')?.status).toBe('failed');
    expect(h.ran).not.toContain('reviewer');
  });

  it('records when a single-vendor install could not honour the cross-vendor tiebreak', async () => {
    const sameVendor = harness({ specTests: true });
    const report = await sameVendor.runner.run(
      request({ reviewer: tier('mid'), verifier: tier('frontier') }),
    );
    expect(report.verifier?.vendorDiversityUnavailable).toBe(true);

    const crossVendor = harness({ specTests: true });
    const other = await crossVendor.runner.run(request());
    expect(other.verifier?.vendorDiversityUnavailable).toBe(false);
  });

  it('carries a verifier rejection through as its own outcome', async () => {
    const h = harness({
      specTests: true,
      verifierOutcome: {
        verdict: 'rejected',
        findings: [{ severity: 'high', message: 'AC-2 is not satisfied', criterionId: 'AC-2' }],
      },
    });
    const report = await h.runner.run(request());
    expect(report.outcome).toBe('verifier_rejected');
    expect(report.verifier?.findings).toHaveLength(1);
  });

  it('refuses a verifier that returned no verdict, rather than treating silence as approval', async () => {
    const h = harness({ specTests: true, verifierOutcome: { verdict: undefined } });
    expect((await rejection(() => h.runner.run(request()))).code).toBe('verifier_failed');
  });
});

describe('ReviewGatesRunner — separation of the LLM passes', () => {
  it('never gives the reviewer the implementer’s transcript', async () => {
    const h = harness({ specTests: true });
    await h.runner.run(request());
    const [reviewerPrompt] = h.sessionPrompts;
    expect(reviewerPrompt).toBeDefined();
    expect(reviewerPrompt).not.toContain(IMPLEMENTER_TRANSCRIPT);
    // Enforced by the signature, not by the wording: two parameters, neither a transcript.
    expect(buildReviewerPrompt.length).toBe(2);
  });

  it('gives the verifier the reviewer’s findings, and not the other way round', async () => {
    const finding: ReviewFindingV1 = {
      severity: 'medium',
      path: 'apps/daemon/src/review-gates.ts',
      message: 'the ordering is not asserted anywhere',
    };
    const h = harness({ specTests: true, reviewerOutcome: { findings: [finding] } });
    await h.runner.run(request());

    const [reviewerPrompt, verifierPrompt] = h.sessionPrompts;
    expect(reviewerPrompt).not.toContain('the ordering is not asserted anywhere');
    expect(verifierPrompt).toContain('the ordering is not asserted anywhere');
    expect(verifierPrompt).toContain('Reviewer findings to adjudicate');
  });

  it('runs the two passes as two separate sessions', async () => {
    const h = harness({ specTests: true });
    const report = await h.runner.run(request());
    expect(report.reviewer?.sessionId).toBe('reviewer-session');
    expect(report.verifier?.sessionId).toBe('verifier-session');
    expect(report.reviewer?.sessionId).not.toBe(report.verifier?.sessionId);
  });

  it('tells the reviewer its findings are advisory and the verifier that it is the gate', () => {
    expect(buildReviewerPrompt(spec(), 'diff')).toContain('advisory');
    const verifierPrompt = buildVerifierPrompt(spec(), 'diff', []);
    expect(verifierPrompt).toContain('You are the gate');
    expect(verifierPrompt).toContain('not conclusions');
  });

  it('gives both passes the spec’s criteria and out-of-scope bounds', () => {
    for (const prompt of [buildReviewerPrompt(spec(), 'diff'), buildVerifierPrompt(spec(), 'diff', [])]) {
      expect(prompt).toContain('AC-1');
      expect(prompt).toContain('AC-2');
      expect(prompt).toContain('Model-tier routing');
      expect(prompt).toContain('jortega0033/pipenzo#181');
    }
  });
});

describe('ReviewGatesRunner — input validation', () => {
  it('refuses an invalid spec, two malformed shas, or a missing worktree path', async () => {
    const h = harness({ specTests: true });
    expect(
      (await rejection(() => h.runner.run(request({ spec: { schemaVersion: 1 } })))).code,
    ).toBe('invalid_spec');
    expect((await rejection(() => h.runner.run(request({ baseCommit: 'HEAD' })))).code).toBe(
      'invalid_request',
    );
    expect((await rejection(() => h.runner.run(request({ worktreePath: '  ' })))).code).toBe(
      'invalid_request',
    );
  });

  it('surfaces an unreadable diff distinctly from a gate failure', async () => {
    const runner = new ReviewGatesRunner({
      commands: { available: async () => true, run: async () => ({ stdout: '', stderr: '', code: 0 }) },
      sessions: { run: async () => ({ sessionId: 's', findings: [] }) },
      runGit: async () => ({ stdout: '', stderr: 'fatal: bad revision', code: 128 }),
    });
    expect((await rejection(() => runner.run(request()))).code).toBe('diff_unavailable');
  });

  it('terminates git option parsing before the caller-influenced revision range', () => {
    const source = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'review-gates.ts'),
      'utf8',
    );
    for (const call of source.match(/this\.#runGit\(\s*\[[^\]]*\]/g) ?? []) {
      expect(call).toContain('--end-of-options');
    }
  });
});
