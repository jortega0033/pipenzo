import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  pipenzoIdeaDraftRequestV1Schema,
  pipenzoIdeaDraftResultV1Schema,
  pipenzoCaptureCapabilityRequestV1Schema,
  pipenzoCaptureCapabilityV1Schema,
  pipenzoImplementRequestV1Schema,
  pipenzoImplementResultQueryV1Schema,
  pipenzoImplementResultV1Schema,
  pipenzoImplementCommitsV1Schema,
  pipenzoIssueClaimRequestV1Schema,
  pipenzoIssueClaimResultV1Schema,
  pipenzoIssueCommentRequestV1Schema,
  pipenzoIssueCommentResultV1Schema,
  pipenzoIssueCreateRequestV1Schema,
  pipenzoIssueCreateResultV1Schema,
  pipenzoRefineRequestV1Schema,
  pipenzoRefineResultV1Schema,
  pipenzoReviewRequestV1Schema,
  pipenzoReviewResultV1Schema,
  type PipenzoPhaseErrorCodeV1,
} from '@agent-dock/shared';
import { PipenzoPhaseError, type PipenzoPhaseService } from '../pipenzo-phase-service.js';

/**
 * The Refine / Implement / Review routes, and the two GitHub issue write ops (Pipenzo issue #184).
 *
 * These sit on exactly the surface `routes/pipenzo-publish.ts` describes and inherit every one of
 * its properties from `server.ts`: the startup bearer token, the reject-any-Origin browser guard,
 * and the fact that an agent session's environment carries neither the daemon's port nor its token
 * (`test/publish-token-boundary.test.ts`). They are not agent tools, not MCP servers, not skills,
 * and nothing a model can name — the caller is the desktop main process, acting for a human.
 *
 * Two deliberate choices, both copied from the publish route rather than re-decided here:
 *
 * - **A rejected body is never echoed.** These payloads carry issue titles, issue bodies, refine
 *   specs and operator instructions. Reflecting a rejected payload back is how a validation error
 *   turns into an accidental echo surface, so the Zod issue list stays on this side.
 * - **Low rate limits.** Every one of these is human-paced: a person clicks Refine, clicks Start,
 *   clicks Review, clicks Create issue. Nothing legitimate does any of them ten times a minute,
 *   and the failure mode worth defending against is a loop, not a flood.
 */
const PHASE_ERROR_STATUS: Record<PipenzoPhaseErrorCodeV1, number> = {
  invalid_request: 400,
  invalid_issue: 400,
  invalid_spec: 400,
  // A read-only violation is not a bad request and not an upstream failure: it is the refine
  // boundary reporting that something inside it did what it is not allowed to do.
  read_only_violation: 409,
  spec_invalid: 422,
  spec_missing: 422,
  workspace_untrusted: 409,
  worktree_failed: 409,
  worktree_secret_risk: 409,
  worktree_not_found: 404,
  branch_failed: 409,
  verifier_tier_too_low: 409,
  diff_unavailable: 409,
  reviewer_failed: 502,
  verifier_failed: 502,
  session_failed: 502,
  token_missing: 412,
  repository_not_configured: 412,
  issue_not_found: 404,
  claimed_elsewhere: 409,
  // GitHub's own 401/403 are reported as 502, never mirrored. A 401 on this route means the
  // *daemon's* bearer token was wrong, and an upstream credential failure wearing the same status
  // would send an operator looking in entirely the wrong place.
  github_unauthorized: 502,
  github_forbidden: 502,
  github_rate_limited: 429,
  github_failed: 502,
};

function fail(reply: FastifyReply, error: PipenzoPhaseError): void {
  reply.code(PHASE_ERROR_STATUS[error.code]).send({
    code: error.code,
    error: error.message,
    ...(error.details.length > 0 ? { details: error.details } : {}),
  });
}

function invalid(reply: FastifyReply, what: string): void {
  reply.code(400).send({ code: 'invalid_request', error: `invalid ${what}` });
}

export function registerPipenzoPhaseRoutes(
  app: FastifyInstance,
  service: PipenzoPhaseService,
): void {
  const limits = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/v2/pipenzo/refine', limits, async (req, reply) => {
    const parsed = pipenzoRefineRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'refine request');
    try {
      reply.send(pipenzoRefineResultV1Schema.parse(await service.refine(parsed.data)));
    } catch (error) {
      if (error instanceof PipenzoPhaseError) return fail(reply, error);
      return fail(reply, new PipenzoPhaseError('session_failed', 'refine failed'));
    }
  });

  app.post('/v2/pipenzo/implement', limits, async (req, reply) => {
    const parsed = pipenzoImplementRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'implement request');
    let result;
    try {
      result = await service.implement(parsed.data);
    } catch (error) {
      if (error instanceof PipenzoPhaseError) return fail(reply, error);
      return fail(reply, new PipenzoPhaseError('session_failed', 'implement failed'));
    }
    // Outside the try, same reasoning as the publish route: a worktree exists and a session is
    // running by now, so a response-shape mismatch must not be reported as a failure to start —
    // the operator's natural retry would cut a second worktree for the same ticket.
    reply.send(pipenzoImplementResultV1Schema.parse(result));
  });

  app.post('/v2/pipenzo/implement/result', limits, async (req, reply) => {
    const parsed = pipenzoImplementResultQueryV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'implement result request');
    try {
      reply.send(pipenzoImplementCommitsV1Schema.parse(await service.implementResult(parsed.data)));
    } catch (error) {
      if (error instanceof PipenzoPhaseError) return fail(reply, error);
      return fail(reply, new PipenzoPhaseError('branch_failed', 'implement result unavailable'));
    }
  });

  app.post('/v2/pipenzo/review', limits, async (req, reply) => {
    const parsed = pipenzoReviewRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'review request');
    try {
      reply.send(pipenzoReviewResultV1Schema.parse(await service.review(parsed.data)));
    } catch (error) {
      if (error instanceof PipenzoPhaseError) return fail(reply, error);
      return fail(reply, new PipenzoPhaseError('session_failed', 'review failed'));
    }
  });

  // Capability detection (issue #124). A read, and a cheap one — a module resolution and a
  // `package.json` parse — so it gets a higher limit than the human-paced phase routes: the
  // Models & gates screen refreshes this whenever the operator switches repository.
  app.post(
    '/v2/pipenzo/capabilities',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = pipenzoCaptureCapabilityRequestV1Schema.safeParse(req.body);
      if (!parsed.success) return invalid(reply, 'capability request');
      try {
        reply.send(
          pipenzoCaptureCapabilityV1Schema.parse(await service.captureCapabilities(parsed.data)),
        );
      } catch (error) {
        if (error instanceof PipenzoPhaseError) return fail(reply, error);
        return fail(reply, new PipenzoPhaseError('invalid_request', 'capability probe failed'));
      }
    },
  );

  app.post('/v2/pipenzo/issues/claim', limits, async (req, reply) => {
    const parsed = pipenzoIssueClaimRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'issue claim request');
    try {
      reply.send(pipenzoIssueClaimResultV1Schema.parse(await service.claimIssue(parsed.data)));
    } catch (error) {
      if (error instanceof PipenzoPhaseError) return fail(reply, error);
      return fail(reply, new PipenzoPhaseError('github_failed', 'issue claim failed'));
    }
  });

  app.post('/v2/pipenzo/issues/draft', limits, async (req, reply) => {
    const parsed = pipenzoIdeaDraftRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'issue draft request');
    try {
      reply.send(pipenzoIdeaDraftResultV1Schema.parse(await service.draftIssue(parsed.data)));
    } catch (error) {
      if (error instanceof PipenzoPhaseError) return fail(reply, error);
      return fail(reply, new PipenzoPhaseError('session_failed', 'drafting failed'));
    }
  });

  app.post('/v2/pipenzo/issues', limits, async (req, reply) => {
    const parsed = pipenzoIssueCreateRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'issue create request');
    let result;
    try {
      result = await service.createIssue(parsed.data);
    } catch (error) {
      if (error instanceof PipenzoPhaseError) return fail(reply, error);
      return fail(reply, new PipenzoPhaseError('github_failed', 'issue creation failed'));
    }
    // Outside the try: the issue is open on GitHub by now, and a retry would file a duplicate.
    reply.code(201).send(pipenzoIssueCreateResultV1Schema.parse(result));
  });

  /**
   * Posts one comment on an issue (issue #228), for #100's refusal panel and #144's blown-estimate
   * record.
   *
   * It shares this file's limits rather than getting its own, and that is the load-bearing choice
   * here: this is the first route on the surface whose payload is prose that becomes public under
   * the operator's GitHub identity. Every other property it needs it inherits from `server.ts` —
   * the startup bearer token, the reject-any-Origin guard, and the fact that an agent session's
   * environment carries neither the daemon's port nor its token.
   */
  app.post('/v2/pipenzo/issues/comment', limits, async (req, reply) => {
    const parsed = pipenzoIssueCommentRequestV1Schema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, 'issue comment request');
    let result;
    try {
      result = await service.commentOnIssue(parsed.data);
    } catch (error) {
      if (error instanceof PipenzoPhaseError) return fail(reply, error);
      return fail(reply, new PipenzoPhaseError('github_failed', 'issue comment failed'));
    }
    // Outside the try, for the same reason as the create route above and with a sharper edge: the
    // comment is already public by now, and GitHub has no idempotency key for one — an operator's
    // natural retry after a response-shape error would post it a second time.
    reply.code(201).send(pipenzoIssueCommentResultV1Schema.parse(result));
  });
}
