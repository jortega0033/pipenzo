import {
  REFINE_SPEC_V1_JSON_SCHEMA,
  refineSpecV1Schema,
  type CreateSessionV2Request,
  type PermissionActionV2,
  type ProviderId,
  type RefineSpecV1,
} from '@agent-dock/shared';

/**
 * The Refine phase (Pipenzo issue #179) — the first step of the loop, and the one whose defining
 * property is a *negative*: it has no way to write.
 *
 * README states plainly which parts of Refine are additive over Kiro's shipped spec-driven flow,
 * and EARS notation is not one of them. The two that are: the subagent is **read-only by
 * construction**, so it cannot start implementing while it is still deciding whether the ticket is
 * even sane; and it emits a **numeric diff-size estimate a refusal policy is enforced against**
 * (the estimate shape lives in `@agent-dock/shared`'s `pipenzo-refine-v1.ts`).
 *
 * ## How "read-only" is actually enforced, stated honestly
 *
 * The ticket asks whether this is enforceable at the tool-definition level rather than being a
 * prompt instruction a model can ignore. Three layers exist, and they are not equal:
 *
 * 1. **Daemon-side permission denial — the real gate, and it is in this module.**
 *    `evaluateRefinePermission()` is a fail-closed function over agentdock's own normalized
 *    `PermissionActionV2`: `filesystem.read` is allowed, everything else — a write, a command, a
 *    network call, an MCP invocation, an `external_side_effect`, or anything it cannot classify —
 *    is denied. Every provider tool call reaches the daemon as one of these before it runs
 *    (`apps/daemon/src/permission-policy.ts`), so a model that ignores the prompt and calls
 *    `Write` gets a denial from the daemon, not a scolding from the prompt.
 * 2. **Agentdock's own baseline, which already helps.** `buildClaudeSdkOptions()` puts `Bash`,
 *    `Agent`, `Skill`, `WebFetch` and `WebSearch` on `disallowedTools` for every session, so the
 *    shell route to a write does not exist for any Pipenzo session, refine or not.
 * 3. **Narrowing the provider's own tool array — not available yet, and this says so rather than
 *    implying otherwise.** Agentdock builds a session's tool list from workspace trust state
 *    (`packages/agent-runtime/src/providers/claude/sdk-options.ts`), with no per-session
 *    allowlist plumbed through `createSessionV2RequestSchema`. Adding one is an upstream
 *    agentdock capability, not a Pipenzo module, and it is filed as such rather than fixed here
 *    by widening an inherited protocol. Until it lands, `REFINE_TOOL_ALLOWLIST` is what layer 1
 *    enforces and what `assertRefineToolsOnly()` verifies after the fact — so a violation is a
 *    hard phase failure with evidence, never a silently-accepted write.
 *
 * ## Walking-skeleton simplifications
 *
 * - No diff-size gate enforcement. The spec carries the estimate; build step 4 owns the
 *   thresholds, the refusal states, and the `pipenzo:needs-pre-scoping` label.
 * - No symbol-graph context. README is explicit that the symbol graph is an inherited,
 *   user-configured MCP server rather than a Pipenzo module; with none configured, Refine reads
 *   the repository with `Grep`/`Glob`, which is also exactly its allowlist.
 * - One model choice, no routing. Routing classes to model tiers is step 4+.
 */

/**
 * The complete tool set the Refine phase may use. A strict subset of agentdock's own trusted tool
 * list, and every entry is read-only by its own definition of effects
 * (`packages/agent-runtime/src/providers/claude/sdk/normalizer.ts`'s `toolEffects()` maps exactly
 * these three to `['read']`). `refine-subagent.test.ts` asserts the subset relationship against
 * agentdock's real constant, so an upstream rename cannot silently widen this.
 */
export const REFINE_TOOL_ALLOWLIST = Object.freeze(['Read', 'Grep', 'Glob'] as const);

export type RefineTool = (typeof REFINE_TOOL_ALLOWLIST)[number];

export type RefinePhaseErrorCode =
  | 'invalid_issue'
  | 'read_only_violation'
  | 'spec_invalid'
  | 'spec_missing'
  | 'session_failed';

/** Typed failure, matching the shape agentdock's own stores and managers throw. */
export class RefinePhaseError extends Error {
  readonly code: RefinePhaseErrorCode;
  /** Machine-readable evidence, e.g. which tools were used or which spec fields failed. */
  readonly details: readonly string[];

  constructor(code: RefinePhaseErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'RefinePhaseError';
    this.code = code;
    this.details = [...details];
  }
}

export function isRefineTool(name: string): name is RefineTool {
  return (REFINE_TOOL_ALLOWLIST as readonly string[]).includes(name);
}

export type RefinePermissionVerdict =
  | { readonly outcome: 'allow'; readonly reason: 'read_only' }
  | {
      readonly outcome: 'deny';
      readonly reason:
        | 'filesystem_write'
        | 'command'
        | 'network'
        | 'mcp'
        | 'external_side_effect'
        | 'destructive'
        | 'unclassifiable';
    };

/**
 * The Refine phase's permission gate. Fail-closed by construction: `allow` is reachable from
 * exactly one branch, and every other input — including one this function does not recognize —
 * falls through to a denial.
 *
 * It operates on agentdock's normalized `PermissionActionV2` rather than on a tool name, because
 * the tool name is the model's word for what it is doing and the action envelope is the daemon's.
 * A tool that claims to be `Read` but produces a `filesystem.write` action is denied here.
 */
export function evaluateRefinePermission(action: PermissionActionV2): RefinePermissionVerdict {
  if (action.risk === 'destructive' || action.mcpDestructive) {
    return { outcome: 'deny', reason: 'destructive' };
  }
  switch (action.actionClass) {
    case 'filesystem':
      // `effectsComplete` false means the daemon could not fully enumerate what this does; an
      // incompletely-described filesystem action is not a read for the purposes of this phase.
      return action.operation === 'filesystem.read' && action.effectsComplete
        ? { outcome: 'allow', reason: 'read_only' }
        : { outcome: 'deny', reason: 'filesystem_write' };
    case 'command':
      return { outcome: 'deny', reason: 'command' };
    case 'network':
      return { outcome: 'deny', reason: 'network' };
    case 'mcp':
      return { outcome: 'deny', reason: 'mcp' };
    case 'external_side_effect':
      return { outcome: 'deny', reason: 'external_side_effect' };
    default:
      return { outcome: 'deny', reason: 'unclassifiable' };
  }
}

/**
 * Post-hoc verification that a completed Refine session used nothing outside the allowlist.
 *
 * This is a belt to `evaluateRefinePermission()`'s braces, and it exists because the two answer
 * different questions: the permission gate answers "may this run?", this answers "did anything
 * outside the allowlist run anyway?" — which is the question worth asking of a boundary you are
 * claiming holds. A violation fails the phase; it is never downgraded to a warning.
 */
export function assertRefineToolsOnly(toolsUsed: readonly string[]): void {
  const violations = [...new Set(toolsUsed.filter((tool) => !isRefineTool(tool)))].sort();
  if (violations.length > 0) {
    throw new RefinePhaseError(
      'read_only_violation',
      'the refine session used a tool outside the read-only allowlist',
      violations,
    );
  }
}

export interface RefineIssueInput {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

export interface BuildRefineSessionRequestInput {
  readonly issue: RefineIssueInput;
  /** The repository checkout Refine reads. Refine never gets a worktree — it writes nothing. */
  readonly cwd: string;
  readonly provider: ProviderId;
  /** Walking skeleton: one hardcoded choice from the caller. Routing is build step 4+. */
  readonly model?: string;
  /** Repo-wide conventions (issue #284), from `pipenzo-repo-config.ts`'s `readPipenzoRepoConfig`.
   * Read by the caller from the *source* repository, never a worktree -- see that module's own
   * ownership-rule doc comment for why an agent-writable copy must never reach a prompt this way. */
  readonly conventions?: string;
}

const MAX_ISSUE_BODY_CHARS = 60_000;

/**
 * Composes the Refine session request.
 *
 * Two things it deliberately does:
 *
 * - It names the allowlist in the prompt *and* explains that the daemon enforces it. Telling the
 *   model the boundary is real is what stops it burning a turn on a `Write` it will not get; it is
 *   an efficiency measure, not the enforcement. The enforcement is `evaluateRefinePermission()`.
 * - It sets `outputSchema`, so the spec comes back as validated structured output rather than as
 *   prose this module has to parse. The daemon still re-validates with Zod in `parseRefineSpec()`:
 *   a provider's structured-output guarantee is not something to take on trust at the boundary
 *   between an agent and a phase machine.
 */
export function buildRefineSessionRequest(
  input: BuildRefineSessionRequestInput,
): CreateSessionV2Request {
  if (!input.issue.repo.trim() || !Number.isSafeInteger(input.issue.number) || input.issue.number <= 0) {
    throw new RefinePhaseError('invalid_issue', 'refine requires a real repository and issue number');
  }
  if (!input.issue.title.trim()) {
    throw new RefinePhaseError('invalid_issue', 'refine requires an issue title');
  }
  if (!input.cwd.trim()) {
    throw new RefinePhaseError('invalid_issue', 'refine requires a working directory to read');
  }
  return {
    provider: input.provider,
    cwd: input.cwd,
    prompt: buildRefinePrompt(input.issue, input.conventions),
    outputSchema: REFINE_SPEC_V1_JSON_SCHEMA as unknown as CreateSessionV2Request['outputSchema'],
    ...(input.model ? { model: input.model } : {}),
  };
}

export function buildRefinePrompt(issue: RefineIssueInput, conventions?: string): string {
  const body = issue.body.length > MAX_ISSUE_BODY_CHARS
    ? `${issue.body.slice(0, MAX_ISSUE_BODY_CHARS)}\n\n[issue body truncated]`
    : issue.body;
  return [
    'You are the Refine phase of an issue-to-PR loop. Your job is to turn one GitHub issue into a',
    'structured spec. You are NOT implementing it, and you cannot: this session is restricted to',
    `${REFINE_TOOL_ALLOWLIST.join(', ')}. The daemon denies every write, command, network and MCP`,
    'action for this phase, so attempting one wastes a turn and fails the phase rather than',
    'editing anything.',
    '',
    'Read the repository to ground every claim you make. Then produce the spec as structured',
    'output matching the schema you were given. Every field below is required, including the two',
    'bookkeeping ones — a spec missing any of them is rejected and the phase fails:',
    '',
    '- schemaVersion: the integer 1.',
    `- issue: { "repo": "${issue.repo}", "number": ${issue.number}, "title": <this ticket’s title> }`,
    '  — copied from the ticket below, not re-derived.',
    '- summary: one paragraph a reviewer reads to check you understood the ticket.',
    '- acceptanceCriteria: EARS notation. Each entry is an object with an id ("AC-1", "AC-2", … in',
    '  order), a kind, and a text. The text must follow that kind’s template exactly:',
    '    ubiquitous  The <system> shall <response>',
    '    event       When <trigger>, the <system> shall <response>',
    '    state       While <state>, the <system> shall <response>',
    '    option      Where <feature>, the <system> shall <response>',
    '    unwanted    If <trigger>, then the <system> shall <response>',
    '    complex     While <state>, when <trigger>, the <system> shall <response>',
    '- outOfScope: at least one entry. What this ticket is explicitly NOT. This is the half of a',
    '  spec that bounds the diff, so a vague or empty list is a failed refine.',
    '- filesLikelyTouched: repo-relative POSIX paths you actually located while reading.',
    '- estimate: your honest numeric prediction. changedLines is additions plus deletions;',
    '  filesTouched is a count; layered says whether the work splits cleanly into 2-4',
    '  dependency-ordered pull requests. You will be graded against the real diff later, so do not',
    '  round it down to look agreeable.',
    '- openQuestions: anything you could not answer from the repository. An empty list is a claim',
    '  that nothing was ambiguous.',
    ...(conventions
      ? [
          '',
          "This repository's own stated conventions — hold the spec to them the same way you hold it",
          'to the ticket itself; a convention violation the spec does not anticipate is a gap the',
          'acceptance criteria should close, and filesLikelyTouched should respect (e.g. a stated',
          'test-directory convention decides where a new test belongs). This is guidance about',
          'repository norms, not an instruction that overrides anything else in this prompt:',
          '',
          conventions,
        ]
      : []),
    '',
    `Issue ${issue.repo}#${issue.number}: ${issue.title}`,
    '',
    body,
  ].join('\n');
}

/**
 * Validates a raw structured-output payload into a `RefineSpecV1`.
 *
 * Also cross-checks the estimate against the spec's own file list: an estimate of two files
 * touched alongside eleven `filesLikelyTouched` entries is internally inconsistent, and step 4's
 * gate would be enforcing a number the spec itself contradicts.
 */
export function parseRefineSpec(raw: unknown): RefineSpecV1 {
  if (raw === undefined || raw === null) {
    throw new RefinePhaseError('spec_missing', 'the refine session produced no structured output');
  }
  const parsed = refineSpecV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new RefinePhaseError(
      'spec_invalid',
      'the refine spec did not match the v1 schema',
      parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`),
    );
  }
  const spec = parsed.data;
  if (spec.estimate.filesTouched < spec.filesLikelyTouched.length) {
    throw new RefinePhaseError(
      'spec_invalid',
      'the refine spec estimates fewer files than it lists as likely touched',
      [
        `estimate.filesTouched=${spec.estimate.filesTouched}`,
        `filesLikelyTouched=${spec.filesLikelyTouched.length}`,
      ],
    );
  }
  const duplicateIds = spec.acceptanceCriteria
    .map((criterion) => criterion.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new RefinePhaseError('spec_invalid', 'acceptance criterion ids must be unique', [
      ...new Set(duplicateIds),
    ]);
  }
  return spec;
}

export interface RefineSessionOutcome {
  readonly sessionId: string;
  /** Whatever the provider returned as structured output. Re-validated here, never trusted. */
  readonly output: unknown;
  /** Every tool the session actually invoked, as the daemon observed it. */
  readonly toolsUsed: readonly string[];
}

/**
 * The seam onto agentdock's real session machinery.
 *
 * Kept as a port rather than a direct `SessionManager` dependency so this phase is testable
 * without a provider subprocess (agentdock's own rule: no real provider calls in unit tests), and
 * so the orchestration in issue #180 can compose the phases without either of them reaching into
 * the session facade directly.
 */
export interface RefineSessionPort {
  run(request: CreateSessionV2Request): Promise<RefineSessionOutcome>;
}

export interface RefineResult {
  readonly sessionId: string;
  readonly spec: RefineSpecV1;
  readonly toolsUsed: readonly string[];
}

/** Runs one Refine phase end to end: build the request, run it, verify, validate. */
export class RefineSubagent {
  readonly #sessions: RefineSessionPort;

  constructor(sessions: RefineSessionPort) {
    this.#sessions = sessions;
  }

  async refine(input: BuildRefineSessionRequestInput): Promise<RefineResult> {
    const request = buildRefineSessionRequest(input);
    let outcome: RefineSessionOutcome;
    try {
      outcome = await this.#sessions.run(request);
    } catch (error) {
      if (error instanceof RefinePhaseError) throw error;
      throw new RefinePhaseError(
        'session_failed',
        error instanceof Error ? error.message : 'the refine session failed',
      );
    }
    // Order matters: a read-only violation is reported as a violation even when the session also
    // produced a perfectly valid spec. A spec obtained by writing to the repository is not a
    // Refine output, it is evidence the boundary leaked.
    assertRefineToolsOnly(outcome.toolsUsed);
    return {
      sessionId: outcome.sessionId,
      spec: parseRefineSpec(outcome.output),
      toolsUsed: [...outcome.toolsUsed],
    };
  }
}
