import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FakeProvider, ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { agentSessionV2Schema } from '@agent-dock/shared';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { resolveWorkspaceIdentity } from '../src/workspace-identity.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';

const TOKEN = 'workspace-lease-token';
let cwd: string;

/**
 * Teardown belongs here, not at the end of the test body, so it still runs when the body does not
 * reach the end. It previously did not: a timeout skipped the shutdown, `rmSync` then deleted a
 * directory the daemon and its provider still held open, and the real failure was buried under a
 * second `EBUSY: rmdir` from `afterEach` (issue #219).
 */
const opened: Array<{ app: FastifyInstance; sessionManager: SessionManager }> = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-dock-workspace-lease-'));
});

afterEach(async () => {
  for (const { app, sessionManager } of opened.splice(0)) {
    sessionManager.beginShutdown();
    await sessionManager.cancelAll();
    await app.close();
  }
  rmSync(cwd, { recursive: true, force: true });
});

describe('v2 workspace execution leases', () => {
  it('rejects a canonical-path mutation conflict before a second provider dispatch and releases on terminal', async () => {
    execFileSync('git', ['init', '-b', 'lease-test', cwd], { windowsHide: true });
    const registry = new ProviderRegistry();
    const provider = new FakeProvider('claude', undefined, 'success', 'multi-input');
    const support = provider.getV2Support(await provider.detect());
    if (!support) throw new Error('fake provider did not expose v2 support');
    vi.spyOn(provider, 'getV2Support').mockReturnValue({
      transports: support.transports.map((transport) => ({
        ...transport,
        possibleEffects: ['command'],
      })),
      capabilities: support.capabilities.map((capability) => ({
        ...capability,
        scope: { ...capability.scope, trustState: 'trusted' },
        prerequisites: { ...capability.prerequisites, trustStates: ['trusted'] },
      })),
    });
    const start = vi.spyOn(provider, 'startInteractiveSession');
    registry.register(provider);
    const identity = await resolveWorkspaceIdentity(cwd);
    const trustStore = new WorkspaceTrustStore(join(cwd, 'trust.json'));
    await trustStore.setTrusted(identity);
    const sessionManager = new SessionManager(registry, noopLogger, undefined, { trustStore });
    const app = buildServer({
      registry,
      sessionManager,
      trustStore,
      token: TOKEN,
      logger: noopLogger,
    });
    opened.push({ app, sessionManager });
    const payload = {
      provider: 'claude',
      cwd,
      prompt: 'mutate safely',
      capabilities: {
        required: [{ id: 'session.cancel' }],
        optional: [],
        allowExperimental: false,
      },
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload,
    });
    expect(first.statusCode, first.body).toBe(201);
    const firstSession = agentSessionV2Schema.parse(first.json());
    expect(firstSession.branch).toBe('lease-test');
    expect(firstSession.selection.possibleEffects).toContain('command');

    const conflict = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { ...payload, cwd: join(cwd, '.') },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'workspace_execution_conflict' });
    expect(start).toHaveBeenCalledTimes(1);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${firstSession.id}/cancel`,
      headers: auth(),
    });
    expect(cancelled.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const snapshot = await app.inject({
        method: 'GET',
        url: `/v2/sessions/${firstSession.id}`,
        headers: auth(),
      });
      expect(agentSessionV2Schema.parse(snapshot.json()).status).toBe('cancelled');
    });

    const afterRelease = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload,
    });
    expect(afterRelease.statusCode, afterRelease.body).toBe(201);
    expect(start).toHaveBeenCalledTimes(2);

    const userFile = join(cwd, 'uncommitted-user-work.txt');
    writeFileSync(userFile, 'preserve me', 'utf8');
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v2/sessions/${firstSession.id}`,
      headers: auth(),
    });
    expect(deleted.statusCode).toBe(204);
    expect(readFileSync(userFile, 'utf8')).toBe('preserve me');
    // Budget sized from measurement, not raised until it went quiet. This test spawns `git init`
    // and then drives three real interactive session starts, each of which resolves the workspace
    // identity by spawning more Git -- a process spawn on Windows costs 100-300 ms, and the whole
    // body measures ~7.3 s on an idle machine. Its 15 s was therefore about 2x headroom, which
    // this suite has already been shown not to have: #219 records the identically-shaped
    // `server-v2.test.ts` corrupted-queue test (~7.2 s idle) timing out at 15 s on the Windows
    // runner. 45 s is ~6x the measured cost, and still fails a genuine hang two orders of
    // magnitude inside the job's 20-minute limit.
  }, 45_000);
});

function auth(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}
