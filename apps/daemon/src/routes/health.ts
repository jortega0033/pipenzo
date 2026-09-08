import type { FastifyInstance } from 'fastify';
import {
  AGENT_DOCK_PROTOCOL_VERSION,
  AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS,
} from '@agent-dock/shared';
import type { DaemonGitHubCredential } from '../github-credential.js';

/**
 * `githubCredential` is optional so a daemon built without one (a route test, a build that never
 * wired the credential seam) still answers `/health` — it just omits the field, the same
 * compatibility shape `supportedProtocolVersions` already established. See
 * `DaemonGitHubCredential.resolvedSource` (issue #209) for what the value means.
 */
export function registerHealthRoute(
  app: FastifyInstance,
  startedAt: number,
  githubCredential?: DaemonGitHubCredential,
): void {
  app.get('/health', async () => ({
    status: 'ok' as const,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    protocolVersion: AGENT_DOCK_PROTOCOL_VERSION,
    supportedProtocolVersions: AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS,
    ...(githubCredential ? { githubCredentialSource: githubCredential.resolvedSource() } : {}),
  }));
}
