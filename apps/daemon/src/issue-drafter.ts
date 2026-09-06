import {
  EARS_TEMPLATES,
  PIPENZO_ISSUE_DRAFT_V1_JSON_SCHEMA,
  pipenzoIssueDraftV1Schema,
  type CreateSessionV2Request,
  type PipenzoIdeaDraftRequestV1,
  type PipenzoIssueDraftV1,
} from '@agent-dock/shared';
import { REFINE_TOOL_ALLOWLIST, assertRefineToolsOnly, type RefineSessionPort } from './refine-subagent.js';

/**
 * The "New from idea" drafter (Pipenzo issue #84).
 *
 * It is Refine's shape without Refine's job: read the repository, produce something structured,
 * write nothing. That is not a coincidence and it is not code reuse for its own sake — a drafted
 * issue is the thing Refine will later be pointed at, so a drafter that could edit the repository
 * would be able to make its own draft true, and a drafter that spoke a different vocabulary than
 * Refine would produce tickets Refine then re-interprets from scratch.
 *
 * Three properties, in decreasing order of how much they matter:
 *
 * 1. **Read-only, enforced the same way Refine is.** It runs on the same session port and its
 *    tool use is checked against `REFINE_TOOL_ALLOWLIST` afterwards. Drafting an issue is the one
 *    moment in the loop where a model is asked to imagine work that does not exist yet; giving it
 *    a write while it does that is the worst possible pairing.
 * 2. **Prose is one field.** `title` is the only thing a style pass may have written. The
 *    acceptance criteria, the out-of-scope list and the estimate are data, and the issue body is
 *    assembled from them by a pure function on the renderer side — which is what makes the
 *    canvas's claim ("every number below it is rendered from data and never rewritten") a checkable
 *    property rather than a caption.
 * 3. **Nothing is created here.** This module returns a draft. Filing it is a separate,
 *    human-clicked call to `createIssue`, and the two are separate so that a model can never be
 *    the last thing that happened before a ticket appeared in someone's repository.
 */

const MAX_IDEA_CHARS = 8_000;

export type IssueDraftErrorCode = 'invalid_request' | 'draft_invalid' | 'draft_missing' | 'read_only_violation' | 'session_failed';

export class IssueDraftError extends Error {
  readonly code: IssueDraftErrorCode;
  readonly details: readonly string[];

  constructor(code: IssueDraftErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'IssueDraftError';
    this.code = code;
    this.details = details.slice(0, 20).map((detail) => detail.slice(0, 500));
  }
}

export interface IssueDraftResult {
  readonly sessionId: string;
  readonly draft: PipenzoIssueDraftV1;
}

export class IssueDrafter {
  readonly #sessions: RefineSessionPort;

  constructor(sessions: RefineSessionPort) {
    this.#sessions = sessions;
  }

  async draft(request: PipenzoIdeaDraftRequestV1): Promise<IssueDraftResult> {
    if (!request.idea.trim()) {
      throw new IssueDraftError('invalid_request', 'drafting requires something to draft from');
    }
    if (!request.repositoryPath.trim()) {
      throw new IssueDraftError('invalid_request', 'drafting requires a repository to read');
    }
    let outcome;
    try {
      outcome = await this.#sessions.run(buildIssueDraftSessionRequest(request));
    } catch (error) {
      throw new IssueDraftError(
        'session_failed',
        error instanceof Error ? error.message : 'the drafting session failed',
      );
    }
    // Same order as Refine: a violation is reported as a violation even when the output was fine.
    try {
      assertRefineToolsOnly(outcome.toolsUsed);
    } catch (error) {
      throw new IssueDraftError(
        'read_only_violation',
        'the drafting session used a tool outside the read-only allowlist',
        error instanceof Error && 'details' in error
          ? ((error as { details: readonly string[] }).details ?? [])
          : [],
      );
    }
    return { sessionId: outcome.sessionId, draft: parseIssueDraft(outcome.output) };
  }
}

export function buildIssueDraftSessionRequest(
  request: PipenzoIdeaDraftRequestV1,
): CreateSessionV2Request {
  return {
    provider: request.provider,
    cwd: request.repositoryPath,
    prompt: buildIssueDraftPrompt(request.idea),
    outputSchema:
      PIPENZO_ISSUE_DRAFT_V1_JSON_SCHEMA as unknown as CreateSessionV2Request['outputSchema'],
    ...(request.model ? { model: request.model } : {}),
  };
}

export function parseIssueDraft(raw: unknown): PipenzoIssueDraftV1 {
  if (raw === undefined || raw === null) {
    throw new IssueDraftError('draft_missing', 'the drafting session produced no structured output');
  }
  const parsed = pipenzoIssueDraftV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new IssueDraftError(
      'draft_invalid',
      'the drafted issue did not match the v1 schema',
      parsed.error.issues
        .slice(0, 20)
        .map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`),
    );
  }
  const duplicates = parsed.data.acceptanceCriteria
    .map((criterion) => criterion.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new IssueDraftError('draft_invalid', 'acceptance criterion ids must be unique', [
      ...new Set(duplicates),
    ]);
  }
  return parsed.data;
}

/**
 * The drafting prompt.
 *
 * It says the two things a drafter gets wrong by default. First, that the *title* is the only
 * place to write well — everything else is fields a renderer will lay out, so effort spent
 * polishing them is effort spent on text nobody will see. Second, that an honest small estimate
 * beats a flattering one, because the number is checked against a real diff later and the person
 * reading this draft is deciding whether to spend money on it.
 */
export function buildIssueDraftPrompt(idea: string): string {
  const body = idea.length > MAX_IDEA_CHARS ? `${idea.slice(0, MAX_IDEA_CHARS)}\n\n[idea truncated]` : idea;
  return [
    'Someone described a problem in their own words. Turn it into one scoped issue. You are not',
    'implementing it and you cannot: this session is restricted to',
    `${REFINE_TOOL_ALLOWLIST.join(', ')}, and the daemon denies every write, command, network and`,
    'MCP action. Read the repository to ground what you write — a draft that names files that do',
    'not exist wastes the reader’s time twice.',
    '',
    'Nothing is created from this. A human reads your draft and decides whether to file it, so',
    'write for that decision.',
    '',
    'Produce structured output matching the schema you were given:',
    '',
    '- title: one line, specific enough that somebody scanning a board knows what it is. This is',
    '  the only prose in the draft; everything else is laid out from fields, so do not write',
    '  paragraphs into them.',
    '- acceptanceCriteria: EARS notation. Each entry declares its kind and its text must follow',
    '  that kind’s template exactly:',
    ...Object.entries(EARS_TEMPLATES).map(
      ([kind, template]) => `    ${kind.padEnd(11)} ${template.template}`,
    ),
    '- outOfScope: at least one entry. What this ticket is explicitly NOT. A reader uses this to',
    '  decide the ticket is small enough to say yes to.',
    '- estimate: your honest numeric prediction — changedLines is additions plus deletions,',
    '  filesTouched is a count, layered says whether the work splits into 2-4 dependency-ordered',
    '  pull requests. Somebody is deciding whether to spend money on this, and the number is',
    '  checked against the real diff later, so a flattering estimate costs them twice.',
    '- openQuestions: what you had to guess at. An empty list is a claim that the idea was',
    '  unambiguous, which it usually is not.',
    '',
    'The idea, in their words:',
    '',
    body,
  ].join('\n');
}
