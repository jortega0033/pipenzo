import { DETERMINISTIC_GATE_IDS, type DeterministicGateId } from '@agent-dock/shared';

/**
 * The deterministic gate catalogue the Models & gates screen renders (issue #123).
 *
 * Models.dc.html shows **five** rows; `DETERMINISTIC_GATE_IDS` has **six** ids. That is not a
 * discrepancy to reconcile by picking one — the artboard says which it is, in the panel's own help
 * text: *"the same five, grouped for reading rather than for configuring"*. `build` and
 * `typecheck` are one row because a human reads them as one thing, and they stay two ids because
 * the runner reports them separately and a build failure is not a type error.
 *
 * So the rows are **derived from the shared constant**, not typed out beside it. A hardcoded list
 * would drift the moment a seventh gate landed, and it would drift silently — a panel claiming to
 * show the non-negotiable set while omitting one of it is worse than no panel. `assertCatalogueIsComplete()`
 * makes that a compile-and-run error instead: every id in `DETERMINISTIC_GATE_IDS` must appear in
 * exactly one row.
 */

export interface GateCatalogueRow {
  /** Stable key: the ids this row covers, joined. */
  readonly key: string;
  /** Every gate id this row stands for. Usually one; `build` and `typecheck` share a row. */
  readonly ids: readonly DeterministicGateId[];
  readonly name: string;
  readonly description: string;
}

/**
 * The five rows, with the copy from Models.dc.html.
 *
 * The descriptions are the artboard's, not paraphrases: they carry facts a reader needs (the
 * spec-generated tests are "written from the spec, never by the implementer that has to pass
 * them"; the diff-scope miss threshold and the label it moves the ticket to) and rewording them
 * would quietly drop those.
 */
export const GATE_CATALOGUE: readonly GateCatalogueRow[] = Object.freeze([
  {
    key: 'build+typecheck',
    ids: ['build', 'typecheck'],
    name: 'Build and typecheck',
    description: 'pnpm build, inside the ticket worktree',
  },
  {
    key: 'spec_tests',
    ids: ['spec_tests'],
    name: 'Spec-generated tests',
    description: 'Written from the spec, never by the implementer that has to pass them',
  },
  { key: 'gitleaks', ids: ['gitleaks'], name: 'gitleaks', description: 'Committed secrets' },
  { key: 'semgrep', ids: ['semgrep'], name: 'Semgrep', description: 'The p/ci ruleset' },
  {
    key: 'diff_scope',
    ids: ['diff_scope'],
    name: 'Diff-scope check',
    description:
      'The real diff against the Refine estimate. A miss over 50% moves the ticket to ' +
      'pipenzo:awaiting-stack-approval with the real numbers against the predicted ones',
  },
] as const satisfies readonly GateCatalogueRow[]);

/**
 * Every deterministic gate appears in exactly one catalogue row.
 *
 * Exported and tested rather than merely true today. A panel that renders "the hard,
 * non-negotiable set" and quietly omits a gate is a worse artefact than no panel, and a new gate
 * id is exactly the change that would cause it.
 */
export function catalogueCoverage(): {
  readonly missing: readonly DeterministicGateId[];
  readonly duplicated: readonly DeterministicGateId[];
  readonly unknown: readonly string[];
} {
  const seen = new Map<string, number>();
  for (const row of GATE_CATALOGUE) {
    for (const id of row.ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return {
    missing: DETERMINISTIC_GATE_IDS.filter((id) => !seen.has(id)),
    duplicated: DETERMINISTIC_GATE_IDS.filter((id) => (seen.get(id) ?? 0) > 1),
    unknown: [...seen.keys()].filter(
      (id) => !(DETERMINISTIC_GATE_IDS as readonly string[]).includes(id),
    ),
  };
}

/**
 * The two rules that keep the test gate honest (issues #146 and #145), as the panel states them.
 *
 * Exported as data rather than inlined as JSX because they are claims about how the daemon
 * behaves, and both are backed by code that can be pointed at: `spec-test-adjudicator.ts` and
 * `computeDiffScope()`. Keeping them addressable is what lets a test assert the panel says the
 * thing the daemon actually does.
 */
export const GATE_HONESTY_RULES: readonly { readonly lead: string; readonly body: string }[] =
  Object.freeze([
    {
      lead: 'A failing spec-generated test is not automatically the code’s fault.',
      body:
        'It is adjudicated once, by the verifier tier, into test-wrong or code-wrong. A test ruled ' +
        'invalid is dropped with the ruling recorded in the evidence block, never silently deleted, ' +
        'and the drop is visible in the PR body.',
    },
    {
      lead: 'The diff-scope check measures implementation files only.',
      body:
        'Generated tests are counted and reported separately, so a large generated test file can ' +
        'never blow a ticket’s size estimate on its own.',
    },
  ]);
