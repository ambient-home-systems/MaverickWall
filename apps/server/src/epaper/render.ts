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
import { DENSITY_STEPS, densitySteps, monthSpans, type MonthSpan } from './month-spans.js';
import { drawText, measureText, type TextOptions } from './font.js';
import { Framebuffer } from './framebuffer.js';
import type { EpaperGridCell, EpaperModel } from './viewmodel.js';

export interface PanelGeometry {
  readonly width: number;
  readonly height: number;
}

/** A pixel rectangle on the framebuffer. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const MARGIN = 16;
const HEADER_H = 54;

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

/**
 * Today's agenda within a box.
 *
 * `header` draws a labelled rule at the top (the fixed layout's "TODAY"); a
 * widget passes none because its own title bar is drawn by the freeform frame.
 */
export function drawAgendaBox(fb: Framebuffer, model: EpaperModel, box: Box, header?: string): void {
  const x0 = box.x;
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  let y = box.y;
  if (header !== undefined) {
    drawText(fb, x0, y, header, { scale: 2, tracking: 2 });
    fb.hLine(x0, right, y + 22, true);
    y += 36;
  }
  const rowH = 34;
  const timeColW = measureText('00:00', { scale: 2 }) + 12;
  if (model.agenda.length === 0) {
    // Sized to the box, for the same reason as the upcoming list below.
    const note = 'Nothing on today';
    const scale = measureText(note, { scale: 2 }) <= box.w ? 2 : 1;
    drawText(fb, x0, y, fit(note, box.w, { scale }), { scale });
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
    drawText(fb, titleX, y, fit(asciiTitle(item.title), right - titleX, { scale: 2 }), { scale: 2 });
    y += rowH;
  }
  if (model.agendaOverflow > 0 && y + 12 <= bottom) {
    drawText(fb, x0 + 20, y, `+${model.agendaOverflow} more`, { scale: 1, tracking: 1 });
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
  box: Box,
  options: { readonly calendars?: readonly string[]; readonly count?: number } = {},
): void {
  const keep = options.calendars ?? [];
  const limit = options.count !== undefined && options.count >= 1 ? Math.min(50, Math.trunc(options.count)) : 12;
  const rows = model.upcoming
    .filter((item) => keep.length === 0 || keep.includes(item.sourceId))
    .slice(0, limit);

  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const timeColW = measureText('00:00', { scale: 2 }) + 12;
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
    const scale = measureText(note, { scale: 2 }) <= box.w ? 2 : 1;
    drawText(fb, box.x, y, fit(note, box.w, { scale }), { scale });
    return;
  }
  let heading: CivilDate | undefined;
  for (const item of rows) {
    // A date rule where the day turns over, so a list spanning days reads as
    // days rather than as one run of times.
    if (item.date !== heading) {
      if (y + 12 > bottom) break;
      const label = item.isToday ? 'TODAY' : dayLabel(item.date);
      drawText(fb, box.x, y, label, { scale: 1, tracking: 1 });
      fb.hLine(box.x, right, y + 10, true);
      y += 16;
      heading = item.date;
    }
    if (y + 16 > bottom) break;
    if (item.allDay) fb.strokeRect(box.x, y + 2, 12, 12, true);
    else fb.fillRect(box.x, y + 2, 12, 12, true);
    let titleX = box.x + 20;
    if (!item.allDay) {
      drawText(fb, box.x + 20, y, item.time, { scale: 2 });
      titleX = box.x + 20 + timeColW;
    }
    drawText(fb, titleX, y, fit(asciiTitle(item.title), right - titleX, { scale: 2 }), { scale: 2 });
    y += 30;
  }
}

/**
 * The coming seven days as columns — the widget's "Week columns".
 *
 * Built from the grid row that contains today, so it follows the household's
 * week start exactly as the month does rather than inventing a second answer
 * to "when does a week begin".
 */
export function drawWeekBox(fb: Framebuffer, model: EpaperModel, box: Box): void {
  const row = model.weeks.find((week) => week.some((cell) => cell.isToday)) ?? model.weeks[0];
  if (row === undefined) return;
  const colW = Math.floor(box.w / 7);
  const headH = 26;
  for (let c = 0; c < 7; c++) {
    const cell = row[c]!;
    const x = box.x + c * colW;
    // The day's head: its letter and its number, inverted for today so the
    // column somebody is standing in front of is findable across a kitchen.
    if (cell.isToday) fb.fillRect(x, box.y, colW, headH, true);
    const label = `${model.weekdayLabels[c] ?? ''} ${cell.day}`;
    const lw = measureText(label, { scale: 2 });
    drawText(fb, x + Math.max(2, Math.floor((colW - lw) / 2)), box.y + 4, label, {
      scale: 2,
      ink: !cell.isToday,
    });
    fb.strokeRect(x, box.y, colW, box.h, true);

    let y = box.y + headH + 4;
    let drawn = 0;
    for (const event of cell.events) {
      if (y + 8 > box.y + box.h - 2) break;
      const line = fit(asciiTitle(event.title), colW - 6, { scale: 1 });
      if (line === '') break;
      drawText(fb, x + 3, y, line, { scale: 1 });
      y += 11;
      drawn++;
    }
    const rest = cell.eventCount - drawn;
    if (rest > 0 && y + 8 <= box.y + box.h - 2) drawText(fb, x + 3, y, `+${rest}`, { scale: 1 });
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

/**
 * The smallest cell that can hold a labelled event under its day number:
 * the number's own line plus one 8px row, with a pixel either side.
 */
const PILL_MIN_CELL = 34;

/**
 * One span lane: the bar itself, and the pixels under it before the next.
 *
 * The panel *predicts* rather than measures, which is the standing difference
 * between the two renderers and is why this is a constant here and a `calc()`
 * on the wall: `drawText` owns its line heights, so how tall a bar must be to
 * hold a scale-1 title is arithmetic rather than a question for a browser.
 */
const SPAN_BAR_H = 10;
const SPAN_LANE_H = SPAN_BAR_H + 2;

/** The density mark: a hairline whose length steps with the day's count. */
const MARK_H = 3;
const MARK_GAP = 3;

/** The rolling month grid within a box. */
export function drawMonthBox(fb: Framebuffer, model: EpaperModel, box: Box, options: MonthOptions = {}): void {
  const weeks = model.weeks.length;
  const labelH = 22;
  const gridTop = box.y + labelH;
  const cell = Math.max(12, Math.floor(Math.min(box.w / 7, (box.y + box.h - gridTop) / weeks)));
  const gridW = cell * 7;
  const gx = box.x + Math.floor((box.w - gridW) / 2);
  const pills = options.pills === true && cell >= PILL_MIN_CELL;
  // Deliberately not conditioned on `pills`: the day number is the thing a
  // person scans for, and having it change size because a household ticked
  // "labelled pills" is a surprise. It also keeps the setting honest — with
  // nothing on any day, dots and pills draw the identical frame, so the only
  // thing the switch can change is whether the events are named.
  const numScale = cell >= 34 ? 2 : 1;

  // Weekday labels, centred over their columns.
  for (let c = 0; c < 7; c++) {
    const label = model.weekdayLabels[c] ?? '';
    const w = measureText(label, { scale: 2 });
    drawText(fb, gx + c * cell + Math.floor((cell - w) / 2), box.y, label, { scale: 2 });
  }

  /*
   * Which multi-day events are one bar, resolved exactly as the wall resolves
   * them — `month-spans.ts` is the wall's own reading, transcribed, and
   * `month-spans-parity.test.ts` holds the two files to each other. A panel
   * following a wall has to draw the same month, and "the same month" now
   * includes which events are a bar and which are rows.
   *
   * Only where names are drawn at all: the unlabelled treatment answers "how
   * busy" with dither and never says what is on, so a bar there would be a
   * coloured band with nothing in it.
   *
   * The events go in without a colour, because a panel has no hue to give one.
   * `SpanEvent` asks for it because the wall needs it, and answering with the
   * empty string is more honest than inventing a value the renderer would then
   * have to ignore.
   */
  const laneTop = 4 + 8 * numScale + 2;
  /*
   * How many lanes a cell can actually afford, which the wall has to *measure*
   * and this can work out: the room under the number, less a pixel of ground,
   * over the height of a lane. A bar drawn past that would run into the week
   * below — the one failure a month grid must never have — and an event whose
   * lane does not fit simply goes back to being a row in each of its cells,
   * which is what every multi-day event was until now.
   */
  const maxLanes = pills ? Math.max(0, Math.floor((cell - laneTop - 2) / SPAN_LANE_H)) : 0;
  const spans =
    maxLanes > 0
      ? monthSpans(
          model.weeks.map((week) =>
            week.map((item) => item.events.map((event) => ({ ...event, color: '' }))),
          ),
        )
      : undefined;

  for (let r = 0; r < weeks; r++) {
    const bars = (spans?.[r]?.bars ?? []).filter((bar) => bar.lane < maxLanes);
    // What each column's cell must not repeat, taken from the bars that will
    // actually be drawn rather than from what `monthSpans` proposed.
    const covered: string[][] = [[], [], [], [], [], [], []];
    for (const bar of bars) {
      for (let c = bar.column; c < bar.column + bar.span; c++) (covered[c] ?? []).push(bar.id);
    }
    for (let c = 0; c < 7; c++) {
      const item = model.weeks[r]![c]!;
      const x = gx + c * cell;
      const y = gridTop + r * cell;
      if (item.isToday) {
        fb.fillRect(x, y, cell, cell, true); // the lit cell
      } else if (!pills) {
        // Shading is the *unlabelled* answer to "how busy is this day". With
        // the names drawn in the cell they are the density, and dither behind
        // them is ink under ink — the thing that makes 1-bit text unreadable.
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
        if (!pills && densityOf(item) > 0) fb.fillRect(nx - 1, ny - 1, measureText(num, { scale: numScale }) + 2, 8 * numScale + 2, false);
        drawText(fb, nx, ny, num, { scale: numScale });
      }
      // Today's cell is filled, so its names are knocked out of it exactly as
      // its number is. Drawn in ink they were black on black — invisible on
      // the one cell somebody actually walks over to read.
      if (pills) {
        let top = y + laneTop + laneRowsAt(bars, c) * SPAN_LANE_H;
        top = drawDensityMark(fb, item, { x, y, w: cell, h: cell }, top, !item.isToday);
        drawCellTitles(fb, item, { x, y, w: cell, h: cell }, top, !item.isToday, covered[c] ?? []);
      }
    }
    /*
     * The bars last, over the cells they cross.
     *
     * A pixel of clear ground around each one, which does two jobs for the
     * price of one `fillRect`: it separates the bar from the cell borders it
     * runs over, so a week reads as one object rather than as three boxes with
     * ink in them — and it is the *only* thing that makes a bar visible where
     * it crosses today, whose whole cell is filled and would otherwise swallow
     * an ink bar completely.
     */
    for (const bar of bars) {
      const bx = gx + bar.column * cell + 1;
      const bw = bar.span * cell - 2;
      const by = gridTop + r * cell + laneTop + bar.lane * SPAN_LANE_H;
      fb.fillRect(bx - 1, by - 1, bw + 2, SPAN_BAR_H + 2, false);
      fb.fillRect(bx, by, bw, SPAN_BAR_H, true);
      // Only the first bar of a run carries the words; a continuation is the
      // same event still being true, and saying so again is the repetition the
      // whole rule exists to end.
      if (bar.leading) {
        drawText(fb, bx + 3, by + 1, fit(asciiTitle(bar.title), bw - 6, { scale: 1 }), {
          scale: 1,
          ink: false,
        });
      }
    }
  }
}

/** How many lanes are reserved above the cell in column `c`. */
function laneRowsAt(bars: readonly MonthSpan[], column: number): number {
  let lanes = 0;
  for (const bar of bars) {
    if (column < bar.column || column >= bar.column + bar.span) continue;
    lanes = Math.max(lanes, bar.lane + 1);
  }
  return lanes;
}

/**
 * The density mark under the day number: how busy the day is, in ink alone.
 *
 * The wall's own, at 1 bit. It is the answer for a cell too small to name
 * anything — which on a panel is most of them — and it is what the labelled
 * treatment had *nothing* of: dither is the unlabelled mode's density and is
 * deliberately not drawn behind names, so a named month said how busy a day
 * was only by how many lines happened to fit.
 *
 * Returns where the titles may start, so a cell with no mark loses nothing.
 */
function drawDensityMark(
  fb: Framebuffer,
  item: EpaperGridCell,
  cell: Box,
  top: number,
  ink: boolean,
): number {
  const steps = densitySteps(item.eventCount);
  if (steps <= 0) return top;
  const inset = 3;
  const width = Math.max(2, Math.round(((cell.w - inset * 2) * steps) / DENSITY_STEPS));
  if (top + MARK_H > cell.y + cell.h - 2) return top;
  fb.fillRect(cell.x + inset, top, width, MARK_H, ink);
  return top + MARK_H + MARK_GAP;
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
  cell: Box,
  top: number,
  ink: boolean,
  covered: readonly string[],
): void {
  const lineH = 10;
  const inset = 3;
  const width = cell.w - inset * 2;
  const bottom = cell.y + cell.h - 2;
  // Everything a bar is not already drawing. By id, which is the same on every
  // date the event touches; by title it would take an unrelated "Bin day" with
  // it.
  const rows = item.events.filter((event) => covered.indexOf(event.id) < 0);
  const lines: { text: string; y: number }[] = [];
  let y = top;
  for (const event of rows) {
    if (y + 8 > bottom) break;
    const line = fit(asciiTitle(event.title), width, { scale: 1 });
    if (line === '') break;
    lines.push({ text: line, y });
    y += lineH;
  }
  /*
   * A cell that can draw no name draws no counter either.
   *
   * "+3" alone is a number with no subject — the cell's whole content is a
   * claim about something it never says. Measured at 800x480, thirteen cells
   * drew exactly that. The density mark above is what such a cell shows
   * instead: it is already there, it needs no legible text, and it says the
   * one thing the "+3" was saying.
   */
  if (lines.length === 0) return;
  /*
   * And the counter shares the last line rather than taking one.
   *
   * It used to sit on a line of its own, out of the same budget as the names,
   * so a cell with room for one row could spend it on the count. Hard right on
   * the last name's line costs no row at all; the name it shares with gives up
   * the width instead, which on 1 bit is a truncation the panel already does
   * everywhere and never a name lost.
   */
  const rest = item.eventCount - lines.length - covered.length;
  if (rest > 0) {
    const tag = `+${rest}`;
    const tagWidth = measureText(tag, { scale: 1 });
    const last = lines[lines.length - 1] as { text: string; y: number };
    const source = rows[lines.length - 1];
    if (source !== undefined) {
      last.text = fit(asciiTitle(source.title), Math.max(0, width - tagWidth - 4), { scale: 1 });
    }
    drawText(fb, cell.x + cell.w - inset - tagWidth, last.y, tag, { scale: 1, ink });
  }
  for (const line of lines) drawText(fb, cell.x + inset, line.y, line.text, { scale: 1, ink });
}

/** Render the model to a framebuffer sized to the panel. */
export function renderEpaper(model: EpaperModel, geometry: PanelGeometry): Framebuffer {
  const { width, height } = geometry;
  const fb = new Framebuffer(width, height);
  drawHeader(fb, model, width);

  const bodyTop = HEADER_H + 14;
  const bodyBottom = height - MARGIN;

  const bodyH = bodyBottom - bodyTop;
  if (width >= height) {
    // Landscape: agenda left, month grid right. The agenda gets the larger
    // share — event titles need the width more than the grid does, and the
    // grid stays legible down to ~44px cells.
    const split = Math.round(width * 0.54);
    drawAgendaBox(fb, model, { x: MARGIN, y: bodyTop, w: split - MARGIN * 2, h: bodyH }, 'TODAY');
    drawMonthBox(fb, model, { x: split, y: bodyTop, w: width - split - MARGIN, h: bodyH });
  } else {
    // Portrait: agenda over the grid. The grid takes the lower two-thirds,
    // which is enough for whole weeks and keeps today's list at eye height.
    const agendaH = Math.round(bodyH * 0.42);
    drawAgendaBox(fb, model, { x: MARGIN, y: bodyTop, w: width - MARGIN * 2, h: agendaH }, 'TODAY');
    drawMonthBox(fb, model, {
      x: MARGIN,
      y: bodyTop + agendaH + 12,
      w: width - MARGIN * 2,
      h: bodyBottom - (bodyTop + agendaH + 12),
    });
  }
  return fb;
}
