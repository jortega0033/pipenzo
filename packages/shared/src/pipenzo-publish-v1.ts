import { z } from 'zod';

/**
 * Wire contract for the publish gate (Pipenzo issue #178).
 *
 * This lives in `@agent-dock/shared` because it genuinely crosses the daemon/client boundary:
 * the desktop renderer sends it after a human clicks "Push branch" or "Push & open PR", and the
 * daemon answers with what actually happened. It crosses **no other** boundary — there is no
 * agent-facing tool, MCP server, or skill that speaks this schema, and adding one would break the
 * property CLAUDE.md's hard rule #1 exists to hold.
 *
 * Every field an operator can influence is validated here *and* re-validated in the service, on
 * purpose: the schema is the wire contract, the service's own assertions are the argv contract,
 * and neither is allowed to be the only thing standing between a request and `execFile('git', …)`.
 */

/** Nothing that could be read as a `git` option, a path traversal, or a ref-syntax escape. */
const gitRefNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'must start alphanumeric and use only [A-Za-z0-9._/-]')
  .refine((value) => !value.includes('..'), 'must not contain ..')
  .refine((value) => !value.includes('//'), 'must not contain //')
  .refine((value) => !value.endsWith('/') && !value.endsWith('.'), 'must not end with / or .')
  .refine((value) => !/(^|\/)\.lock$|\.lock$/.test(value), 'must not end with .lock')
  .refine((value) => !value.includes('@{'), 'must not contain @{');

/** A git remote name, not a URL: Pipenzo pushes to a remote the repository already has. */
const gitRemoteNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a plain remote name')
  .refine((value) => !value.includes('..'), 'must not contain ..');

const noControlCharacters = (value: string): boolean =>
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  });

export const pipenzoPullRequestInputV1Schema = z
  .object({
    title: z.string().min(1).max(256).refine(noControlCharacters, 'must not contain control characters'),
    body: z.string().max(65_536),
    /** Omitted means the daemon's configured default base branch. */
    base: gitRefNameSchema.optional(),
    draft: z.boolean().optional(),
  })
  .strict();

export const pipenzoPublishRequestV1Schema = z
  .object({
    /**
     * An agentdock-owned worktree id, never a filesystem path. The renderer is never told a
     * worktree's absolute path (agentdock's `OwnedWorktreeManager` deliberately withholds it from
     * its public projection), so it cannot ask the daemon to push from an arbitrary directory.
     */
    worktreeId: z.string().uuid(),
    branch: gitRefNameSchema,
    remote: gitRemoteNameSchema.optional(),
    operation: z.enum(['push', 'push_and_open_pull_request']),
    pullRequest: pipenzoPullRequestInputV1Schema.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.operation === 'push_and_open_pull_request' && !request.pullRequest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pullRequest'],
        message: 'push_and_open_pull_request requires pull request details',
      });
    }
    if (request.operation === 'push' && request.pullRequest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pullRequest'],
        message: 'push does not open a pull request',
      });
    }
  });

export const pipenzoPublishedPullRequestV1Schema = z
  .object({
    number: z.number().int().positive(),
    htmlUrl: z.string().url(),
    baseRef: gitRefNameSchema,
    draft: z.boolean(),
  })
  .strict();

export const pipenzoPublishResultV1Schema = z
  .object({
    worktreeId: z.string().uuid(),
    remote: gitRemoteNameSchema,
    branch: gitRefNameSchema,
    /** The commit that was actually pushed, so the diff view can pin evidence to a real sha. */
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    /** False when the remote already had this exact commit — a no-op push is still a success. */
    updatedRemote: z.boolean(),
    pullRequest: pipenzoPublishedPullRequestV1Schema.optional(),
  })
  .strict();

/** The closed failure union. Routes map these to statuses; nothing string-matches a message. */
export const PIPENZO_PUBLISH_ERROR_CODES = [
  'invalid_request',
  'worktree_not_found',
  'worktree_not_a_git_repository',
  'uncommitted_changes',
  'branch_not_found',
  'remote_not_found',
  'push_rejected',
  'push_failed',
  'publish_busy',
  'token_missing',
  'repository_not_configured',
  'pull_request_failed',
] as const;

export const pipenzoPublishErrorV1Schema = z
  .object({
    code: z.enum(PIPENZO_PUBLISH_ERROR_CODES),
    error: z.string().min(1).max(4_096),
  })
  .strict();

export type PipenzoPullRequestInputV1 = z.infer<typeof pipenzoPullRequestInputV1Schema>;
export type PipenzoPublishRequestV1 = z.infer<typeof pipenzoPublishRequestV1Schema>;
export type PipenzoPublishedPullRequestV1 = z.infer<typeof pipenzoPublishedPullRequestV1Schema>;
export type PipenzoPublishResultV1 = z.infer<typeof pipenzoPublishResultV1Schema>;
export type PipenzoPublishErrorCodeV1 = (typeof PIPENZO_PUBLISH_ERROR_CODES)[number];
