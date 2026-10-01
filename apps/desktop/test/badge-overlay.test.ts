import { describe, expect, it } from 'vitest';
import { badgeLabelForCount, compositeBadgeOverlay } from '../electron/badge-overlay.js';

describe('badgeLabelForCount', () => {
  it('has no badge at all for a count of zero (AC-2)', () => {
    expect(badgeLabelForCount(0)).toBeUndefined();
  });

  it('has no badge for a negative count (defensive -- never expected in practice)', () => {
    expect(badgeLabelForCount(-1)).toBeUndefined();
  });

  it('renders counts 1 through 9 as their own numeral', () => {
    for (let count = 1; count <= 9; count++) {
      expect(badgeLabelForCount(count)).toBe(String(count));
    }
  });

  it('renders any count above 9 as "9+" (AC-3)', () => {
    expect(badgeLabelForCount(10)).toBe('9+');
    expect(badgeLabelForCount(42)).toBe('9+');
    expect(badgeLabelForCount(5000)).toBe('9+');
  });
});

/** A flat, fully transparent/black bitmap of `size x size` pixels -- big enough for the badge's own
 *  minimum radius (4px) to fit without clipping. */
function blankBitmap(size: number): { buffer: Buffer; width: number; height: number } {
  return { buffer: Buffer.alloc(size * size * 4, 0), width: size, height: size };
}

function pixelAt(buffer: Buffer, width: number, x: number, y: number): [number, number, number, number] {
  const offset = (y * width + x) * 4;
  // Stored BGRA (see badge-overlay.ts's own doc comment); returned as [r, g, b, a] so callers read
  // assertions in the color order they'd naturally write them.
  return [buffer[offset + 2]!, buffer[offset + 1]!, buffer[offset]!, buffer[offset + 3]!];
}

describe('compositeBadgeOverlay', () => {
  it('does not mutate the input buffer', () => {
    const input = blankBitmap(32);
    const before = Buffer.from(input.buffer);
    compositeBadgeOverlay(input, '3');
    expect(input.buffer).toEqual(before);
  });

  it('returns a buffer the same size as the input', () => {
    const input = blankBitmap(32);
    const out = compositeBadgeOverlay(input, '3');
    expect(out.length).toBe(input.buffer.length);
  });

  it('fills a badge circle near the bottom-right corner in the danger-red fill color', () => {
    const input = blankBitmap(32);
    const out = compositeBadgeOverlay(input, '1');
    // A couple of pixels in from the bottom-right corner, comfortably inside any plausible circle
    // placement -- asserts opaque and red-dominant without coupling the test to the exact centering
    // formula compositeBadgeOverlay happens to use.
    const [r, g, b, a] = pixelAt(out, 32, 29, 29);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  it('leaves the far corner (top-left) untouched by the badge', () => {
    const input = blankBitmap(32);
    const out = compositeBadgeOverlay(input, '9+');
    expect(pixelAt(out, 32, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('draws at least one white label pixel inside the badge circle', () => {
    const input = blankBitmap(32);
    const out = compositeBadgeOverlay(input, '8'); // '8' lights every row of the 3x5 font
    const radius = Math.max(4, Math.round(Math.min(32, 32) * 0.3));
    const centerX = 32 - Math.round(radius * 0.85);
    const centerY = 32 - Math.round(radius * 0.85);
    let sawWhite = false;
    for (let y = centerY - radius; y <= centerY + radius && !sawWhite; y++) {
      for (let x = centerX - radius; x <= centerX + radius; x++) {
        const [r, g, b, a] = pixelAt(out, 32, x, y);
        if (r === 255 && g === 255 && b === 255 && a === 255) {
          sawWhite = true;
          break;
        }
      }
    }
    expect(sawWhite).toBe(true);
  });

  it('renders a two-character label ("9+") without throwing and without clipping outside the bitmap', () => {
    const input = blankBitmap(20); // small enough that a clipping bug would throw or wrap
    expect(() => compositeBadgeOverlay(input, '9+')).not.toThrow();
  });

  it('rejects a character with no glyph', () => {
    const input = blankBitmap(32);
    expect(() => compositeBadgeOverlay(input, 'x')).toThrow(/no glyph/);
  });
});
