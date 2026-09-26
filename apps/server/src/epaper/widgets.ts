/**
 * The eInk widgets, each drawn into a box in 1-bit (RFC 006 phase 2).
 *
 * This is the 1-bit counterpart to the display bundle's `renderWidget`: the
 * household arranges the *same* `layout_widgets` a browser wall uses (fractional
 * boxes, per orientation, per screen), and here each widget type is drawn
 * server-side in one colour. The palette is deliberately the subset that reads
 * at 1-bit — colour, gradient, opacity and shadow are simply not honoured,
 * because there is no colour to honour them with.
 *
 * `weather`, `homeassistant` and `external` read their module's panel out of the
 * manifest with a tolerant reader rather than a bespoke parser: a module can
 * change a field and this degrades to fewer lines, never a crash on the one
 * screen the household is looking at (rule nine). Their richer, dedicated draws
 * are a later slice. `image` is a placeholder until there is a decoder — a
 * dithered photo is worth doing, but it is not free at 1-bit.
 */
import { daysBetween } from '@maverick-wall/core';

import {
  readingHandlesFor,
  readingIndexOf,
  todoListHandle,
  todoListOf,
  type Manifest,
} from '../api/manifest.js';

import { drawText, measureText, rungAtMost, rungStep, shorterRung, tallerRung, type TypeRung } from './font.js';
import { Framebuffer } from './framebuffer.js';
import {
  drawGlyph,
  glyphAdvance,
  glyphHeight,
  glyphScaleFor,
  isGlyphKey,
  GLYPH_CELL,
  type GlyphKey,
  type GlyphScale,
} from './glyphs.js';
import { panelMetrics, scaleRung, type EpaperMetrics, type PanelGeometry } from './metrics.js';
import {
  asciiTitle,
  drawMonthBox,
  drawUpcomingBox,
  drawWeekBox,
  fit,
  recordRegion,
  type Box,
  type RegionLog,
} from './render.js';
import {
  HOUSE_ROLES,
  SHIFT_ROLES,
  WEATHER_ROLES,
  dropToFit,
  ladderRows,
  houseLadder,
  pairsTemperatures,
  shiftLadder,
  weatherLadder,
  type LadderRole,
  type LadderRow,
  type ShiftField,
  type WeatherField,
} from './ladder.js';
import { calendarView } from './calendar-view.js';
import { shiftsShown } from './shift-style.js';
import { variantOf } from './variants.js';
import { withInk } from './honours.js';
import { childCells, groupChildren, topLevelWidgets } from './group-cells.js';
import { clockLabel, type EpaperModel } from './viewmodel.js';
import { drawAnalogueFace } from './clock-face.js';
import {
  TODAY_WORDS,
  countDigits,
  countdownFrom,
  countdownProgress,
  countdownWords,
  miniMonth,
  percentWords,
  ticketLine,
  todayInMonth,
  unitWords,
} from './countdown.js';

/**
 * A widget placed on the canvas: fractional box, plus its stored options.
 *
 * `id` and `parentId` are the group link (RFC 014 §5.1) and are carried only
 * where they mean something — an id on a group, a parent on a child — because
 * this list is serialised into the frame's ETag preimage (`frame.ts`), and a
 * key present on every widget would move every paired panel's ETag at one
 * image pull for canvases with no group on them. `toEpaperWidgets` is the one
 * place a stored row becomes one of these, so no route can drop the link.
 */
export interface PlacedEpaperWidget {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly id?: string;
  readonly parentId?: string;
}

/**
 * The stored rows of one canvas, as the panel draws them.
 *
 * Every route that hands a canvas to `renderScreenFrame` — the device's own
 * frame, the designer's backdrop, the two preview endpoints — used to map the
 * row by hand, four copies of one shape, and a field added to the row would
 * have to be added to all four or a group would reach one renderer and not
 * another. One mapping now. A config that is not an object reads as none, the
 * way each copy already read it.
 */
export function toEpaperWidgets(
  rows: readonly {
    readonly id: string;
    readonly type: string;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly z: number;
    readonly config?: unknown;
    readonly parentId?: string | undefined;
  }[],
): PlacedEpaperWidget[] {
  return rows.map((row) => ({
    type: row.type,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    z: row.z,
    config: row.config !== null && typeof row.config === 'object' ? (row.config as Record<string, unknown>) : {},
    ...(row.type === 'group' ? { id: row.id } : {}),
    ...(row.parentId !== undefined ? { parentId: row.parentId } : {}),
  }));
}

type Config = Readonly<Record<string, unknown>>;

const str = (c: Config, k: string): string | undefined => (typeof c[k] === 'string' ? (c[k] as string) : undefined);
const list = (c: Config, k: string): unknown[] => (Array.isArray(c[k]) ? (c[k] as unknown[]) : []);
const num = (c: Config, k: string): number | undefined =>
  typeof c[k] === 'number' && Number.isFinite(c[k]) ? (c[k] as number) : undefined;
/** A config array narrowed to its strings — a stranger's JSON reaches here. */
const strings = (c: Config, k: string): string[] | undefined => {
  const raw = list(c, k).filter((v): v is string => typeof v === 'string');
  return raw.length > 0 ? raw : undefined;
};
const alignOf = (c: Config): 'left' | 'center' | 'right' => {
  const a = str(c, 'align');
  return a === 'center' || a === 'right' ? a : 'left';
};

/** Greedy word wrap to a pixel width, in the bitmap font. */
function wrap(text: string, maxWidth: number, rung: TypeRung): string[] {
  const lines: string[] = [];
  for (const paragraph of asciiTitle(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (measureText(candidate, { rung }) <= maxWidth) line = candidate;
      else {
        if (line !== '') lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * The largest rung, down the ladder, at which `text` fits `width`.
 *
 * `drawLines` truncates a line to its box, so a rung picked from the box's
 * *height* alone silently loses characters off the right — a clock drawing
 * "08:3" for half past eight, which is not a smaller clock but a wrong one.
 * Every headline string picks its size through here, so the box shrinks the
 * type rather than the type losing its tail.
 *
 * **It walks `TYPE_RUNGS`, which is why that ladder is monotone in advance as
 * well as height.** Stepping down has to make a string *narrower*; a ladder
 * with `f8@5` on it (40px tall, 45px of advance) would sit between two rungs
 * where a step down widens the text, and this loop would never terminate
 * usefully.
 *
 * It is also the last content-dependent size on the panel and the refresh
 * contract in `render.ts` says so: the built-in layout takes every rung from
 * its tier, and a household's own canvas does not yet.
 */
/**
 * What a panel with an authored-but-empty canvas says.
 *
 * Word for word the wall's `canvas-empty` note, so a household looking at a
 * panel and the wall it follows is told one thing about one state rather than
 * two sentences they have to reconcile. "Wall" is the product's word for both
 * kinds — the Walls list holds panels too — so it needs no second wording here.
 */
const EMPTY_CANVAS = 'Nothing on this wall yet.';

function rungToFit(text: string, width: number, max: TypeRung): TypeRung {
  let rung = max;
  while (rung.index > 0 && measureText(text, { rung }) > width) rung = rungStep(rung, -1);
  return rung;
}

/**
 * Rows of differing sizes down a box, stopping at its foot — the 1-bit twin of
 * a card with a kicker, a headline and a detail line.
 */
function drawStack(
  fb: Framebuffer,
  m: EpaperMetrics,
  box: Box,
  rows: readonly StackRow[],
  align: 'left' | 'center' | 'right',
): void {
  let y = box.y;
  for (const row of rows) {
    /*
     * A glyph row is a drawing and takes its own height, never the type's.
     *
     * The room reserved for it and the room it occupies are the same
     * expression — `glyphHeight(scale)`, here and in the caller's `heightOf` —
     * which is the count-and-loop rule `drawPanel` states one widget along and
     * paid for by asking a module for four readings and drawing five.
     */
    if (row.glyph !== undefined) {
      const h = glyphHeight(row.glyphScale);
      if (y + h > box.y + box.h) break;
      const w = GLYPH_CELL * row.glyphScale;
      const x =
        align === 'center'
          ? box.x + Math.floor((box.w - w) / 2)
          : align === 'right'
            ? box.x + box.w - w
            : box.x;
      drawGlyph(fb, x, y, row.glyph, row.glyphScale);
      y += h + m.widget.linePad;
      continue;
    }
    if (row.text === '') continue;
    const h = row.rung.height;
    if (y + h > box.y + box.h) break;
    drawLines(fb, m, [row.text], { ...box, y, h }, row.rung, align);
    y += h + m.widget.linePad;
  }
}

/**
 * One row of a stack: a run of text, or a glyph drawn at its own whole-number
 * scale. Never both — a glyph is a mark of its own here, not an ornament on a
 * line, because a 1-bit row has no room to be two things.
 */
type StackRow =
  | { readonly text: string; readonly rung: TypeRung; readonly glyph?: undefined }
  | { readonly text: ''; readonly rung: TypeRung; readonly glyph: GlyphKey; readonly glyphScale: GlyphScale };

/** Draw stacked lines within a box, clipped to its height and width, honouring align. */
function drawLines(
  fb: Framebuffer,
  m: EpaperMetrics,
  lines: readonly string[],
  box: Box,
  rung: TypeRung,
  align: 'left' | 'center' | 'right',
): void {
  const lineH = rung.height + m.widget.linePad;
  let y = box.y;
  for (const raw of lines) {
    if (y + rung.height > box.y + box.h) break;
    // Truncate to the box so a long line stops at its own edge rather than
    // bleeding into the widget beside it.
    const line = fit(raw, box.w, { rung });
    const w = measureText(line, { rung });
    const x =
      align === 'center' ? box.x + Math.floor((box.w - w) / 2) : align === 'right' ? box.x + box.w - w : box.x;
    drawText(fb, x, y, line, { rung });
    y += lineH;
  }
}

/**
 * A widget's border and optional title bar; returns the inner content box.
 *
 * The one piece of chrome every widget shares, and the worst of the absolute
 * pixels: an 8px inset and a title drawn at `scale: 1` — eight pixels of type
 * under a hairline twelve down — which on a 13.3" panel is a label nobody can
 * read from the other side of a kitchen. All three come off the ladder now.
 */
/**
 * A widget's own inset step (RFC 014 §4.1) as a fraction of the panel's own
 * `widget.inset`, which is what every widget drew before the lane existed
 * and is step 4 here as it is on the wall (`STYLE_INSET_CSS`, where step 4 is
 * `--s4`, today's padding). The rungs below are the wall's spacing scale —
 * 0, 0.14, 0.28, 0.5 and 0.85 of the event role — as fractions of its top,
 * so the two media give up room in the same proportions; rounded, because a
 * 1-bit raster has no half-lit column. Absent, malformed, or off the ladder
 * is today's inset: a lane this renderer cannot read is no lane (rule nine).
 */
const PANEL_INSET_STEPS: readonly number[] = [0, 0.14 / 0.85, 0.28 / 0.85, 0.5 / 0.85, 1];

function panelInset(m: EpaperMetrics, config: Config): number {
  const lane = config['style'];
  if (typeof lane !== 'object' || lane === null || Array.isArray(lane)) return m.widget.inset;
  const step = (lane as Record<string, unknown>)['inset'];
  if (typeof step !== 'number' || !Number.isInteger(step)) return m.widget.inset;
  const fraction = PANEL_INSET_STEPS[step];
  return fraction === undefined ? m.widget.inset : Math.round(m.widget.inset * fraction);
}

function drawFrame(fb: Framebuffer, m: EpaperMetrics, box: Box, config: Config): Box {
  const pad = panelInset(m, config);
  fb.strokeRect(box.x, box.y, box.w, box.h, true);
  let inner: Box = { x: box.x + pad, y: box.y + pad, w: box.w - pad * 2, h: box.h - pad * 2 };
  const title = str(config, 'title');
  if (config.showTitle === true && title !== undefined && title !== '') {
    drawText(fb, inner.x, inner.y, asciiTitle(title).toUpperCase(), { rung: m.small, tracking: 1 });
    // Exclusive edge, inclusive line — see `drawAgendaBox` in `render.ts`.
    fb.hLine(inner.x, inner.x + inner.w - 1, inner.y + m.widget.smallLine, true);
    const bar = m.widget.titleBarH;
    inner = { x: inner.x, y: inner.y + bar, w: inner.w, h: inner.h - bar };
  }
  return inner;
}

/** The widest line a stacked clock's date can be: see `drawClock`. */
const STACKED_DATE_BUDGET = '30 SEPTEMBER';

/**
 * The clock, honouring the same options the wall's does.
 *
 * `clockFormat` re-reads the frame's own time rather than reformatting the
 * string the viewmodel already built, which is the only way to change a clock
 * without parsing one. `showDate` is absence-means-on, matching the schema.
 */
function drawClock(fb: Framebuffer, m: EpaperMetrics, box: Box, model: EpaperModel, config: Config): void {
  /*
   * The variant (RFC 014 §4.2), read through the same resolver the wall reads
   * it through — `variantOf` in `variants.ts`, transcribed character for
   * character: one of the clock's three, and anything else — absent, or a
   * value that belongs to another widget type — is `plain`, the clock this
   * function drew before the key existed. So no stored canvas's frame moves
   * and `EPAPER_RENDERER_VERSION` does not either.
   */
  const variant = variantOf('clock', config);
  if (variant === 'analogue') {
    /*
     * A face at the box's short side, centred — a picture has no alignment to
     * honour, and on the wall the SVG is centred in its box the same way. The
     * reading is the digits' own, in 24-hour form, so the hands and the plain
     * clock on the next panel can never disagree about the time.
     */
    const [hh, mm] = clockLabel(model.generatedAt, model.timezone, true).split(':');
    const size = Math.max(0, Math.min(box.w, box.h));
    drawAnalogueFace(
      fb,
      box.x + Math.floor((box.w - size) / 2),
      box.y + Math.floor((box.h - size) / 2),
      size,
      // A label that did not parse draws twelve o'clock rather than a face
      // whose every polygon is `NaN` — the frame still goes out (rule nine).
      (Number(hh) || 0) % 24,
      (Number(mm) || 0) % 60,
    );
    return;
  }
  const format = str(config, 'clockFormat');
  const time =
    format === '12' || format === '24'
      ? clockLabel(model.generatedAt, model.timezone, format === '24')
      : model.time;
  // Bounded by the height it has *and* the width it has: a box taller than it
  // is wide used to pick a size the time could not fit, and lost its last
  // digit to the truncation in `drawLines`.
  // Four ninths of the box's height is a ratio and stays one — a taller box
  // gets a bigger clock on any panel. The *cap* is what was absolute: it was
  // 64px on a 7.5" panel and 64px on a 13.3" one, in a box six times the area.
  const byHeight = tallerRung(m.body, shorterRung(scaleRung(m, 4), rungAtMost((box.h * 4) / 9)));
  const timeRung = rungToFit(time, box.w, byHeight);
  const align = alignOf(config);
  drawLines(fb, m, [time], { ...box, h: timeRung.height }, timeRung, align);
  const dateRung = shorterRung(scaleRung(m, 1.5), rungStep(timeRung, -1));
  if (variant === 'stacked') {
    /*
     * The weekday and the date each on a line of its own, capitalised the way
     * the wall's scaffold role sets them. The date is the stacked form's
     * second half rather than an option on it, so `showDate` is not read —
     * the wall does not read it for this variant either.
     */
    const lines = [model.header.weekday, `${model.header.day} ${model.header.month}`].map((line) =>
      line.toUpperCase(),
    );
    /*
     * Stepped against a character budget rather than today's words, which is
     * the refresh contract's rule: the widest line the English calendar can
     * put here is "30 SEPTEMBER", so the rung is a function of the box alone
     * and does not change size at midnight on the first of a long month.
     */
    const lineRung = rungToFit(STACKED_DATE_BUDGET, box.w, dateRung);
    const top = box.y + timeRung.height + m.widget.inset;
    drawLines(
      fb,
      m,
      lines,
      { x: box.x, y: top, w: box.w, h: Math.max(0, box.y + box.h - top) },
      lineRung,
      align,
    );
    return;
  }
  if (config['showDate'] === false) return;
  const date = `${model.header.weekday} ${model.header.day} ${model.header.month}`;
  const dateTop = box.y + timeRung.height + m.widget.inset;
  drawLines(
    fb,
    m,
    wrap(date, box.w, dateRung),
    // The remaining height, not the whole box: measuring from the box's top
    // let the wrapped date run past its foot and into the widget below.
    { x: box.x, y: dateTop, w: box.w, h: Math.max(0, box.y + box.h - dateTop) },
    dateRung,
    align,
  );
}

/**
 * A countdown, in the looks a panel draws (plan item P5.2): the number, the
 * tear-off page, the boarding pass, the progress bar and the mini month, each
 * as a still frame.
 *
 * The words are the wall's — `countdown.ts` is its transcription, held to it
 * by `countdown-parity.test.ts` — so "sleeps" is honoured here and the day
 * says "Today!" on every look. What is not drawn is the picture and the
 * confetti: the alphabet is ASCII, which `asciiTitle` enforces on the label,
 * and a panel does not move. `occasion` is drawn as the number, for good: its
 * colours, its motif and its scene are the three things one still bit has none
 * of, so what is left of it is the number it dresses.
 */
function drawCountdown(fb: Framebuffer, m: EpaperMetrics, box: Box, model: EpaperModel, config: Config): void {
  const target = str(config, 'target');
  const look = variantOf('countdown', config);
  if (target !== undefined && look === 'page') {
    drawCountdownPage(fb, m, box, daysBetween(model.today, target), target, config);
    return;
  }
  if (target !== undefined && look === 'ticket') {
    drawCountdownTicket(fb, m, box, daysBetween(model.today, target), config);
    return;
  }
  if (target !== undefined && look === 'progress') {
    drawCountdownProgress(fb, m, box, model, target, config);
    return;
  }
  if (target !== undefined && look === 'month') {
    drawCountdownMonth(fb, m, box, model, target, config);
    return;
  }
  const title = str(config, 'title') ?? '';
  let big = '--';
  let unit = '';
  if (target !== undefined) {
    const days = daysBetween(model.today, target);
    if (days === 0) big = TODAY_WORDS;
    else {
      big = countDigits(days);
      unit = unitWords(days, countdownWords(config));
    }
  }
  // Same fitting as the clock: "365" in a narrow box must shrink, not lose its
  // last digit — a countdown that reads 36 is worse than a small one.
  const rung = rungToFit(big, box.w, tallerRung(m.body, shorterRung(scaleRung(m, 4.5), rungAtMost(box.h / 2))));
  drawLines(fb, m, [big], { ...box, h: rung.height }, rung, 'center');
  const restTop = box.y + rung.height + m.widget.rowGap;
  drawLines(
    fb,
    m,
    [unit, asciiTitle(title)].filter((l) => l !== ''),
    { x: box.x, y: restTop, w: box.w, h: Math.max(0, box.y + box.h - restTop) },
    m.body,
    'center',
  );
}

const PANEL_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const PANEL_WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** A target as a page prints it on one bit: "THU 25 DEC", in the panel's own alphabet. */
function panelTargetDate(target: string): string {
  const at = new Date(`${target}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return target;
  return `${PANEL_WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${PANEL_MONTHS[at.getUTCMonth()]}`;
}

/**
 * The widest thing the count's slot has to hold, in the state it is in.
 *
 * The refresh contract (`render.ts`) wants a rectangle's size to be a function
 * of the panel and never of today's words, so the count's rung is stepped
 * against a budget rather than against the number: three figures while it is
 * counting, whatever the number is, and the day's words on the day. The slot
 * moves once, at the midnight the words change, which is a full refresh the
 * panel was going to take for a new date anyway.
 */
function countBudget(days: number): string {
  return days === 0 ? TODAY_WORDS : '000';
}

/**
 * The tear-off page, still. **The widget's own frame is the sheet** — every
 * panel widget is outlined by `drawFrame` — so the page is what goes inside
 * it: a solid binder band across the top with two holes knocked through it,
 * the count, its unit, a rule, the target's date, and the label at the foot.
 *
 * What a short box gives up is the wall's order (`PAGE_PARTS`), read from the
 * end: the date, then the label, then the unit — never the count. Predicted
 * rather than measured, which is what a panel that owns its line heights does.
 */
function drawCountdownPage(
  fb: Framebuffer,
  m: EpaperMetrics,
  box: Box,
  days: number,
  target: string,
  config: Config,
): void {
  const gap = m.widget.linePad;
  const label = asciiTitle(str(config, 'title') ?? '').trim();
  const unit = unitWords(days, countdownWords(config));
  const binderH = Math.max(6, Math.round(m.body.height * 0.75));

  let withDate = true;
  let withLabel = label !== '';
  let withUnit = unit !== '';
  const below = (): number =>
    (withUnit ? m.small.height + gap : 0) +
    (withDate ? m.small.height + gap * 2 + 1 : 0) +
    (withLabel ? m.body.height + gap : 0);
  const fits = (): boolean => box.h - binderH - gap - below() >= m.body.height;
  if (!fits()) withDate = false;
  if (!fits()) withLabel = false;
  if (!fits()) withUnit = false;

  const band = Math.min(binderH, box.h);
  fb.fillRect(box.x, box.y, box.w, band);
  // The binder's two holes, knocked out of the band.
  const hole = Math.max(2, Math.round(band / 3));
  for (const at of [0.28, 0.72]) {
    fb.fillRect(box.x + Math.round(box.w * at) - Math.floor(hole / 2), box.y + Math.floor((band - hole) / 2), hole, hole, false);
  }

  let foot = box.y + box.h;
  if (withLabel) {
    foot -= m.body.height;
    drawLines(fb, m, [label], { ...box, y: foot, h: m.body.height }, m.body, 'center');
    foot -= gap;
  }
  if (withDate) {
    foot -= m.small.height;
    drawLines(fb, m, [panelTargetDate(target)], { ...box, y: foot, h: m.small.height }, m.small, 'center');
    foot -= gap + 1;
    fb.hLine(box.x, box.x + box.w - 1, foot);
    foot -= gap;
  }
  if (withUnit) {
    foot -= m.small.height;
    drawLines(fb, m, [unit.toUpperCase()], { ...box, y: foot, h: m.small.height }, m.small, 'center');
    foot -= gap;
  }
  const top = box.y + band + gap;
  const room = Math.max(0, foot - top);
  const rung = rungToFit(countBudget(days), box.w, tallerRung(m.body, shorterRung(scaleRung(m, 4.5), rungAtMost(room))));
  const countY = top + Math.max(0, Math.floor((room - rung.height) / 2));
  drawLines(fb, m, [days === 0 ? TODAY_WORDS : countDigits(days)], { ...box, y: countY, h: rung.height }, rung, 'center');
}

/**
 * The boarding pass, still. The frame is the pass; inside it, the pass's head
 * over a rule, the destination, the line "Departs in 12 days", a perforated
 * rule, and the count on a board of filled tiles, each digit knocked out of
 * its own and the board centred in the room left under the perforation.
 *
 * A short box gives up in the wall's order (`TICKET_PARTS`) from the end: the
 * head, then the board with its perforation — never the destination or the
 * line. On the day the line says "Today!" and there is no board: nothing is
 * left to count.
 */
function drawCountdownTicket(fb: Framebuffer, m: EpaperMetrics, box: Box, days: number, config: Config): void {
  const gap = m.widget.linePad;
  const pad = Math.max(2, gap);
  const dest = asciiTitle(str(config, 'title') ?? '').trim();
  const line = ticketLine(days, countdownWords(config));
  const destRung = rungToFit(dest, box.w, tallerRung(m.body, scaleRung(m, 1.5)));
  const tileFloor = m.body.height + pad * 2;

  let withHead = true;
  let withBoard = days !== 0;
  const text = (): number =>
    (withHead ? m.small.height + gap * 2 + 1 : 0) + (dest !== '' ? destRung.height + gap : 0) + m.body.height;
  const perforation = gap * 3 + 1;
  if (withBoard && box.h - text() - perforation < tileFloor) withHead = false;
  if (withBoard && box.h - text() - perforation < tileFloor) withBoard = false;

  let y = box.y;
  if (withHead) {
    drawLines(fb, m, ['BOARDING PASS'], { ...box, y, h: m.small.height }, m.small, 'left');
    y += m.small.height + gap;
    fb.hLine(box.x, box.x + box.w - 1, y);
    y += gap + 1;
  }
  if (dest !== '') {
    drawLines(fb, m, [dest], { ...box, y, h: destRung.height }, destRung, 'left');
    y += destRung.height + gap;
  }
  drawLines(fb, m, [line], { ...box, y, h: m.body.height }, m.body, 'left');
  y += m.body.height;
  if (!withBoard) return;

  // The perforation: a dashed rule across the pass.
  y += gap;
  const dash = Math.max(2, pad);
  for (let x = box.x; x < box.x + box.w; x += dash * 2) fb.hLine(x, Math.min(box.x + box.w - 1, x + dash - 1), y);
  y += gap * 2 + 1;

  const room = Math.max(0, box.y + box.h - y);
  const digits = countDigits(days).split('');
  const tallest = tallerRung(m.body, shorterRung(scaleRung(m, 3), rungAtMost(Math.max(0, room - pad * 2))));
  // Stepped against three figures, the refresh contract's budget: the board is
  // the same size at 12 and at 345, so only the ink inside it changes.
  const tileOf = (rung: TypeRung): number => measureText('0', { rung }) + pad * 2;
  let rung = tallest;
  while (rung.index > 0 && tileOf(rung) * 3 + gap * 2 > box.w) rung = rungStep(rung, -1);
  const w = tileOf(rung);
  const h = rung.height + pad * 2;
  const top = y + Math.max(0, Math.floor((room - h) / 2));
  digits.forEach((digit, index) => {
    const x = box.x + index * (w + gap * 2);
    fb.fillRect(x, top, w, h);
    drawText(fb, x + pad, top + pad, digit, { rung, ink: false });
  });
}

/**
 * The progress bar, still: the label, the count with its unit under it, a bar
 * of the days gone since the start date — an outline with its gone part
 * filled — and the percentage under it.
 *
 * A short box gives up in the wall's order (`PROGRESS_PARTS`) from the end: the
 * percentage, then the label, then the bar — never the count. With no start
 * date the bar's place says so, in the panel's own capitals, rather than
 * drawing a length made up. Every rectangle is a function of the box and of
 * whether today is the day (the count's budget), never of how far through the
 * run the household is: only the ink inside the bar moves from one day to the
 * next, which is exactly what a partial refresh wants.
 */
function drawCountdownProgress(
  fb: Framebuffer,
  m: EpaperMetrics,
  box: Box,
  model: EpaperModel,
  target: string,
  config: Config,
): void {
  const gap = m.widget.linePad;
  const days = daysBetween(model.today, target);
  const label = asciiTitle(str(config, 'title') ?? '').trim();
  const unit = unitWords(days, countdownWords(config));
  const from = countdownFrom(config);
  const progress = from === undefined ? undefined : countdownProgress(model.today, from, target);
  const barH = progress === undefined ? m.small.height : m.body.height;

  let withPct = progress !== undefined;
  let withLabel = label !== '';
  let withBar = true;
  const fixed = (): number =>
    (withLabel ? m.body.height + gap : 0) +
    (unit !== '' ? m.small.height + gap : 0) +
    (withBar ? barH + gap : 0) +
    (withPct ? m.small.height + gap : 0);
  const fits = (): boolean => box.h - fixed() >= m.body.height;
  if (!fits()) withPct = false;
  if (!fits()) withLabel = false;
  if (!fits()) withBar = false;

  let top = box.y;
  if (withLabel) {
    drawLines(fb, m, [label], { ...box, y: top, h: m.body.height }, m.body, 'center');
    top += m.body.height + gap;
  }
  let foot = box.y + box.h;
  if (withPct && progress !== undefined) {
    foot -= m.small.height;
    drawLines(fb, m, [percentWords(progress).toUpperCase()], { ...box, y: foot, h: m.small.height }, m.small, 'center');
    foot -= gap;
  }
  if (withBar) {
    foot -= barH;
    if (progress === undefined) {
      drawLines(fb, m, ['SET A START DATE'], { ...box, y: foot, h: barH }, m.small, 'center');
    } else {
      fb.strokeRect(box.x, foot, box.w, barH);
      const inner = Math.max(0, box.w - 4);
      const filled = Math.round(inner * progress.fraction);
      if (filled > 0) fb.fillRect(box.x + 2, foot + 2, filled, Math.max(0, barH - 4));
    }
    foot -= gap;
  }
  if (unit !== '') {
    foot -= m.small.height;
    drawLines(fb, m, [unit.toUpperCase()], { ...box, y: foot, h: m.small.height }, m.small, 'center');
    foot -= gap;
  }
  const room = Math.max(0, foot - top);
  const rung = rungToFit(countBudget(days), box.w, tallerRung(m.body, shorterRung(scaleRung(m, 4.5), rungAtMost(room))));
  const countY = top + Math.max(0, Math.floor((room - rung.height) / 2));
  drawLines(fb, m, [days === 0 ? TODAY_WORDS : countDigits(days)], { ...box, y: countY, h: rung.height }, rung, 'center');
}

/**
 * The mini month, still: the count, the target's month under its name and the
 * weekday heads, with the target ringed and today underlined, and the label at
 * the foot.
 *
 * The heads come from the model, already in the household's order, and the
 * squares from `miniMonth` at the household's own week start — the calendar's
 * rule, so Monday is in the same column on both widgets. A short box gives up
 * in the wall's order (`MONTH_PARTS`) from the end: the heads and the name
 * together, then the label, then the grid — never the count. The grid's shape
 * is a fact about the target's month, and the count's rung is stepped against
 * a budget rather than today's words, so no rectangle moves between two days.
 */
function drawCountdownMonth(
  fb: Framebuffer,
  m: EpaperMetrics,
  box: Box,
  model: EpaperModel,
  target: string,
  config: Config,
): void {
  const gap = m.widget.linePad;
  const days = daysBetween(model.today, target);
  const label = asciiTitle(str(config, 'title') ?? '').trim();
  const unit = unitWords(days, countdownWords(config));
  const month = miniMonth(target, model.weekStart);
  const cellH = m.small.height + gap;
  const countRung = rungToFit(
    days === 0 ? TODAY_WORDS : '000 DAYS AGO',
    box.w,
    tallerRung(m.small, shorterRung(scaleRung(m, 2), rungAtMost(Math.max(m.small.height, Math.floor(box.h / 4))))),
  );

  let withHeads = true;
  let withLabel = label !== '';
  let withGrid = true;
  const need = (): number =>
    countRung.height +
    (withGrid ? gap + (withHeads ? m.small.height + gap + cellH : 0) + month.weeks.length * cellH : 0) +
    (withLabel ? gap + m.body.height : 0);
  if (need() > box.h) withHeads = false;
  if (need() > box.h) withLabel = false;
  if (need() > box.h) withGrid = false;

  let y = box.y;
  const count = days === 0 ? TODAY_WORDS : `${countDigits(days)} ${unit.toUpperCase()}`;
  drawLines(fb, m, [count], { ...box, y, h: countRung.height }, countRung, 'center');
  y += countRung.height + gap;

  if (withGrid) {
    if (withHeads) {
      const title = `${PANEL_MONTHS[month.month - 1] ?? ''} ${month.year}`;
      drawLines(fb, m, [title], { ...box, y, h: m.small.height }, m.small, 'center');
      y += m.small.height + gap;
    }
    const cellW = Math.floor(box.w / 7);
    const left = box.x + Math.floor((box.w - cellW * 7) / 2);
    const cellRung = rungToFit('30', Math.max(1, cellW - 2), m.small);
    const centred = (text: string, column: number, rowTop: number): { x: number; w: number } => {
      const w = measureText(text, { rung: cellRung });
      const x = left + column * cellW + Math.floor((cellW - w) / 2);
      drawText(fb, x, rowTop + Math.floor((cellH - cellRung.height) / 2), text, { rung: cellRung });
      return { x, w };
    };
    if (withHeads) {
      model.weekdayLabels.forEach((head, column) => centred(head.charAt(0).toUpperCase(), column, y));
      y += cellH;
    }
    const targetDay = Number(target.slice(8, 10));
    const todayDay = todayInMonth(model.today, target);
    month.weeks.forEach((week, row) => {
      const rowTop = y + row * cellH;
      week.forEach((day, column) => {
        if (day === null) return;
        const drawn = centred(String(day), column, rowTop);
        if (day === targetDay) ringAround(fb, left + column * cellW, rowTop, cellW, cellH, drawn.w);
        if (day === todayDay) {
          const under = rowTop + Math.floor((cellH + cellRung.height) / 2);
          fb.hLine(drawn.x, drawn.x + drawn.w - 1, Math.min(rowTop + cellH - 1, under));
        }
      });
    });
  }
  if (withLabel) {
    drawLines(fb, m, [label], { ...box, y: box.y + box.h - m.body.height, h: m.body.height }, m.body, 'center');
  }
}

/**
 * A ring round a square's number: an ellipse inside the square, as wide as the
 * number needs and no wider than the square, rasterised by asking of every
 * pixel's centre whether it falls between the ellipse and one stroke inside it
 * — crisp at one bit, and a function of the square alone.
 */
function ringAround(fb: Framebuffer, x: number, y: number, w: number, h: number, textW: number): void {
  const ry = h / 2;
  const stroke = Math.max(1, Math.round(ry / 5));
  const rx = Math.min(w / 2, Math.max(ry, textW / 2 + stroke + 1));
  const cx = x + w / 2;
  const cy = y + h / 2;
  for (let py = y; py < y + h; py++) {
    for (let px = Math.floor(cx - rx); px < Math.ceil(cx + rx); px++) {
      const outer = ((px + 0.5 - cx) / rx) ** 2 + ((py + 0.5 - cy) / ry) ** 2;
      const inner = ((px + 0.5 - cx) / Math.max(0.5, rx - stroke)) ** 2 + ((py + 0.5 - cy) / Math.max(0.5, ry - stroke)) ** 2;
      if (outer <= 1 && inner > 1) fb.set(px, py);
    }
  }
}

/**
 * Today's rota, honouring the same options the wall's badge does.
 *
 * `people` filters, `shiftName` picks the label or the short code, and
 * `showHours` drops the times — all *absence means on*, matching the schema, so
 * a panel arranged before these existed draws exactly what it drew.
 *
 * `showRun` is deliberately not read here: this renderer has never drawn the
 * run line, so honouring an option whose absence means "on" would make every
 * existing panel grow a row nobody asked for. It is the wall's option until the
 * panel has a row for it.
 */
function drawShift(fb: Framebuffer, m: EpaperMetrics, box: Box, model: EpaperModel, config: Config): void {
  // None chosen shows everyone, the same rule the wall's widget follows.
  const chosen = list(config, 'people').filter((p): p is string => typeof p === 'string');
  const shifts =
    chosen.length === 0
      ? model.todayShifts
      : model.todayShifts.filter((s) => chosen.includes(s.personId));
  const useCode = str(config, 'shiftName') === 'code';
  const nameOf = (s: (typeof shifts)[number]): string => {
    const preferred = useCode ? s.code : s.label;
    // Either can be empty on a shift type that only defines the other, so each
    // falls back to its twin rather than drawing a card with no name on it.
    return preferred !== '' ? preferred : useCode ? s.label : s.code;
  };

  if (shifts.length === 0) {
    // Sized to the box: at a fixed scale this read "No shift t" in a narrow
    // column, which is not a smaller message but a broken one.
    drawLines(fb, m, ['No shift today'], box, rungToFit('No shift today', box.w, m.body), 'left');
    return;
  }

  const ladder = shiftLadder(config);
  /*
   * What each row would say. `run` is deliberately absent: the panel's model
   * has never carried a run position, so the rung simply never resolves here
   * and `ladderRows` drops it. The ladder is shared; the data is not.
   */
  const valuesFor = (s: (typeof shifts)[number]): Partial<Record<ShiftField, string>> => {
    const values: Partial<Record<ShiftField, string>> = {
      person: asciiTitle(s.person),
      shift: asciiTitle(nameOf(s)),
    };
    if (s.time !== '') values.hours = s.time;
    return values;
  };

  const [only] = shifts;
  if (shifts.length === 1 && only !== undefined) {
    const rows = ladderRows(ladder, valuesFor(only), SHIFT_ROLES);
    /*
     * How tall each role is before the headline is allowed to grow.
     *
     * The headline is measured at its floor here so the fit question has one
     * answer rather than depending on itself; whatever room the surviving rows
     * leave is handed back to it below. This replaces `box.h >= 44`, which was
     * a renderer's private opinion about the household's box — a number nobody
     * outside this file could see, and one that decided the whole shape of the
     * widget at a threshold nobody chose.
     */
    const ROW_GAP = m.widget.linePad;
    const heightOf = (role: LadderRole): number =>
      (role === 'headline' ? m.bodyGlyph : m.smallGlyph) + ROW_GAP;
    const kept = dropToFit(rows, box.h, heightOf);

    /*
     * One row left where there were more is a *line*, not a word.
     *
     * A box too short for two rows used to draw "Daddy: S 07:00-19:00" and
     * would otherwise now draw "DADDY" — the same room spent on strictly less.
     * Collapsing keeps every field the household asked for, in the order they
     * asked for it, and lets the truncation in `drawLines` decide what the box
     * can actually hold.
     */
    if (kept.length === 1 && rows.length > 1) {
      drawLines(fb, m, [compactLine(rows)], box, rungToFit(compactLine(rows), box.w, m.body), 'left');
      return;
    }

    // The headline takes whatever the surviving rows did not need.
    const others = kept.filter((row) => row.role !== 'headline');
    const small = m.smallGlyph;
    const headroom = Math.max(small, box.h - others.length * (small + ROW_GAP));
    const stack = kept.map((row) => {
      if (row.role !== 'headline') return { text: row.text, rung: m.small };
      const text = row.text.toUpperCase();
      return {
        text,
        rung: rungToFit(text, box.w, tallerRung(m.body, shorterRung(scaleRung(m, 3.5), rungAtMost(headroom)))),
      };
    });
    drawStack(
      fb,
      m,
      box,
      stack.map((row) => (row.rung === m.small ? { ...row, text: row.text.toUpperCase() } : row)),
      'left',
    );
    return;
  }

  // More than one person: a compact line each, sized so the longest still fits
  // rather than being cut at the box edge. The ladder decides which parts are
  // on the line and in what order, exactly as it decides the rows above.
  const lines = shifts.map((s) => compactLine(ladderRows(ladder, valuesFor(s), SHIFT_ROLES)));
  const rung = lines.reduce(
    (smallest, line) => shorterRung(smallest, rungToFit(line, box.w, m.body)),
    m.body,
  );
  drawLines(fb, m, lines, box, rung, 'left');
}

/**
 * A ladder as one line, in the household's own order.
 *
 * The person keeps its colon when it leads, because "Amy: Nights" reads as an
 * attribution and "Amy Nights" reads as a mistake. Anywhere else it is just
 * another part, since "Nights: Amy" would attribute the wrong way round.
 */
function compactLine(rows: readonly LadderRow<ShiftField>[]): string {
  const parts = rows.map((row) => row.text);
  if (rows[0]?.field === 'person' && parts.length > 1) {
    const [head, ...rest] = parts;
    return asciiTitle(`${head}: ${rest.join('  ')}`);
  }
  return asciiTitle(parts.join('  '));
}

/** One row of a to-do list as this renderer draws it: words, and whether it is ticked. */
interface TodoLine {
  readonly summary: string;
  readonly done: boolean;
}

/** One watched list, as the panel draws it: how many are open, and each line. */
interface TodoRead {
  readonly open: number;
  readonly items: readonly TodoLine[];
}

/**
 * The to-do panel's lists, read defensively — `readChorePanel`'s shape.
 *
 * Keyed by the handle the manifest minted (`todoListHandle`), never an entity
 * id: the panel is the same slice a wall receives, and this renderer resolves
 * the widget's stored entity id to that handle itself, because it draws from
 * the household's rows rather than from the manifest's layout.
 */
function readTodoPanel(panel: unknown): Map<string, TodoRead> {
  const lists = new Map<string, TodoRead>();
  if (typeof panel !== 'object' || panel === null) return lists;
  const raw = (panel as { lists?: unknown }).lists;
  if (!Array.isArray(raw)) return lists;
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const list = entry as { key?: unknown; open?: unknown; items?: unknown };
    if (typeof list.key !== 'string' || list.key === '') continue;
    const items: TodoLine[] = [];
    for (const candidate of Array.isArray(list.items) ? list.items : []) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const item = candidate as { summary?: unknown; done?: unknown };
      if (typeof item.summary !== 'string' || item.summary === '') continue;
      items.push({ summary: item.summary, done: item.done === true });
    }
    lists.set(list.key, {
      open: typeof list.open === 'number' && Number.isFinite(list.open) ? list.open : items.length,
      items,
    });
  }
  return lists;
}

/**
 * The To-do widget: the lines the household typed, or a Home Assistant list.
 *
 * `list` is read exactly as `render.ts` reads it — absent, or empty, means the
 * typed `items`, present means that list — through `todoListOf`, the same
 * function the manifest's omission uses. A stored key is one value read one
 * way, which is the bug this repository has shipped five times (`shifts[0]`,
 * `display_mode`, `cellEvents`, `mode`, `pillMinCell`) and the reason the
 * absent-key frame is pinned byte-identical to the frame before this existed.
 *
 * Both sources draw the same rows. A completed item, when `showDone` asks for
 * it, is a filled box rather than a struck line: at one bit a strike through
 * 8px type is a smudge, and solid against empty is the strongest contrast the
 * medium has — the chore board's own reasoning. Summaries go through
 * `asciiTitle` like every stranger's string here.
 */
function drawTodo(fb: Framebuffer, m: EpaperMetrics, box: Box, found: TodoRead | undefined, config: Config): void {
  const note = (text: string): void => {
    drawLines(fb, m, [text], box, rungToFit(text, box.w, m.body), 'left');
  };
  const entityId = todoListOf(config);

  let rows: TodoLine[];
  if (entityId === undefined) {
    rows = list(config, 'items')
      .filter((x): x is string => typeof x === 'string')
      .map((summary) => ({ summary, done: false }));
    if (rows.length === 0) {
      note('(nothing on the list)');
      return;
    }
  } else {
    if (found === undefined) {
      note('(list not on Home Assistant)');
      return;
    }
    const showDone = config['showDone'] === true;
    rows = found.items.filter((item) => showDone || !item.done);
    if (rows.length === 0) {
      note(found.open === 0 && found.items.length === 0 ? '(nothing on the list)' : '(nothing left to do)');
      return;
    }
  }

  const rowH = m.widget.listRowH;
  const textX = m.bullet + m.bulletGap;
  let y = box.y;
  for (const item of rows) {
    // The row is drawn when its *box* fits, which is the bullet's own bottom —
    // the same guard the agenda uses, in the same terms.
    if (y + m.bulletDrop + m.bullet > box.y + box.h) break;
    fb.strokeRect(box.x, y + m.bulletDrop, m.bullet, m.bullet, true);
    if (item.done) {
      const inset = m.widget.tickInset;
      fb.fillRect(box.x + inset, y + m.bulletDrop + inset, m.widget.tickDot, m.widget.tickDot, true);
    }
    drawText(fb, box.x + textX, y, fit(asciiTitle(item.summary), box.w - textX, { rung: m.body }), {
      rung: m.body,
    });
    y += rowH;
  }
}

function drawImage(fb: Framebuffer, m: EpaperMetrics, box: Box, config: Config): void {
  const name = str(config, 'image');
  const rung = m.small;
  // Lifted a line, less half a gap, so the two-line block straddles the middle.
  // Two pixels shy of a true centre at the anchor, and kept that way: it is
  // what the panel draws today and this is a placeholder until there is a
  // decoder to draw a real photograph.
  const lift = m.widget.smallLine - Math.round(m.widget.linePad / 2);
  drawLines(
    fb,
    m,
    ['[ photo ]', name !== undefined ? fit(name, box.w, { rung }) : 'not shown on eInk yet'],
    { x: box.x, y: box.y + Math.max(0, Math.floor(box.h / 2) - lift), w: box.w, h: box.h },
    rung,
    'center',
  );
}

/**
 * A tolerant list of "label: value" lines out of a module's panel JSON.
 *
 * A module contributes data whose exact shape is its own; this reaches for the
 * common shapes (an `items`/`readings` array of labelled values, then scalar
 * top-level fields) and stops rather than throwing on anything it does not
 * recognise. The wall drawing one fewer line beats the wall drawing an error.
 */
function panelLines(panel: unknown, max: number): string[] {
  if (panel === null || typeof panel !== 'object') return [];
  const obj = panel as Record<string, unknown>;
  const out: string[] = [];
  const items = Array.isArray(obj.items) ? obj.items : Array.isArray(obj.readings) ? obj.readings : undefined;
  if (items !== undefined) {
    for (const entry of items) {
      if (out.length >= max) break;
      if (typeof entry === 'string') out.push(entry);
      else if (entry !== null && typeof entry === 'object') {
        const o = entry as Record<string, unknown>;
        const label = typeof o.label === 'string' ? o.label : typeof o.title === 'string' ? o.title : '';
        const value =
          typeof o.value === 'string'
            ? o.value
            : typeof o.state === 'string'
              ? o.state
              : typeof o.text === 'string'
                ? o.text
                : '';
        const line = [label, value].filter((p) => p !== '').join(': ');
        if (line !== '') out.push(line);
      }
    }
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (out.length >= max) break;
    if (typeof v === 'string' || typeof v === 'number') out.push(`${k}: ${v}`);
  }
  return out;
}

/**
 * The forecast, drawn as a forecast.
 *
 * This used to go through `drawPanel`, whose tolerant reader looks for an
 * `items`/`readings` array and, failing that, prints every scalar field it can
 * see. The weather panel has neither — it carries `days` — so a household who
 * put Weather on a panel got exactly two lines:
 *
 *     provider: nws
 *     fetchedAt: 1787654321000
 *
 * Internals, and no temperatures. Found by rendering one and looking at it.
 *
 * The degree sign is not in the 0x20–0x7E font, so the unit rides on the low
 * the way the wall's strip already does it: "24  13F" rather than five repeated
 * degree marks across the row.
 */
interface EpaperForecastDay {
  readonly name: string;
  readonly high: string;
  readonly low: string;
  /** A key the panel can draw, or `undefined` — a newer server may name one. */
  readonly glyph: GlyphKey | undefined;
  /*
   * The `range` look's three extra readings (plan item P5.1), carried **only
   * when the widget draws that look** — `panelInput` asks for them by look.
   * A strip does not draw them, so they must not be in what its frame's ETag
   * hashes (P3.5): a rain chance revised overnight would otherwise refresh
   * every panel with a strip on it for a number it never shows.
   */
  readonly highValue?: number;
  readonly lowValue?: number;
  readonly precipChance?: number;
}

/**
 * Read the weather panel defensively — a module's shape is its own.
 *
 * `range` is whether the draw is the `range` look, which reads the numbers as
 * numbers and the rain chance too; every other look reads the strip's four
 * strings and nothing else.
 */
function forecastDays(panel: unknown, range = false): EpaperForecastDay[] {
  if (panel === null || typeof panel !== 'object') return [];
  const raw = (panel as { days?: unknown }).days;
  if (!Array.isArray(raw)) return [];
  const out: EpaperForecastDay[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const day = entry as {
      name?: unknown; high?: unknown; low?: unknown; unit?: unknown; glyph?: unknown; precipChance?: unknown;
    };
    const finite = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const chance = finite(day.precipChance);
    if (typeof day.name !== 'string') continue;
    const unit = typeof day.unit === 'string' ? asciiTitle(day.unit) : '';
    const degrees = (value: unknown): string =>
      typeof value === 'number' ? String(Math.round(value)) : '-';
    out.push({
      name: asciiTitle(day.name),
      high: degrees(day.high),
      low: `${degrees(day.low)}${unit}`,
      glyph: isGlyphKey(day.glyph) ? day.glyph : undefined,
      ...(range && finite(day.high) !== undefined ? { highValue: finite(day.high) as number } : {}),
      ...(range && finite(day.low) !== undefined ? { lowValue: finite(day.low) as number } : {}),
      ...(range && chance !== undefined && chance >= 0 && chance <= 100 ? { precipChance: Math.round(chance) } : {}),
    });
  }
  return out;
}

/**
 * The current conditions, as a panel may draw them: the temperature and the
 * time it was read, never the one without the other (P3.5).
 *
 * A browser wall redraws every fifteen seconds and a battery panel may sleep
 * for an hour, so a panel's "52" can be an hour older than the wall's beside
 * it — and a temperature with no time on it says it is the temperature *now*.
 * So there is no reader that hands a draw the bare number: `text` is the
 * reading and its stamp, "52F at 07:15", and a style that draws current
 * conditions on a panel (P5.1's `today`) draws that. The degree sign is not in
 * the panel's 0x20–0x7E faces, so the unit rides on the number the way the
 * strip's low already carries it ("13F").
 *
 * The time is the reading's own — `observedAt`, which for a modelled reading is
 * the hour it describes — in the household's zone and clock, through the same
 * `clockLabel` the panel's header uses. The `today` look (`drawWeatherToday`)
 * is the draw that reads it, and `panelInput` hands it over only to that look,
 * so the frame's ETag hashes the reading's exact words where it is drawn and
 * nowhere else.
 */
export interface EpaperCurrent {
  /** "52F" — rounded, with the panel's unit letter when it has one. */
  readonly temp: string;
  /** "07:15", or "07:15 am" on a twelve-hour household. */
  readonly at: string;
  /** "52F at 07:15" — the only form a draw should use. */
  readonly text: string;
}

export function epaperCurrent(panel: unknown, timezone: string, clock24: boolean): EpaperCurrent | undefined {
  if (panel === null || typeof panel !== 'object') return undefined;
  const current = (panel as { current?: unknown }).current;
  if (current === null || typeof current !== 'object') return undefined;
  const reading = current as { temp?: unknown; observedAt?: unknown };
  if (typeof reading.temp !== 'number' || !Number.isFinite(reading.temp)) return undefined;
  if (typeof reading.observedAt !== 'number' || !Number.isFinite(reading.observedAt)) return undefined;
  const units = (panel as { units?: unknown }).units;
  const unit =
    units !== null && typeof units === 'object' && typeof (units as { temp?: unknown }).temp === 'string'
      ? asciiTitle((units as { temp: string }).temp)
      : '';
  const temp = `${Math.round(reading.temp)}${unit}`;
  const at = clockLabel(reading.observedAt, timezone, clock24);
  return { temp, at, text: `${temp} at ${at}` };
}

function drawWeather(
  fb: Framebuffer,
  m: EpaperMetrics,
  box: Box,
  forecast: readonly EpaperForecastDay[],
  config: Config,
  /** The reading and its time, handed over only when the look draws it (`panelInput`). */
  current?: EpaperCurrent,
): void {
  let days = [...forecast];
  if (days.length === 0) {
    drawLines(fb, m, ['No weather yet'], box, rungToFit('No weather yet', box.w, m.body), 'left');
    return;
  }
  const wanted = config['count'];
  if (typeof wanted === 'number' && Number.isFinite(wanted) && wanted >= 1) {
    days = days.slice(0, Math.trunc(wanted));
  }

  // The `range` and `today` looks are drawings of their own (plan item P5.1);
  // `colour` and `playful` are drawn as the strip, below — one has no colour
  // to draw on one bit and the other's pictures have no one-bit artwork (D3).
  const look = variantOf('weather', config);
  if (look === 'range') {
    drawWeatherRange(fb, m, box, days);
    return;
  }
  if (look === 'today') {
    drawWeatherToday(fb, m, box, forecast, current);
    return;
  }

  const ladder = weatherLadder(config);
  const paired = pairsTemperatures(ladder);
  /*
   * `icon` resolves now, and for years it did not.
   *
   * The rung used to be dropped here because the module chose an *emoji* and
   * this panel's font is 0x20–0x7E, so `asciiTitle` deleted it — a household
   * who put a forecast on a panel got a column of temperatures with a hole in
   * it, and no test could see the difference because the widget drew inside its
   * box, did not throw and produced ink. With a first-party vocabulary there is
   * a drawing to draw.
   *
   * The key travels through the ladder as this rung's *text*, which is how the
   * wall carries it too, and `drawStack` turns it into a drawing. A key this
   * panel cannot draw is not put in the record at all, so `ladderRows` drops
   * the rung and the column gives the room back.
   */
  const glyphScale = glyphScaleFor(m.bodyGlyph);
  const rowsFor = (day: EpaperForecastDay): readonly LadderRow<WeatherField>[] =>
    ladderRows(
      ladder,
      { name: day.name, icon: day.glyph ?? '', high: day.high, low: day.low },
      WEATHER_ROLES,
    );

  /**
   * The rows of one column, with the temperatures folded onto one line when the
   * household left them adjacent — "24  13F" is how the strip reads, and it is
   * what the wall does with the same ladder.
   */
  const foldPairs = (
    rows: readonly LadderRow<WeatherField>[],
  ): { readonly text: string; readonly role: LadderRole }[] => {
    const out: { text: string; role: LadderRole }[] = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      const next = rows[index + 1];
      const isTemp = (field: WeatherField): boolean => field === 'high' || field === 'low';
      if (paired && isTemp(row.field) && next !== undefined && isTemp(next.field)) {
        // The pair takes the louder of the two roles: a range led by the high
        // is a headline, and pairing must not quietly demote it.
        const role = row.role === 'headline' || next.role === 'headline' ? 'headline' : row.role;
        out.push({ text: `${row.text}  ${next.text}`, role });
        index++;
        continue;
      }
      out.push({ text: row.text, role: row.role });
    }
    return out;
  };

  /*
   * Columns when each one has room to be read, lines when it has not — the same
   * two-mode shape `drawShift` uses, and for the same reason: a weather widget
   * is usually a wide short strip, but a household can drag it into a tall
   * narrow box and a strip of 20px columns is a smudge.
   */
  const columnWidth = Math.floor(box.w / days.length);
  if (columnWidth >= m.widget.columnMinW && box.h >= m.widget.columnMinH) {
    const ROW_GAP = m.widget.rowGap;
    // Size comes from the *role*, never from the row's position. Putting the
    // temperatures above the day name must not make the day name enormous —
    // that is the ladder's own rule, and sizing by index broke it the moment a
    // household reordered anything. Found by rendering a reordered strip.
    const maxRung = (role: LadderRole): TypeRung =>
      role === 'headline' ? scaleRung(m, 1.5) : m.small;
    // Predicted from `maxScale` rather than from its own literals, so the room
    // reserved for a row and the size that row is allowed to reach cannot
    // disagree — the count-and-loop rule one widget along.
    /*
     * `body` is the icon rung and nothing else — `WEATHER_ROLES` gives `name`,
     * `high` and `low` the other three roles — so a role is enough to say which
     * rows are drawings, with no second lookup and no change to `dropToFit`.
     */
    const heightOf = (role: LadderRole): number =>
      role === 'body' ? glyphHeight(glyphScale) + ROW_GAP : maxRung(role).height + ROW_GAP;

    const columns = days.map((day) => foldPairs(dropToFit(rowsFor(day), box.h, heightOf)));
    /*
     * One scale per row, across every column.
     *
     * `rungToFit` answers per string, so "20  9C" fits a size that "24  13C"
     * does not and the strip came out with one column twice the size of its
     * neighbours — a forecast that reads as five unrelated widgets. Taking the
     * smallest that fits them all is what keeps a strip a strip.
     */
    const rowCount = columns.reduce((most, rows) => Math.max(most, rows.length), 0);
    const rungs: TypeRung[] = [];
    for (let row = 0; row < rowCount; row++) {
      let rung: TypeRung | undefined;
      for (const rows of columns) {
        const cell = rows[row];
        // A glyph has no string to measure and no type rung to agree on.
        if (cell === undefined || cell.role === 'body') continue;
        const fits = rungToFit(cell.text, columnWidth - m.widget.linePad, maxRung(cell.role));
        rung = rung === undefined ? fits : shorterRung(rung, fits);
      }
      rungs.push(rung ?? m.small);
    }

    columns.forEach((rows, index) => {
      const column: Box = {
        x: box.x + columnWidth * index,
        y: box.y,
        w: columnWidth - m.widget.linePad,
        h: box.h,
      };
      drawStack(
        fb,
        m,
        column,
        rows.map((cell, row) =>
          cell.role === 'body' && isGlyphKey(cell.text)
            ? { text: '' as const, rung: m.small, glyph: cell.text, glyphScale }
            : { text: cell.text, rung: rungs[row] ?? m.small },
        ),
        'left',
      );
    });
    return;
  }

  /*
   * The narrow fallback is one line a day, and a glyph does not go in it.
   *
   * This branch is what a household gets when they drag the forecast into a
   * tall thin box, and a line here is already "Tue  24  13F" at whatever size
   * fits. A drawing wedged between two words on a 1-bit line is neither, so the
   * rung is dropped exactly as `run` is dropped from a shift on a panel that has
   * no row for it — the ladder is shared, the medium is not.
   */
  const lines = days.map((day) =>
    foldPairs(rowsFor(day))
      .filter((cell) => cell.role !== 'body')
      .map((cell) => cell.text)
      .join('  '),
  );
  const rung = lines.reduce(
    (smallest, line) => shorterRung(smallest, rungToFit(line, box.w, m.body)),
    m.body,
  );
  drawLines(fb, m, lines, box, rung, 'left');
}

/**
 * The widest reading a Today panel's lede writes: a sign, two figures and the
 * unit letter — and, with no reading to call now, today's high and low. Every
 * size on the card is stepped against these rather than against the reading,
 * the refresh contract's rule (`render.ts`): the lede is the same size at 9F
 * and at 19F, so a new reading moves ink inside its rectangle and moves no
 * rectangle.
 */
const TODAY_LEDE_BUDGET = '-00F';
const TODAY_RANGE_LEDE_BUDGET = '-00/-00F';
/** The widest line under the lede: "at 12:45 pm", or "H -00  L -00F". */
const TODAY_LINE_BUDGET = 'H -00  L -00F';

/**
 * The `today` forecast on one bit (plan item P5.1): the large reading with the
 * time it was read, and today's high and low under it. No sky and no gradient
 * — one bit has neither — and no feels-like or hours, which are the wall's.
 *
 * **The reading and its time are one thing.** A battery panel may sleep for an
 * hour, so its "52F" can be an hour older than the wall's beside it, and a
 * temperature with no time on it says it is the temperature now (P3.5). So the
 * stamp is drawn under the lede in every box that has room for a lede at all,
 * and a box too short for both draws `epaperCurrent`'s own one line —
 * "52F at 07:15" — rather than the number alone. With no reading, the lede is
 * today's high and low with the day's name under it, exactly as the wall's
 * card falls back: a forecast is never drawn as a measurement.
 *
 * Every size is the box's: the lede is the tallest rung the room above the
 * lines has, no taller than the clock's own cap, and no wider than the budget
 * above fits — never a function of the words.
 */
function drawWeatherToday(
  fb: Framebuffer,
  m: EpaperMetrics,
  box: Box,
  days: readonly EpaperForecastDay[],
  current: EpaperCurrent | undefined,
): void {
  const today = days[0];
  if (current === undefined && today === undefined) {
    drawLines(fb, m, ['No weather yet'], box, rungToFit('No weather yet', box.w, m.body), 'left');
    return;
  }
  const big = current !== undefined ? current.temp : `${today!.high}/${today!.low}`;
  const budget = current !== undefined ? TODAY_LEDE_BUDGET : TODAY_RANGE_LEDE_BUDGET;
  const lines: string[] =
    current !== undefined
      ? [`at ${current.at}`, ...(today === undefined ? [] : [`H ${today.high}  L ${today.low}`])]
      : [today!.name];
  const lineRung = rungToFit(TODAY_LINE_BUDGET, box.w, m.body);
  const lineH = lineRung.height + m.widget.linePad;
  // The stamp has to fit under the lede; the range may go, the stamp may not.
  const room = (count: number): number => box.h - count * lineH - m.widget.rowGap;
  const keep = room(lines.length) >= m.body.height ? lines.length : room(1) >= m.body.height ? 1 : 0;
  if (keep === 0) {
    // No room for a lede over its stamp: the reading and its time on one line.
    const one = current !== undefined ? current.text : `${today!.high}/${today!.low} ${today!.name}`;
    drawLines(fb, m, [one], box, rungToFit(`${TODAY_LEDE_BUDGET} at 12:45 pm`, box.w, m.body), 'left');
    return;
  }
  const byHeight = tallerRung(m.body, shorterRung(scaleRung(m, 4.5), rungAtMost(room(keep))));
  const lede = rungToFit(budget, box.w, byHeight);
  drawLines(fb, m, [big], { ...box, h: lede.height }, lede, 'left');
  const top = box.y + lede.height + m.widget.rowGap;
  drawLines(fb, m, lines.slice(0, keep), { x: box.x, y: top, w: box.w, h: Math.max(0, box.y + box.h - top) }, lineRung, 'left');
}

/**
 * The `range` forecast on one bit (plan item P5.1): a row per day, its name,
 * its glyph, its rain chance, its low, a **black bar** from the low to the high
 * on the week's own scale, and its high.
 *
 * The wall's bar is a ramp of four colours; a panel has one, so the bar is
 * solid ink over a one-pixel track and the scale is what carries the reading —
 * where a day's bar sits against the others says as much as its colour did.
 * No dot for "now": the current reading needs its time on a panel (P3.5), and
 * a dot has nowhere to write one.
 *
 * Gives up what the wall gives up, in the wall's order (`RANGE_TIERS`): days
 * from the bottom, then the rain chance, then the glyph; the bar and its two
 * numbers stay. The day's name is never cut, so every column is laid out
 * beside the widest one drawn. Every size comes from the panel's own ladder —
 * the body rung for the numbers and the name, the small rung for the rain
 * chance, the glyph at the forecast's own scale — never from a string, which
 * is the refresh contract in `render.ts`: a revised forecast moves ink inside
 * this box and moves nothing else.
 */
function drawWeatherRange(fb: Framebuffer, m: EpaperMetrics, box: Box, days: readonly EpaperForecastDay[]): void {
  const rung = m.body;
  const small = m.small;
  const gap = Math.max(4, Math.round(rung.height / 2));
  const glyphScale = glyphScaleFor(m.bodyGlyph);
  const glyphW = GLYPH_CELL * glyphScale;

  const values = days.flatMap((day) => [day.lowValue, day.highValue]).filter((v): v is number => v !== undefined);
  let min = values.length > 0 ? Math.min(...values) : 0;
  let max = values.length > 0 ? Math.max(...values) : 0;
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const num = (value: number | undefined): string => (value === undefined ? '-' : String(Math.round(value)));

  const nameW = Math.max(...days.map((day) => measureText(day.name, { rung })));
  const tempW = Math.max(...days.flatMap((day) => [num(day.lowValue), num(day.highValue)]).map((t) => measureText(t, { rung })));
  const hasRain = days.some((day) => day.precipChance !== undefined);
  const rainW = hasRain ? measureText('100%', { rung: small }) : 0;
  const minBar = rung.height * 2;
  const needed = nameW + gap + tempW + gap + minBar + gap + tempW;
  const withGlyph = box.w >= needed + glyphW + gap;
  const withRain = hasRain && box.w >= needed + (withGlyph ? glyphW + gap : 0) + rainW + gap;

  // A box too short for one full row still draws its first day in the room
  // it has (rule nine) — squeezed to the box, never spilling past its foot.
  const rowH = Math.min(box.h, Math.max(m.widget.listRowH, withGlyph ? glyphHeight(glyphScale) + m.widget.linePad : 0));
  const rows = Math.max(1, Math.min(days.length, Math.floor(box.h / Math.max(1, rowH))));

  let x = box.x + nameW + gap;
  const glyphX = x;
  if (withGlyph) x += glyphW + gap;
  const rainX = x;
  if (withRain) x += rainW + gap;
  const lowX = x;
  x += tempW + gap;
  const barX = x;
  const highX = box.x + box.w - tempW;
  const barW = Math.max(1, highX - gap - barX);
  const at = (value: number): number => barX + Math.round(((value - min) / (max - min)) * (barW - 1));
  const thick = Math.max(2, Math.round(rung.height * 0.35));

  for (let i = 0; i < rows; i++) {
    const day = days[i] as EpaperForecastDay;
    const top = box.y + i * rowH;
    const textY = top + Math.floor((rowH - rung.height) / 2);
    drawText(fb, box.x, textY, day.name, { rung });
    if (withGlyph && day.glyph !== undefined && glyphHeight(glyphScale) <= rowH) {
      drawGlyph(fb, glyphX, top + Math.floor((rowH - glyphHeight(glyphScale)) / 2), day.glyph, glyphScale);
    }
    if (withRain && day.precipChance !== undefined) {
      const words = `${day.precipChance}%`;
      drawText(fb, rainX + rainW - measureText(words, { rung: small }), top + Math.floor((rowH - small.height) / 2), words, { rung: small });
    }
    const low = num(day.lowValue);
    const high = num(day.highValue);
    drawText(fb, lowX + tempW - measureText(low, { rung }), textY, low, { rung });
    drawText(fb, highX + tempW - measureText(high, { rung }), textY, high, { rung });
    const middle = top + Math.floor(rowH / 2);
    // The track: a hairline the whole width, so the scale is there to read a
    // bar against even on a day with nothing to draw on it.
    fb.hLine(barX, barX + barW - 1, middle);
    if (day.lowValue !== undefined && day.highValue !== undefined) {
      const a = at(Math.min(day.lowValue, day.highValue));
      const b = at(Math.max(day.lowValue, day.highValue));
      const w = Math.max(thick, b - a + 1);
      fb.fillRect(Math.min(a, barX + barW - w), middle - Math.floor(thick / 2), w, thick);
    }
  }
}

/**
 * The house, honouring the setting it used to ignore.
 *
 * This went through `drawPanel`'s tolerant reader, which builds "label: value"
 * out of anything with a `readings` array — so all four `display_mode` shapes
 * came out identical here, and a reading the household set to `value` said
 * `Locked` on the wall and `Front door: Locked` on a panel. One stored value,
 * two renderers, two answers. Found by rendering one and looking at it.
 *
 * The icon rung resolves now. It used to be nothing — the module chose an emoji
 * and `asciiTitle` deleted it — so `icon_state`, whose whole name is the mark
 * and the state, drew its label and its value and no mark at all. With a
 * first-party vocabulary there is a drawing.
 *
 * **The mark leads the line wherever the household put the rung**, and that is
 * a deliberate difference from the wall. A panel reading is one line read left
 * to right, not a stack, so a picture between two words is a hole in a
 * sentence; leading it is the only place a mark on a line can go. The order of
 * the *words* is untouched, which is what the ladder actually promises.
 */
interface EpaperReading {
  /** The handle a widget's `readings` resolves to; absent from an older panel. */
  readonly key: string | undefined;
  readonly label: string;
  readonly value: string;
  readonly mode: string;
  readonly glyph: GlyphKey | undefined;
}

function houseReadings(panel: unknown): EpaperReading[] {
  if (panel === null || typeof panel !== 'object') return [];
  const raw = (panel as { readings?: unknown }).readings;
  if (!Array.isArray(raw)) return [];
  const out: EpaperReading[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as { key?: unknown; label?: unknown; value?: unknown; mode?: unknown; glyph?: unknown };
    if (typeof row.label !== 'string' || typeof row.value !== 'string') continue;
    out.push({
      key: typeof row.key === 'string' ? row.key : undefined,
      label: asciiTitle(row.label),
      value: asciiTitle(row.value),
      mode: typeof row.mode === 'string' ? row.mode : 'label_value',
      glyph: isGlyphKey(row.glyph) ? row.glyph : undefined,
    });
  }
  return out;
}

function drawHouse(fb: Framebuffer, m: EpaperMetrics, box: Box, panel: unknown, config: Config): void {
  let readings = houseReadings(panel);
  const noReadings = (): void => {
    drawLines(fb, m, ['No readings yet'], box, rungToFit('No readings yet', box.w, m.body), 'left');
  };
  if (readings.length === 0) {
    noReadings();
    return;
  }
  /*
   * Which readings, by handle (P1.3). The panel draws from the stored config,
   * so its entries are entity ids — or labels, on a widget saved before the
   * editor wrote ids — and they resolve exactly as `displayConfig` resolves
   * them for the wall, against the same panel, so the two cannot pick
   * differently. This used to compare the stored label with `asciiTitle` of
   * the panel's, which never matched a label with an accent in it: a panel
   * showing "Température" drew "No readings yet" for a widget that asked for it.
   */
  const wanted = readingHandlesFor(list(config, 'readings'), readingIndexOf(panel)) ?? [];
  if (wanted.length > 0) readings = readings.filter((r) => r.key !== undefined && wanted.includes(r.key));
  if (readings.length === 0) {
    noReadings();
    return;
  }
  const cap = config['count'];
  if (typeof cap === 'number' && Number.isFinite(cap) && cap >= 1) {
    readings = readings.slice(0, Math.trunc(cap));
  }

  /*
   * One line each, the parts in the household's own order.
   *
   * A reading is a line rather than a stack because the panel's list is read
   * down, not across — the same reason the multi-person shift card collapses.
   * The label keeps its colon when it leads, because "Kitchen: 19.4 C" reads as
   * an attribution and "Kitchen 19.4 C" reads as a mistake.
   */
  const glyphScale = glyphScaleFor(m.bodyGlyph);
  const advance = glyphAdvance(glyphScale);
  const lines = readings.map((reading) => {
    const rows = ladderRows(
      houseLadder(config, reading.mode),
      { icon: reading.glyph ?? '', label: reading.label, value: reading.value },
      HOUSE_ROLES,
    );
    // `body` is the icon rung and nothing else here, exactly as it is in the
    // forecast's roles — see `heightOf` in `drawWeather`.
    const glyph = rows.find((row) => row.role === 'body');
    const words = rows.filter((row) => row.role !== 'body');
    const parts = words.map((row) => row.text);
    const text =
      words[0]?.field === 'label' && parts.length > 1
        ? `${parts[0]}: ${parts.slice(1).join('  ')}`
        : parts.join('  ');
    return { text, glyph: glyph !== undefined && isGlyphKey(glyph.text) ? glyph.text : undefined };
  });

  // Every line is measured against the same width, glyph or no glyph, so a
  // reading with a mark and one without still share a scale — the strip rule
  // `drawWeather` states, one widget along.
  const anyGlyph = lines.some((line) => line.glyph !== undefined);
  const textWidth = Math.max(1, box.w - (anyGlyph ? advance : 0));
  const rung = lines.reduce(
    (smallest, line) => shorterRung(smallest, rungToFit(line.text, textWidth, m.body)),
    m.body,
  );

  /*
   * One row a reading, drawn here rather than through `drawLines`, because a
   * row is a mark and a run of words on one baseline and that is two draws.
   *
   * The row's height is the taller of the two, so a mark can never push the
   * line it belongs to into the reading below — the reservation and the
   * advance are the same expression, which is the rule this file states twice
   * already.
   */
  const glyphH = anyGlyph ? glyphHeight(glyphScale) : 0;
  const textH = rung.height;
  const rowH = Math.max(glyphH, textH) + m.widget.linePad;
  let y = box.y;
  for (const line of lines) {
    if (y + rowH - m.widget.linePad > box.y + box.h) break;
    const left = box.x + (anyGlyph ? advance : 0);
    if (line.glyph !== undefined) {
      // Centred against the words, so a 24px mark beside 16px type does not
      // read as a mark with a caption hanging off its chin.
      drawGlyph(fb, box.x, y + Math.floor((rowH - m.widget.linePad - glyphH) / 2), line.glyph, glyphScale);
    }
    const text = fit(line.text, textWidth, { rung });
    drawText(fb, left, y + Math.floor((rowH - m.widget.linePad - textH) / 2), text, { rung });
    y += rowH;
  }
}

function drawPanel(
  fb: Framebuffer,
  m: EpaperMetrics,
  box: Box,
  panel: unknown,
  empty: string,
  rows?: number,
): void {
  /*
   * The box's own limit, and then the household's if they set a smaller one.
   *
   * Counted at the line height `drawLines` will actually use, not at a separate
   * 24 — those disagreed, so a box with room for five readings asked the module
   * for four and drew four. A count and the loop that draws it have to be the
   * same arithmetic; `agendaRowsInBox` is the same rule in the built-in layout.
   */
  const lineH = m.bodyGlyph + m.widget.linePad;
  const fits = Math.max(1, Math.floor(box.h / lineH));
  const lines = panelLines(panel, rows === undefined ? fits : Math.min(fits, rows)).map(asciiTitle);
  drawLines(fb, m, lines.length > 0 ? lines : [empty], box, m.body, 'left');
}

/**
 * A calendar widget, drawn the way the household asked.
 *
 * The view is read *exactly* as `renderCalendarWidget` reads it on the wall,
 * and that is the whole of one bug: the editor stores the default (`month`) as
 * an absence, and this tested `=== 'month'` — so the commonest setting, the one
 * nobody changes, drew the agenda on every panel. Two renderers reading one
 * stored value opposite ways is the same fault as two renderers drawing one
 * canvas, and the cure is the same: one reading, written down. It is written
 * down in `calendar-view.ts` now, rather than in a matching pair of `if`
 * statements two packages apart that somebody has to notice are a pair.
 *
 * Every option the designer offers is answered here, because an option that
 * does nothing is a worse answer than an option that is not offered.
 */
function drawCalendarWidget(
  fb: Framebuffer,
  box: Box,
  model: EpaperModel,
  m: EpaperMetrics,
  config: Config,
  log?: RegionLog,
): void {
  /*
   * The view, resolved by the transcription of the wall's own reading — never
   * by testing `mode` against a string here. `calendar-view.ts` carries why.
   *
   * The *density* half is read and then deliberately dropped: `compact` buys
   * its room back from gaps, cards and padding, and a 1-bit panel is already
   * edge to edge with hairline rules and has none of the three to give up. So
   * both densities draw the same frame, and `PANEL_IGNORES` says so where the
   * household set it rather than leaving it to be discovered on a panel bolted
   * to a wall in the hall. That is also what keeps a canvas storing `skymonth`
   * drawing exactly what it drew before the split.
   */
  const { view } = calendarView(config);
  /*
   * Whether the rota is drawn, read by the wall's own function (plan item
   * P5.4): on the month the absence of `showShifts` means on, on the week it
   * means off (Q2), and the panel must answer exactly as the wall it follows.
   * How it is drawn is the panel's own: the shift's code beside the day
   * number, whichever of the four colour looks the wall wears — three of them
   * are colour, which is `PANEL_IGNORES`'s sentence beside `shiftStyle`.
   */
  if (view === 'week') return drawWeekBox(fb, model, m, box, { shifts: shiftsShown(config, 'week') });
  if (view === 'month') {
    /*
     * `text`, `swiss` and `pills` all draw names here, and that is not a
     * shortcut.
     *
     * What separates them on the wall is a coloured ground versus a colour dot
     * versus neither, and a panel has none of those — it is one bit, so they
     * all resolve to the same question: does the cell show the event's name, or
     * a mark that something is on? Reading `=== 'pills'` alone would have
     * answered "no" for swiss and dropped a panel back to dots while the wall
     * it follows drew names, which is one stored value giving two renderers two
     * answers.
     *
     * The absence is the live half of that now. `cellEvents` unset means `text`
     * on the wall, so it has to mean names here — `dots` is the value a
     * household writes when they want the quiet grid, and it is the only one
     * that answers no.
     */
    const cellEvents = str(config, 'cellEvents');
    return drawMonthBox(
      fb,
      model,
      m,
      box,
      { pills: cellEvents !== 'dots', shifts: shiftsShown(config, 'month') },
      log,
    );
  }

  const calendars = strings(config, 'calendars');
  const count = num(config, 'count');
  return drawUpcomingBox(fb, model, m, box, {
    ...(calendars !== undefined ? { calendars } : {}),
    ...(count !== undefined ? { count } : {}),
  });
}

/**
 * The chore board, at 1-bit (RFC 008 phase 2).
 *
 * A dedicated draw rather than `drawPanel`, because chores are first-party data
 * with a shape the generic reader would flatten into unlabelled lines — and
 * because the box carries the one thing worth seeing from across a kitchen:
 * done or not.
 *
 * **The view is read exactly as the wall's `renderChoresWidget` reads it**, and
 * that sentence is the whole reason this function is worth reviewing. The
 * e-paper calendar shipped testing `mode === 'month'` while the editor stored
 * the default by leaving the key out, so every "Show as" value drew the same
 * thing and the commonest setting was the broken one. The rule that came out of
 * it: the wall is the spec, an absent `mode` is the default, and a test holds
 * the two renderers to each other.
 *
 * **A panel never offers a tick**, in this phase or any later one. A sleeping
 * ESP32 cannot honour a tap, so drawing a control it could not answer would be
 * a lie in ink — the same reason battery panels are documented as a glance
 * class rather than an alert class.
 */
function drawChores(fb: Framebuffer, m: EpaperMetrics, box: Box, panel: unknown, config: Config): void {
  const note = (text: string): void => {
    drawLines(fb, m, [text], box, rungToFit(text, box.w, m.body), 'left');
  };
  const board = readChorePanel(panel);
  if (board === undefined) {
    note('(no chores yet)');
    return;
  }

  const mode = str(config, 'mode') ?? '';
  const wanted = strings(config, 'people');
  const keep = (items: readonly ChoreLine[]): ChoreLine[] =>
    wanted === undefined
      ? [...items]
      : items.filter((item) => item.personId !== undefined && wanted.includes(item.personId));

  const rowH = m.widget.choreRowH;
  const tick = m.bullet;
  const textX = tick + m.bulletGap;
  const bottom = box.y + box.h;
  // A row is drawn when its tick fits, which is the tick's own bottom edge.
  const rowFits = (at: number): boolean => at + m.widget.tickDrop + tick <= bottom;
  let y = box.y;

  /** One chore: an empty box, or a filled one when it is done, then its name. */
  const drawRow = (item: ChoreLine, indent: number): void => {
    const left = box.x + indent;
    // Done is a *filled* box rather than a drawn tick: at 1-bit a 12px tick is
    // four pixels of ink that reads as a smudge from two metres, and solid
    // against empty is the strongest contrast the medium has.
    fb.strokeRect(left, y + m.widget.tickDrop, tick, tick, true);
    if (item.done) {
      const inset = m.widget.tickInset;
      fb.fillRect(left + inset, y + m.widget.tickDrop + inset, m.widget.tickDot, m.widget.tickDot, true);
    }
    const width = box.w - indent - textX;
    /*
     * The owner's name is dropped whole rather than truncated.
     *
     * `fit` cuts a character at a time, so a box one letter too narrow turned
     * "Feed the cat (Ella)" into "Feed the cat (E" — a parenthesis opened and
     * never closed, which reads as a rendering fault rather than as a name that
     * did not fit. Losing the owner is a real loss; losing it *visibly
     * mid-bracket* is a loss plus a bug the household has to explain to
     * themselves. The chore is the thing they walked over to read.
     */
    const name = asciiTitle(item.name);
    const withOwner = item.person === undefined ? name : `${name} (${asciiTitle(item.person)})`;
    const label = measureText(withOwner, { rung: m.body }) <= width ? withOwner : name;
    drawText(fb, left + textX, y, fit(label, width, { rung: m.body }), { rung: m.body });
    y += rowH;
  };

  if (mode === 'week') {
    for (const day of board.days) {
      const items = keep(day.items);
      // Empty days are skipped, the same as the wall's week view. The panel
      // keeps them so a caller drawing a grid can line them up; neither of
      // these two draws a grid.
      if (items.length === 0) continue;
      if (!rowFits(y)) break;
      const heading = day.date === board.today ? 'TODAY' : weekdayOf(day.date).toUpperCase();
      drawText(fb, box.x, y, fit(heading, box.w, { rung: m.small }), { rung: m.small });
      y += m.widget.smallLine;
      for (const item of items) {
        if (!rowFits(y)) break;
        drawRow(item, m.bulletGap);
      }
      y += m.widget.rowGap;
    }
    if (y === box.y) note('(nothing due this week)');
    return;
  }

  const today = keep(board.days[0]?.items ?? []);
  if (today.length === 0) {
    note('(nothing due today)');
    return;
  }

  if (mode === 'people') {
    /*
     * Grouped by person and stacked, not laid out in columns.
     *
     * A 1-bit panel is 800x480 and a widget box is a fraction of it; two
     * columns of 2x-scale text is about eleven characters each, which is a
     * chore board nobody can read. The *grouping* is what the setting asked
     * for, so that is what it gets, drawn the way this medium can carry it.
     */
    const groups = new Map<string, ChoreLine[]>();
    for (const item of today) {
      const key = item.person ?? '';
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [item]);
      else group.push(item);
    }
    const loose = groups.get('');
    groups.delete('');
    const draw = (name: string, items: readonly ChoreLine[]): void => {
      if (!rowFits(y)) return;
      drawText(fb, box.x, y, fit(asciiTitle(name).toUpperCase(), box.w, { rung: m.small }), {
        rung: m.small,
      });
      y += m.widget.smallLine;
      for (const item of items) {
        if (!rowFits(y)) break;
        // The name is already the heading; repeating it on every row would
        // spend a third of a narrow box saying it twice.
        drawRow({ ...item, person: undefined }, m.bulletGap);
      }
      y += m.widget.rowGap;
    };
    for (const [name, items] of groups) draw(name, items);
    if (loose !== undefined) draw('Anyone', loose);
    return;
  }

  // Today, the default, and what an absent `mode` means — the wall's rule.
  for (const item of today) {
    if (!rowFits(y)) break;
    drawRow(item, 0);
  }
}

interface ChoreLine {
  readonly name: string;
  /** The id the "whose chores" filter matches on; never drawn. */
  readonly personId: string | undefined;
  readonly person: string | undefined;
  readonly done: boolean;
}

interface ChoreBoard {
  readonly today: string;
  readonly days: readonly { readonly date: string; readonly items: readonly ChoreLine[] }[];
}

/**
 * The chore panel out of the manifest, read tolerantly.
 *
 * This process built the slice, but it is read as untrusted for the same reason
 * the display's `choresFrom` is: a panel and a server are two versions that can
 * drift, and rule nine says a bad slice costs a widget rather than the frame.
 */
function readChorePanel(panel: unknown): ChoreBoard | undefined {
  if (typeof panel !== 'object' || panel === null) return undefined;
  const raw = panel as { today?: unknown; days?: unknown };
  if (typeof raw.today !== 'string' || !Array.isArray(raw.days)) return undefined;

  const days: { date: string; items: ChoreLine[] }[] = [];
  for (const entry of raw.days) {
    if (typeof entry !== 'object' || entry === null) continue;
    const day = entry as { date?: unknown; items?: unknown };
    if (typeof day.date !== 'string') continue;
    const items: ChoreLine[] = [];
    for (const candidate of Array.isArray(day.items) ? day.items : []) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const item = candidate as {
        name?: unknown; person?: unknown; personId?: unknown; done?: unknown;
      };
      if (typeof item.name !== 'string' || item.name === '') continue;
      items.push({
        name: item.name,
        personId:
          typeof item.personId === 'string' && item.personId !== '' ? item.personId : undefined,
        person: typeof item.person === 'string' && item.person !== '' ? item.person : undefined,
        done: item.done === true,
      });
    }
    days.push({ date: day.date, items });
  }
  return days.length === 0 ? undefined : { today: raw.today, days };
}

/**
 * A civil date's short weekday.
 *
 * At UTC midnight, because the string is a calendar date with no zone in it —
 * reading it as a local instant slides it a day for anybody west of Greenwich.
 * Fixed English names rather than `Intl`: the bitmap font is ASCII, so a
 * localised weekday would come out as boxes on the one surface that cannot fall
 * back to a system font.
 */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function weekdayOf(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? '' : (WEEKDAYS[at.getUTCDay()] ?? '');
}

/**
 * What one widget's draw takes out of `manifest.panels`, and all it takes (P3.5).
 *
 * A panel's frame ETag used to hash the whole manifest, so anything any module
 * wrote moved every paired panel: a Home Assistant reading every thirty
 * seconds, a to-do list every minute, and — once the weather carried current
 * conditions — the weather every fifteen minutes, on panels with no weather on
 * them. A panel that sees a new ETag downloads a new frame and a battery panel
 * does a full refresh to show it, so the churn was a flash and a drained
 * battery for a picture that had not changed.
 *
 * So this is the one place a widget reads a module's panel, and `drawWidget`
 * is handed its answer rather than the manifest: **a draw cannot read anything
 * the ETag does not hash**, because it has nothing else to read from. The
 * frame hashes these answers (`canvasPanelInputs`) in place of `panels`. That
 * is the general version of the change the plan asks for, and it is the same
 * rule as `agendaRowsInBox`, one layer out: what is hashed and what is drawn
 * have to be the same reading, or one of them is a guess about the other.
 *
 * Each answer is as narrow as the draw it feeds:
 *
 * - **Weather** is the forecast days as `forecastDays` reads them — a name, a
 *   high, a low and a glyph each — so the fields the strip does not draw
 *   (`current`, `hourly`, `air`, `units`, `fetchedAt`, a day's `detail` and
 *   rain chance) cannot move a frame. A style that draws current conditions
 *   (P5.1's `today`) has `epaperCurrent`'s answer added here, which is the
 *   only way `current` can reach a draw and so the only way it can reach the
 *   ETag: a panel that draws the reading gets a new frame when it changes, and
 *   one that does not, does not.
 * - **A to-do widget** reads its own list and nothing else, and a typed
 *   checklist reads no panel at all.
 * - **The house, the chore board and a module's panel** read their whole slice,
 *   because each draw reads it whole.
 *
 * The widget's config is the one the draw is given — after the ink lane — so a
 * panel-only override is read the way it is drawn.
 */
export type PanelInput =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'weather';
      readonly days: readonly EpaperForecastDay[];
      /** The reading and its time — only on the `today` look, which draws it. */
      readonly current?: EpaperCurrent;
    }
  | { readonly kind: 'todo'; readonly list: TodoRead | undefined }
  | { readonly kind: 'panel'; readonly panel: unknown };

const NO_INPUT: PanelInput = { kind: 'none' };

export function panelInput(type: string, manifest: Manifest, config: Config): PanelInput {
  const panels = manifest.panels;
  switch (type) {
    case 'weather': {
      const look = variantOf('weather', config);
      const days = forecastDays(panels['weather'], look === 'range');
      if (look !== 'today') return { kind: 'weather', days };
      /*
       * The `today` look draws the current reading with its time (P3.5, P5.1),
       * so it is the one weather input that carries it — and so the one whose
       * ETag moves when a new reading arrives. A strip, a range or any other
       * look reads `days` alone, and a reading taken every fifteen minutes
       * cannot refresh a panel that does not draw it.
       *
       * And of the days it reads today's name, high and low and nothing else:
       * the card draws no glyph and no other day, so a revised sky on Friday
       * must not refresh a panel whose card is about today.
       */
      const first = days[0];
      const today: EpaperForecastDay[] =
        first === undefined ? [] : [{ name: first.name, high: first.high, low: first.low, glyph: undefined }];
      const current = epaperCurrent(panels['weather'], manifest.timezone, manifest.display.clock24 !== false);
      return current === undefined ? { kind: 'weather', days: today } : { kind: 'weather', days: today, current };
    }
    case 'todo': {
      const entityId = todoListOf(config);
      if (entityId === undefined) return NO_INPUT;
      return { kind: 'todo', list: readTodoPanel(panels['todo']).get(todoListHandle(entityId)) };
    }
    case 'chores':
      return { kind: 'panel', panel: panels['chores'] };
    case 'homeassistant':
      return { kind: 'panel', panel: panels['home'] ?? panels['homeassistant'] };
    case 'external': {
      const mod = str(config, 'module');
      return { kind: 'panel', panel: mod !== undefined ? panels[mod] : undefined };
    }
    default:
      return NO_INPUT;
  }
}

/**
 * Every widget's input on one canvas, in the canvas's own order — what the
 * frame's ETag hashes in place of `manifest.panels`.
 *
 * Every widget in the list, drawn or not: a box too small to draw, or a child
 * whose group was dropped, costs a panel at most a refresh it did not need,
 * where leaving one out could hide a change it did. The config goes through
 * `withInk` exactly as `renderFreeformEpaper` sends it to the draw.
 */
export function canvasPanelInputs(
  manifest: Manifest,
  widgets: readonly PlacedEpaperWidget[],
): readonly PanelInput[] {
  return widgets.map((widget) => panelInput(widget.type, manifest, withInk(widget.config)));
}

function drawWidget(
  fb: Framebuffer,
  type: string,
  box: Box,
  model: EpaperModel,
  input: PanelInput,
  m: EpaperMetrics,
  config: Config,
  /**
   * The canvas's region log, when the caller keeps one. Only the calendar
   * records inside its box today — its cells and the rectangles its rota codes
   * take (plan item P5.4), which is what lets a test hold those to the refresh
   * contract on a household's own canvas rather than only on the built-in one.
   */
  log?: RegionLog,
): void {
  switch (type) {
    case 'clock':
      return drawClock(fb, m, box, model, config);
    case 'calendar':
      return drawCalendarWidget(fb, box, model, m, config, log);
    case 'shift':
      return drawShift(fb, m, box, model, config);
    case 'countdown':
      return drawCountdown(fb, m, box, model, config);
    case 'notes':
      return drawLines(
        fb,
        m,
        wrap(str(config, 'text') ?? '', box.w, m.body),
        box,
        m.body,
        alignOf(config),
      );
    case 'todo':
      return drawTodo(fb, m, box, input.kind === 'todo' ? input.list : undefined, config);
    case 'chores':
      return drawChores(fb, m, box, input.kind === 'panel' ? input.panel : undefined, config);
    case 'weather':
      return input.kind === 'weather'
        ? drawWeather(fb, m, box, input.days, config, input.current)
        : drawWeather(fb, m, box, [], config);
    case 'homeassistant':
      return drawHouse(fb, m, box, input.kind === 'panel' ? input.panel : undefined, config);
    case 'external': {
      const rows = config['count'];
      return drawPanel(
        fb,
        m,
        box,
        input.kind === 'panel' ? input.panel : undefined,
        'No data yet',
        typeof rows === 'number' && Number.isFinite(rows) && rows >= 1 ? Math.trunc(rows) : undefined,
      );
    }
    case 'image':
      return drawImage(fb, m, box, config);
    default:
      return drawLines(fb, m, [asciiTitle(type)], box, m.body, 'left');
  }
}

/**
 * Draw a free-form canvas of widgets to a framebuffer sized to the panel.
 *
 * Each widget's fractional box becomes a pixel box; widgets are drawn back to
 * front by `z`. A box too small to hold anything is skipped rather than drawn
 * as a lone border.
 */
export function renderFreeformEpaper(
  model: EpaperModel,
  manifest: Manifest,
  widgets: readonly PlacedEpaperWidget[],
  geometry: PanelGeometry,
  /**
   * Opt-in, like `renderEpaper`'s: pass an array and every box this canvas
   * draws into is recorded — each widget's, and inside a group each child's —
   * under a *positional* name, which is what `reflow-stability.test.ts`
   * compares between two frames. See `DrawnRegion` in `render.ts`.
   */
  regions?: RegionLog,
): Framebuffer {
  const fb = new Framebuffer(geometry.width, geometry.height);
  // One reading of the panel, handed down. The shared calendar draws size their
  // type from the panel and their row counts from the box, so a widget dragged
  // small on a 13.3" panel gets fewer rows of the same readable type rather
  // than the same rows shrunk to nothing.
  const m = panelMetrics(geometry);
  /*
   * A canvas authored with nothing on it says so, rather than being a white
   * sheet nobody can explain from the kitchen — the panel's twin of the wall's
   * own `canvas-empty` note, in the same words, because a household following a
   * wall from a panel should not be told two different things about one state.
   *
   * The rung is stepped against a *constant* sentence, which is what keeps this
   * inside the refresh contract: every drawn region has to be a function of
   * (panel size, tier) alone, and a note whose text never varies is exactly the
   * character budget `noteRung` and `HEADER_MAX_CHARS` already work to.
   */
  if (widgets.length === 0) {
    const box: Box = {
      x: m.margin,
      y: m.margin,
      w: Math.max(0, geometry.width - m.margin * 2),
      h: Math.max(0, geometry.height - m.margin * 2),
    };
    drawLines(fb, m, [EMPTY_CANVAS], box, rungToFit(EMPTY_CANVAS, box.w, m.body), 'left');
    return fb;
  }
  /*
   * The parents, then the children inside them (RFC 014 §5.1) — the wall's
   * own order, and the same cells: `childCells` is the display's module
   * transcribed, so a child lands in the same fraction of its group's inner
   * box on both media — from the order, or from its own stored fractions in
   * a `free` group and resolves to panel pixels exactly as a top-level box
   * does. A group is a box here too: its frame and title are drawn, and its
   * children are drawn inside what is left, each with a frame of its own.
   */
  const children = groupChildren(widgets.map((widget, index) => ({ ...widget, id: widget.id ?? `#${index}`, z: widget.z })));
  const ordered = topLevelWidgets(widgets)
    .map((widget, index) => ({ widget, index }))
    .sort((a, b) => a.widget.z - b.widget.z || a.index - b.index);
  /** A child's pixel box: edges rounded, so adjacent cells meet and never overlap. */
  const cellBox = (inner: Box, cell: { x: number; y: number; w: number; h: number }): Box => {
    const x0 = inner.x + Math.round(cell.x * inner.w);
    const x1 = inner.x + Math.round((cell.x + cell.w) * inner.w);
    const y0 = inner.y + Math.round(cell.y * inner.h);
    const y1 = inner.y + Math.round((cell.y + cell.h) * inner.h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  ordered.forEach(({ widget }, position) => {
    const box: Box = {
      x: Math.round(widget.x * geometry.width),
      y: Math.round(widget.y * geometry.height),
      w: Math.round(widget.w * geometry.width),
      h: Math.round(widget.h * geometry.height),
    };
    recordRegion(regions, `widget:${position}`, box);
    if (box.w < 16 || box.h < 16) return;
    /*
     * The ink lane, applied once and only here (RFC 005, direction B).
     *
     * A widget carries the household's wall settings and, optionally, an `ink`
     * object saying what it does differently in black and white. Merging at the
     * one place the panel draws a widget means every reader below — the frame,
     * the ladders, each draw — is untouched and none of them can forget to ask.
     * The wall renderer never looks at `ink` at all, which is what keeps the
     * lane one-way: a household cannot change their kitchen wall by tuning a
     * panel.
     */
    const config = withInk(widget.config);
    const inner = drawFrame(fb, m, box, config);
    recordRegion(regions, `widget-inner:${position}`, inner);
    if (widget.type !== 'group') {
      drawWidget(fb, widget.type, inner, model, panelInput(widget.type, manifest, config), m, config, regions);
      return;
    }
    const members = widget.id === undefined ? [] : (children.get(widget.id) ?? []);
    const cells = childCells(config, members);
    members.forEach((child, index) => {
      const cell = cells[index];
      if (cell === undefined) return;
      const childBox = cellBox(inner, cell);
      recordRegion(regions, `child:${position}:${index}`, childBox);
      if (childBox.w < 16 || childBox.h < 16) return;
      const childConfig = withInk(child.config);
      const childInner = drawFrame(fb, m, childBox, childConfig);
      recordRegion(regions, `child-inner:${position}:${index}`, childInner);
      drawWidget(fb, child.type, childInner, model, panelInput(child.type, manifest, childConfig), m, childConfig, regions);
    });
  });
  return fb;
}
