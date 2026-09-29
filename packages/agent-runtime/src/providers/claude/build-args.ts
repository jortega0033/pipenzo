import type { StartSessionOptions } from '../../types.js';

type ClaudeCliSandbox = NonNullable<StartSessionOptions['sandbox']>;

/**
 * The complete built-in tool set a sandbox-pinned `claude -p` session is launched with, per scope.
 *
 * Both are strict subsets of `buildClaudeSdkOptions()`'s trusted tool list (`sdk-options.ts`), and
 * every entry is one the SDK normalizer (`sdk/normalizer.ts`'s `claudeToolEffects`) classifies as a
 * complete `read` or `filesystem_write` effect: nothing here can run a command, reach the network,
 * spawn a subagent, or invoke an MCP server. `AskUserQuestion` is left out because a `-p` session
 * has nobody to ask.
 */
export const CLAUDE_CLI_SANDBOX_TOOLS: Readonly<Record<ClaudeCliSandbox, readonly string[]>> =
  Object.freeze({
    'read-only': Object.freeze(['Read', 'Grep', 'Glob']),
    'workspace-write': Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write']),
  });

/**
 * Denied outright, on top of `--tools` leaving them unavailable. Deny rules win over any allow
 * rule from any source, so this still holds if a future CLI version starts honoring an allow rule
 * for a tool outside `--tools`. Mirrors `buildClaudeSdkOptions()`'s baseline, plus the other
 * built-ins that execute code (`PowerShell` on Windows) or edit outside the Edit/Write pair.
 */
export const CLAUDE_CLI_SANDBOX_DISALLOWED_TOOLS = Object.freeze([
  'Bash',
  'PowerShell',
  'Agent',
  'Task',
  'Skill',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
]);

/**
 * `dontAsk` for read-only: anything that would have prompted (a read outside the working
 * directory, any write) is denied, never waited on. `acceptEdits` for workspace-write: edits inside
 * the working directory are accepted, and an edit outside it still needs a prompt nobody can answer
 * in `-p` mode, so it is denied too.
 */
const SANDBOX_PERMISSION_MODE: Readonly<Record<ClaudeCliSandbox, string>> = Object.freeze({
  'read-only': 'dontAsk',
  'workspace-write': 'acceptEdits',
});

/**
 * The launch restriction a sandbox-pinned session gets, so the scope a caller states is the scope
 * the CLI actually enforces instead of whatever the operator's own Claude settings allow.
 *
 * `--setting-sources=` (empty) skips user, project and local settings files -- the operator's
 * permission allow rules and default mode, and a checked-out repository's `.claude/settings.json`
 * hooks -- and `--strict-mcp-config` with no `--mcp-config` loads no MCP server at all. This is the
 * same lockdown `buildClaudeSdkOptions()` gives the SDK transport (`settingSources: []`,
 * `strictMcpConfig: true`, `mcpServers: {}`), expressed as the CLI flags that option set maps to.
 *
 * `--restricted` closes what the flags above do not: Claude Code's own auto-memory directory
 * (`~/.claude/projects/<source repo>/memory/`) is writable by `Write` even with every other
 * restriction in place, and what lands there is loaded into the operator's *future* interactive
 * sessions on that repository — which do have a shell and MCP servers. Restricted mode confines
 * the file tools to the working directory, so a phase session cannot plant anything that outlives
 * it. It also refuses `bypassPermissions` and leaves writes to settings, git and
 * tool-configuration files to a person. A CLI too old to know the flag exits on it, so an
 * unsupported CLI fails the phase rather than running it with less.
 */
function sandboxArgs(sandbox: ClaudeCliSandbox): string[] {
  return [
    '--restricted',
    '--tools',
    CLAUDE_CLI_SANDBOX_TOOLS[sandbox].join(','),
    '--disallowedTools',
    CLAUDE_CLI_SANDBOX_DISALLOWED_TOOLS.join(','),
    '--permission-mode',
    SANDBOX_PERMISSION_MODE[sandbox],
    '--setting-sources=',
    '--strict-mcp-config',
  ];
}

/**
 * Pure argv construction for `claude -p ...`, extracted from adapter.ts so it can be unit- and
 * contract-tested without spawning a process (in particular, the resume-vs-fresh-session
 * branching, see the provider contract suite's "resume" section).
 *
 * The prompt is deliberately NOT one of these argv elements: it's written to the child's stdin
 * instead (see `runProviderSession`'s `promptViaStdin`, wired in adapter.ts). Two reasons: an
 * argv element has to fit Windows' `CreateProcess` command-line limit (~32,767 characters), well
 * under what the shared request schema permits, and an argv-passed prompt is visible to any
 * same-user process via `ps`/Task Manager's command line column for the process's whole
 * lifetime. `--input-format text` makes the stdin-reads-the-prompt behavior explicit rather than
 * relying on it being `-p`'s undocumented default.
 *
 * Without `sandbox` the argv is unchanged. With it, the session is restricted per
 * `sandboxArgs()` -- the Claude half of the scope `buildCodexArgs` already passes as `--sandbox`.
 */
export function buildClaudeArgs(opts: StartSessionOptions): string[] {
  const args = ['-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose'];
  if (opts.resumeProviderSessionId) {
    args.push('--resume', opts.resumeProviderSessionId);
  } else {
    args.push('--session-id', opts.sessionId);
  }
  if (opts.sandbox) args.push(...sandboxArgs(opts.sandbox));
  return args;
}
