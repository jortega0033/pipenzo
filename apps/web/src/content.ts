/**
 * Factual claims used on the landing page, kept in one file and traced back to their source
 * rather than hand-typed again at each call site (#245: "no fabricated product metrics").
 *
 * The page is written at a plain-language level on purpose. Exact thresholds, named check lists,
 * and routing/tier names are left out of the visible copy and live only in README.md, which stays
 * the detailed source of truth. `test/App.test.tsx` guards against that detail creeping back in.
 */

export const REPO_URL = 'https://github.com/jortega0033/pipenzo';
export const RESEARCH_REPORT_URL = `${REPO_URL}/blob/main/docs/research-report.html`;
export const README_URL = `${REPO_URL}#readme`;
/** The two files that back the page's "never pushes without you" claim, linked so a reader can
 * check the boundary in source rather than take the page's word for it. */
export const PUBLISH_SERVICE_URL = `${REPO_URL}/blob/main/apps/daemon/src/publish-service.ts`;
export const BOUNDARY_TEST_URL = `${REPO_URL}/blob/main/apps/daemon/test/publish-token-boundary.test.ts`;

/**
 * README.md, "How it works" -- the four phases plus the human decision that follows them, in plain
 * language. The Review phase deliberately does not name its individual checks (issue #289's drift
 * risk came from hand-copying that list); README's "Review" bullet is the one place it lives.
 */
export const WORKFLOW_STEPS = [
  {
    role: 'recon',
    phase: 'Refine',
    summary:
      'A read-only session turns the issue into a spec: what done looks like, what is out of scope, which files it will likely touch, and a size estimate.',
  },
  {
    role: 'engineer',
    phase: 'Implement',
    summary: 'A fresh session writes the change against that spec.',
  },
  {
    role: 'inspector',
    phase: 'Review',
    summary:
      'Automated checks run first. Then a second AI session reviews the change with fresh eyes.',
  },
  {
    role: 'auditor',
    phase: 'Verify',
    summary:
      'A separate skeptical session, on a model at least as strong as the one that wrote the code, checks the change against the spec one more time.',
  },
  {
    role: 'ready',
    phase: 'You approve',
    summary:
      'Nothing is pushed or opened as a PR without an explicit human approval step. That property lives in the architecture, and no prompt is asked to enforce it.',
  },
] as const;

/**
 * Short labels for the How It Works rail. Delivery only: each one restates something the matching
 * `WORKFLOW_STEPS` summary already says, so no new claim enters the page through this map.
 */
export const PHASE_TAGS: Record<(typeof WORKFLOW_STEPS)[number]['role'], string> = {
  recon: 'read-only',
  engineer: 'writes the code',
  inspector: 'checks + review',
  auditor: 'second look',
  ready: 'human only',
};

/** README.md, "What exists today" -- kept as a short, honest summary rather than a duplicated
 * long-form status list that will drift from the real one. Cross-checked against source as well
 * as README: the board is mounted by `apps/desktop/src/AppRoot.tsx` (`PipenzoAppShell`), device
 * flow and the vault are used from `apps/desktop/electron/main.ts`, and the token reaches the
 * daemon over stdin per `apps/desktop/electron/daemon-environment.ts`. */
export const STATUS_SUMMARY = {
  built: [
    'GitHub client, phase machine, ticket store (real @octokit/core client, atomic-write JSON store)',
    'Refine/Implement orchestration and the deterministic review gates',
    'The publish service, the only code in the repo that can call git push or open a pull request',
    'Screenshot verification via a schema-validated capture manifest the daemon executes',
    "The kanban/ticket board, mounted as the desktop app's main screen",
    'GitHub OAuth device-flow sign-in and the token vault. The token reaches the daemon over stdin',
  ],
  inProgress: [
    'The risk classifier: every push/PR action is gated today, with no LOW/MEDIUM/HIGH distinction yet',
  ],
} as const;
