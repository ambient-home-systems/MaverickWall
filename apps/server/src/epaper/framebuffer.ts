/**
 * A 1-bit framebuffer for e-paper panels (RFC 006).
 *
 * The whole e-paper design is "the server renders a finished frame, the device
 * is dumb", so this is where a frame is drawn before it is packed for a
 * controller or wrapped in a PNG. It is deliberately tiny and vendor-free —
 * rule three's spirit applied server-side: draw what nobody else supplies,
 * the same decision as `http/qr.ts`.
 *
 * One convention, pinned here and nowhere else: **a set bit is ink** — a dark
 * pixel, the thing you drew. The panel's own "1 means white or black" is a
 * property of its controller and belongs at the packing/encoding edge
 * (`png.ts`, the raw `.bin` path), not in the drawing code. Getting this
 * backwards is the "inverted panel that passes every check a person can reason
 * about" trap the RFC calls out, which is why the encoder round-trip test
 * decodes a known frame rather than eyeballing it.
 *
 * Packing is the controller-native layout: 1 bit per pixel, MSB is the
 * leftmost pixel, rows are whole bytes (`ceil(width / 8)`), top to bottom. For
 * the first target, a Seeed 7.5" at 800×480, that is 100 bytes a row and
 * 48,000 bytes a frame.
 */
export class Framebuffer {
  readonly width: number;
  readonly height: number;
  /** Bytes per row, rounded up to a whole byte. */
  readonly stride: number;
  /** Raw 1bpp bits, MSB-first, row-major. A set bit is ink (dark). */
  readonly bits: Uint8Array;

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error(`Framebuffer needs positive integer dimensions, got ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.stride = (width + 7) >> 3;
    this.bits = new Uint8Array(this.stride * height);
  }

  /** True when (x, y) is inside the canvas. Off-canvas draws are no-ops. */
  private inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Set or clear one pixel. `ink` true draws a dark pixel. */
  set(x: number, y: number, ink = true): void {
    if (!this.inside(x, y)) return;
    const idx = y * this.stride + (x >> 3);
    const mask = 0x80 >> (x & 7);
    if (ink) this.bits[idx]! |= mask;
    else this.bits[idx]! &= ~mask & 0xff;
  }

  /** Whether (x, y) is ink. Off-canvas reads as not-ink. */
  get(x: number, y: number): boolean {
    if (!this.inside(x, y)) return false;
    const idx = y * this.stride + (x >> 3);
    const mask = 0x80 >> (x & 7);
    return (this.bits[idx]! & mask) !== 0;
  }

  /** Fill the whole canvas with ink or clear it. */
  clear(ink = false): void {
    this.bits.fill(ink ? 0xff : 0x00);
  }

  /** Filled rectangle. Clipped to the canvas. */
  fillRect(x: number, y: number, w: number, h: number, ink = true): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w);
    const y1 = Math.min(this.height, y + h);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) this.set(px, py, ink);
    }
  }

  /** One-pixel rectangle outline. */
  strokeRect(x: number, y: number, w: number, h: number, ink = true): void {
    if (w <= 0 || h <= 0) return;
    this.hLine(x, x + w - 1, y, ink);
    this.hLine(x, x + w - 1, y + h - 1, ink);
    this.vLine(y, y + h - 1, x, ink);
    this.vLine(y, y + h - 1, x + w - 1, ink);
  }

  /** Horizontal run from x0 to x1 inclusive at row y. */
  hLine(x0: number, x1: number, y: number, ink = true): void {
    const a = Math.min(x0, x1);
    const b = Math.max(x0, x1);
    for (let x = a; x <= b; x++) this.set(x, y, ink);
  }

  /** Vertical run from y0 to y1 inclusive at column x. */
  vLine(y0: number, y1: number, x: number, ink = true): void {
    const a = Math.min(y0, y1);
    const b = Math.max(y0, y1);
    for (let y = a; y <= b; y++) this.set(x, y, ink);
  }

  /**
   * The panel-native packing, ready for a controller expecting `1 = ink`.
   *
   * A copy, so a caller cannot mutate the frame through it. The raw `.bin`
   * endpoint serves this; a controller with the opposite convention inverts at
   * its own edge (ESPHome's `online_image` has an invert flag), which is why
   * the convention is documented rather than guessed here.
   */
  toPacked(): Uint8Array {
    return this.bits.slice();
  }
}

/**
 * A copy of `src` turned clockwise by 0/90/180/270 degrees.
 *
 * The frame is always drawn in the panel's visual orientation and then turned
 * to the controller's native scan order here, *before* packing — so a panel
 * mounted on its side shows upright without the renderer ever knowing. 90 and
 * 270 swap width and height, which is the whole reason rotation is a raster
 * step and not a layout flag: get it wrong and a portrait-mounted panel comes
 * out half size, the same trap the wall's rem-basis swap has.
 */
export function rotate(src: Framebuffer, degrees: number): Framebuffer {
  const d = (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
  if (d === 0) {
    const copy = new Framebuffer(src.width, src.height);
    copy.bits.set(src.bits);
    return copy;
  }
  const swap = d === 90 || d === 270;
  const out = new Framebuffer(swap ? src.height : src.width, swap ? src.width : src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (!src.get(x, y)) continue;
      if (d === 90) out.set(src.height - 1 - y, x, true);
      else if (d === 180) out.set(src.width - 1 - x, src.height - 1 - y, true);
      else out.set(y, src.width - 1 - x, true); // 270
    }
  }
  return out;
}
