import { describe, expect, it } from 'vitest';
import {
  validateCandidate,
  validateSnapshot,
  type ReconcileCandidate,
  type ReconcileError,
} from '../src/reconcile-input.js';

const provenance = { kind: 'note', ref: 'pasted note' } as const;
const ok = (over: Partial<ReconcileCandidate> = {}): ReconcileCandidate => ({
  title: 'Valid title here',
  provenance,
  ...over,
});
const codeOf = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    return (error as ReconcileError).code;
  }
};
const snap = (issues: unknown[], truncated: unknown = false) => ({ issues, truncated }) as never;

describe('reconcile input validation', () => {
  it('accepts a bounded candidate and snapshot', () => {
    expect(() => validateCandidate(ok())).not.toThrow();
    expect(validateSnapshot(snap([]))).toEqual([]);
  });

  it('rejects a bad candidate with a typed error', () => {
    const bad = [
      ok({ title: '  ' }),
      ok({ title: 'a '.repeat(200) }),
      ok({ provenance: { kind: 'note', ref: '' } }),
      ok({ provenance: { kind: 'bogus', ref: 'x' } as never }),
      ok({ provenance: { kind: 'url', ref: 'x'.repeat(301) } }),
      null as never,
    ];
    for (const c of bad) expect(codeOf(() => validateCandidate(c))).toBe('invalid_candidate');
  });

  it('rejects a malformed snapshot and normalises a good one', () => {
    const good = { number: 3, title: 'T'.repeat(400), state: 'closed' };
    const huge = Array.from({ length: 2_001 }, () => good);
    const bad = [
      snap(huge),
      null as never,
      snap([], 'no'),
      snap([{ ...good, number: Number.NaN }]),
      snap([{ ...good, number: -1 }]),
      snap([{ ...good, title: 5 }]),
      snap([{ ...good, state: 'merged' }]),
    ];
    for (const s of bad) expect(codeOf(() => validateSnapshot(s))).toBe('invalid_snapshot');
    expect(validateSnapshot(snap([good, good]))).toEqual([
      { number: 3, title: 'T'.repeat(300), state: 'closed' },
    ]);
  });

  it('bounds criteria and issue bodies, allowing a null body', () => {
    const many = Array.from({ length: 21 }, () => 'x');
    for (const criteria of [many, ['x'.repeat(301)], [5 as never], 'x' as never])
      expect(codeOf(() => validateCandidate(ok({ criteria })))).toBe('invalid_candidate');
    expect(() => validateCandidate(ok({ criteria: ['fine'] }))).not.toThrow();
    const good = { number: 3, title: 'T', state: 'open' };
    expect(codeOf(() => validateSnapshot(snap([{ ...good, body: 5 }])))).toBe('invalid_snapshot');
    const [long, none] = validateSnapshot(
      snap([
        { ...good, body: 'b'.repeat(5_000) },
        { ...good, number: 4, body: null },
      ]),
    );
    expect(long!.body).toHaveLength(4_000);
    expect(none).toEqual({ number: 4, title: 'T', state: 'open' });
  });
});
