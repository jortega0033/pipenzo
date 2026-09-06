import { describe, expect, it } from 'vitest';
import type { CreateSessionV2Request, PipenzoIssueDraftV1 } from '@agent-dock/shared';
import {
  IssueDraftError,
  IssueDrafter,
  buildIssueDraftPrompt,
  buildIssueDraftSessionRequest,
  parseIssueDraft,
} from '../src/issue-drafter.js';
import { REFINE_TOOL_ALLOWLIST, type RefineSessionPort } from '../src/refine-subagent.js';

/**
 * Issue #84's daemon half. The drafter is Refine's shape without Refine's job, and the tests are
 * mostly about the properties that borrowing buys: read-only enforcement, one prose field, and
 * the fact that nothing is created here.
 */

const DRAFT: PipenzoIssueDraftV1 = {
  schemaVersion: 1,
  title: 'Show an unread badge on the tray icon when a ticket is ready for review',
  acceptanceCriteria: [
    {
      id: 'AC-1',
      kind: 'event',
      text: 'When a ticket reaches ready-for-review, the tray icon shall show an unread badge',
    },
  ],
  outOfScope: ['sounds', 'per-repo settings'],
  estimate: { changedLines: 40, filesTouched: 1, layered: false },
  openQuestions: ['Does the badge clear on open or on read?'],
};

const REQUEST = {
  idea: 'the tray icon never tells me a PR is ready',
  repositoryPath: '/repo',
  provider: 'claude' as const,
};

function drafter(
  outcome: { output?: unknown; toolsUsed?: string[]; throws?: unknown } = {},
  onRequest?: (request: CreateSessionV2Request) => void,
): IssueDrafter {
  const sessions: RefineSessionPort = {
    run: async (request) => {
      onRequest?.(request);
      if (outcome.throws) throw outcome.throws;
      return {
        sessionId: 'draft-session',
        output: 'output' in outcome ? outcome.output : DRAFT,
        toolsUsed: outcome.toolsUsed ?? ['Read', 'Grep'],
      };
    },
  };
  return new IssueDrafter(sessions);
}

async function rejection(fn: () => Promise<unknown>): Promise<IssueDraftError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof IssueDraftError) return error;
    throw error;
  }
  throw new Error('expected an IssueDraftError');
}

describe('IssueDrafter', () => {
  it('turns free text into a validated structured draft', async () => {
    const result = await drafter().draft(REQUEST);
    expect(result).toEqual({ sessionId: 'draft-session', draft: DRAFT });
  });

  /**
   * Drafting is the one moment a model is asked to imagine work that does not exist yet. A write
   * would let it make its own draft true, so the same allowlist Refine is checked against applies
   * here — and a violation fails the draft even though the output was fine.
   */
  it('fails the draft when the session used a tool outside the read-only allowlist', async () => {
    const error = await rejection(() => drafter({ toolsUsed: ['Read', 'Write'] }).draft(REQUEST));
    expect(error.code).toBe('read_only_violation');
    expect(error.details).toContain('Write');
  });

  it('runs under the same read-only allowlist Refine names, and says so in the prompt', async () => {
    let seen: CreateSessionV2Request | undefined;
    await drafter({}, (request) => (seen = request)).draft(REQUEST);
    for (const tool of REFINE_TOOL_ALLOWLIST) expect(seen?.prompt).toContain(tool);
    expect(seen?.prompt).toContain('denies every write');
    expect(seen?.outputSchema).toBeDefined();
  });

  it('refuses an empty idea and an empty repository path before running anything', async () => {
    let ran = false;
    const port = drafter({}, () => (ran = true));
    expect((await rejection(() => port.draft({ ...REQUEST, idea: '   ' }))).code).toBe(
      'invalid_request',
    );
    expect((await rejection(() => port.draft({ ...REQUEST, repositoryPath: '' }))).code).toBe(
      'invalid_request',
    );
    expect(ran).toBe(false);
  });

  it('reports a missing payload as missing, distinctly from a malformed one', async () => {
    expect((await rejection(() => drafter({ output: undefined }).draft(REQUEST))).code).toBe(
      'draft_missing',
    );
    expect(
      (await rejection(() => drafter({ output: { schemaVersion: 1 } }).draft(REQUEST))).code,
    ).toBe('draft_invalid');
  });

  it('reports a session failure as a session failure, not as a bad draft', async () => {
    const error = await rejection(() =>
      drafter({ throws: new Error('provider offline') }).draft(REQUEST),
    );
    expect(error.code).toBe('session_failed');
  });
});

describe('parseIssueDraft', () => {
  /** Same rule `RefineSpecV1` has, for the same reason: what a ticket is not is what bounds it. */
  it('refuses a draft with an empty out-of-scope list', () => {
    expect(() => parseIssueDraft({ ...DRAFT, outOfScope: [] })).toThrow(IssueDraftError);
  });

  it('refuses acceptance criteria that do not follow their declared EARS template', () => {
    expect(() =>
      parseIssueDraft({
        ...DRAFT,
        acceptanceCriteria: [{ id: 'AC-1', kind: 'event', text: 'the badge should appear' }],
      }),
    ).toThrow(IssueDraftError);
  });

  it('refuses duplicate criterion ids', () => {
    const error = (() => {
      try {
        parseIssueDraft({
          ...DRAFT,
          acceptanceCriteria: [DRAFT.acceptanceCriteria[0]!, DRAFT.acceptanceCriteria[0]!],
        });
      } catch (thrown) {
        return thrown as IssueDraftError;
      }
      throw new Error('expected a throw');
    })();
    expect(error.details).toContain('AC-1');
  });

  /** No field for model-written markdown, which is what makes the render-from-data claim hold. */
  it('refuses a payload carrying a prewritten body', () => {
    expect(() => parseIssueDraft({ ...DRAFT, body: '## Acceptance\n\nlooks great' })).toThrow(
      IssueDraftError,
    );
  });
});

describe('buildIssueDraftPrompt', () => {
  it('tells the drafter the title is the only prose it should spend effort on', () => {
    const prompt = buildIssueDraftPrompt('make the tray badge work');
    expect(prompt).toContain('only prose in the draft');
    expect(prompt).toContain('do not write');
  });

  /** The number is checked against a real diff later, and somebody is spending money on it. */
  it('says a flattering estimate costs the reader twice', () => {
    expect(buildIssueDraftPrompt('idea')).toContain('flattering estimate costs them twice');
  });

  it('says plainly that nothing is created from the draft', () => {
    expect(buildIssueDraftPrompt('idea')).toContain('Nothing is created from this');
  });

  it('truncates an oversized idea rather than sending it whole', () => {
    const prompt = buildIssueDraftPrompt('x'.repeat(20_000));
    expect(prompt).toContain('[idea truncated]');
    expect(prompt.length).toBeLessThan(12_000);
  });
});

describe('buildIssueDraftSessionRequest', () => {
  it('reads the repository it was pointed at and carries the structured-output schema', () => {
    const request = buildIssueDraftSessionRequest({ ...REQUEST, model: 'sonnet' });
    expect(request).toMatchObject({ provider: 'claude', cwd: '/repo', model: 'sonnet' });
    expect(request.outputSchema).toBeDefined();
  });
});
