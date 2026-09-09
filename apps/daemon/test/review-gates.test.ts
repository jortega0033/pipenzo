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
  selectVerifier,
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

  it('fails the diff-scope gate on a blown estimate, reports estimate_blown, and stops there', async () => {
    const h = harness({ specTests: true, numstat: '900\t0\tsrc/enormous.ts' });
    const report = await h.runner.run(request());
    // Issue #144/#265: a lone diff_scope failure is its own outcome, not generic
    // deterministic_failed -- distinct so a consequence can attach to this reason specifically.
    expect(report.outcome).toBe('estimate_blown');
    expect(report.deterministic.find((entry) => entry.id === 'diff_scope')?.status).toBe('failed');
    expect(h.ran).not.toContain('reviewer');
  });

  it('reports plain deterministic_failed when diff_scope fails alongside another gate', async () => {
    // No specTests generator, so spec_tests reports 'skipped' rather than joining the failure --
    // build and typecheck both shell out to 'pnpm' by default, so failing that executable fails
    // both of them alongside diff_scope, which is enough to prove the point: more than one cause.
    const h = harness({
      numstat: '900\t0\tsrc/enormous.ts',
      commandResults: { pnpm: { stdout: '', stderr: 'build broke', code: 1 } },
    });
    const report = await h.runner.run(request());
    // A real multi-cause failure must not be collapsed into estimate_blown -- that outcome is for
    // a blown estimate being the *whole* story, and here it is not.
    expect(report.outcome).toBe('deterministic_failed');
    expect(report.deterministic.find((entry) => entry.id === 'diff_scope')?.status).toBe('failed');
    expect(report.deterministic.find((entry) => entry.id === 'build')?.status).toBe('failed');
  });

  /**
   * Issue #147 corrected which comparison this is. The cross-vendor rule is about the
   * *implementer*: a verifier sharing the vendor of the code it is checking shares that vendor's
   * blind spots. Comparing the verifier against the reviewer answered a question nobody asked.
   */
  it('records when a single-vendor install could not honour the cross-vendor tiebreak', async () => {
    const sameVendor = harness({ specTests: true });
    const report = await sameVendor.runner.run(
      request({ implementerProvider: 'codex', verifier: tier('frontier', 'codex') }),
    );
    expect(report.verifier?.vendorDiversityUnavailable).toBe(true);

    const crossVendor = harness({ specTests: true });
    const other = await crossVendor.runner.run(
      request({ implementerProvider: 'claude', verifier: tier('frontier', 'codex') }),
    );
    expect(other.verifier?.vendorDiversityUnavailable).toBe(false);
  });

  /**
   * Fail-closed. A caller that never said which vendor the implementer ran on cannot have this run
   * recorded as cross-vendor: that would be a claim the report has no basis for, and the whole
   * point of the field is that the evidence block must not imply a stronger check than happened.
   */
  it('records diversity as unavailable when the implementer’s vendor is unknown', async () => {
    const h = harness({ specTests: true });
    const report = await h.runner.run(request({ verifier: tier('frontier', 'codex') }));
    expect(report.verifier?.vendorDiversityUnavailable).toBe(true);
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

describe('ReviewGatesRunner — the lint gate (issue #283)', () => {
  it('defaults to `pnpm lint`, the same shape build/typecheck default to', async () => {
    const h = harness({ specTests: true });
    await h.runner.run(request());
    expect(h.commandRuns).toContainEqual(['pnpm', 'lint']);
  });

  it('honours a custom lintCommand, the same way the other three do', async () => {
    const runs: string[][] = [];
    const runner = new ReviewGatesRunner({
      commands: {
        available: async () => true,
        run: async (command, args) => {
          runs.push([command, ...args]);
          return { stdout: '', stderr: '', code: 0 };
        },
      },
      sessions: { run: async () => ({ sessionId: 's', findings: [], verdict: 'approved' }) },
      runGit: async (args) => ({
        stdout: args.includes('--numstat') ? NUMSTAT : 'diff',
        stderr: '',
        code: 0,
      }),
      lintCommand: ['eslint', '.'],
    });
    await runner.run(request());
    expect(runs).toContainEqual(['eslint', '.']);
  });

  /**
   * Unlike build/typecheck -- commands this runner's own repo always defines -- not every
   * repository defines a lint script at all. pnpm's own `ERR_PNPM_NO_SCRIPT` marker distinguishes
   * that from a real lint regression, so an absent script is recorded the same honest way an
   * uninstalled gitleaks/semgrep binary is: skipped, with the reason, never as a failure the repo
   * did nothing to earn.
   */
  it('records a repo with no lint script as skipped, not failed', async () => {
    const h = harness({
      specTests: true,
      commandResults: {
        pnpm: {
          stdout: '',
          stderr: ' ERR_PNPM_NO_SCRIPT  Missing script: lint\n\nCommand "lint" not found.',
          code: 1,
        },
      },
    });
    const report = await h.runner.run(request());
    const gate = report.deterministic.find((entry) => entry.id === 'lint');
    expect(gate?.status).toBe('skipped');
    expect(gate?.summary).toContain('no lint script');
    // Build and typecheck share the same executable and the same failing result in this harness,
    // so this pins that the ERR_PNPM_NO_SCRIPT carve-out is scoped to `lint` alone -- a real build
    // failure must still fail, not be forgiven by the same marker check.
    expect(report.deterministic.find((entry) => entry.id === 'build')?.status).toBe('failed');
    expect(report.deterministic.find((entry) => entry.id === 'typecheck')?.status).toBe('failed');
  });

  /**
   * Caught by review: checking merely whether `ERR_PNPM_NO_SCRIPT` appears *anywhere* in the
   * combined output would let a real regression hide behind it -- a caller-configured recursive
   * `lintCommand` (`pnpm -r lint`) could plausibly mix one workspace member's missing script with
   * another member's real violation in one run. Requiring the marker to *lead* the output (verified
   * empirically: a genuinely missing, non-recursive script prints nothing else) means a real
   * failure that happens to arrive alongside that marker is still reported as the failure it is --
   * the exact silent-downgrade issue #196 was about, which this whole gate exists to catch.
   */
  it('does not let a real failure hide behind a missing-script marker elsewhere in the output', async () => {
    const h = harness({
      specTests: true,
      commandResults: {
        pnpm: {
          stdout: 'packages/other: 1:1 error no-unused-vars\n',
          stderr: 'packages/missing: ERR_PNPM_NO_SCRIPT  Missing script: lint',
          code: 1,
        },
      },
    });
    const report = await h.runner.run(request());
    const gate = report.deterministic.find((entry) => entry.id === 'lint');
    expect(gate?.status).toBe('failed');
    expect(gate?.detail).toContain('no-unused-vars');
  });

  it('fails on a real lint regression, distinctly from a missing script', async () => {
    const runner = new ReviewGatesRunner({
      commands: {
        available: async () => true,
        run: async (command) =>
          command === 'eslint'
            ? { stdout: 'src/x.ts\n  1:1  error  no-unused-vars', stderr: '', code: 1 }
            : { stdout: '', stderr: '', code: 0 },
      },
      sessions: { run: async () => ({ sessionId: 's', findings: [], verdict: 'approved' }) },
      runGit: async (args) => ({
        stdout: args.includes('--numstat') ? NUMSTAT : 'diff',
        stderr: '',
        code: 0,
      }),
      lintCommand: ['eslint', '.'],
    });
    const report = await runner.run(request());
    const gate = report.deterministic.find((entry) => entry.id === 'lint');
    expect(gate?.status).toBe('failed');
    expect(gate?.detail).toContain('no-unused-vars');
    expect(report.outcome).toBe('deterministic_failed');
  });
});

describe('ReviewGatesRunner — separation of the LLM passes', () => {
  it('never gives the reviewer the implementer’s transcript', async () => {
    const h = harness({ specTests: true });
    await h.runner.run(request());
    const [reviewerPrompt] = h.sessionPrompts;
    expect(reviewerPrompt).toBeDefined();
    expect(reviewerPrompt).not.toContain(IMPLEMENTER_TRANSCRIPT);
    // Enforced by the signature, not by the wording: three parameters (issue #284 added
    // `conventions`, repo-authored prose, as the third) and none of them is a transcript.
    expect(buildReviewerPrompt.length).toBe(3);
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

  /**
   * Issue #284: repo-wide conventions reach both LLM passes, end to end through the runner (not
   * just the prompt builders in isolation) -- and are absent from the prompt entirely when the
   * request carries none, the same "no clause for a fact nobody supplied" rule the rest of this
   * module already follows (e.g. `unavailableReason` in `startup-route.ts`).
   */
  it('folds repo-wide conventions into both prompts when the request carries them, and omits the section otherwise', async () => {
    const withConventions = harness({ specTests: true });
    await withConventions.runner.run(request({ conventions: 'Prefer named exports.' }));
    const [reviewerPrompt, verifierPrompt] = withConventions.sessionPrompts;
    expect(reviewerPrompt).toContain('Prefer named exports.');
    expect(verifierPrompt).toContain('Prefer named exports.');

    const without = harness({ specTests: true });
    await without.runner.run(request());
    const [reviewerPromptNoConventions] = without.sessionPrompts;
    expect(reviewerPromptNoConventions).not.toContain('stated conventions');
  });

  it('gives the prompt builders the same conventions section, so the two prompts cannot drift', () => {
    const conventions = 'Prefer named exports.';
    expect(buildReviewerPrompt(spec(), 'diff', conventions)).toContain(conventions);
    expect(buildVerifierPrompt(spec(), 'diff', [], conventions)).toContain(conventions);
    expect(buildReviewerPrompt(spec(), 'diff')).not.toContain('stated conventions');
    expect(buildVerifierPrompt(spec(), 'diff', [])).not.toContain('stated conventions');
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

/**
 * Issue #145's daemon half: the `diff_scope` gate's *summary* has to name the exclusion, not just
 * its detail pane. A one-line summary reading "3.20x the estimate" beside a diff that is mostly
 * generated tests is the exact misreading the split exists to prevent, and nobody opens the detail
 * pane before forming that impression.
 */
describe('the diff_scope gate summary', () => {
  const scoped = (numstat: string) =>
    harness({ numstat }).runner.run(
      request({
        spec: spec({ estimate: { changedLines: 100, filesTouched: 4, layered: false } }),
      }) as never,
    );

  const row = (added: number, deleted: number, path: string): string =>
    [added, deleted, path].join('\t');

  it('names the generated-test lines it excluded, in the summary itself', async () => {
    const report = await scoped(
      `${row(40, 10, 'src/a.ts')}\n${row(900, 0, 'test/pipenzo-generated/a.test.ts')}\n`,
    );
    const gate = report.deterministic.find((entry) => entry.id === 'diff_scope');
    expect(gate?.status).toBe('passed');
    expect(gate?.summary).toContain('900 generated-test lines excluded');
    expect(gate?.detail).toContain('the estimate is compared against the implementation half only');
  });

  it('says nothing about exclusions when there were none to exclude', async () => {
    const report = await scoped(`${row(40, 10, 'src/a.ts')}\n`);
    const gate = report.deterministic.find((entry) => entry.id === 'diff_scope');
    expect(gate?.summary).not.toContain('excluded');
  });

  /** The property itself: a large generated test file cannot fail the gate on its own. */
  it('passes a diff whose generated tests alone would have blown the estimate', async () => {
    const report = await scoped(
      `${row(10, 0, 'src/a.ts')}\n${row(5_000, 0, 'test/pipenzo-generated/a.test.ts')}\n`,
    );
    const gate = report.deterministic.find((entry) => entry.id === 'diff_scope');
    expect(gate?.status).toBe('passed');
  });
});

/**
 * Issue #147: the same-or-higher rule as *executable policy*, not as an assertion somebody
 * remembers to call. A rule you check after choosing is a rule you can satisfy by choosing badly
 * and then not checking.
 */
describe('selectVerifier', () => {
  const claude = (t: ModelTier, model = `claude-${t}`): ModelChoice => ({
    provider: 'claude',
    model,
    tier: t,
  });
  const codex = (t: ModelTier, model = `codex-${t}`): ModelChoice => ({
    provider: 'codex',
    model,
    tier: t,
  });

  it('eliminates every candidate below the implementer tier, rather than deprioritising them', () => {
    const selection = selectVerifier({
      implementer: claude('mid'),
      candidates: [claude('cheap'), codex('cheap'), codex('mid')],
    });
    expect(selection.outcome).toBe('selected');
    expect(selection.outcome === 'selected' && selection.verifier.tier).toBe('mid');
  });

  /** README states the rule as a floor, and a floor is not a target. */
  it('picks the lowest qualifying tier rather than the strongest available', () => {
    const selection = selectVerifier({
      implementer: claude('cheap'),
      candidates: [codex('frontier'), codex('cheap'), codex('mid')],
    });
    expect(selection.outcome === 'selected' && selection.verifier.tier).toBe('cheap');
  });

  /** An adversarial check that fails the same way as the thing it checks is not adversarial. */
  it('prefers a different vendor from the implementer among equal tiers', () => {
    const selection = selectVerifier({
      implementer: claude('mid'),
      candidates: [claude('mid'), codex('mid')],
    });
    expect(selection.outcome === 'selected' && selection.verifier.provider).toBe('codex');
    expect(selection.outcome === 'selected' && selection.crossVendor).toBe(true);
    expect(selection.outcome === 'selected' && selection.vendorDiversityUnavailable).toBe(false);
  });

  /**
   * The tiebreak is scoped to the winning tier. Reaching up a tier to find a different vendor
   * would break the floor-is-not-a-target rule, and the tier relationship is the one README backs
   * with regression evidence.
   */
  it('does not reach up a tier to find a different vendor', () => {
    const selection = selectVerifier({
      implementer: claude('mid'),
      candidates: [claude('mid'), codex('frontier')],
    });
    expect(selection.outcome === 'selected' && selection.verifier.tier).toBe('mid');
    expect(selection.outcome === 'selected' && selection.verifier.provider).toBe('claude');
    expect(selection.outcome === 'selected' && selection.crossVendor).toBe(false);
    // Diversity *was* available in the eligible set, just not at the winning tier. The run records
    // that honestly rather than claiming the tiebreak had nothing to work with.
    expect(selection.outcome === 'selected' && selection.vendorDiversityUnavailable).toBe(false);
  });

  it('records vendor diversity as unavailable on a single-vendor install', () => {
    const selection = selectVerifier({
      implementer: claude('mid'),
      candidates: [claude('mid'), claude('frontier')],
    });
    expect(selection.outcome === 'selected' && selection.crossVendor).toBe(false);
    expect(selection.outcome === 'selected' && selection.vendorDiversityUnavailable).toBe(true);
  });

  /** Silently downgrading is the failure mode the rule exists to prevent. */
  it('returns none_eligible rather than the closest available when nothing clears the floor', () => {
    const selection = selectVerifier({
      implementer: claude('frontier'),
      candidates: [claude('mid'), codex('cheap')],
    });
    expect(selection.outcome).toBe('none_eligible');
    expect(selection.outcome === 'none_eligible' && selection.reason).toContain('frontier');
  });

  it('returns none_eligible for an empty install rather than inventing a verifier', () => {
    expect(selectVerifier({ implementer: claude('cheap'), candidates: [] }).outcome).toBe(
      'none_eligible',
    );
  });

  /** A gate that picks a different model each run produces evidence nobody can compare. */
  it('is deterministic for a given installed set, whatever order it arrives in', () => {
    const candidates = [codex('mid', 'codex-b'), codex('mid', 'codex-a'), claude('mid')];
    const first = selectVerifier({ implementer: claude('mid'), candidates });
    const second = selectVerifier({
      implementer: claude('mid'),
      candidates: [...candidates].reverse(),
    });
    expect(first).toEqual(second);
    expect(first.outcome === 'selected' && first.verifier.model).toBe('codex-a');
  });

  /** Whatever it selects always satisfies the assertion — policy and rule cannot disagree. */
  it('never selects a verifier that assertVerifierTierAllowed would reject', () => {
    for (const implementerTier of ['cheap', 'mid', 'frontier'] as const) {
      const selection = selectVerifier({
        implementer: claude(implementerTier),
        candidates: [claude('cheap'), codex('mid'), claude('frontier'), codex('frontier')],
      });
      if (selection.outcome !== 'selected') continue;
      expect(() =>
        assertVerifierTierAllowed(implementerTier, selection.verifier.tier),
      ).not.toThrow();
    }
  });
});
