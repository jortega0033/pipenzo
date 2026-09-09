import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REFINE_SPEC_V1_JSON_SCHEMA,
  createSessionV2RequestSchema,
  permissionActionV2Schema,
  type CreateSessionV2Request,
  type PermissionActionV2,
  type RefineSpecV1,
} from '@agent-dock/shared';
import {
  REFINE_TOOL_ALLOWLIST,
  RefinePhaseError,
  RefineSubagent,
  assertRefineToolsOnly,
  buildRefineSessionRequest,
  evaluateRefinePermission,
  isRefineTool,
  parseRefineSpec,
  type RefineSessionOutcome,
  type RefineSessionPort,
} from '../src/refine-subagent.js';
import { validateStructuredOutput } from '../src/structured-output.js';

const runtimeSrc = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'agent-runtime',
  'src',
);

const ISSUE = {
  repo: 'jortega0033/pipenzo',
  number: 179,
  title: 'Backend: Refine subagent (read-only by construction)',
  body: 'A session whose tool definition contains no write capability.',
};

function validSpec(overrides: Partial<RefineSpecV1> = {}): RefineSpecV1 {
  return {
    schemaVersion: 1,
    issue: { repo: ISSUE.repo, number: ISSUE.number, title: ISSUE.title },
    summary: 'Add a read-only Refine phase that turns one issue into a structured spec.',
    acceptanceCriteria: [
      { id: 'AC-1', kind: 'ubiquitous', text: 'The refine phase shall emit a v1 spec.' },
      {
        id: 'AC-2',
        kind: 'unwanted',
        text: 'If the session invokes a write tool, then the daemon shall deny the action.',
      },
      {
        id: 'AC-3',
        kind: 'event',
        text: 'When the spec is produced, the daemon shall validate it against the v1 schema.',
      },
    ],
    outOfScope: ['Enforcing the diff-size gate', 'Model-tier routing'],
    filesLikelyTouched: ['apps/daemon/src/refine-subagent.ts', 'packages/shared/src/pipenzo-refine-v1.ts'],
    estimate: { changedLines: 320, filesTouched: 4, layered: false },
    openQuestions: [],
    ...overrides,
  };
}

function action(overrides: Partial<PermissionActionV2>): PermissionActionV2 {
  return permissionActionV2Schema.parse({
    actionClass: 'filesystem',
    operation: 'filesystem.read',
    targetFingerprint: 'a'.repeat(64),
    safeTargetSummary: 'filesystem:filesystem.read',
    risk: 'normal',
    effectsComplete: true,
    mcpDestructive: false,
    ...overrides,
  });
}

function port(outcome: Partial<RefineSessionOutcome> = {}): {
  port: RefineSessionPort;
  requests: CreateSessionV2Request[];
} {
  const requests: CreateSessionV2Request[] = [];
  return {
    requests,
    port: {
      run: async (request) => {
        requests.push(request);
        return {
          sessionId: '33333333-4444-4555-8666-777777777777',
          output: validSpec(),
          toolsUsed: ['Read', 'Grep'],
          ...outcome,
        };
      },
    },
  };
}

async function refineError(fn: () => Promise<unknown>): Promise<RefinePhaseError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof RefinePhaseError) return error;
    throw error;
  }
  throw new Error('expected a RefinePhaseError');
}

function syncRefineError(fn: () => unknown): RefinePhaseError {
  try {
    fn();
  } catch (error) {
    if (error instanceof RefinePhaseError) return error;
    throw error;
  }
  throw new Error('expected a RefinePhaseError');
}

describe('the refine allowlist is read-only, checked against agentdock rather than asserted', () => {
  it('is a strict subset of agentdock\u2019s own trusted tool set', () => {
    const options = readFileSync(join(runtimeSrc, 'providers', 'claude', 'sdk-options.ts'), 'utf8');
    const block = /TRUSTED_TOOLS = Object\.freeze\(\[([\s\S]*?)\]/.exec(options)?.[1] ?? '';
    const trusted = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(trusted.length).toBeGreaterThan(REFINE_TOOL_ALLOWLIST.length);
    for (const tool of REFINE_TOOL_ALLOWLIST) expect(trusted).toContain(tool);
    // The property that matters: every write tool agentdock trusts is absent from ours.
    for (const writeTool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(REFINE_TOOL_ALLOWLIST as readonly string[]).not.toContain(writeTool);
    }
  });

  it('contains only tools agentdock itself classifies as producing a read effect', () => {
    const normalizer = readFileSync(join(runtimeSrc, 'providers', 'claude', 'sdk', 'normalizer.ts'), 'utf8');
    const readBlock = /if \(\[([^\]]*)\]\.includes\(name\)\) \{\s*return \{ possibleEffects: \['read'\]/.exec(
      normalizer,
    )?.[1];
    expect(readBlock).toBeDefined();
    const readTools = [...(readBlock ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
    for (const tool of REFINE_TOOL_ALLOWLIST) expect(readTools).toContain(tool);
  });

  it('recognizes exactly its own members', () => {
    expect(isRefineTool('Read')).toBe(true);
    for (const tool of ['Write', 'Edit', 'Bash', 'WebFetch', 'read', 'READ', '']) {
      expect(isRefineTool(tool)).toBe(false);
    }
  });
});

describe('evaluateRefinePermission is the gate, and it is fail-closed', () => {
  it('allows exactly one thing: a complete filesystem read', () => {
    expect(evaluateRefinePermission(action({}))).toEqual({ outcome: 'allow', reason: 'read_only' });
  });

  it('denies a filesystem write, and a read whose effects the daemon could not fully enumerate', () => {
    expect(evaluateRefinePermission(action({ operation: 'filesystem.write' }))).toMatchObject({
      outcome: 'deny',
      reason: 'filesystem_write',
    });
    expect(
      evaluateRefinePermission(action({ effectsComplete: false, risk: 'unknown' })),
    ).toMatchObject({ outcome: 'deny', reason: 'filesystem_write' });
  });

  it('denies every non-filesystem action class', () => {
    const cases: Array<[Partial<PermissionActionV2>, string]> = [
      [{ actionClass: 'command', operation: 'command.execute' }, 'command'],
      [{ actionClass: 'network', operation: 'network.access' }, 'network'],
      [{ actionClass: 'mcp', operation: 'mcp.invoke' }, 'mcp'],
      [
        { actionClass: 'external_side_effect', operation: 'external.perform' },
        'external_side_effect',
      ],
      [
        { actionClass: 'other', operation: 'other.unknown', risk: 'unknown', effectsComplete: false },
        'unclassifiable',
      ],
    ];
    for (const [overrides, reason] of cases) {
      expect(evaluateRefinePermission(action(overrides))).toEqual({ outcome: 'deny', reason });
    }
  });

  it('denies anything destructive before it looks at the action class at all', () => {
    expect(evaluateRefinePermission(action({ risk: 'destructive' }))).toEqual({
      outcome: 'deny',
      reason: 'destructive',
    });
    expect(
      evaluateRefinePermission(
        action({ actionClass: 'mcp', operation: 'mcp.invoke', risk: 'destructive', mcpDestructive: true }),
      ),
    ).toEqual({ outcome: 'deny', reason: 'destructive' });
  });

  it('has exactly one branch that can return allow', () => {
    const source = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'refine-subagent.ts'),
      'utf8',
    );
    const gate = /export function evaluateRefinePermission[\s\S]*?\n}/.exec(source)?.[0] ?? '';
    expect(gate).not.toBe('');
    expect(gate.match(/outcome: 'allow'/g)).toHaveLength(1);
  });
});

describe('assertRefineToolsOnly', () => {
  it('accepts the allowlist and an empty run', () => {
    expect(() => assertRefineToolsOnly(['Read', 'Glob', 'Grep', 'Read'])).not.toThrow();
    expect(() => assertRefineToolsOnly([])).not.toThrow();
  });

  it('fails the phase with the violating tools as evidence, deduplicated', () => {
    const error = syncRefineError(() => assertRefineToolsOnly(['Read', 'Write', 'Bash', 'Write']));
    expect(error.code).toBe('read_only_violation');
    expect(error.details).toEqual(['Bash', 'Write']);
  });
});

describe('buildRefineSessionRequest', () => {
  it('produces a request agentdock\u2019s own session schema accepts', () => {
    const request = buildRefineSessionRequest({
      issue: ISSUE,
      cwd: process.cwd(),
      provider: 'claude',
      model: 'claude-sonnet-4-5',
    });
    const parsed = createSessionV2RequestSchema.safeParse(request);
    expect(parsed.success).toBe(true);
    expect(request.outputSchema).toBe(REFINE_SPEC_V1_JSON_SCHEMA);
    expect(request.model).toBe('claude-sonnet-4-5');
  });

  it('carries the issue and names the allowlist in the prompt', () => {
    const request = buildRefineSessionRequest({ issue: ISSUE, cwd: process.cwd(), provider: 'codex' });
    expect(request.prompt).toContain('jortega0033/pipenzo#179');
    expect(request.prompt).toContain(ISSUE.body);
    for (const tool of REFINE_TOOL_ALLOWLIST) expect(request.prompt).toContain(tool);
    expect(request.prompt).toContain('EARS');
    expect(request.model).toBeUndefined();
  });

  /**
   * Found by the first live run, not by any unit test here: the prompt described the spec in prose
   * and the prose was missing three of the schema's required fields (`schemaVersion`, `issue`, and
   * the per-criterion `id`), so a well-behaved model returned a payload `refineSpecV1Schema`
   * rejected. Every test in this file fed a hand-written valid spec through a fake session port,
   * which is exactly why none of them could see it.
   *
   * It matters because `AwaitedPhaseSessions` dispatches these on the legacy session path, where
   * `outputSchema` is *not* enforced by the provider — the prompt is the only thing telling the
   * model what the schema requires. So the prompt has to name every required key.
   */
  it('names every field the spec schema requires, since the prompt is the only enforcement', () => {
    const { prompt } = buildRefineSessionRequest({
      issue: ISSUE,
      cwd: process.cwd(),
      provider: 'codex',
    });
    for (const key of REFINE_SPEC_V1_JSON_SCHEMA.required) expect(prompt).toContain(key);
    // The two the prose used to leave to the schema: the literal version, the issue identity, and
    // the criterion id format a generated test or a review finding cites.
    expect(prompt).toContain('the integer 1');
    expect(prompt).toContain(`"number": ${ISSUE.number}`);
    expect(prompt).toContain('"AC-1"');
  });

  it('truncates an oversized issue body rather than blowing the prompt bound', () => {
    const request = buildRefineSessionRequest({
      issue: { ...ISSUE, body: 'x'.repeat(200_000) },
      cwd: process.cwd(),
      provider: 'claude',
    });
    expect(request.prompt).toContain('[issue body truncated]');
    expect(createSessionV2RequestSchema.safeParse(request).success).toBe(true);
  });

  it('refuses an issue or a working directory it cannot use', () => {
    const cases = [
      { issue: { ...ISSUE, repo: '  ' }, cwd: process.cwd(), provider: 'claude' as const },
      { issue: { ...ISSUE, number: 0 }, cwd: process.cwd(), provider: 'claude' as const },
      { issue: { ...ISSUE, title: '' }, cwd: process.cwd(), provider: 'claude' as const },
      { issue: ISSUE, cwd: '', provider: 'claude' as const },
    ];
    for (const input of cases) {
      expect(syncRefineError(() => buildRefineSessionRequest(input)).code).toBe('invalid_issue');
    }
  });
});

describe('the spec contract', () => {
  it('agrees between its Zod and JSON Schema representations', () => {
    const spec = validSpec();
    expect(validateStructuredOutput(REFINE_SPEC_V1_JSON_SCHEMA, spec)).toMatchObject({ valid: true });
    expect(() => parseRefineSpec(spec)).not.toThrow();

    // Both reject the same shape: an unknown key.
    const extra = { ...spec, unexpected: true };
    expect(validateStructuredOutput(REFINE_SPEC_V1_JSON_SCHEMA, extra).valid).toBe(false);
    expect(syncRefineError(() => parseRefineSpec(extra)).code).toBe('spec_invalid');
  });

  /**
   * Issue #271: `proposedSplit` is optional on both sides and absent from `validSpec()`'s own
   * fixture, so the test above already proves the two schemas agree when it's missing. This proves
   * they agree when it's present too, and that both reject an empty array (a "split" into zero parts
   * is not a split) and a malformed part the same way.
   */
  it('agrees on the optional proposedSplit field too', () => {
    const withSplit = validSpec({
      proposedSplit: [
        { summary: 'Extract the shared validation helper', changedLines: 80, filesTouched: 2 },
        { summary: 'Wire the new endpoint through it', changedLines: 140, filesTouched: 5 },
      ],
    });
    expect(validateStructuredOutput(REFINE_SPEC_V1_JSON_SCHEMA, withSplit)).toMatchObject({
      valid: true,
    });
    expect(() => parseRefineSpec(withSplit)).not.toThrow();

    const emptySplit = validSpec({ proposedSplit: [] });
    expect(validateStructuredOutput(REFINE_SPEC_V1_JSON_SCHEMA, emptySplit).valid).toBe(false);
    expect(syncRefineError(() => parseRefineSpec(emptySplit)).code).toBe('spec_invalid');

    const malformedPart = validSpec({
      // @ts-expect-error -- deliberately missing `filesTouched` to exercise the nested-object check
      proposedSplit: [{ summary: 'Missing a required field', changedLines: 10 }],
    });
    expect(validateStructuredOutput(REFINE_SPEC_V1_JSON_SCHEMA, malformedPart).valid).toBe(false);
    expect(syncRefineError(() => parseRefineSpec(malformedPart)).code).toBe('spec_invalid');
  });

  it('enforces the EARS template for each declared kind', () => {
    const bad = validSpec({
      acceptanceCriteria: [
        { id: 'AC-1', kind: 'event', text: 'The refine phase shall emit a spec.' },
      ],
    });
    const error = syncRefineError(() => parseRefineSpec(bad));
    expect(error.code).toBe('spec_invalid');
    expect(error.details.join(' ')).toContain('EARS template');
  });

  it('accepts every EARS kind written to its own template', () => {
    const spec = validSpec({
      acceptanceCriteria: [
        { id: 'AC-1', kind: 'ubiquitous', text: 'The daemon shall record the estimate.' },
        { id: 'AC-2', kind: 'event', text: 'When refine completes, the daemon shall store the spec.' },
        { id: 'AC-3', kind: 'state', text: 'While refine runs, the daemon shall deny write actions.' },
        { id: 'AC-4', kind: 'option', text: 'Where a symbol graph exists, the phase shall use it.' },
        { id: 'AC-5', kind: 'unwanted', text: 'If the spec is invalid, then the daemon shall fail the phase.' },
        {
          id: 'AC-6',
          kind: 'complex',
          text: 'While refine runs, when a write is attempted, then the daemon shall deny it.',
        },
      ],
    });
    expect(() => parseRefineSpec(spec)).not.toThrow();
  });

  it('requires a non-empty out-of-scope list, because that is what bounds the diff', () => {
    expect(syncRefineError(() => parseRefineSpec(validSpec({ outOfScope: [] }))).code).toBe(
      'spec_invalid',
    );
  });

  it('rejects an absolute or traversing path in filesLikelyTouched', () => {
    for (const path of ['/etc/passwd', 'C:/Windows/system32', '../../secrets.env', 'src\\index.ts']) {
      expect(
        syncRefineError(() => parseRefineSpec(validSpec({ filesLikelyTouched: [path] }))).code,
      ).toBe('spec_invalid');
    }
  });

  it('rejects a spec whose estimate contradicts its own file list', () => {
    const error = syncRefineError(() =>
      parseRefineSpec(
        validSpec({
          filesLikelyTouched: ['a.ts', 'b.ts', 'c.ts'],
          estimate: { changedLines: 40, filesTouched: 2, layered: false },
        }),
      ),
    );
    expect(error.code).toBe('spec_invalid');
    expect(error.message).toContain('fewer files than it lists');
  });

  it('rejects duplicate acceptance criterion ids', () => {
    const error = syncRefineError(() =>
      parseRefineSpec(
        validSpec({
          acceptanceCriteria: [
            { id: 'AC-1', kind: 'ubiquitous', text: 'The daemon shall do one thing.' },
            { id: 'AC-1', kind: 'ubiquitous', text: 'The daemon shall do another thing.' },
          ],
        }),
      ),
    );
    expect(error.code).toBe('spec_invalid');
    expect(error.details).toEqual(['AC-1']);
  });

  it('reports missing structured output distinctly from invalid structured output', () => {
    expect(syncRefineError(() => parseRefineSpec(undefined)).code).toBe('spec_missing');
    expect(syncRefineError(() => parseRefineSpec(null)).code).toBe('spec_missing');
    expect(syncRefineError(() => parseRefineSpec('not an object')).code).toBe('spec_invalid');
  });

  it('carries the estimate build step 4\u2019s gate will read', () => {
    const spec = parseRefineSpec(validSpec());
    expect(spec.estimate).toEqual({ changedLines: 320, filesTouched: 4, layered: false });
  });
});

describe('RefineSubagent', () => {
  it('runs a session and returns a validated spec', async () => {
    const { port: sessions, requests } = port();
    const result = await new RefineSubagent(sessions).refine({
      issue: ISSUE,
      cwd: process.cwd(),
      provider: 'claude',
    });
    expect(result.spec.issue.number).toBe(179);
    expect(result.toolsUsed).toEqual(['Read', 'Grep']);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.outputSchema).toBe(REFINE_SPEC_V1_JSON_SCHEMA);
  });

  it('reports a read-only violation even when the spec itself is perfectly valid', async () => {
    const { port: sessions } = port({ toolsUsed: ['Read', 'Write'] });
    const error = await refineError(() =>
      new RefineSubagent(sessions).refine({ issue: ISSUE, cwd: process.cwd(), provider: 'claude' }),
    );
    expect(error.code).toBe('read_only_violation');
    expect(error.details).toEqual(['Write']);
  });

  it('surfaces an invalid spec as spec_invalid, not as a session failure', async () => {
    const { port: sessions } = port({ output: { schemaVersion: 1 } });
    expect(
      (
        await refineError(() =>
          new RefineSubagent(sessions).refine({ issue: ISSUE, cwd: process.cwd(), provider: 'claude' }),
        )
      ).code,
    ).toBe('spec_invalid');
  });

  it('wraps a session-layer failure as session_failed', async () => {
    const sessions: RefineSessionPort = {
      run: async () => {
        throw new Error('provider transport unavailable');
      },
    };
    const error = await refineError(() =>
      new RefineSubagent(sessions).refine({ issue: ISSUE, cwd: process.cwd(), provider: 'claude' }),
    );
    expect(error.code).toBe('session_failed');
    expect(error.message).toContain('provider transport unavailable');
  });
});
