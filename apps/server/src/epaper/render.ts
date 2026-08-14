/**
 * The eInk viewmodel, drawn to a 1-bit framebuffer (RFC 006).
 *
 * The renderer does no selection — that all happened in `viewmodel.ts`. Here
 * the language is purely 1-bit: an inverted band for the header, a *filled*
 * cell for today (the mark's lit cell, with no colour to lean on), and Bayer
 * density instead of the wall's colour heat. Meaning is carried by weight and
 * pattern because hue is gone.
 *
 * It draws in the panel's native orientation and picks a layout from the
 * aspect — two columns when it is wider than tall, a stack when it is taller.
 * Rotation for a sideways-mounted panel happens later, when the frame is
 * packed, so this never has to think about it.
 */
import { ditherRect } from './dither.js';
import { drawText, measureText, type TextOptions } from './font.js';
import { Framebuffer } from './framebuffer.js';
import type { EpaperGridCell, EpaperModel } from './viewmodel.js';

export interface PanelGeometry {
  readonly width: number;
  readonly height: number;
}

const MARGIN = 16;
const HEADER_H = 54;

/** Truncate a string so it fits `maxWidth` at the given options. */
function fit(text: string, maxWidth: number, options: TextOptions): string {
  if (measureText(text, options) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && measureText(out, options) > maxWidth) out = out.slice(0, -1);
  return out;
}

/**
 * Map the punctuation calendars actually use down to the font's ASCII, and drop
 * anything else, so an em-dash does not silently become a hole in a title. The
 * manifest is already sanitised for safety; this is only about the bitmap font
 * having 0x20–0x7E and nothing more.
 */
function asciiTitle(text: string): string {
  return text
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[•·]/g, '*')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e]/g, '');
}

/** Density 0–1 for a day, from how many events fall on it. */
function densityOf(cell: EpaperGridCell): number {
  if (cell.eventCount <= 0) return 0;
  // Saturate quickly: one event is already worth noticing, four is "busy".
  return Math.min(1, 0.18 + cell.eventCount * 0.16);
}

function drawHeader(fb: Framebuffer, model: EpaperModel, width: number): void {
  fb.fillRect(0, 0, width, HEADER_H, true);
  const left = `${model.header.weekday.toUpperCase()} ${model.header.day} ${model.header.month.toUpperCase()}`;
  // Step the scale down until the date fits the band with room for the year.
  const yearText = model.header.year;
  let scale = 3;
  const budget = width - 2 * MARGIN - measureText(yearText, { scale: 2 }) - 16;
  while (scale > 1 && measureText(left, { scale, tracking: 1 }) > budget) scale -= 1;
  const y = Math.floor((HEADER_H - 8 * scale) / 2);
  drawText(fb, MARGIN, y, left, { scale, tracking: 1, ink: false });
  drawText(fb, width - MARGIN - measureText(yearText, { scale: 2 }), Math.floor((HEADER_H - 16) / 2), yearText, {
    scale: 2,
    ink: false,
  });
}

function drawAgenda(fb: Framebuffer, model: EpaperModel, x0: number, top: number, colW: number, bottom: number): void {
  drawText(fb, x0, top, 'TODAY', { scale: 2, tracking: 2 });
  fb.hLine(x0, x0 + colW, top + 22, true);

  let y = top + 36;
  const rowH = 34;
  const timeColW = measureText('00:00', { scale: 2 }) + 12;
  if (model.agenda.length === 0) {
    drawText(fb, x0, y, 'Nothing on today', { scale: 2 });
    return;
  }
  for (const item of model.agenda) {
    if (y + 16 > bottom) break;
    // The bullet carries the all-day/timed distinction — an open square for a
    // day-long thing, a filled one for a timed event — so an all-day title need
    // not spend width on the words "All day" and starts where the time would.
    if (item.allDay) fb.strokeRect(x0, y + 2, 12, 12, true);
    else fb.fillRect(x0, y + 2, 12, 12, true);
    let titleX = x0 + 20;
    if (!item.allDay) {
      drawText(fb, x0 + 20, y, item.time, { scale: 2 });
      titleX = x0 + 20 + timeColW;
    }
    drawText(fb, titleX, y, fit(asciiTitle(item.title), x0 + colW - titleX, { scale: 2 }), { scale: 2 });
    y += rowH;
  }
  if (model.agendaOverflow > 0 && y + 12 <= bottom) {
    drawText(fb, x0 + 20, y, `+${model.agendaOverflow} more`, { scale: 1, tracking: 1 });
  }
}

function drawGrid(
  fb: Framebuffer,
  model: EpaperModel,
  areaX: number,
  areaW: number,
  top: number,
  bottom: number,
): void {
  const weeks = model.weeks.length;
  const labelH = 22;
  const gridTop = top + labelH;
  const cell = Math.max(12, Math.floor(Math.min(areaW / 7, (bottom - gridTop) / weeks)));
  const gridW = cell * 7;
  const gx = areaX + Math.floor((areaW - gridW) / 2);
  const numScale = cell >= 34 ? 2 : 1;

  // Weekday labels, centred over their columns.
  for (let c = 0; c < 7; c++) {
    const label = model.weekdayLabels[c] ?? '';
    const w = measureText(label, { scale: 2 });
    drawText(fb, gx + c * cell + Math.floor((cell - w) / 2), top, label, { scale: 2 });
  }

  for (let r = 0; r < weeks; r++) {
    for (let c = 0; c < 7; c++) {
      const item = model.weeks[r]![c]!;
      const x = gx + c * cell;
      const y = gridTop + r * cell;
      if (item.isToday) {
        fb.fillRect(x, y, cell, cell, true); // the lit cell
      } else {
        const density = densityOf(item);
        if (density > 0) ditherRect(fb, x + 1, y + 1, cell - 2, cell - 2, density);
      }
      fb.strokeRect(x, y, cell, cell, true);
      const num = String(item.day);
      const nx = x + 4;
      const ny = y + 4;
      // Today's number is knocked out of the fill; a busy day keeps a solid
      // number by first clearing a little box behind it, so dither never eats it.
      if (item.isToday) {
        drawText(fb, nx, ny, num, { scale: numScale, ink: false });
      } else {
        if (densityOf(item) > 0) fb.fillRect(nx - 1, ny - 1, measureText(num, { scale: numScale }) + 2, 8 * numScale + 2, false);
        drawText(fb, nx, ny, num, { scale: numScale });
      }
    }
  }
}

/** Render the model to a framebuffer sized to the panel. */
export function renderEpaper(model: EpaperModel, geometry: PanelGeometry): Framebuffer {
  const { width, height } = geometry;
  const fb = new Framebuffer(width, height);
  drawHeader(fb, model, width);

  const bodyTop = HEADER_H + 14;
  const bodyBottom = height - MARGIN;

  if (width >= height) {
    // Landscape: agenda left, month grid right. The agenda gets the larger
    // share — event titles need the width more than the grid does, and the
    // grid stays legible down to ~44px cells.
    const split = Math.round(width * 0.54);
    drawAgenda(fb, model, MARGIN, bodyTop, split - MARGIN * 2, bodyBottom);
    drawGrid(fb, model, split, width - split - MARGIN, bodyTop, bodyBottom);
  } else {
    // Portrait: agenda over the grid. The grid takes the lower two-thirds,
    // which is enough for whole weeks and keeps today's list at eye height.
    const agendaBottom = bodyTop + Math.round((bodyBottom - bodyTop) * 0.42);
    drawAgenda(fb, model, MARGIN, bodyTop, width - MARGIN * 2, agendaBottom);
    drawGrid(fb, model, MARGIN, width - MARGIN * 2, agendaBottom + 12, bodyBottom);
  }
  return fb;
}
