import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, splitPath } from '../../src/pipenzo/diff-parser.js';

const SAMPLE_DIFF = [
  'diff --git a/packages/agent-runtime/src/mcp/stdio-mcp-connection.ts b/packages/agent-runtime/src/mcp/stdio-mcp-connection.ts',
  'index 1111111..2222222 100644',
  '--- a/packages/agent-runtime/src/mcp/stdio-mcp-connection.ts',
  '+++ b/packages/agent-runtime/src/mcp/stdio-mcp-connection.ts',
  '@@ -3,6 +3,7 @@',
  " import { StdioJsonRpcTransport } from './stdio-json-rpc-transport';",
  "+import { buildBaseProcessEnvironment } from '../process/base-environment';",
  ' import type { McpSpawnConfig } from \'./types\';',
  '@@ -71,7 +72,10 @@ export class StdioMcpConnection {',
  '     this.transport = new StdioJsonRpcTransport(spawnConfig.command, spawnConfig.args, {',
  '       cwd: spawnConfig.cwd,',
  '-      env: spawnConfig.env ? { ...process.env, ...spawnConfig.env } : undefined,',
  '+      env: { ...buildBaseProcessEnvironment(), ...(spawnConfig.env ?? {}) },',
  '     });',
  'diff --git a/apps/desktop/test/new-file.test.ts b/apps/desktop/test/new-file.test.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/apps/desktop/test/new-file.test.ts',
  '@@ -0,0 +1,2 @@',
  "+it('does something', () => {});",
  '+// trailing comment',
  '\\ No newline at end of file',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('splits a diff into one entry per file, in order', () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    expect(files.map((file) => file.path)).toEqual([
      'packages/agent-runtime/src/mcp/stdio-mcp-connection.ts',
      'apps/desktop/test/new-file.test.ts',
    ]);
  });

  it('counts additions and deletions per file across all of its hunks', () => {
    const [first] = parseUnifiedDiff(SAMPLE_DIFF);
    expect(first).toMatchObject({ additions: 2, deletions: 1 });
  });

  it('splits a file into its hunks, each carrying its own @@ header verbatim', () => {
    const [first] = parseUnifiedDiff(SAMPLE_DIFF);
    expect(first?.hunks).toHaveLength(2);
    expect(first?.hunks[0]?.header).toBe('@@ -3,6 +3,7 @@');
    expect(first?.hunks[1]?.header).toBe('@@ -71,7 +72,10 @@ export class StdioMcpConnection {');
  });

  it('classifies and numbers context, add and del lines correctly on both old and new sides', () => {
    const [first] = parseUnifiedDiff(SAMPLE_DIFF);
    const hunk = first?.hunks[0];
    expect(hunk?.lines).toEqual([
      {
        kind: 'context',
        oldLineNumber: 3,
        newLineNumber: 3,
        content: "import { StdioJsonRpcTransport } from './stdio-json-rpc-transport';",
      },
      {
        kind: 'add',
        newLineNumber: 4,
        content: "import { buildBaseProcessEnvironment } from '../process/base-environment';",
      },
      {
        kind: 'context',
        oldLineNumber: 4,
        newLineNumber: 5,
        content: "import type { McpSpawnConfig } from './types';",
      },
    ]);
  });

  it('numbers a del line on the old side only and an add line on the new side only', () => {
    const [first] = parseUnifiedDiff(SAMPLE_DIFF);
    const hunk = first?.hunks[1];
    const del = hunk?.lines.find((line) => line.kind === 'del');
    const add = hunk?.lines.find((line) => line.kind === 'add');
    expect(del?.oldLineNumber).toBe(73);
    expect(del?.newLineNumber).toBeUndefined();
    expect(add?.newLineNumber).toBe(74);
    expect(add?.oldLineNumber).toBeUndefined();
  });

  it('treats a --- /dev/null pair as a new file with no old path', () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    const created = files[1];
    expect(created?.oldPath).toBeUndefined();
    expect(created?.newPath).toBe('apps/desktop/test/new-file.test.ts');
  });

  it('drops the "\\ No newline at end of file" marker rather than rendering it as a line', () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    const created = files[1];
    expect(created?.hunks[0]?.lines).toHaveLength(2);
  });

  it('returns an empty list for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

describe('splitPath', () => {
  it('splits a nested path into a trailing-slash directory and a bare file name', () => {
    expect(splitPath('packages/agent-runtime/src/mcp/stdio-mcp-connection.ts')).toEqual({
      dir: 'packages/agent-runtime/src/mcp/',
      name: 'stdio-mcp-connection.ts',
    });
  });

  it('returns an empty directory for a top-level file', () => {
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' });
  });
});
