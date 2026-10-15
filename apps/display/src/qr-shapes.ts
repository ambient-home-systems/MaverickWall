/**
 * How a QR code's modules and its three eyes are drawn (plan item M5.3, the
 * dot and eye styles).
 *
 * A camera reads a code by its finder patterns and by sampling the middle of
 * each module, so a module may be any shape that keeps its middle dark and
 * leaves its neighbours' middles alone, and an eye any shape whose cross
 * section through its centre is still dark, light, dark, light, dark in the
 * ratio 1:1:3:1:1. Every shape here keeps both, and `browser-qr.test.ts`
 * holds that by decoding a screenshot of each one rather than by looking.
 *
 * `square` for both is the absence and is exactly the path every code was
 * drawn with before the styles existed — the same string, run by run — so a
 * code nobody restyled is byte for byte the code it was.
 *
 * Pure, no DOM, so the shapes can be tested at all.
 */

export const QR_DOTS = ['square', 'rounded', 'dots'] as const;
export const QR_EYES = ['square', 'rounded', 'circle'] as const;
export type QrDots = (typeof QR_DOTS)[number];
export type QrEyes = (typeof QR_EYES)[number];

export interface QrShapes {
  readonly dots: QrDots;
  readonly eyes: QrEyes;
}

/** A widget's stored styles, read the one way: absent, or a value this bundle does not know, is square. */
export function qrShapes(config: unknown): QrShapes {
  const record = typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
  const dots = record['qrDots'];
  const eyes = record['qrEyes'];
  return {
    dots: (QR_DOTS as readonly unknown[]).includes(dots) ? (dots as QrDots) : 'square',
    eyes: (QR_EYES as readonly unknown[]).includes(eyes) ? (eyes as QrEyes) : 'square',
  };
}

export interface QrMatrix {
  readonly size: number;
  readonly modules: readonly (readonly boolean[])[];
}

export interface QrPaths {
  /** Every dark module but the eyes', or every one when the eyes are square too. */
  readonly modules: string;
  /** The three eyes, drawn even-odd, or `''` when they are part of `modules`. */
  readonly eyes: string;
  /** Whether the shapes are all axis-aligned squares, which `crispEdges` keeps hard. */
  readonly crisp: boolean;
}

/** A rounded module's corner, as a share of the module. */
const ROUND = 0.3;
/** A dot's radius. Under a half, so two dots side by side never touch and each middle stays its own. */
const DOT = 0.42;

/** Whether a module is part of one of the three 7x7 finder patterns. */
function inEye(size: number, row: number, column: number): boolean {
  const top = row < 7;
  const left = column < 7;
  return (top && left) || (top && column >= size - 7) || (left && row >= size - 7);
}

function n(value: number): string {
  // Two places: a module is one unit of a viewBox a few dozen units wide.
  return String(Math.round(value * 100) / 100);
}

/** A rounded rectangle, clockwise, as a closed sub-path. */
function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M${n(x + r)} ${n(y)}h${n(w - 2 * r)}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(r)}` +
    `v${n(h - 2 * r)}a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(r)}` +
    `h${n(2 * r - w)}a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(-r)}` +
    `v${n(2 * r - h)}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(-r)}z`
  );
}

function circle(cx: number, cy: number, r: number): string {
  return `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0z`;
}

/** One eye at its top-left corner: a 7x7 ring with a 5x5 hole, and a 3x3 centre. */
function eye(x: number, y: number, style: QrEyes): string {
  if (style === 'circle') {
    return circle(x + 3.5, y + 3.5, 3.5) + circle(x + 3.5, y + 3.5, 2.5) + circle(x + 3.5, y + 3.5, 1.5);
  }
  if (style === 'rounded') {
    return roundRect(x, y, 7, 7, 2) + roundRect(x + 1, y + 1, 5, 5, 1.3) + roundRect(x + 2, y + 2, 3, 3, 0.9);
  }
  return `M${x} ${y}h7v7h-7z` + `M${x + 1} ${y + 1}h5v5h-5z` + `M${x + 2} ${y + 2}h3v3h-3z`;
}

export function qrPaths(matrix: QrMatrix, quiet: number, shapes: QrShapes): QrPaths {
  const separateEyes = shapes.eyes !== 'square' || shapes.dots !== 'square';
  let modules = '';
  for (let row = 0; row < matrix.size; row++) {
    const line = matrix.modules[row] as readonly boolean[];
    let column = 0;
    while (column < matrix.size) {
      const dark = line[column] === true && !(separateEyes && inEye(matrix.size, row, column));
      if (!dark) {
        column++;
        continue;
      }
      if (shapes.dots === 'square') {
        // Runs, exactly as the square code has always been drawn.
        let end = column;
        while (end < matrix.size && line[end] === true && !(separateEyes && inEye(matrix.size, row, end))) end++;
        modules += `M${column + quiet} ${row + quiet}h${end - column}v1h${column - end}z`;
        column = end;
        continue;
      }
      modules +=
        shapes.dots === 'dots'
          ? circle(column + quiet + 0.5, row + quiet + 0.5, DOT)
          : roundRect(column + quiet, row + quiet, 1, 1, ROUND);
      column++;
    }
  }
  if (!separateEyes) return { modules, eyes: '', crisp: true };
  const far = matrix.size - 7;
  const eyes =
    eye(quiet, quiet, shapes.eyes) + eye(quiet + far, quiet, shapes.eyes) + eye(quiet, quiet + far, shapes.eyes);
  return { modules, eyes, crisp: shapes.dots === 'square' && shapes.eyes === 'square' };
}
