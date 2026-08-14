/**
 * Ordered (Bayer) dithering for e-paper grey (RFC 006).
 *
 * At 1-bit there is no grey, only the *impression* of it from how densely ink
 * is scattered. Ordered dithering is the right kind here rather than error
 * diffusion (Floyd–Steinberg and friends): it is stable — the same region
 * always produces the same pattern — so it does not shimmer between refreshes,
 * and it fights e-paper ghosting less than a diffusion pattern that changes
 * every frame. The eInk theme uses it to shade a day by how busy it is, which
 * is the 1-bit stand-in for the wall's colour heat.
 */
import type { Framebuffer } from './framebuffer.js';

/** Classic 4×4 Bayer matrix, thresholds 0–15. */
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

/**
 * Fill a rectangle with ink at density `level` (0 = blank, 1 = solid).
 *
 * A pixel is inked when its Bayer threshold is below the level, so the pattern
 * is anchored to absolute coordinates — abutting rectangles tile seamlessly
 * rather than showing a seam.
 */
export function ditherRect(fb: Framebuffer, x: number, y: number, w: number, h: number, level: number): void {
  const clamped = Math.max(0, Math.min(1, level));
  if (clamped <= 0) return;
  // 17 steps so level 1 fills every pixel (threshold 15 needs a cut above it).
  const cut = clamped * 17;
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const threshold = BAYER_4[((py % 4) + 4) % 4]![((px % 4) + 4) % 4]!;
      if (threshold < cut) fb.set(px, py, true);
    }
  }
}
