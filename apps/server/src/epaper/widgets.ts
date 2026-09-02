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

import type { Manifest } from '../api/manifest.js';

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
  type Box,
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
import { withInk } from './honours.js';
import { clockLabel, type EpaperModel } from './viewmodel.js';

/** A widget placed on the canvas: fractional box, plus its stored options. */
export interface PlacedEpaperWidget {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly config: Readonly<Record<string, unknown>>;
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
function drawFrame(fb: Framebuffer, m: EpaperMetrics, box: Box, config: Config): Box {
  const pad = m.widget.inset;
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

/**
 * The clock, honouring the same two options the wall's does.
 *
 * `clockFormat` re-reads the frame's own time rather than reformatting the
 * string the viewmodel already built, which is the only way to change a clock
 * without parsing one. `showDate` is absence-means-on, matching the schema.
 */
function drawClock(fb: Framebuffer, m: EpaperMetrics, box: Box, model: EpaperModel, config: Config): void {
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
  if (config['showDate'] === false) return;
  const dateRung = shorterRung(scaleRung(m, 1.5), rungStep(timeRung, -1));
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

function drawCountdown(fb: Framebuffer, m: EpaperMetrics, box: Box, model: EpaperModel, config: Config): void {
  const target = str(config, 'target');
  const title = str(config, 'title') ?? '';
  let big = '--';
  let unit = '';
  if (target !== undefined) {
    const days = daysBetween(model.today, target);
    if (days === 0) big = 'Today';
    else {
      big = String(Math.abs(days));
      unit = days > 0 ? (days === 1 ? 'day' : 'days') : days === -1 ? 'day ago' : 'days ago';
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

function drawTodo(fb: Framebuffer, m: EpaperMetrics, box: Box, config: Config): void {
  const items = list(config, 'items').filter((x): x is string => typeof x === 'string');
  if (items.length === 0) {
    drawLines(fb, m, ['(nothing on the list)'], box, rungToFit('(nothing on the list)', box.w, m.body), 'left');
    return;
  }
  const rowH = m.widget.listRowH;
  const textX = m.bullet + m.bulletGap;
  let y = box.y;
  for (const item of items) {
    // The row is drawn when its *box* fits, which is the bullet's own bottom —
    // the same guard the agenda uses, in the same terms.
    if (y + m.bulletDrop + m.bullet > box.y + box.h) break;
    fb.strokeRect(box.x, y + m.bulletDrop, m.bullet, m.bullet, true);
    drawText(fb, box.x + textX, y, fit(asciiTitle(item), box.w - textX, { rung: m.body }), {
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
}

/** Read the weather panel defensively — a module's shape is its own. */
function forecastDays(panel: unknown): EpaperForecastDay[] {
  if (panel === null || typeof panel !== 'object') return [];
  const raw = (panel as { days?: unknown }).days;
  if (!Array.isArray(raw)) return [];
  const out: EpaperForecastDay[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const day = entry as {
      name?: unknown; high?: unknown; low?: unknown; unit?: unknown; glyph?: unknown;
    };
    if (typeof day.name !== 'string') continue;
    const unit = typeof day.unit === 'string' ? asciiTitle(day.unit) : '';
    const degrees = (value: unknown): string =>
      typeof value === 'number' ? String(Math.round(value)) : '-';
    out.push({
      name: asciiTitle(day.name),
      high: degrees(day.high),
      low: `${degrees(day.low)}${unit}`,
      glyph: isGlyphKey(day.glyph) ? day.glyph : undefined,
    });
  }
  return out;
}

function drawWeather(fb: Framebuffer, m: EpaperMetrics, box: Box, manifest: Manifest, config: Config): void {
  let days = forecastDays(manifest.panels['weather']);
  if (days.length === 0) {
    drawLines(fb, m, ['No weather yet'], box, rungToFit('No weather yet', box.w, m.body), 'left');
    return;
  }
  const wanted = config['count'];
  if (typeof wanted === 'number' && Number.isFinite(wanted) && wanted >= 1) {
    days = days.slice(0, Math.trunc(wanted));
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
    const row = entry as { label?: unknown; value?: unknown; mode?: unknown; glyph?: unknown };
    if (typeof row.label !== 'string' || typeof row.value !== 'string') continue;
    out.push({
      label: asciiTitle(row.label),
      value: asciiTitle(row.value),
      mode: typeof row.mode === 'string' ? row.mode : 'label_value',
      glyph: isGlyphKey(row.glyph) ? row.glyph : undefined,
    });
  }
  return out;
}

function drawHouse(fb: Framebuffer, m: EpaperMetrics, box: Box, manifest: Manifest, config: Config): void {
  const panel = manifest.panels['home'] ?? manifest.panels['homeassistant'];
  let readings = houseReadings(panel);
  const noReadings = (): void => {
    drawLines(fb, m, ['No readings yet'], box, rungToFit('No readings yet', box.w, m.body), 'left');
  };
  if (readings.length === 0) {
    noReadings();
    return;
  }
  // Which readings, by the label the household sees — the manifest carries no
  // entity id, exactly as the wall's widget reads it.
  const wanted = list(config, 'readings').filter((r): r is string => typeof r === 'string');
  if (wanted.length > 0) readings = readings.filter((r) => wanted.includes(r.label));
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
  if (view === 'week') return drawWeekBox(fb, model, m, box);
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
    return drawMonthBox(fb, model, m, box, { pills: cellEvents !== 'dots' });
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

function drawWidget(
  fb: Framebuffer,
  type: string,
  box: Box,
  model: EpaperModel,
  manifest: Manifest,
  m: EpaperMetrics,
  config: Config,
): void {
  switch (type) {
    case 'clock':
      return drawClock(fb, m, box, model, config);
    case 'calendar':
      return drawCalendarWidget(fb, box, model, m, config);
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
      return drawTodo(fb, m, box, config);
    case 'chores':
      return drawChores(fb, m, box, manifest.panels['chores'], config);
    case 'weather':
      return drawWeather(fb, m, box, manifest, config);
    case 'homeassistant':
      return drawHouse(fb, m, box, manifest, config);
    case 'external': {
      const mod = str(config, 'module');
      const rows = config['count'];
      return drawPanel(
        fb,
        m,
        box,
        mod !== undefined ? manifest.panels[mod] : undefined,
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
): Framebuffer {
  const fb = new Framebuffer(geometry.width, geometry.height);
  // One reading of the panel, handed down. The shared calendar draws size their
  // type from the panel and their row counts from the box, so a widget dragged
  // small on a 13.3" panel gets fewer rows of the same readable type rather
  // than the same rows shrunk to nothing.
  const m = panelMetrics(geometry);
  const ordered = [...widgets].sort((a, b) => a.z - b.z);
  for (const widget of ordered) {
    const box: Box = {
      x: Math.round(widget.x * geometry.width),
      y: Math.round(widget.y * geometry.height),
      w: Math.round(widget.w * geometry.width),
      h: Math.round(widget.h * geometry.height),
    };
    if (box.w < 16 || box.h < 16) continue;
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
    drawWidget(fb, widget.type, inner, model, manifest, m, config);
  }
  return fb;
}
