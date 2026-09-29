import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CLI_SANDBOX_TOOLS,
  FAKE_PROVIDER_CAPABILITIES,
  FakeProvider,
  ProviderRegistry,
  buildClaudeArgs,
  noopLogger,
  type StartSessionOptions,
} from '@agent-dock/agent-runtime';
import { SessionManager } from '../src/session-manager.js';
import {
  AwaitedPhaseSessions,
  DispatchOnlyPhaseSessions,
  PhaseSessionError,
  assertPhaseToolGrant,
  claudeToolAction,
  extractJsonPayload,
  llmPassPayloadSchema,
} from '../src/pipenzo-phase-sessions.js';
import { evaluateRefinePermission, isWorkspaceUntrustedError } from '../src/refine-subagent.js';
import { evaluateImplementPermission } from '../src/implement-orchestrator.js';
import { resolveWorkspaceIdentity } from '../src/workspace-identity.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';

const OWNED = 'daemon-owned-worktree' as const;

/**
 * The adapters between the phase modules' ports and agentdock's real session machinery
 * (issue #184). These are the pieces that were missing when `refine-subagent.ts`,
 * `implement-orchestrator.ts` and `review-gates.ts` had no route.
 */

function managerWith(scenario: 'success' | 'failure'): SessionManager {
  const registry = new ProviderRegistry();
  registry.register(
    new FakeProvider(
      'claude',
      {
        id: 'claude',
        name: 'Fake Provider',
        installed: true,
        authenticated: 'authenticated',
        capabilities: FAKE_PROVIDER_CAPABILITIES,
      },
      scenario,
    ),
  );
  return new SessionManager(registry, noopLogger);
}

const request = { provider: 'claude' as const, cwd: process.cwd(), prompt: 'do the thing' };

describe('DispatchOnlyPhaseSessions', () => {
  /**
   * Implement's port. It returns as soon as the provider has the session, because the renderer
   * streams that session by id — which is how a session gets started *inside a ticket's worktree*
   * without the renderer ever being handed the worktree's path.
   */
  it('returns a session id without waiting for the session to finish', async () => {
    const manager = managerWith('success');
    const started = Date.now();
    const outcome = await new DispatchOnlyPhaseSessions({ sessionManager: manager }).run(request);
    expect(outcome.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(manager.get(outcome.sessionId, 1)).toBeDefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    await manager.cancelAll(500, 1);
  });

  /** What the orchestrator hangs the daemon's own post-session commit on. */
  it('reports how the session ended, without the dispatch itself waiting for it', async () => {
    const succeeded = managerWith('success');
    const ok = await new DispatchOnlyPhaseSessions({ sessionManager: succeeded }).run(request);
    await expect(ok.ended).resolves.toBe('completed');

    const failing = managerWith('failure');
    const failed = await new DispatchOnlyPhaseSessions({ sessionManager: failing }).run(request);
    await expect(failed.ended).resolves.toBe('failed');
    await succeeded.cancelAll(500, 1);
    await failing.cancelAll(500, 1);
  });

  /**
   * Issue #143, slice 1: `FakeProvider`'s 'success' and 'failure' scenarios both push
   * `{ type: 'usage', inputTokens: 10, outputTokens: 5 }` before their terminal event (see
   * `packages/agent-runtime/src/providers/fake/adapter.ts`), so 15 is the real number a session
   * that reported usage settles with either way -- a budget still accrues against a failed
   * session's real spend, not just a completed one's.
   */
  it('settles tokensUsed with the session’s reported usage once it ends, on success or failure', async () => {
    const succeeded = managerWith('success');
    const ok = await new DispatchOnlyPhaseSessions({ sessionManager: succeeded }).run(request);
    await expect(ok.tokensUsed).resolves.toBe(15);

    const failing = managerWith('failure');
    const failed = await new DispatchOnlyPhaseSessions({ sessionManager: failing }).run(request);
    await expect(failed.tokensUsed).resolves.toBe(15);
    await succeeded.cancelAll(500, 1);
    await failing.cancelAll(500, 1);
  });
});

describe('AwaitedPhaseSessions', () => {
  it('waits for the terminal event and reports the tools the session used', async () => {
    const manager = managerWith('success');
    const outcome = await new AwaitedPhaseSessions({ sessionManager: manager, workspaceTrust: OWNED }).run(request);
    expect(outcome.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Array.isArray(outcome.toolsUsed)).toBe(true);
    await manager.cancelAll(500, 1);
  });

  it('rejects with a typed failure when the session fails', async () => {
    const manager = managerWith('failure');
    await expect(
      new AwaitedPhaseSessions({ sessionManager: manager, workspaceTrust: OWNED }).run(request),
    ).rejects.toBeInstanceOf(PhaseSessionError);
    await manager.cancelAll(500, 1);
  });

  /** Issue #143, slice 1. See `DispatchOnlyPhaseSessions`'s own usage test for where 15 comes from. */
  it('reports the session’s tokensUsed alongside its output', async () => {
    const manager = managerWith('success');
    const outcome = await new AwaitedPhaseSessions({ sessionManager: manager, workspaceTrust: OWNED }).run(request);
    expect(outcome.tokensUsed).toBe(15);
    await manager.cancelAll(500, 1);
  });
});

/**
 * Issue #191. The phase adapters used to hand `SessionManager.create` `undefined` for its eighth
 * positional parameter, the sandbox. `create` spreads that field only when truthy, so no
 * `--sandbox` flag reached `codex exec` and it fell back to its own default of read-only —
 * making Implement structurally incapable of writing a file while still reporting success.
 *
 * These assert the dispatched scope rather than the observable behaviour on purpose: the fake
 * provider writes nothing either way, so an end-to-end assertion here would pass against the bug.
 * The scope *is* the contract.
 */
function recordingManager(scenario: 'success' | 'failure'): {
  manager: SessionManager;
  starts: StartSessionOptions[];
} {
  const starts: StartSessionOptions[] = [];
  const provider = new FakeProvider(
    'claude',
    {
      id: 'claude',
      name: 'Fake Provider',
      installed: true,
      authenticated: 'authenticated',
      capabilities: FAKE_PROVIDER_CAPABILITIES,
    },
    scenario,
  );
  const start = provider.startSession.bind(provider);
  (provider as unknown as { startSession: (o: StartSessionOptions) => unknown }).startSession = (
    options: StartSessionOptions,
  ) => {
    starts.push(options);
    return start(options);
  };
  const registry = new ProviderRegistry();
  registry.register(provider);
  return { manager: new SessionManager(registry, noopLogger), starts };
}

describe('phase sandbox scope', () => {
  it('gives Implement the workspace-write scope it needs to change a file at all', async () => {
    const { manager, starts } = recordingManager('success');
    await new DispatchOnlyPhaseSessions({ sessionManager: manager }).run(request);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.sandbox).toBe('workspace-write');
    await manager.cancelAll(500, 1);
  });

  /**
   * The half that matters after the bug is fixed. Refine (#179) is read-only *by construction*, and
   * before this it was read-only only because codex happened to default that way — an upstream
   * change to that default would have handed it write access to the operator's worktree silently.
   */
  it('pins Refine and Review read-only instead of inheriting a provider default', async () => {
    const { manager, starts } = recordingManager('success');
    await new AwaitedPhaseSessions({ sessionManager: manager, workspaceTrust: OWNED }).run(request);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.sandbox).toBe('read-only');
    await manager.cancelAll(500, 1);
  });

  // The regression in its most direct form: absence is what the bug actually was.
  it('never dispatches a phase without stating a sandbox', async () => {
    const dispatch = recordingManager('success');
    await new DispatchOnlyPhaseSessions({ sessionManager: dispatch.manager }).run(request);
    const awaited = recordingManager('success');
    await new AwaitedPhaseSessions({ sessionManager: awaited.manager, workspaceTrust: OWNED }).run(request);
    for (const options of [...dispatch.starts, ...awaited.starts]) {
      expect(options.sandbox).toBeDefined();
    }
    await dispatch.manager.cancelAll(500, 1);
    await awaited.manager.cancelAll(500, 1);
  });
});

/**
 * The security gap these close: a phase session used to reach `claude -p` with no tool
 * restriction at all, so it ran with whatever the operator's own Claude settings allowed plus the
 * repository's `.claude/settings.json` hooks — and a Refine prompt carries a stranger's issue body.
 * `evaluateRefinePermission()` existed and nothing called it. These assert the restriction is in the
 * argv the provider is actually launched with, and that the evaluators decide it before dispatch.
 */
function argvOf(options: StartSessionOptions | undefined): string[] {
  expect(options).toBeDefined();
  return buildClaudeArgs(options as StartSessionOptions);
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

describe('phase sessions launch Claude restricted, not with the operator’s settings', () => {
  it('launches Refine/Draft/Review with only Read, Grep and Glob, and no way to run anything', async () => {
    const { manager, starts } = recordingManager('success');
    await new AwaitedPhaseSessions({ sessionManager: manager, workspaceTrust: OWNED }).run(request);
    const argv = argvOf(starts[0]);
    expect(flag(argv, '--tools')).toBe('Read,Grep,Glob');
    expect(flag(argv, '--permission-mode')).toBe('dontAsk');
    // File tools confined to the working directory (not Claude Code's auto-memory directory).
    expect(argv).toContain('--restricted');
    for (const denied of ['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Agent', 'Skill']) {
      expect(flag(argv, '--disallowedTools')?.split(',')).toContain(denied);
      expect(flag(argv, '--tools')?.split(',')).not.toContain(denied);
    }
    // The operator's settings (allow rules, default mode) and the repository's `.claude/settings.json`
    // hooks are not loaded, and no MCP server is.
    expect(argv).toContain('--setting-sources=');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).not.toContain('--mcp-config');
    await manager.cancelAll(500, 1);
  });

  it('launches Implement write-capable but with no command, network or MCP tool', async () => {
    const { manager, starts } = recordingManager('success');
    await new DispatchOnlyPhaseSessions({ sessionManager: manager }).run(request);
    const argv = argvOf(starts[0]);
    expect(flag(argv, '--tools')).toBe('Read,Grep,Glob,Edit,Write');
    expect(flag(argv, '--permission-mode')).toBe('acceptEdits');
    expect(argv).toContain('--restricted');
    expect(flag(argv, '--disallowedTools')?.split(',')).toEqual(
      expect.arrayContaining(['Bash', 'PowerShell', 'WebFetch', 'WebSearch']),
    );
    expect(argv).toContain('--setting-sources=');
    expect(argv).toContain('--strict-mcp-config');
    await manager.cancelAll(500, 1);
  });
});

describe('the phase evaluators judge the tool grant before dispatch', () => {
  it('classifies tools with agentdock’s own effects table, unknown tools failing closed', () => {
    expect(claudeToolAction('Read')).toMatchObject({
      actionClass: 'filesystem',
      operation: 'filesystem.read',
      effectsComplete: true,
    });
    expect(claudeToolAction('Write')).toMatchObject({ operation: 'filesystem.write' });
    expect(claudeToolAction('Bash')).toMatchObject({ actionClass: 'command' });
    expect(claudeToolAction('WebFetch')).toMatchObject({ actionClass: 'network' });
    expect(claudeToolAction('mcp__github__create_pull_request')).toMatchObject({
      actionClass: 'external_side_effect',
      effectsComplete: false,
    });
  });

  it('accepts exactly the grants the phases are launched with', () => {
    expect(() =>
      assertPhaseToolGrant(CLAUDE_CLI_SANDBOX_TOOLS['read-only'], evaluateRefinePermission),
    ).not.toThrow();
    expect(() =>
      assertPhaseToolGrant(CLAUDE_CLI_SANDBOX_TOOLS['workspace-write'], evaluateImplementPermission),
    ).not.toThrow();
  });

  it('refuses a read-only grant that includes a write, a shell, the network or an MCP tool', () => {
    for (const extra of ['Edit', 'Write', 'Bash', 'PowerShell', 'WebFetch', 'mcp__gh__pr_create']) {
      expect(() =>
        assertPhaseToolGrant([...CLAUDE_CLI_SANDBOX_TOOLS['read-only'], extra], evaluateRefinePermission),
      ).toThrow(PhaseSessionError);
    }
    // The workspace-write grant is not a read-only grant: Review/Refine must never get it.
    expect(() =>
      assertPhaseToolGrant(CLAUDE_CLI_SANDBOX_TOOLS['workspace-write'], evaluateRefinePermission),
    ).toThrow(/Edit: filesystem_write/);
  });

  it('refuses an Implement grant that could publish: a shell, the network, or an MCP tool', () => {
    for (const extra of ['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'mcp__gh__pr_create', 'Agent']) {
      expect(() =>
        assertPhaseToolGrant(
          [...CLAUDE_CLI_SANDBOX_TOOLS['workspace-write'], extra],
          evaluateImplementPermission,
        ),
      ).toThrow(PhaseSessionError);
    }
  });

  it('has exactly one branch in evaluateImplementPermission that can return allow', async () => {
    const source = await readFile(
      join(import.meta.dirname, '..', 'src', 'implement-orchestrator.ts'),
      'utf8',
    );
    const gate = /export function evaluateImplementPermission[\s\S]*?\n}/.exec(source)?.[0] ?? '';
    expect(gate).not.toBe('');
    expect(gate.match(/outcome: 'allow'/g)).toHaveLength(1);
  });
});

describe('Refine/Draft dispatch requires a trusted workspace', () => {
  async function trustFixture(trusted: boolean) {
    const cwd = await mkdtemp(join(tmpdir(), 'pipenzo-phase-trust-'));
    const trustStore = new WorkspaceTrustStore(join(cwd, 'trust.json'));
    if (trusted) await trustStore.setTrusted(await resolveWorkspaceIdentity(cwd));
    return { cwd, trustStore };
  }

  it('refuses an untrusted repository before any provider session exists', async () => {
    const { cwd, trustStore } = await trustFixture(false);
    const { manager, starts } = recordingManager('success');
    const sessions = new AwaitedPhaseSessions({ sessionManager: manager, workspaceTrust: trustStore });
    const failure = await sessions.run({ ...request, cwd }).catch((error: unknown) => error);
    expect(isWorkspaceUntrustedError(failure)).toBe(true);
    expect(starts).toHaveLength(0);
    expect(manager.list(1)).toHaveLength(0);
  });

  it('offers the same check as a pre-baseline admission step, before any session exists', async () => {
    const untrusted = await trustFixture(false);
    const trusted = await trustFixture(true);
    const { manager } = recordingManager('success');
    const gated = (store: WorkspaceTrustStore) =>
      new AwaitedPhaseSessions({ sessionManager: manager, workspaceTrust: store });
    const refusal = await gated(untrusted.trustStore).admit(untrusted.cwd).catch((e: unknown) => e);
    expect(isWorkspaceUntrustedError(refusal)).toBe(true);
    await expect(gated(trusted.trustStore).admit(trusted.cwd)).resolves.toBeUndefined();
    expect(manager.list(1)).toHaveLength(0);
  });

  it('refuses a path that does not resolve to a workspace at all', async () => {
    const { cwd, trustStore } = await trustFixture(true);
    const { manager, starts } = recordingManager('success');
    const sessions = new AwaitedPhaseSessions({ sessionManager: manager, workspaceTrust: trustStore });
    const failure = await sessions
      .run({ ...request, cwd: join(cwd, 'does-not-exist') })
      .catch((error: unknown) => error);
    expect(isWorkspaceUntrustedError(failure)).toBe(true);
    expect(starts).toHaveLength(0);
  });

  it('dispatches into a trusted repository at its canonical path', async () => {
    const { cwd, trustStore } = await trustFixture(true);
    const { manager, starts } = recordingManager('success');
    const sessions = new AwaitedPhaseSessions({ sessionManager: manager, workspaceTrust: trustStore });
    await sessions.run({ ...request, cwd });
    expect(starts).toHaveLength(1);
    expect((await realpath(starts[0]?.cwd ?? '')).toLowerCase()).toBe(
      (await realpath(cwd)).toLowerCase(),
    );
    await manager.cancelAll(500, 1);
  });

  it('refuses a workspace whose trust the session manager has blocked', async () => {
    const { cwd, trustStore } = await trustFixture(true);
    const { manager, starts } = recordingManager('success');
    manager.blockWorkspace((await resolveWorkspaceIdentity(cwd)).workspaceId);
    const sessions = new AwaitedPhaseSessions({ sessionManager: manager, workspaceTrust: trustStore });
    const failure = await sessions.run({ ...request, cwd }).catch((error: unknown) => error);
    expect(isWorkspaceUntrustedError(failure)).toBe(true);
    expect(starts).toHaveLength(0);
  });
});

describe('extractJsonPayload', () => {
  it('reads a fenced JSON block, preferring the last one a session emitted', () => {
    expect(
      extractJsonPayload([
        'Here is a draft:\n```json\n{"verdict":"rejected"}\n```',
        'On reflection:\n```json\n{"verdict":"approved"}\n```',
      ]),
    ).toEqual({ verdict: 'approved' });
  });

  it('reads a bare JSON object when the session answered with nothing else', () => {
    expect(extractJsonPayload(['{"findings":[]}'])).toEqual({ findings: [] });
  });

  /**
   * A payload that is not there must read as *absent*, not as empty. `parseRefineSpec()` turns
   * `undefined` into `spec_missing`, which is a different fact from "the spec was malformed" and
   * the operator needs to be able to tell them apart.
   */
  it('answers undefined rather than inventing a payload', () => {
    expect(extractJsonPayload(['I could not do this.', 'not json {'])).toBeUndefined();
    expect(extractJsonPayload([])).toBeUndefined();
  });
});

describe('llmPassPayloadSchema', () => {
  it('accepts a verdict and findings, and drops a verdict it does not recognize', () => {
    expect(llmPassPayloadSchema.safeParse({ verdict: 'approved', findings: [] }).success).toBe(true);
    expect(llmPassPayloadSchema.safeParse({ verdict: 'probably fine' }).success).toBe(false);
  });

  /**
   * A verifier that returned no verdict is not an approval. The schema lets the field be absent
   * and `ReviewGatesRunner` then throws `verifier_failed` — silence never reads as consent.
   */
  it('treats a missing verdict as missing, not as approval', () => {
    const parsed = llmPassPayloadSchema.parse({ findings: [] });
    expect(parsed.verdict).toBeUndefined();
  });
});
