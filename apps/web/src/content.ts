/**
 * Factual claims used on the landing page, kept in one file and traced back to their source
 * rather than hand-typed again at each call site (#245's own requirement: "source thresholds from
 * the canonical README where practical" and "no fabricated product metrics"). If one of these
 * numbers ever drifts from README.md, this is the one place to fix it.
 */

export const REPO_URL = 'https://github.com/jortega0033/pipenzo';
export const RESEARCH_REPORT_URL = `${REPO_URL}/blob/main/docs/research-report.html`;
export const README_URL = `${REPO_URL}#readme`;

/** README.md, "Small PRs, by construction". */
export const DIFF_SIZE_THRESHOLDS = {
  soloPr: { maxLines: 100, maxFiles: 10 },
  stackedPrs: { maxLines: 400, maxFiles: 20, minPrs: 2, maxPrs: 4 },
} as const;

/**
 * README.md, "How it works" -- the four phases plus the human decision that follows them.
 *
 * Drift risk (issue #289): this file's own doc comment says these numbers are sourced from
 * README "where practical", but there is no build-time or test-time check that actually enforces
 * that for prose fields like `summary` below -- `docs:claim-check` (`scripts/docs-claim-check.mjs`)
 * only scans `.md` files, and nothing imports or diffs this against README.md at all. The Review
 * phase's gate list here (and the near-identical one in `ReviewBeforeTrust.tsx`'s `GATES`) is
 * hand-duplicated from README's own "Review" bullet in three independent places; it already drifted
 * once (none of the three mentioned `lint` until it was added here alongside #283 shipping the gate
 * itself) and has no mechanism to catch the next drift automatically. Recorded here rather than
 * fixed: a `docs:claim-check`-style check that fails when this list disagrees with README's is real
 * follow-up scope, worth its own ticket once someone decides it's worth building rather than just
 * re-checking `apps/web` by hand at release time.
 */
export const WORKFLOW_STEPS = [
  {
    role: 'recon',
    phase: 'Refine',
    summary:
      'A read-only subagent turns the issue into a spec: acceptance criteria, an out-of-scope list, files likely touched, and a diff-size estimate.',
  },
  {
    role: 'engineer',
    phase: 'Implement',
    summary:
      'A fresh session writes the change against that spec, seeded with symbol-graph context where one is configured.',
  },
  {
    role: 'inspector',
    phase: 'Review',
    summary:
      'Deterministic gates run first: build, typecheck, lint, spec-generated tests, gitleaks, Semgrep, a diff-scope check. Then an LLM review pass.',
  },
  {
    role: 'auditor',
    phase: 'Verify',
    summary:
      'A separate adversarial verifier, never a weaker model than the implementer, checks the diff against the spec one more time.',
  },
  {
    role: 'ready',
    phase: 'You approve',
    summary:
      'Nothing is pushed or opened as a PR without an explicit human approval step. That property is architectural, not a prompt.',
  },
] as const;

/** README.md, "What exists today" -- kept as a short, honest summary rather than a duplicated
 * long-form status list that will drift from the real one. */
export const STATUS_SUMMARY = {
  built: [
    'GitHub client, phase machine, ticket store (real @octokit/core client, atomic-write JSON store)',
    'Refine/Implement orchestration and the deterministic review gates',
    'The publish service, the only code in the repo that can call git push or open a pull request',
    'Screenshot verification via a schema-validated capture manifest the daemon executes',
  ],
  inProgress: [
    "The kanban/ticket desktop UI: components exist under apps/desktop/src/pipenzo/, individually tested, not yet wired into the app's render tree",
    'GitHub OAuth device-flow and the token vault (a PAT via env var today)',
    'The risk classifier: every push/PR action is gated today, with no LOW/MEDIUM/HIGH distinction yet',
  ],
} as const;
