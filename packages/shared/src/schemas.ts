import { z } from 'zod';
import { AUTH_SOURCES, PROVIDER_IDS } from './provider.js';
import { daemonCredentialSourceV1Schema } from './pipenzo-credential-v1.js';

export const providerIdSchema = z.enum(PROVIDER_IDS);

/**
 * The ticket store's own primary key. A UUID, like every other daemon-generated id (session,
 * worktree). Defined here rather than in `pipenzo-ticket-v1.ts` (which re-exports it, so nothing
 * that already imports it from there needs to change) because `pipenzo-phase-v1.ts` needs it too
 * (issue #144's `ticketId` on a review request) and `pipenzo-ticket-v1.ts` itself already imports
 * from `pipenzo-phase-v1.ts` — a leaf module with no pipenzo-specific dependencies is what breaks
 * that cycle, not a third pipenzo-* file that would just move the cycle sideways.
 */
export const pipenzoTicketIdV1Schema = z.string().uuid();

// AD-15: every key is optional and unknown keys pass through rather than being rejected or
// silently stripped: "absent means unsupported" is a documented, valid state (see
// ProviderCapabilities), not a validation failure. This is what makes adding a 6th capability
// additive: a client built against a newer @agent-dock/shared can validate an older daemon's
// response (missing the new key) without error, and an older client validating a newer daemon's
// response keeps whatever future keys it doesn't understand rather than losing them.
export const providerCapabilitiesSchema = z
  .object({
    resume: z.boolean().optional(),
    cancellation: z.boolean().optional(),
    tools: z.boolean().optional(),
    usage: z.boolean().optional(),
    thinking: z.boolean().optional(),
  })
  .catchall(z.boolean());

export const providerStatusSchema = z.object({
  id: providerIdSchema,
  name: z.string(),
  installed: z.boolean(),
  authenticated: z.enum(['authenticated', 'unauthenticated', 'unknown']),
  authSource: z.enum(AUTH_SOURCES).optional(),
  capabilities: providerCapabilitiesSchema,
  executablePath: z.string().optional(),
  version: z.string().optional(),
  error: z.string().optional(),
});

/** Body for POST /sessions. Rejects anything not an absolute-looking, non-empty path/prompt. */
export const createSessionRequestSchema = z.object({
  provider: providerIdSchema,
  cwd: z.string().min(1, 'cwd is required'),
  prompt: z.string().min(1, 'prompt is required').max(200_000, 'prompt is too long'),
  /** Continue a prior provider-native session/thread, when `capabilities.resume` is true. */
  resumeProviderSessionId: z.string().min(1).optional(),
});

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const sessionIdParamSchema = z.object({
  sessionId: z.string().uuid(),
});

export const sessionStatusSchema = z.enum([
  'starting',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const agentSessionSchema = z.object({
  id: z.string().uuid(),
  provider: providerIdSchema,
  cwd: z.string(),
  prompt: z.string(),
  status: sessionStatusSchema,
  providerSessionId: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
});

const agentEventBaseSchema = z.object({
  sequence: z.number().int().nonnegative(),
  timestamp: z.string(),
});

/**
 * Runtime validation for the wire shape of `AgentEventEnvelope` (protocol v1), used by
 * @agent-dock/client to reject a malformed SSE frame with a typed error instead of handing the
 * caller garbage. Mirrors the `AgentEvent` union in events.ts field-for-field; if you add a
 * variant there, add it here too.
 */
export const agentEventEnvelopeSchema = z.discriminatedUnion('type', [
  agentEventBaseSchema.extend({
    type: z.literal('session.started'),
    sessionId: z.string(),
    provider: providerIdSchema,
    providerSessionId: z.string().optional(),
  }),
  agentEventBaseSchema.extend({
    type: z.literal('status'),
    status: z.string(),
    detail: z.string().optional(),
  }),
  agentEventBaseSchema.extend({
    type: z.literal('assistant.message'),
    text: z.string(),
  }),
  agentEventBaseSchema.extend({
    type: z.literal('thinking.delta'),
    text: z.string(),
  }),
  agentEventBaseSchema.extend({
    type: z.literal('tool.started'),
    toolName: z.string(),
    toolCallId: z.string().optional(),
    input: z.unknown().optional(),
  }),
  agentEventBaseSchema.extend({
    type: z.literal('tool.completed'),
    toolName: z.string().optional(),
    toolCallId: z.string().optional(),
    result: z.unknown().optional(),
    isError: z.boolean().optional(),
  }),
  agentEventBaseSchema.extend({
    type: z.literal('usage'),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cachedInputTokens: z.number().optional(),
    cost: z.number().optional(),
  }),
  agentEventBaseSchema.extend({
    type: z.literal('error'),
    code: z.string().optional(),
    message: z.string(),
    recoverable: z.boolean(),
  }),
  agentEventBaseSchema.extend({
    type: z.literal('session.completed'),
    providerSessionId: z.string().optional(),
  }),
  agentEventBaseSchema.extend({
    type: z.literal('session.failed'),
    message: z.string(),
  }),
  agentEventBaseSchema.extend({
    type: z.literal('session.cancelled'),
  }),
]);

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number(),
  protocolVersion: z.number(),
  /** Optional for compatibility with pre-v2 daemons; new daemons emit `[1, 2]`. */
  supportedProtocolVersions: z
    .array(z.number().int().positive())
    .min(1)
    .superRefine((versions, ctx) => {
      if (new Set(versions).size !== versions.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'supported protocol versions must be unique',
        });
      }
    })
    .optional(),
  /**
   * The daemon's own report of where its GitHub credential came from (issue #209). Optional for
   * compatibility with a daemon built before this field existed, the same reason
   * `supportedProtocolVersions` is optional above; absent means "ask an older daemon," not "no
   * credential." Electron main reconciles this against what it intended to send
   * (`reconcileDaemonTokenSource` in `apps/desktop/electron/daemon-environment.ts`) rather than
   * trusting its own pre-handoff intent, which a failed stdin write could leave stale.
   */
  githubCredentialSource: daemonCredentialSourceV1Schema.optional(),
});
