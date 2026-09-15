import { relative, isAbsolute, sep } from 'node:path';
import type { PermissionActionV2 } from '@agent-dock/shared';

/**
 * The risk classifier (Pipenzo issue #157).
 *
 * LOW/MEDIUM/HIGH does not classify itself, and it cannot be the agent's own judgment — an agent
 * grading its own actions is not a gate. This is a daemon-side, pure function translating
 * AgentDock's real permission taxonomy (`packages/shared/src/policy-v2.ts`'s `actionClass`/`risk`,
 * evaluated by `permission-policy.ts`) into Pipenzo's three levels, per the mapping in
 * `docs/research-report.html` §07:
 *
 * - **LOW** — `risk: normal`, `actionClass` of `filesystem` or `command`, and a path inside the
 *   ticket's own worktree.
 * - **MEDIUM** — everything else that isn't HIGH. Not narrower than that: MEDIUM is the residual
 *   bucket, not a second allowlist.
 * - **HIGH** — `external_side_effect`, a destructive MCP tool (`mcpDestructive`), or a path
 *   matching the security/auth/migration globs.
 *
 * **Why this takes the action's own shape, not a `PermissionPolicyResult`.** The obvious-looking
 * alternative — feed in what `evaluatePermissionPolicy` just decided (`allow` / `ask` / `deny`) —
 * was considered and rejected: that outcome depends on ephemeral state (an existing session grant
 * can turn a LOW-shaped action from `ask` into `allow` on a second occurrence), so it would make
 * the same action classify differently run to run. The classifier's job is to grade the *action*,
 * not to explain a specific policy call's transient result — "one classifier serves both risk
 * grading and the pre-commitment trigger" (§07) only holds if grading an action is deterministic
 * from the action alone.
 *
 * **The security/auth/migration glob list lives here, not imported from a tier-override module.**
 * §05 of the research report describes model-tier routing reusing "the same security/auth/migration
 * globs" the risk classifier uses, but as of this ticket no such override module exists yet in this
 * codebase (issues #120/#121, the routing table and deterministic-override panels, are still open).
 * So this file is the first and only definition; whichever of #120/#121 lands second should import
 * `SENSITIVE_PATH_PATTERN` from here rather than defining a second, driftable copy.
 */

export type RiskGrade = 'low' | 'medium' | 'high';

/**
 * Matches a path under a `security/`, `auth/`, or `migrations/` directory, or whose filename
 * carries one of those words as its own token (`github-auth-client.ts`, `security_scan.ts`,
 * `0007_add_risk_migration.sql`) — case-insensitive, and the boundary class includes both `/` and
 * `\`, so it matches identically on POSIX and Windows paths without needing to normalize
 * separators first. The boundary is any of `/ \ . - _` or the start/end of the string, on both
 * sides, so `auth` matches in `apps/daemon/src/github-auth-client.ts` (bounded
 * by `-` and `-`) but not inside `authority-list.ts` (the substring's right edge, `o`, isn't a
 * boundary character) — a plain word match, not a path-segment-only match, since this repo's own
 * naming convention is kebab-case filenames, not one-concern-per-directory.
 *
 * Deliberately narrower than `worktree-manager.ts`'s own `risky()` check (`.env`, `id_rsa`,
 * `credentials`, `secrets`, `tokens`): that one guards against touching a literal credential file,
 * a filesystem-hygiene concern; this one guards against touching the code that *implements*
 * auth/security/schema-migration logic, a blast-radius concern. The two overlap in spirit but not
 * in the paths they actually match, and conflating them would make either check harder to reason
 * about on its own.
 */
export const SENSITIVE_PATH_PATTERN = /(^|[/\\._-])(security|auth|migrations?)($|[/\\._-])/i;

export function matchesSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERN.test(path);
}

/** Mirrors `worktree-manager.ts`'s own private `inside()` exactly (relative-path containment, no
 * `..` escape, never absolute after resolving) — not imported from there because that module has
 * no exported path-containment helper, and adding one is a larger, separate refactor this ticket
 * doesn't need. */
export function isInsideWorktree(worktreeRoot: string, candidatePath: string): boolean {
  const suffix = relative(worktreeRoot, candidatePath);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

export interface RiskClassificationInput {
  readonly action: PermissionActionV2;
  /**
   * The raw filesystem path the action targets, when the action is about one — not
   * `action.targetFingerprint`, which is a one-way hash and can't be tested for worktree
   * containment or sensitive-path matching. `undefined` when the action has no path target (e.g. a
   * network call), which can never qualify for LOW's path-containment clause.
   */
  readonly targetPath?: string;
  /** The ticket's owned worktree root — `OwnedWorktreeManager.ownedLocation(id).path`. */
  readonly worktreeRoot: string;
}

/**
 * Classifies one AgentDock permission action into Pipenzo's LOW/MEDIUM/HIGH risk grade.
 *
 * Checked in a fixed order, HIGH first: HIGH's conditions each independently mean "irreversible or
 * off-machine," so none of them should ever be shadowed by a LOW-shaped path coincidence (a
 * migration file edited via a plain `filesystem` action must still grade HIGH). LOW is checked
 * next, as a narrow explicit allowlist. Anything reaching neither grades MEDIUM — the residual
 * bucket, not a second allowlist to keep in sync with the first.
 */
export function classifyRisk(input: RiskClassificationInput): RiskGrade {
  const { action, targetPath, worktreeRoot } = input;

  if (action.actionClass === 'external_side_effect') return 'high';
  if (action.actionClass === 'mcp' && action.mcpDestructive) return 'high';
  if (targetPath !== undefined && matchesSensitivePath(targetPath)) return 'high';

  if (
    action.risk === 'normal' &&
    (action.actionClass === 'filesystem' || action.actionClass === 'command') &&
    targetPath !== undefined &&
    isInsideWorktree(worktreeRoot, targetPath)
  ) {
    return 'low';
  }

  return 'medium';
}
