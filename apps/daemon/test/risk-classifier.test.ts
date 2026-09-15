import { describe, expect, it } from 'vitest';
import type { PermissionActionV2 } from '@agent-dock/shared';
import {
  classifyRisk,
  isInsideWorktree,
  matchesSensitivePath,
  type RiskClassificationInput,
} from '../src/risk-classifier.js';

const WORKTREE = process.platform === 'win32' ? 'C:\\owned\\issue-157' : '/owned/issue-157';

function pathIn(...segments: string[]): string {
  return [WORKTREE, ...segments].join(process.platform === 'win32' ? '\\' : '/');
}

function action(overrides: Partial<PermissionActionV2> = {}): PermissionActionV2 {
  return {
    actionClass: 'filesystem',
    operation: 'filesystem.write',
    targetFingerprint: 'x'.repeat(64),
    safeTargetSummary: 'filesystem:filesystem.write',
    risk: 'normal',
    effectsComplete: true,
    mcpDestructive: false,
    ...overrides,
  };
}

function classify(overrides: Partial<RiskClassificationInput> = {}): ReturnType<typeof classifyRisk> {
  return classifyRisk({
    action: action(),
    targetPath: pathIn('src', 'index.ts'),
    worktreeRoot: WORKTREE,
    ...overrides,
  });
}

describe('classifyRisk', () => {
  it('grades a normal-risk filesystem edit inside the worktree as LOW', () => {
    expect(classify()).toBe('low');
  });

  it('grades a normal-risk command execution inside the worktree as LOW', () => {
    expect(classify({ action: action({ actionClass: 'command', operation: 'command.execute' }) })).toBe(
      'low',
    );
  });

  it('grades external_side_effect as HIGH regardless of risk', () => {
    expect(
      classify({
        action: action({ actionClass: 'external_side_effect', operation: 'external.perform', risk: 'normal' }),
      }),
    ).toBe('high');
  });

  it('grades a destructive MCP tool as HIGH', () => {
    expect(
      classify({
        action: action({ actionClass: 'mcp', operation: 'mcp.invoke', mcpDestructive: true, risk: 'destructive' }),
      }),
    ).toBe('high');
  });

  it('does not grade a non-destructive MCP tool as HIGH on that basis alone', () => {
    expect(
      classify({
        action: action({ actionClass: 'mcp', operation: 'mcp.invoke', mcpDestructive: false }),
        targetPath: pathIn('src', 'mcp-tool.ts'),
      }),
    ).toBe('medium');
  });

  it('grades a path under a security/ directory as HIGH even for an otherwise-LOW-shaped action', () => {
    expect(classify({ targetPath: pathIn('apps', 'daemon', 'src', 'security', 'token-guard.ts') })).toBe(
      'high',
    );
  });

  it('grades a path under an auth/ directory as HIGH', () => {
    expect(classify({ targetPath: pathIn('apps', 'desktop', 'electron', 'auth', 'device-flow.ts') })).toBe(
      'high',
    );
  });

  it('grades a path under a migrations/ directory as HIGH', () => {
    expect(classify({ targetPath: pathIn('packages', 'shared', 'migrations', '0007_add_risk.sql') })).toBe(
      'high',
    );
  });

  it('grades a filename containing "auth" as HIGH even outside a directory named auth/', () => {
    expect(classify({ targetPath: pathIn('apps', 'daemon', 'src', 'github-auth-client.ts') })).toBe('high');
  });

  it('does not false-positive HIGH on a path merely containing "auth" as a substring, like "authority"', () => {
    // "authority-list.ts" contains "auth" as a substring, but its right edge ("o") isn't a
    // boundary character, so the sensitive-path check correctly doesn't match it. The path is
    // still a normal-risk filesystem edit inside the worktree, so it correctly grades LOW here --
    // the point of this test is that it's *not* HIGH, not that it's specifically MEDIUM.
    expect(classify({ targetPath: pathIn('src', 'authority-list.ts') })).toBe('low');
  });

  it('grades a normal-risk filesystem action outside the worktree as MEDIUM, not LOW', () => {
    const outside =
      process.platform === 'win32' ? 'C:\\elsewhere\\other-file.ts' : '/elsewhere/other-file.ts';
    expect(classify({ targetPath: outside })).toBe('medium');
  });

  it('grades a destructive-risk filesystem action inside the worktree as MEDIUM, not LOW', () => {
    expect(classify({ action: action({ risk: 'destructive' }) })).toBe('medium');
  });

  it('grades an unknown-risk action as MEDIUM', () => {
    expect(classify({ action: action({ risk: 'unknown' }) })).toBe('medium');
  });

  it('grades a network action as MEDIUM (LOW is scoped to filesystem/command only)', () => {
    expect(
      classify({ action: action({ actionClass: 'network', operation: 'network.access' }) }),
    ).toBe('medium');
  });

  it('grades an action with no target path as MEDIUM, never LOW', () => {
    expect(classify({ targetPath: undefined })).toBe('medium');
  });

  it('grades actionClass "other" as MEDIUM', () => {
    expect(classify({ action: action({ actionClass: 'other', operation: 'other.unknown' }) })).toBe(
      'medium',
    );
  });
});

describe('isInsideWorktree', () => {
  it('accepts a path directly inside the root', () => {
    expect(isInsideWorktree(WORKTREE, pathIn('src', 'index.ts'))).toBe(true);
  });

  it('accepts the root itself', () => {
    expect(isInsideWorktree(WORKTREE, WORKTREE)).toBe(true);
  });

  it('rejects a sibling directory that merely shares a string prefix', () => {
    const sibling = process.platform === 'win32' ? 'C:\\owned\\issue-157-other' : '/owned/issue-157-other';
    expect(isInsideWorktree(WORKTREE, sibling)).toBe(false);
  });

  it('rejects a path that escapes the root via ..', () => {
    const escaped =
      process.platform === 'win32' ? 'C:\\owned\\issue-157\\..\\..\\etc\\passwd' : '/owned/issue-157/../../etc/passwd';
    expect(isInsideWorktree(WORKTREE, escaped)).toBe(false);
  });
});

describe('matchesSensitivePath', () => {
  it('matches on Windows-style backslash paths identically to POSIX', () => {
    expect(matchesSensitivePath('C:\\repo\\src\\auth\\login.ts')).toBe(true);
    expect(matchesSensitivePath('/repo/src/auth/login.ts')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesSensitivePath('/repo/SECURITY/policy.ts')).toBe(true);
  });

  it('does not match an unrelated path', () => {
    expect(matchesSensitivePath('/repo/src/components/Button.tsx')).toBe(false);
  });

  it('does not match a substring like "authority" that merely contains "auth"', () => {
    expect(matchesSensitivePath('/repo/src/authority-list.ts')).toBe(false);
  });

  it('matches "auth" as a kebab-case token inside a longer filename', () => {
    expect(matchesSensitivePath('/repo/apps/daemon/src/github-auth-client.ts')).toBe(true);
  });
});
