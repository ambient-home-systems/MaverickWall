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
 *
 * ## The refresh contract (RFC 006 phase 11)
 *
 * An e-paper panel can update part of a sheet, and a partial refresh is the
 * difference between a frame that appears and a frame that flashes the whole
 * screen black and back. What it needs from a renderer is not speed, it is
 * **stability**: it has to know which rectangle changed, and it can only know
 * that if the rectangles do not move.
 *
 *     Every drawn region is a rectangle whose position is a function of
 *     (panel size, tier) ONLY.
 *
 *     Two frames at the same panel size and tier, with different events,
 *     have identical region rectangles.
 *
 *     Only the ink inside a region may differ.
 *
 * Three consequences, and each of them is a rule somewhere below rather than an
 * aspiration.
 *
 * **A size is never picked by measuring a string.** Every rung on this frame
 * comes from the panel's tier (`type-tiers.ts`) or from the box, and where a
 * rung still has to be stepped down it is stepped against a *character budget*
 * — `HEADER_MAX_CHARS`, `NOTE_MAX_CHARS`, `'30'` — which is a constant of this
 * renderer and of the locale the viewmodel fixes, never of the household's
 * calendar. The two that were not are the ones this phase repaired: the
 * empty-state note picked scale 2 or 1 from its own sentence's width (so the
 * two notes could be drawn at different sizes in the same box, and rewording
 * one would have moved a rectangle), and the header band shrank to fit today's
 * date (so the band's type changed size at midnight — a reflow at exactly the
 * boundary a panel most wants to partial-refresh across).
 *
 * **`fit()` stays, and is legitimate.** Truncating a title changes the ink
 * inside a rectangle and never the rectangle: it can only shorten a run, never
 * move its origin and never change the line height. That is the one
 * content-dependent thing left in this file, it is stated here rather than
 * hidden, and `reflow-stability.test.ts` holds every truncated run to the
 * rectangle it was given.
 *
 * **The tier is in the ETag.** `frame.ts` puts the resolved tier in the
 * preimage, so a geometry change forces exactly one full refresh and everything
 * between two frames at the same tier is safe to draw as a partial. Without it
 * a panel could composite two layouts onto one sheet.
 *
 * What this does **not** claim: `widgets.ts` — the free-form canvas — still
 * sizes a few headlines with `scaleToFit`, which reads the string. The built-in
 * layout satisfies the contract; a household's own canvas does not yet, and
 * saying so is better than a half-fix.
 */
import type { CivilDate } from '@maverick-wall/core';

import { ditherRect } from './dither.js';
import { DENSITY_STEPS, densitySteps, monthSpans, type MonthSpan } from './month-spans.js';
import { drawText, measureText, rungStep, type TextOptions, type TypeRung } from './font.js';
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
import {
  namesAt,
  spanIsLabelled,
  tierFor,
  weekdayHead,
} from './tiers.js';
import type { EpaperGridCell, EpaperModel } from './viewmodel.js';

export type { PanelGeometry } from './metrics.js';

/** A pixel rectangle on the framebuffer. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * One rectangle this frame drew into, and what it was.
 *
 * The refresh contract above is a claim about rectangles, and a claim about
 * rectangles cannot be settled from pixels: two frames with different words in
 * the same row have different ink in it by definition, and a row that *moved*
 * looks the same from the outside as a row whose first letter happens to be a
 * lowercase 'a'. So the renderer says where it drew.
 *
 * **It is not a prediction and it must not become one.** Every entry below is
 * pushed at the site that does the drawing, from the same expression that
 * positions it, which is what makes `regions(A) == regions(B)` a real test: a
 * position computed from content moves the record with the ink. What would be
 * circular is comparing a record against an independently-predicted value, and
 * nothing does that — `reflow-stability.test.ts` compares two frames with each
 * other, checks that their pixels genuinely differ, and checks that every run
 * of ink lands inside the rectangle it was recorded under.
 *
 * The name is positional (`cell-row:2:3:1`), never content-derived, so the two
 * lists are comparable at all.
 */
export interface DrawnRegion {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Where a caller collects them. Absent means the renderer records nothing. */
export type RegionLog = DrawnRegion[];

const note = (log: RegionLog | undefined, name: string, x: number, y: number, w: number, h: number): void => {
  if (log !== undefined) log.push({ name, x, y, w, h });
};

/**
 * The width `chars` characters occupy at these options.
 *
 * The refresh contract's workhorse: every step-down below asks this rather than
 * measuring the string it is about to draw, so the answer is a fact about the
 * panel and the tier instead of a fact about today's calendar.
 */
function runWidth(chars: number, options: TextOptions): number {
  return measureText('0'.repeat(Math.max(0, chars)), options);
}

/**
 * The longest date line the header band can ever draw.
 *
 * `headerParts` formats en-GB with `weekday: 'long'` and `month: 'long'`, so
 * the worst case is `WEDNESDAY 30 SEPTEMBER` — 22 characters. A constant of the
 * renderer, which is what lets the band be one size all year (see `drawHeader`).
 */
const HEADER_MAX_CHARS = 22;

/** The two empty-state notes this frame draws, and the longest of them. */
const EMPTY_TODAY = 'Nothing on today';
const EMPTY_UPCOMING = 'Nothing coming up';
const NOTE_MAX_CHARS = Math.max(EMPTY_TODAY.length, EMPTY_UPCOMING.length);

/**
 * The rung an empty-state note is drawn at, from the box and the tier.
 *
 * It used to be `measureText(note, body) <= box.w ? body : small`, measured on
 * each note's own sentence — so "Nothing on today" and "Nothing coming up"
 * could take different rungs in the same box, and a reworded note would have
 * moved a rectangle. It asks the *longest* note this renderer draws now, which
 * makes the answer a property of the box: both notes land on one rung, and the
 * rung a box affords is the same on every frame that box is drawn in.
 *
 * `fit` is still the belt underneath, for the reason the upcoming list gives:
 * in a column too narrow even for the small rung, a truncated line beats a line
 * lying across the widget next door.
 */
function noteRung(boxW: number, m: EpaperMetrics): TypeRung {
  return runWidth(NOTE_MAX_CHARS, { rung: m.body }) <= boxW ? m.body : m.small;
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

function drawHeader(fb: Framebuffer, model: EpaperModel, m: EpaperMetrics, log?: RegionLog): void {
  const width = m.panel.width;
  fb.fillRect(0, 0, width, m.headerHeight, true);
  note(log, 'header', 0, 0, width, m.headerHeight);
  const left = `${model.header.weekday.toUpperCase()} ${model.header.day} ${model.header.month.toUpperCase()}`;
  // Step the scale down until the date fits the band with room for the year.
  // The starting rung is the panel's, not a literal 3 — but the step-down is
  // unchanged, because a long weekday in a narrow band is a width problem and
  // no amount of deriving from the height can see it.
  const yearText = model.header.year;
  const yearW = measureText(yearText, { rung: m.year });
  const budget = width - 2 * m.margin - yearW - m.bodyGlyph;
  /*
   * Stepped down to the *budget*, never to today's date.
   *
   * It used to measure `left` and shrink until that particular string fitted,
   * which is a band whose type changes size at midnight — a reflow at exactly
   * the boundary an e-paper panel is meant to partial-refresh across, and one
   * no test comparing two frames on the same day can see. The budget and the
   * longest line this locale can produce are both facts about the renderer, so
   * the band is one size for every day of the year and `fit` stays as the belt.
   */
  let rung = m.header;
  while (rung.index > 0 && runWidth(HEADER_MAX_CHARS, { rung, tracking: 1 }) > budget) {
    rung = rungStep(rung, -1);
  }
  const y = Math.floor((m.headerHeight - rung.height) / 2);
  note(log, 'header-date', m.margin, y, budget, rung.height);
  drawText(fb, m.margin, y, fit(left, budget, { rung, tracking: 1 }), { rung, tracking: 1, ink: false });
  const yearY = Math.floor((m.headerHeight - m.year.height) / 2);
  note(log, 'header-year', width - m.margin - yearW, yearY, yearW, m.year.height);
  drawText(fb, width - m.margin - yearW, yearY, yearText, { rung: m.year, ink: false });
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
  log?: RegionLog,
): void {
  const x0 = box.x;
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const body = m.body;
  let y = box.y;
  note(log, 'agenda', box.x, box.y, box.w, box.h);
  if (header !== undefined) {
    note(log, 'agenda-head', x0, y, right - x0, m.agendaHeadH);
    drawText(fb, x0, y, header, { rung: body, tracking: 2 });
    // `right` is the box's exclusive edge and `hLine` is inclusive, so the last
    // argument is `right - 1`. It was `right` — a one-pixel rule overhang into
    // the gutter between the agenda and the month grid, which is outside the
    // rectangle this section records and so outside the refresh contract. Found
    // by asserting the gutters carry no ink at all.
    fb.hLine(x0, right - 1, y + m.agendaRuleY, true);
    y += m.agendaHeadH;
  }
  // The gutter past the time column is one bullet wide, which is what the
  // shipped 12 was beside a 12px bullet — stated rather than left as two
  // constants that happened to agree.
  const timeColW = measureText('00:00', { rung: body }) + m.bullet;
  if (model.agenda.length === 0) {
    const rung = noteRung(box.w, m);
    note(log, 'agenda-note', x0, y, box.w, rung.height);
    drawText(fb, x0, y, fit(EMPTY_TODAY, box.w, { rung }), { rung });
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
    note(log, `agenda-row:${drawn}`, x0, y, right - x0, m.bodyGlyph);
    // The bullet carries the all-day/timed distinction — an open square for a
    // day-long thing, a filled one for a timed event — so an all-day title need
    // not spend width on the words "All day" and starts where the time would.
    if (item.allDay) fb.strokeRect(x0, y + m.bulletDrop, m.bullet, m.bullet, true);
    else fb.fillRect(x0, y + m.bulletDrop, m.bullet, m.bullet, true);
    const textX = x0 + m.bullet + m.bulletGap;
    let titleX = textX;
    if (!item.allDay) {
      drawText(fb, textX, y, item.time, { rung: body });
      titleX = textX + timeColW;
    }
    drawText(fb, titleX, y, fit(asciiTitle(item.title), right - titleX, { rung: body }), { rung: body });
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
  const smallGlyph = m.smallGlyph;
  if (overflow > 0 && y + Math.round(smallGlyph * 1.5) <= bottom) {
    note(log, 'agenda-more', x0 + m.bullet + m.bulletGap, y, right - x0, smallGlyph);
    drawText(fb, x0 + m.bullet + m.bulletGap, y, `+${overflow} more`, { rung: m.small, tracking: 1 });
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

  const body = m.body;
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const timeColW = measureText('00:00', { rung: body }) + m.bullet;
  let y = box.y;
  if (rows.length === 0) {
    const rung = noteRung(box.w, m);
    drawText(fb, box.x, y, fit(EMPTY_UPCOMING, box.w, { rung }), { rung });
    return;
  }
  let heading: CivilDate | undefined;
  for (const item of rows) {
    // A date rule where the day turns over, so a list spanning days reads as
    // days rather than as one run of times.
    if (item.date !== heading) {
      if (y + Math.round(m.smallGlyph * 1.5) > bottom) break;
      const label = item.isToday ? 'TODAY' : dayLabel(item.date);
      drawText(fb, box.x, y, label, { rung: m.small, tracking: 1 });
      // Exclusive edge, inclusive line — see `drawAgendaBox`.
      fb.hLine(box.x, right - 1, y + m.dateRuleY, true);
      y += m.dateRuleH;
      heading = item.date;
    }
    if (y + m.bodyGlyph > bottom) break;
    if (item.allDay) fb.strokeRect(box.x, y + m.bulletDrop, m.bullet, m.bullet, true);
    else fb.fillRect(box.x, y + m.bulletDrop, m.bullet, m.bullet, true);
    const textX = box.x + m.bullet + m.bulletGap;
    let titleX = textX;
    if (!item.allDay) {
      drawText(fb, textX, y, item.time, { rung: body });
      titleX = textX + timeColW;
    }
    drawText(fb, titleX, y, fit(asciiTitle(item.title), right - titleX, { rung: body }), { rung: body });
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
  const small = m.small;
  const smallGlyph = m.smallGlyph;
  const inset = m.cellInset;
  const foot = box.y + box.h - Math.round(smallGlyph / 4);
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
    const lw = measureText(label, { rung: m.label });
    drawText(fb, x + Math.max(2, Math.floor((colW - lw) / 2)), box.y + m.pad, label, {
      rung: m.label,
      ink: !cell.isToday,
    });
    fb.strokeRect(x, box.y, colW, box.h, true);

    let y = top;
    let drawn = 0;
    for (const event of cell.events.slice(0, fits)) {
      if (y + smallGlyph > foot) break;
      const line = fit(asciiTitle(event.title), colW - inset * 2, { rung: small });
      if (line === '') break;
      drawText(fb, x + inset, y, line, { rung: small });
      y += m.weekTitleLineH;
      drawn++;
    }
    const rest = cell.eventCount - drawn;
    if (rest > 0 && y + smallGlyph <= foot) drawText(fb, x + inset, y, `+${rest}`, { rung: small });
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
  log?: RegionLog,
): void {
  note(log, 'month', box.x, box.y, box.w, box.h);
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
  /*
   * What this cell affords, from the tier table the wall reads (`tiers.ts`).
   *
   * It replaces `pillMinCell`/`pillMinWidth`, which asked the two halves of the
   * same question separately and asked the width half far too gently: 32px is
   * three and a half characters of this font, so on every panel in the range a
   * household who asked for labelled cells got "Denti" and "Assem" — a
   * truncation this project's own rule calls a *different string* rather than a
   * shortened title, and one the wall stopped drawing when flat names replaced
   * pills. Measured, the built-in layout's cells are 3.8 to 9.7 characters
   * wide, which is the whole of why they draw a density mark now.
   *
   * The pair also disagreed with the wall it follows: at 800x480 the wall draws
   * no names in a cell of that size and the panel drew four. One stored value,
   * two renderers, two answers — the fault this seam exists to end.
   *
   * A character here is the rung's own advance — its cell plus one pixel of
   * tracking — so the two measurements the table needs are arithmetic rather
   * than a probe. It is a *face* measurement now rather than `8 + 1` times a
   * multiplier, which is why a 13.3" panel's names got half again as tall
   * without costing the cell a single character.
   */
  const cellEm = m.smallGlyph;
  const cellCh = m.small.advance;
  // Deliberately not conditioned on `pills`: the day number is the thing a
  // person scans for, and having it change size because a household ticked
  // "labelled pills" is a surprise. It also keeps the setting honest — with
  // nothing on any day, dots and pills draw the identical frame, so the only
  // thing the switch can change is whether the events are named.
  /*
   * Two scales, and keeping them apart is what stops one guard moving another
   * rule's arithmetic.
   *
   * `assumedNumScale` is the rung `pillMinCell` is *derived from* — its whole
   * definition is the number's line plus one row of name — so every vertical
   * decision below reads it: the lane top, the room for names, the threshold
   * itself. `numScale` is what actually gets drawn, which may be a rung lower
   * when the numeral would otherwise run through its own cell's right border.
   *
   * Folding the two together looked tidier and was wrong: at a cell of exactly
   * `pillMinCell` the numeral does not fit its width, so the drawn rung
   * dropped, the band shrank by a line, and a cell the "no name, no counter"
   * rule is calibrated on suddenly had room for a name — which turned that
   * rule's own test red. A width guard should stop a numeral overflowing and
   * change nothing else.
   */
  const assumedNum = Math.min(grid.cellH, grid.cellW) >= m.pillMinCell ? rungStep(m.small, 1) : m.small;
  const numRung = fitNumberRung(assumedNum, grid.cellW - m.cellNumberInset * 2);
  const cellFoot = Math.round(m.smallGlyph / 4);
  const numberBand = m.cellNumberInset + assumedNum.height + cellFoot;

  const tier = tierFor(grid.cellW - m.cellInset * 2, grid.cellH - numberBand - cellFoot, cellCh, cellEm);
  /*
   * The household's choice and the box's answer are two different things, and
   * folding them together is a fault this was written with for one commit.
   *
   * `named` is what the household asked for and decides the cell's *language*:
   * a named cell carries its density in a mark under the numeral, an unnamed
   * one shades the whole square with dither, and the two never appear together
   * because dither behind text is ink under ink. The tier decides only how many
   * names there are room for — which at M0 is none. Read as one flag, a cell
   * too narrow to name anything fell all the way back to the *dots* treatment:
   * it lost its mark, gained a shaded square, and `cellEvents` stopped moving
   * any ink at all, which is a control that does nothing.
   */
  const named = options.pills === true;
  /*
   * How many, still asked of the box that draws them — the tier says what the
   * cell affords and `cellTitlesInBox` says how many of the panel's own line
   * heights fit, and the count is the lesser. Two questions rather than one
   * because a count and the loop that draws it have to be the same arithmetic,
   * which is the rule `agendaRowsInBox` is written under.
   */
  const titleRows = Math.min(
    namesAt(tier, grid.cellH - numberBand - cellFoot, cellEm),
    cellTitlesInBox(grid.cellH - numberBand - cellFoot, m),
  );

  // Weekday labels, centred over their columns, cut to what the tier has room
  // for. The model carries both spellings for exactly this.
  for (let c = 0; c < 7; c++) {
    const long = model.weekdayLabelsLong[c] ?? model.weekdayLabels[c] ?? '';
    // The long name in both places: this locale's short weekday *is* its first
    // three letters, so cutting one spelling answers all three tiers and there
    // is no second array to fall out of step. At one letter that is the 'S' the
    // panel has always drawn.
    const label = weekdayHead(long, long, tier.weekdayLetters);
    const w = measureText(label, { rung: m.label });
    note(log, `month-head:${c}`, gx + c * grid.cellW, box.y, grid.cellW, m.label.height);
    drawText(fb, gx + c * grid.cellW + Math.floor((grid.cellW - w) / 2), box.y, label, { rung: m.label });
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
  const laneTop = numberBand;
  /*
   * How many lanes a cell can afford, which the wall has to *measure* and this
   * can work out: the room under the number, less a pixel of ground, over the
   * height of a lane. A bar drawn past that would run into the week below —
   * the one failure a month grid must never have — and an event whose lane
   * does not fit goes back to being a row in each of its cells.
   *
   * The lane is the panel's now rather than a flat 12, so a 13.3" panel gives
   * a bar a 16px title instead of the 8px one it drew under a 32px numeral.
   */
  const maxLanes =
    named && tier.spans
      ? Math.max(0, Math.floor((grid.cellH - laneTop - cellFoot) / m.spanLaneH))
      : 0;
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
      const x = gx + c * grid.cellW;
      const y = gridTop + r * grid.cellH;
      note(log, `cell:${r}:${c}`, x, y, grid.cellW, grid.cellH);
      if (item.isToday) {
        fb.fillRect(x, y, grid.cellW, grid.cellH, true); // the lit cell
      } else if (!named) {
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
        drawText(fb, nx, ny, num, { rung: numRung, ink: false });
      } else {
        if (!named && densityOf(item) > 0) {
          fb.fillRect(nx - 1, ny - 1, measureText(num, { rung: numRung }) + 2, numRung.height + 2, false);
        }
        drawText(fb, nx, ny, num, { rung: numRung });
      }
      // Today's cell is filled, so its names are knocked out of it exactly as
      // its number is. Drawn in ink they were black on black — invisible on
      // the one cell somebody actually walks over to read.
      if (named) {
        const cellBox: Box = { x, y, w: grid.cellW, h: grid.cellH };
        let top = y + laneTop + laneRowsAt(bars, c) * m.spanLaneH;
        // The mark first and always: at M0 it is the cell's whole answer, which
        // is the tier the wall's own grid draws at this size too.
        top = drawDensityMark(fb, item, m, cellBox, top, !item.isToday, log, `${r}:${c}`);
        drawCellTitles(fb, item, m, cellBox, top, titleRows, !item.isToday, covered[c] ?? [], log, `${r}:${c}`);
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
      const bx = gx + bar.column * grid.cellW + 1;
      const bw = bar.span * grid.cellW - 2;
      const by = gridTop + r * grid.cellH + laneTop + bar.lane * m.spanLaneH;
      note(log, `span:${r}:${bar.lane}:${bar.column}`, bx, by, bw, m.spanBarH);
      fb.fillRect(bx - 1, by - 1, bw + 2, m.spanBarH + 2, false);
      fb.fillRect(bx, by, bw, m.spanBarH, true);
      // Only the first bar of a run carries the words; a continuation is the
      // same event still being true, and saying so again is the repetition the
      // whole rule exists to end.
      /*
       * The words, and whether they are worth drawing is asked of the *bar* and
       * not of the cell under it — the one place the table is read against a
       * different box, and the wall's copy says why. A five-day bar on a panel
       * whose cells are four characters wide is twenty-six of its own, and
       * "Half term" is the only name either e-ink panel has ever had on its
       * grid.
       */
      if (bar.leading && spanIsLabelled(bw - m.cellInset * 2, cellCh)) {
        drawText(
          fb,
          bx + m.cellInset,
          by + Math.round(m.smallGlyph / 8),
          fit(asciiTitle(bar.title), bw - m.cellInset * 2, { rung: m.small }),
          { rung: m.small, ink: false },
        );
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
 * The density mark under a cell's numeral: a hairline whose length steps with
 * the day's count, so a cell with no room for a legible name still says how
 * busy it is. Sized to the panel rather than a flat 3px band.
 */
function drawDensityMark(
  fb: Framebuffer,
  item: EpaperGridCell,
  m: EpaperMetrics,
  cell: Box,
  top: number,
  ink: boolean,
  log?: RegionLog,
  at?: string,
): number {
  const steps = densitySteps(item.eventCount);
  if (steps <= 0) return top;
  const inset = m.cellInset;
  const width = Math.max(2, Math.round(((cell.w - inset * 2) * steps) / DENSITY_STEPS));
  if (top + m.markH > cell.y + cell.h - Math.round(m.smallGlyph / 4)) return top;
  /*
   * The *lane* rather than the bar, and the difference is the contract.
   *
   * The mark's own length steps with the day's count, so its ink is content —
   * what is not is the strip it is drawn in, which is the cell's inner width at
   * a fixed offset. Recording the ink here would say a rectangle moved every
   * time a household added an event to a Tuesday.
   */
  note(log, `cell-mark:${at ?? ''}`, cell.x + inset, top, cell.w - inset * 2, m.markH);
  fb.fillRect(cell.x + inset, top, width, m.markH, ink);
  return top + m.markH + m.markGap;
}

/**
 * Step the day number down the ladder until it fits its cell's width.
 *
 * Never needed while the cell was square and the number was one of two sizes:
 * a 50px cell holds "31" at 16px with room over. A cell that fills a tall
 * narrow column on a 13.3" panel is 116px wide with a 48px number in it, which
 * is one bad rounding from drawing through the cell beside it. `'30'` is a
 * constant of the renderer rather than the day being drawn — every date is two
 * characters wide or fewer, so the band is one size for every cell in the grid
 * and for every day of the month.
 */
function fitNumberRung(wanted: TypeRung, available: number): TypeRung {
  let rung = wanted;
  while (rung.index > 0 && measureText('30', { rung }) > available) rung = rungStep(rung, -1);
  return rung;
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
  maxRows: number,
  ink: boolean,
  covered: readonly string[],
  log?: RegionLog,
  at?: string,
): void {
  const rung = m.small;
  const glyph = m.smallGlyph;
  const lineH = m.cellTitleLineH;
  const inset = m.cellInset;
  const width = cell.w - inset * 2;
  const bottom = cell.y + cell.h - Math.round(glyph / 4);
  // Everything a bar is not already drawing. By id, which is the same on every
  // date the event touches; by title it would take an unrelated "Bin day" with
  // it.
  const rows = item.events.filter((event) => covered.indexOf(event.id) < 0);
  // `maxRows` is how many the cell has room for, worked out once by the caller
  // from the panel's own line height; the guard below stays as the belt, the
  // way `agendaRowsInBox` and the agenda loop keep each other honest.
  const lines: { text: string; y: number }[] = [];
  let y = top;
  for (const event of rows.slice(0, Math.max(0, maxRows))) {
    if (y + glyph > bottom) break;
    const line = fit(asciiTitle(event.title), width, { rung });
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
    const tagWidth = measureText(tag, { rung });
    const last = lines[lines.length - 1] as { text: string; y: number };
    const source = rows[lines.length - 1];
    if (source !== undefined) {
      last.text = fit(asciiTitle(source.title), Math.max(0, width - tagWidth - m.cellInset), { rung });
    }
    drawText(fb, cell.x + cell.w - inset - tagWidth, last.y, tag, { rung, ink });
  }
  lines.forEach((line, index) => {
    note(log, `cell-row:${at ?? ''}:${index}`, cell.x + inset, line.y, width, glyph);
    drawText(fb, cell.x + inset, line.y, line.text, { rung, ink });
  });
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

/**
 * Render the model to a framebuffer sized to the panel.
 *
 * `regions` is opt-in and costs nothing when it is absent: pass an array and
 * the frame records every rectangle it drew into, which is what
 * `reflow-stability.test.ts` compares between two frames. See `DrawnRegion`.
 */
export function renderEpaper(
  model: EpaperModel,
  geometry: PanelGeometry,
  regions?: RegionLog,
): Framebuffer {
  const m = panelMetrics(geometry);
  const fb = new Framebuffer(m.panel.width, m.panel.height);
  drawHeader(fb, model, m, regions);
  const blocks = epaperBlocks(model.weeks.length, m);
  drawAgendaBox(fb, model, m, blocks.agenda, 'TODAY', regions);
  drawMonthBox(fb, model, m, blocks.month, {}, regions);
  return fb;
}
