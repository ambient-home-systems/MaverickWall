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
import type { CivilDate } from '@maverick-wall/core';

import { ditherRect } from './dither.js';
import { drawText, measureText, type TextOptions } from './font.js';
import { Framebuffer } from './framebuffer.js';
import {
  agendaRowsInBox,
  cellTitlesInBox,
  gridMetrics,
  panelMetrics,
  weekTitlesInBox,
  type EpaperMetrics,
  type PanelGeometry,
} from './metrics.js';
import type { EpaperGridCell, EpaperModel } from './viewmodel.js';

export type { PanelGeometry } from './metrics.js';

/** A pixel rectangle on the framebuffer. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Truncate a string so it fits `maxWidth` at the given options. */
export function fit(text: string, maxWidth: number, options: TextOptions): string {
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
export function asciiTitle(text: string): string {
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

function drawHeader(fb: Framebuffer, model: EpaperModel, m: EpaperMetrics): void {
  const width = m.panel.width;
  fb.fillRect(0, 0, width, m.headerHeight, true);
  const left = `${model.header.weekday.toUpperCase()} ${model.header.day} ${model.header.month.toUpperCase()}`;
  // Step the scale down until the date fits the band with room for the year.
  // The starting rung is the panel's, not a literal 3 — but the step-down is
  // unchanged, because a long weekday in a narrow band is a width problem and
  // no amount of deriving from the height can see it.
  const yearText = model.header.year;
  let scale = m.headerScale;
  const yearW = measureText(yearText, { scale: m.yearScale });
  const budget = width - 2 * m.margin - yearW - m.bodyGlyph;
  while (scale > 1 && measureText(left, { scale, tracking: 1 }) > budget) scale -= 1;
  const y = Math.floor((m.headerHeight - 8 * scale) / 2);
  drawText(fb, m.margin, y, left, { scale, tracking: 1, ink: false });
  drawText(fb, width - m.margin - yearW, Math.floor((m.headerHeight - 8 * m.yearScale) / 2), yearText, {
    scale: m.yearScale,
    ink: false,
  });
}

/**
 * Today's agenda within a box.
 *
 * `header` draws a labelled rule at the top (the fixed layout's "TODAY"); a
 * widget passes none because its own title bar is drawn by the freeform frame.
 */
export function drawAgendaBox(
  fb: Framebuffer,
  model: EpaperModel,
  m: EpaperMetrics,
  box: Box,
  header?: string,
): void {
  const x0 = box.x;
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const body = m.bodyScale;
  let y = box.y;
  if (header !== undefined) {
    drawText(fb, x0, y, header, { scale: body, tracking: 2 });
    fb.hLine(x0, right, y + m.agendaRuleY, true);
    y += m.agendaHeadH;
  }
  // The gutter past the time column is one bullet wide, which is what the
  // shipped 12 was beside a 12px bullet — stated rather than left as two
  // constants that happened to agree.
  const timeColW = measureText('00:00', { scale: body }) + m.bullet;
  if (model.agenda.length === 0) {
    // Sized to the box, for the same reason as the upcoming list below.
    const note = 'Nothing on today';
    const scale = measureText(note, { scale: body }) <= box.w ? body : m.smallScale;
    drawText(fb, x0, y, fit(note, box.w, { scale }), { scale });
    return;
  }
  /*
   * How many rows, asked of the box rather than of a constant.
   *
   * `EPAPER_TODAY_LIMIT` used to answer six here, on every panel from 640×384
   * to 1872×1404 — the shape of the whole bug. The row height has not moved at
   * 800×480, so the eleven rows this now draws there are exactly as readable as
   * the six were; there are simply five fewer of them missing.
   */
  const rows = model.agenda.slice(0, agendaRowsInBox(bottom - y, m));
  let drawn = 0;
  for (const item of rows) {
    if (y + m.bodyGlyph > bottom) break;
    // The bullet carries the all-day/timed distinction — an open square for a
    // day-long thing, a filled one for a timed event — so an all-day title need
    // not spend width on the words "All day" and starts where the time would.
    if (item.allDay) fb.strokeRect(x0, y + m.bulletDrop, m.bullet, m.bullet, true);
    else fb.fillRect(x0, y + m.bulletDrop, m.bullet, m.bullet, true);
    const textX = x0 + m.bullet + m.bulletGap;
    let titleX = textX;
    if (!item.allDay) {
      drawText(fb, textX, y, item.time, { scale: body });
      titleX = textX + timeColW;
    }
    drawText(fb, titleX, y, fit(asciiTitle(item.title), right - titleX, { scale: body }), { scale: body });
    y += m.agendaRowH;
    drawn++;
  }
  /*
   * What did not fit, counted against the *day* rather than against the working
   * set the model carried. The cut used to happen in the viewmodel, so the
   * overflow could be counted there; it happens here now, because only here is
   * the box known — which means the total has to travel instead of the answer.
   */
  const overflow = Math.max(0, model.agendaTotal - drawn);
  const smallGlyph = 8 * m.smallScale;
  if (overflow > 0 && y + Math.round(smallGlyph * 1.5) <= bottom) {
    drawText(fb, x0 + m.bullet + m.bulletGap, y, `+${overflow} more`, { scale: m.smallScale, tracking: 1 });
  }
}

/**
 * The upcoming list a calendar widget draws — today and the days after it.
 *
 * This is what "Upcoming list" on the designer promises, and until now the
 * panel answered it with *today's* agenda: a household with nothing on today
 * saw an empty box under a heading that said more was coming. It honours the
 * two options the wall honours, read the same way — a set of source ids to
 * keep (empty means all) and how many events in total.
 */
export function drawUpcomingBox(
  fb: Framebuffer,
  model: EpaperModel,
  m: EpaperMetrics,
  box: Box,
  options: { readonly calendars?: readonly string[]; readonly count?: number } = {},
): void {
  const keep = options.calendars ?? [];
  const limit = options.count !== undefined && options.count >= 1 ? Math.min(50, Math.trunc(options.count)) : 12;
  const rows = model.upcoming
    .filter((item) => keep.length === 0 || keep.includes(item.sourceId))
    .slice(0, limit);

  const body = m.bodyScale;
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const timeColW = measureText('00:00', { scale: body }) + m.bullet;
  let y = box.y;
  if (rows.length === 0) {
    /*
     * Sized to the box, not to the sentence.
     *
     * This drew at a fixed scale 2 with no width bound at all, so in a narrow
     * column it ran straight out of its box and over whatever was beside it —
     * on the first canvas a panel ever drew, "Nothing coming up" lay across the
     * month grid. Invisible until a panel started drawing a *wall's*
     * arrangement, where a box is whatever the household dragged rather than a
     * half of the built-in layout. `fit` is the belt: at scale 1 in a box too
     * narrow even for that, a truncated line still beats a line in the widget
     * next door.
     */
    const note = 'Nothing coming up';
    const scale = measureText(note, { scale: body }) <= box.w ? body : m.smallScale;
    drawText(fb, box.x, y, fit(note, box.w, { scale }), { scale });
    return;
  }
  let heading: CivilDate | undefined;
  for (const item of rows) {
    // A date rule where the day turns over, so a list spanning days reads as
    // days rather than as one run of times.
    if (item.date !== heading) {
      if (y + Math.round(8 * m.smallScale * 1.5) > bottom) break;
      const label = item.isToday ? 'TODAY' : dayLabel(item.date);
      drawText(fb, box.x, y, label, { scale: m.smallScale, tracking: 1 });
      fb.hLine(box.x, right, y + m.dateRuleY, true);
      y += m.dateRuleH;
      heading = item.date;
    }
    if (y + m.bodyGlyph > bottom) break;
    if (item.allDay) fb.strokeRect(box.x, y + m.bulletDrop, m.bullet, m.bullet, true);
    else fb.fillRect(box.x, y + m.bulletDrop, m.bullet, m.bullet, true);
    const textX = box.x + m.bullet + m.bulletGap;
    let titleX = textX;
    if (!item.allDay) {
      drawText(fb, textX, y, item.time, { scale: body });
      titleX = textX + timeColW;
    }
    drawText(fb, titleX, y, fit(asciiTitle(item.title), right - titleX, { scale: body }), { scale: body });
    y += m.upcomingRowH;
  }
}

/**
 * The coming seven days as columns — the widget's "Week columns".
 *
 * Built from the grid row that contains today, so it follows the household's
 * week start exactly as the month does rather than inventing a second answer
 * to "when does a week begin".
 */
export function drawWeekBox(fb: Framebuffer, model: EpaperModel, m: EpaperMetrics, box: Box): void {
  const row = model.weeks.find((week) => week.some((cell) => cell.isToday)) ?? model.weeks[0];
  if (row === undefined) return;
  const colW = Math.floor(box.w / 7);
  const headH = m.weekHeadH;
  const small = m.smallScale;
  const smallGlyph = 8 * small;
  const inset = m.cellInset;
  const foot = box.y + box.h - 2 * small;
  const top = box.y + headH + m.pad;
  // The names a column can hold, from its own height rather than from the four
  // the model used to carry — the `EPAPER_CELL_TITLES` half of the same bug.
  const fits = weekTitlesInBox(foot - top, m);
  for (let c = 0; c < 7; c++) {
    const cell = row[c]!;
    const x = box.x + c * colW;
    // The day's head: its letter and its number, inverted for today so the
    // column somebody is standing in front of is findable across a kitchen.
    if (cell.isToday) fb.fillRect(x, box.y, colW, headH, true);
    const label = `${model.weekdayLabels[c] ?? ''} ${cell.day}`;
    const lw = measureText(label, { scale: m.labelScale });
    drawText(fb, x + Math.max(2, Math.floor((colW - lw) / 2)), box.y + m.pad, label, {
      scale: m.labelScale,
      ink: !cell.isToday,
    });
    fb.strokeRect(x, box.y, colW, box.h, true);

    let y = top;
    let drawn = 0;
    for (const title of cell.titles.slice(0, fits)) {
      if (y + smallGlyph > foot) break;
      const line = fit(asciiTitle(title), colW - inset * 2, { scale: small });
      if (line === '') break;
      drawText(fb, x + inset, y, line, { scale: small });
      y += m.weekTitleLineH;
      drawn++;
    }
    const rest = cell.eventCount - drawn;
    if (rest > 0 && y + smallGlyph <= foot) drawText(fb, x + inset, y, `+${rest}`, { scale: small });
  }
}

/** `Mon 4` for a list's date rule, in the same en-GB the header uses. */
function dayLabel(date: CivilDate): string {
  const [y, m, d] = date.split('-').map((n) => Number.parseInt(n, 10));
  const at = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 12));
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(at)
    .toUpperCase();
}

/** How a month grid says what is on a day. */
export interface MonthOptions {
  /**
   * Name the events in each cell instead of shading it. The wall calls these
   * pills; at 1-bit they are truncated lines under the day number, because a
   * rounded chip costs the two pixels the words need. Dropped automatically
   * when a cell is too small to hold a legible word — a panel that answers a
   * setting with unreadable smudge is worse than one that answers with dots.
   */
  readonly pills?: boolean;
}

/** The rolling month grid within a box. */
export function drawMonthBox(
  fb: Framebuffer,
  model: EpaperModel,
  m: EpaperMetrics,
  box: Box,
  options: MonthOptions = {},
): void {
  const weeks = model.weeks.length;
  const labelH = m.monthHeadH;
  /*
   * The grid fills its box, in both directions.
   *
   * It used to be one square cell, `min(box.w / 7, available / weeks)` — so on
   * every landscape panel it was bound by the width of its column and simply
   * stopped: at 1872×1404 it drew 580px of grid into an 1178px column and left
   * the rest white, which is half the panel. `gridMetrics` carries the whole
   * argument for why the cell stretches instead, and `topOffset` for why the
   * rounding remainder goes above the first row rather than below the last.
   */
  const grid = gridMetrics(box.w, box.h - labelH, weeks, m);
  const gridTop = box.y + labelH + grid.topOffset;
  const gridW = grid.cellW * 7;
  const gx = box.x + Math.floor((box.w - gridW) / 2);
  // Height says whether a name has somewhere to go; width says whether it would
  // be a name when it got there. The second check is new because the cell used
  // to be square, so a cell tall enough was wide enough by construction.
  const pills = options.pills === true && grid.cellH >= m.pillMinCell && grid.cellW >= m.pillMinWidth;
  // Deliberately not conditioned on `pills`: the day number is the thing a
  // person scans for, and having it change size because a household ticked
  // "labelled pills" is a surprise. It also keeps the setting honest — with
  // nothing on any day, dots and pills draw the identical frame, so the only
  // thing the switch can change is whether the events are named.
  const numScale = fitNumberScale(
    Math.min(grid.cellH, grid.cellW) >= m.pillMinCell ? 2 * m.smallScale : m.smallScale,
    grid.cellW - m.cellNumberInset * 2,
  );
  const numberBand = m.cellNumberInset + 8 * numScale + 2 * m.smallScale;
  const titleRows = cellTitlesInBox(grid.cellH - numberBand - 2 * m.smallScale, m);

  // Weekday labels, centred over their columns.
  for (let c = 0; c < 7; c++) {
    const label = model.weekdayLabels[c] ?? '';
    const w = measureText(label, { scale: m.labelScale });
    drawText(fb, gx + c * grid.cellW + Math.floor((grid.cellW - w) / 2), box.y, label, { scale: m.labelScale });
  }

  for (let r = 0; r < weeks; r++) {
    for (let c = 0; c < 7; c++) {
      const item = model.weeks[r]![c]!;
      const x = gx + c * grid.cellW;
      const y = gridTop + r * grid.cellH;
      if (item.isToday) {
        fb.fillRect(x, y, grid.cellW, grid.cellH, true); // the lit cell
      } else if (!pills) {
        // Shading is the *unlabelled* answer to "how busy is this day". With
        // the names drawn in the cell they are the density, and dither behind
        // them is ink under ink — the thing that makes 1-bit text unreadable.
        const density = densityOf(item);
        if (density > 0) ditherRect(fb, x + 1, y + 1, grid.cellW - 2, grid.cellH - 2, density);
      }
      fb.strokeRect(x, y, grid.cellW, grid.cellH, true);
      const num = String(item.day);
      const nx = x + m.cellNumberInset;
      const ny = y + m.cellNumberInset;
      // Today's number is knocked out of the fill; a busy day keeps a solid
      // number by first clearing a little box behind it, so dither never eats it.
      if (item.isToday) {
        drawText(fb, nx, ny, num, { scale: numScale, ink: false });
      } else {
        if (!pills && densityOf(item) > 0) fb.fillRect(nx - 1, ny - 1, measureText(num, { scale: numScale }) + 2, 8 * numScale + 2, false);
        drawText(fb, nx, ny, num, { scale: numScale });
      }
      // Today's cell is filled, so its names are knocked out of it exactly as
      // its number is. Drawn in ink they were black on black — invisible on
      // the one cell somebody actually walks over to read.
      if (pills) {
        drawCellTitles(
          fb,
          item,
          m,
          { x, y, w: grid.cellW, h: grid.cellH },
          y + numberBand,
          titleRows,
          !item.isToday,
        );
      }
    }
  }
}

/**
 * Step the day number down until it fits its cell's width.
 *
 * Never needed while the cell was square and the number was one of two sizes:
 * a 50px cell holds "31" at scale 2 with room over. A cell that fills a tall
 * narrow column on a 13.3" panel is 116px wide with a scale-6 number in it,
 * which is 102px — one bad rounding from drawing through the cell beside it.
 */
function fitNumberScale(wanted: number, available: number): number {
  let scale = Math.max(1, wanted);
  while (scale > 1 && measureText('30', { scale }) > available) scale -= 1;
  return scale;
}

/**
 * The event names inside one month cell, under its day number.
 *
 * Each line is cleared behind before it is drawn, because the cell it sits in
 * may be dithered or filled — ink on ink is a smudge, and the whole point of
 * asking for pills is to read the words.
 */
function drawCellTitles(
  fb: Framebuffer,
  item: EpaperGridCell,
  m: EpaperMetrics,
  cell: Box,
  top: number,
  rows: number,
  ink: boolean,
): void {
  const scale = m.smallScale;
  const glyph = 8 * scale;
  const lineH = m.cellTitleLineH;
  const inset = m.cellInset;
  const width = cell.w - inset * 2;
  const foot = cell.y + cell.h - 2 * scale;
  let y = top;
  let drawn = 0;
  // `rows` is how many the cell has room for, worked out once by the caller;
  // the model carries a generous working set and this is where it is cut. The
  // guard below stays as the belt, the way `agendaRowsInBox` and the agenda
  // loop keep each other honest.
  for (const title of item.titles.slice(0, rows)) {
    if (y + glyph > foot) break;
    const line = fit(asciiTitle(title), width, { scale });
    if (line === '') break;
    drawText(fb, cell.x + inset, y, line, { scale, ink });
    y += lineH;
    drawn++;
  }
  // Say what did not fit rather than silently showing three of seven.
  const rest = item.eventCount - drawn;
  if (rest > 0 && y + glyph <= foot) {
    drawText(fb, cell.x + inset, y, fit(`+${rest}`, width, { scale }), { scale, ink });
  }
}

/**
 * Where the built-in layout's two blocks go on a panel.
 *
 * Pure, and separate from the drawing, for the reason `placement.ts` is on the
 * wall side: a rule about where a box lands, taken inside a draw call, is a rule
 * only a rendered frame can be asked about — and a test that has to recompute
 * the split to find the block it is measuring is a second opinion about the
 * layout, which is this project's most repeated bug in miniature.
 */
export function epaperBlocks(weeks: number, m: EpaperMetrics): { readonly agenda: Box; readonly month: Box } {
  const { width, height } = m.panel;
  const bodyTop = m.headerHeight + m.headerGap;
  const bodyBottom = height - m.margin;
  const bodyH = bodyBottom - bodyTop;

  if (width >= height) {
    // Landscape: agenda left, month grid right. The agenda gets the larger
    // share — event titles need the width more than the grid does, and the
    // grid stays legible down to ~44px cells.
    const split = Math.round(width * 0.54);
    return {
      agenda: { x: m.margin, y: bodyTop, w: split - m.margin * 2, h: bodyH },
      month: { x: split, y: bodyTop, w: width - split - m.margin, h: bodyH },
    };
  }

  /*
   * Portrait: agenda over the grid, and the *grid* is what sizes the split.
   *
   * It used to be a flat 42% to the agenda, which left the month a box its
   * square cells could not fill — 76px of white under the last week on a
   * 480×800 panel, because a cell is bound by a seventh of the width and the
   * box was taller than seven of those. Stacked, that is a solvable problem the
   * two-column landscape does not have: ask the grid what it needs (a square
   * cell is `width / 7`), give it exactly that, and let the agenda have the
   * rest. So a portrait panel keeps square cells *and* reaches its own bottom
   * edge, where landscape has to give up one to get the other.
   *
   * The floor is what stops a wide portrait canvas — where a seventh of the
   * width is most of the height — leaving the agenda a sliver. There the grid is
   * height-bound again and fills whatever box it is handed, cells and all, which
   * is `drawMonthBox`'s ordinary behaviour rather than a case.
   */
  const cellW = Math.max(m.minCell, Math.floor((width - m.margin * 2) / 7));
  const monthWants = m.monthHeadH + Math.max(1, weeks) * cellW;
  const floor = m.agendaHeadH + m.agendaRowH * 2;
  const agendaH = Math.max(floor, bodyH - m.blockGap - monthWants);
  const monthTop = bodyTop + agendaH + m.blockGap;
  return {
    agenda: { x: m.margin, y: bodyTop, w: width - m.margin * 2, h: agendaH },
    month: { x: m.margin, y: monthTop, w: width - m.margin * 2, h: bodyBottom - monthTop },
  };
}

/** Render the model to a framebuffer sized to the panel. */
export function renderEpaper(model: EpaperModel, geometry: PanelGeometry): Framebuffer {
  const m = panelMetrics(geometry);
  const fb = new Framebuffer(m.panel.width, m.panel.height);
  drawHeader(fb, model, m);
  const blocks = epaperBlocks(model.weeks.length, m);
  drawAgendaBox(fb, model, m, blocks.agenda, 'TODAY');
  drawMonthBox(fb, model, m, blocks.month);
  return fb;
}
