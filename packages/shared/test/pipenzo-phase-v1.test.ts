import { describe, expect, it } from 'vitest';
import {
  IMPLEMENT_SESSION_STATES,
  PIPENZO_PHASE_ERROR_CODES,
  implementSessionStateV1Schema,
  pipenzoImplementCommitsV1Schema,
  pipenzoPhaseErrorV1Schema,
} from '../src/pipenzo-phase-v1.js';

/**
 * Issue #192's first slice: the error code and the terminal-state field the daemon-side detector
 * (a later PR) needs to exist before it can throw or populate either one. No behavior lives here —
 * just the wire contract these tests pin down.
 */

const WORKTREE_ID = '9f8b6c1e-9d3a-4f2b-8b0a-2b6a2f2c9a11';
const BASE_COMMIT = '0'.repeat(40);
const HEAD_COMMIT = '1'.repeat(40);
const COMMIT = '2'.repeat(40);

const baseCommitsPayload = {
  worktreeId: WORKTREE_ID,
  branch: 'pipenzo/issue-192',
  baseCommit: BASE_COMMIT,
  headCommit: HEAD_COMMIT,
  commits: [COMMIT],
} as const;

describe('implementSessionStateV1Schema', () => {
  it('accepts exactly the four states a session can end up in', () => {
    expect(IMPLEMENT_SESSION_STATES).toEqual(['running', 'completed', 'failed', 'cancelled']);
    for (const state of IMPLEMENT_SESSION_STATES) {
      expect(implementSessionStateV1Schema.parse(state)).toBe(state);
    }
  });

  it('refuses a state that is not one of the four', () => {
    for (const bad of ['succeeded', 'done', '', null, undefined]) {
      expect(implementSessionStateV1Schema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});

describe('pipenzoImplementCommitsV1Schema', () => {
  it('round-trips without sessionState -- every existing caller and test omits it', () => {
    expect(pipenzoImplementCommitsV1Schema.parse(baseCommitsPayload)).toEqual(baseCommitsPayload);
  });

  it('round-trips each sessionState value, including the empty-diff shapes', () => {
    for (const sessionState of IMPLEMENT_SESSION_STATES) {
      // 'running' still describes a payload that may have real commits already -- a session can
      // commit nothing (yet) or something before it ends. The other three, paired with an empty
      // commits array and headCommit === baseCommit, are the shape #192's detector watches for.
      const payload = { ...baseCommitsPayload, sessionState };
      expect(pipenzoImplementCommitsV1Schema.parse(payload)).toEqual(payload);

      const empty = {
        ...baseCommitsPayload,
        headCommit: BASE_COMMIT,
        commits: [],
        sessionState,
      };
      expect(pipenzoImplementCommitsV1Schema.parse(empty)).toEqual(empty);
    }
  });

  it('refuses an unrecognized sessionState rather than dropping it', () => {
    const payload = { ...baseCommitsPayload, sessionState: 'succeeded' };
    expect(pipenzoImplementCommitsV1Schema.safeParse(payload).success).toBe(false);
  });

  it('stays strict -- an unknown key is refused, not silently dropped', () => {
    const payload = { ...baseCommitsPayload, sessionState: 'completed', extra: 'nope' };
    expect(pipenzoImplementCommitsV1Schema.safeParse(payload).success).toBe(false);
  });
});

describe('PIPENZO_PHASE_ERROR_CODES', () => {
  it('carries implement_empty_diff exactly once (issue #192)', () => {
    const occurrences = PIPENZO_PHASE_ERROR_CODES.filter((code) => code === 'implement_empty_diff');
    expect(occurrences).toHaveLength(1);
  });

  it('accepts implement_empty_diff on the phase error envelope', () => {
    const error = { code: 'implement_empty_diff', error: 'the session ended without a diff' };
    expect(pipenzoPhaseErrorV1Schema.parse(error)).toEqual(error);
  });
});
