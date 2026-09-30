import { describe, expect, it } from 'vitest';
import {
  PipenzoExecutionLimiter,
  PipenzoExecutionLimiterError,
} from '../src/pipenzo-execution-limiter.js';

describe('PipenzoExecutionLimiter', () => {
  it('defaults to a limit of 2 when constructed with no argument', () => {
    expect(new PipenzoExecutionLimiter().limit).toBe(2);
  });

  it('rejects construction with an out-of-range or non-integer limit', () => {
    expect(() => new PipenzoExecutionLimiter(0)).toThrow(RangeError);
    expect(() => new PipenzoExecutionLimiter(5)).toThrow(RangeError);
    expect(() => new PipenzoExecutionLimiter(2.5)).toThrow(RangeError);
    expect(() => new PipenzoExecutionLimiter(-1)).toThrow(RangeError);
  });

  it('accepts every value in the documented 1..4 range', () => {
    expect(new PipenzoExecutionLimiter(1).limit).toBe(1);
    expect(new PipenzoExecutionLimiter(4).limit).toBe(4);
  });

  it('admits up to the configured limit and refuses the next with PipenzoExecutionLimiterError', () => {
    const limiter = new PipenzoExecutionLimiter(2);
    expect(limiter.running).toBe(0);
    const first = limiter.acquire();
    const second = limiter.acquire();
    expect(limiter.running).toBe(2);
    expect(() => limiter.acquire()).toThrow(PipenzoExecutionLimiterError);
    expect(limiter.running).toBe(2);
    first.release();
    second.release();
  });

  it('carries the execution_limit_exceeded code for HTTP/phase-error mapping', () => {
    const limiter = new PipenzoExecutionLimiter(1);
    limiter.acquire();
    try {
      limiter.acquire();
      throw new Error('expected acquire() to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PipenzoExecutionLimiterError);
      expect((error as PipenzoExecutionLimiterError).code).toBe('execution_limit_exceeded');
    }
  });

  it('makes a slot immediately reusable after release', () => {
    const limiter = new PipenzoExecutionLimiter(1);
    const lease = limiter.acquire();
    expect(() => limiter.acquire()).toThrow(PipenzoExecutionLimiterError);
    lease.release();
    expect(limiter.running).toBe(0);
    const next = limiter.acquire();
    expect(limiter.running).toBe(1);
    next.release();
  });

  it('is idempotent: releasing the same lease twice never double-frees a slot', () => {
    const limiter = new PipenzoExecutionLimiter(1);
    const lease = limiter.acquire();
    lease.release();
    lease.release();
    expect(limiter.running).toBe(0);
    const a = limiter.acquire();
    expect(() => limiter.acquire()).toThrow(PipenzoExecutionLimiterError);
    a.release();
  });

  describe('setLimit', () => {
    it('changes the ceiling with immediate effect', () => {
      const limiter = new PipenzoExecutionLimiter(1);
      limiter.acquire();
      expect(() => limiter.acquire()).toThrow(PipenzoExecutionLimiterError);
      limiter.setLimit(2);
      expect(limiter.limit).toBe(2);
      const second = limiter.acquire();
      expect(limiter.running).toBe(2);
      second.release();
    });

    it('rejects an out-of-range value without changing the current limit', () => {
      const limiter = new PipenzoExecutionLimiter(2);
      expect(() => limiter.setLimit(5)).toThrow(RangeError);
      expect(() => limiter.setLimit(0)).toThrow(RangeError);
      expect(limiter.limit).toBe(2);
    });

    it('never evicts a session already holding a slot when lowered below the running count', () => {
      const limiter = new PipenzoExecutionLimiter(4);
      const a = limiter.acquire();
      const b = limiter.acquire();
      limiter.setLimit(1);
      expect(limiter.running).toBe(2);
      // No new dispatch is admitted until enough of the already-running ones finish to fall back
      // under the new, lower ceiling.
      expect(() => limiter.acquire()).toThrow(PipenzoExecutionLimiterError);
      a.release();
      expect(() => limiter.acquire()).toThrow(PipenzoExecutionLimiterError);
      b.release();
      const c = limiter.acquire();
      expect(limiter.running).toBe(1);
      c.release();
    });
  });
});
