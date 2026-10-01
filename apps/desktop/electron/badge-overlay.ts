/**
 * Pure pixel math for compositing a numeral badge onto a tray icon's raw bitmap (issue #151).
 *
 * Deliberately has no Electron import: `tray-badge.ts` is the only caller, and it supplies the base
 * icon's bitmap buffer (`NativeImage.toBitmap()`) and size, then hands the composited buffer back to
 * `nativeImage.createFromBuffer()`. Keeping the pixel math Electron-free is what makes it testable
 * without a real Electron runtime -- the same split `resolve-window-icon.ts` draws between "resolve
 * a path" (pure, tested) and "load it into a window" (Electron glue, left to `main.ts`).
 *
 * ## Why a hand-rolled 3x5 bitmap font instead of a canvas
 *
 * Node has no built-in 2D canvas, and this repo carries no canvas/image dependency (`sharp`,
 * `canvas`, `@napi-rs/canvas`) worth adding for an eleven-glyph badge. `badgeLabelForCount` below can
 * only ever produce a digit or "9+", so a tiny embedded font covering the ten digits and '+' is the
 * whole alphabet this module will ever need to render.
 *
 * ## Channel order
 *
 * `NativeImage.createFromBuffer`'s own doc comment says a raw-bitmap buffer's format "is
 * platform-dependent" and gives no further detail. `tray-badge.ts` gates every call that reaches this
 * module on `process.platform === 'win32'` (AC-8), where Skia's native bitmap format is BGRA, which
 * is what `setPixel` below assumes. Getting that assumption wrong would tint the badge blue instead
 * of red -- cosmetic, not a correctness bug, since white (the digit color) and full/zero alpha are
 * channel-order-invariant.
 */

export const BADGE_BYTES_PER_PIXEL = 4;

/**
 * The tray badge's label for a Needs-human count of `count`, or `undefined` for "no badge at all"
 * (AC-2: a count back at 0 removes the badge entirely, never leaving a lingering "0"). Counts above 9
 * render as "9+" (AC-3) rather than a wider numeral that would overflow or clip the circle.
 */
export function badgeLabelForCount(count: number): string | undefined {
  if (count <= 0) return undefined;
  if (count > 9) return '9+';
  return String(count);
}

/** Row-major, 5 rows x 3 cols, `'1'` lit / `'0'` unlit. Covers every character
 *  `badgeLabelForCount` can produce -- the ten digits plus `'+'` -- and nothing else. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
});

const GLYPH_COLS = 3;
const GLYPH_ROWS = 5;
const GLYPH_GAP = 1;

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

// README's danger red -- the same semantic `board-lanes.ts` names `--color-danger` for the
// Needs-human lane this badge's count comes from.
const BADGE_FILL: Rgba = { r: 229, g: 72, b: 77, a: 255 };
const BADGE_TEXT: Rgba = { r: 255, g: 255, b: 255, a: 255 };

function setPixel(
  buffer: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  color: Rgba,
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (y * width + x) * BADGE_BYTES_PER_PIXEL;
  buffer[offset] = color.b;
  buffer[offset + 1] = color.g;
  buffer[offset + 2] = color.r;
  buffer[offset + 3] = color.a;
}

export interface BadgeOverlayInput {
  /** Raw bitmap, as returned by `NativeImage.toBitmap()`: `width * height * 4` bytes. */
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * Returns a new buffer -- same dimensions as `input` -- with a filled badge circle and `label`'s
 * glyphs drawn in the bottom-right corner. `input.buffer` is never mutated: `tray-badge.ts` keeps the
 * base icon's `NativeImage` around across repaints rather than re-reading it from disk each time, so
 * composing onto a copy is what makes reusing that same base safe to call repeatedly.
 */
export function compositeBadgeOverlay(input: BadgeOverlayInput, label: string): Buffer {
  const { width, height } = input;
  const out = Buffer.from(input.buffer);

  const radius = Math.max(4, Math.round(Math.min(width, height) * 0.3));
  const centerX = width - Math.round(radius * 0.85);
  const centerY = height - Math.round(radius * 0.85);

  for (let y = centerY - radius; y <= centerY + radius; y++) {
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy <= radius * radius) setPixel(out, width, height, x, y, BADGE_FILL);
    }
  }

  const glyphs = [...label].map((char) => {
    const glyph = GLYPHS[char];
    if (!glyph) {
      throw new Error(`compositeBadgeOverlay: no glyph for ${JSON.stringify(char)}`);
    }
    return glyph;
  });
  const totalCols = glyphs.length * GLYPH_COLS + (glyphs.length - 1) * GLYPH_GAP;
  // Scaled to fill most of the circle's inscribed square, bounded by whichever axis is tighter.
  const scale = Math.max(
    1,
    Math.floor(Math.min((radius * 2 * 0.72) / totalCols, (radius * 2 * 0.72) / GLYPH_ROWS)),
  );
  const pixelWidth = totalCols * scale;
  const pixelHeight = GLYPH_ROWS * scale;
  const startX = centerX - Math.round(pixelWidth / 2);
  const startY = centerY - Math.round(pixelHeight / 2);

  let colOffset = 0;
  for (const glyph of glyphs) {
    for (let row = 0; row < GLYPH_ROWS; row++) {
      for (let col = 0; col < GLYPH_COLS; col++) {
        if (glyph[row]?.[col] !== '1') continue;
        const px0 = startX + (colOffset + col) * scale;
        const py0 = startY + row * scale;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            setPixel(out, width, height, px0 + dx, py0 + dy, BADGE_TEXT);
          }
        }
      }
    }
    colOffset += GLYPH_COLS + GLYPH_GAP;
  }

  return out;
}
