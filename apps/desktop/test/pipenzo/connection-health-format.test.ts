import { describe, expect, it } from 'vitest';
import {
  formatClockTimeUtc,
  formatDurationShort,
} from '../../src/pipenzo/connection-health-format.js';

describe('formatDurationShort', () => {
  it('renders under a minute in seconds', () => {
    expect(formatDurationShort(18_000)).toBe('18s');
    expect(formatDurationShort(500)).toBe('1s');
    expect(formatDurationShort(0)).toBe('0s');
  });

  it('renders a minute or more, rounded to the nearest minute', () => {
    expect(formatDurationShort(60_000)).toBe('1m');
    expect(formatDurationShort(8 * 60_000)).toBe('8m');
    expect(formatDurationShort(8 * 60_000 + 20_000)).toBe('8m');
    expect(formatDurationShort(8 * 60_000 + 31_000)).toBe('9m');
  });

  it('clamps a negative (already-elapsed) duration to zero rather than counting past it', () => {
    expect(formatDurationShort(-5_000)).toBe('0s');
  });
});

describe('formatClockTimeUtc', () => {
  it('renders 24-hour HH:MM, fixed to UTC regardless of the host timezone', () => {
    expect(formatClockTimeUtc(Date.UTC(2026, 0, 1, 14, 2))).toBe('14:02');
    expect(formatClockTimeUtc(Date.UTC(2026, 0, 1, 0, 5))).toBe('00:05');
    expect(formatClockTimeUtc(Date.UTC(2026, 0, 1, 23, 59))).toBe('23:59');
  });
});
