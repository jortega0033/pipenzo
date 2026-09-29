import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CLI_SANDBOX_DISALLOWED_TOOLS,
  CLAUDE_CLI_SANDBOX_TOOLS,
  buildClaudeArgs,
} from '../src/providers/claude/build-args.js';
import { resolveClaudeSdkAuth } from '../src/providers/claude/sdk-auth.js';
import { buildClaudeSdkOptions } from '../src/providers/claude/sdk-options.js';
import { claudeToolEffects } from '../src/providers/claude/sdk/normalizer.js';

/** The SDK transport's locked-down baseline, which the CLI restriction must never be looser than. */
function sdkBaseline() {
  const auth = resolveClaudeSdkAuth({ ANTHROPIC_API_KEY: 'api-key-canary' });
  if (!auth.eligible) throw new Error('test setup failed');
  return buildClaudeSdkOptions({
    cwd: resolve('workspace'),
    env: { ANTHROPIC_API_KEY: 'api-key-canary' },
    auth,
    trustState: 'trusted',
    daemonConfigRoot: resolve('daemon-owned-config'),
    sessionId: 'session-1',
  });
}

describe('buildClaudeArgs — sandbox-pinned sessions are restricted at launch', () => {
  const base = { sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi' };

  it('restricts a read-only session to read tools, fail-closed, with no settings or MCP', () => {
    expect(buildClaudeArgs({ ...base, sandbox: 'read-only' })).toEqual([
      '-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose',
      '--session-id', 'sess-1',
      '--restricted',
      '--tools', 'Read,Grep,Glob',
      '--disallowedTools', 'Bash,PowerShell,Agent,Task,Skill,WebFetch,WebSearch,NotebookEdit',
      '--permission-mode', 'dontAsk',
      '--setting-sources=',
      '--strict-mcp-config',
    ]);
  });

  it('gives a workspace-write session file edits and nothing that runs or reaches out', () => {
    const args = buildClaudeArgs({ ...base, sandbox: 'workspace-write' });
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Edit,Write');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    // Confines Write to the working directory: without it, Claude Code's auto-memory directory
    // (loaded into the operator's later, unrestricted sessions) is writable.
    expect(args).toContain('--restricted');
    expect(args).toContain('--setting-sources=');
    expect(args).toContain('--strict-mcp-config');
  });

  it('keeps the restriction on a resumed session too', () => {
    const args = buildClaudeArgs({ ...base, sandbox: 'read-only', resumeProviderSessionId: 't-1' });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
  });

  it('grants only tools the SDK baseline trusts and classifies as complete read/write effects', () => {
    const sdkTools = sdkBaseline().tools as string[];
    for (const tool of CLAUDE_CLI_SANDBOX_TOOLS['workspace-write']) {
      expect(sdkTools).toContain(tool);
      const effects = claudeToolEffects(tool);
      expect(effects.effectsComplete).toBe(true);
      expect(effects.possibleEffects.every((e) => e === 'read' || e === 'filesystem_write')).toBe(
        true,
      );
    }
    for (const tool of CLAUDE_CLI_SANDBOX_TOOLS['read-only']) {
      expect(claudeToolEffects(tool).possibleEffects).toEqual(['read']);
    }
  });

  it('denies at least everything the SDK baseline denies', () => {
    const sdkDisallowed = sdkBaseline().disallowedTools as string[];
    for (const tool of sdkDisallowed) expect(CLAUDE_CLI_SANDBOX_DISALLOWED_TOOLS).toContain(tool);
  });

  it('leaves an unpinned session exactly as it was', () => {
    expect(buildClaudeArgs(base)).not.toContain('--tools');
  });
});

describe('buildClaudeArgs — prompt transport (AD-05)', () => {
  it('never includes the prompt anywhere in the returned argv', () => {
    const prompt = 'this exact string must never appear in argv, not even split across elements';
    const args = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt });
    expect(args.join(' ')).not.toContain(prompt);
    expect(args).not.toContain(prompt);
  });

  it('never includes the prompt when resuming either', () => {
    const prompt = 'a resumed-session prompt that must also stay out of argv';
    const args = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt, resumeProviderSessionId: 'thread-1' });
    expect(args.join(' ')).not.toContain(prompt);
  });

  it('still passes -p, explicit --input-format text, and the session-id/resume flags', () => {
    const fresh = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi' });
    expect(fresh).toEqual(['-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--session-id', 'sess-1']);

    const resumed = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', resumeProviderSessionId: 'thread-1' });
    expect(resumed).toEqual(['-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--resume', 'thread-1']);
  });

  it('does not change shape based on prompt length — a huge prompt is still absent from argv', () => {
    const hugePrompt = 'x'.repeat(500_000); // well beyond Windows' ~32,767-char argv limit
    const args = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: hugePrompt });
    expect(args.join('').length).toBeLessThan(200); // just the flags, nowhere near the prompt size
  });
});
