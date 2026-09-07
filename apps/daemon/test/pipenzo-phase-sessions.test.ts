import { describe, expect, it } from 'vitest';
import {
  FAKE_PROVIDER_CAPABILITIES,
  FakeProvider,
  ProviderRegistry,
  noopLogger,
  type StartSessionOptions,
} from '@agent-dock/agent-runtime';
import { SessionManager } from '../src/session-manager.js';
import {
  AwaitedPhaseSessions,
  DispatchOnlyPhaseSessions,
  PhaseSessionError,
  extractJsonPayload,
  llmPassPayloadSchema,
} from '../src/pipenzo-phase-sessions.js';

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
});

describe('AwaitedPhaseSessions', () => {
  it('waits for the terminal event and reports the tools the session used', async () => {
    const manager = managerWith('success');
    const outcome = await new AwaitedPhaseSessions({ sessionManager: manager }).run(request);
    expect(outcome.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Array.isArray(outcome.toolsUsed)).toBe(true);
    await manager.cancelAll(500, 1);
  });

  it('rejects with a typed failure when the session fails', async () => {
    const manager = managerWith('failure');
    await expect(
      new AwaitedPhaseSessions({ sessionManager: manager }).run(request),
    ).rejects.toBeInstanceOf(PhaseSessionError);
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
    await new AwaitedPhaseSessions({ sessionManager: manager }).run(request);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.sandbox).toBe('read-only');
    await manager.cancelAll(500, 1);
  });

  // The regression in its most direct form: absence is what the bug actually was.
  it('never dispatches a phase without stating a sandbox', async () => {
    const dispatch = recordingManager('success');
    await new DispatchOnlyPhaseSessions({ sessionManager: dispatch.manager }).run(request);
    const awaited = recordingManager('success');
    await new AwaitedPhaseSessions({ sessionManager: awaited.manager }).run(request);
    for (const options of [...dispatch.starts, ...awaited.starts]) {
      expect(options.sandbox).toBeDefined();
    }
    await dispatch.manager.cancelAll(500, 1);
    await awaited.manager.cancelAll(500, 1);
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
