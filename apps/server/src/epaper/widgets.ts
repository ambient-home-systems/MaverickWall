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

import { drawText, GLYPH_SIZE, measureText } from './font.js';
import { Framebuffer } from './framebuffer.js';
import {
  asciiTitle,
  drawMonthBox,
  drawUpcomingBox,
  drawWeekBox,
  fit,
  type Box,
  type PanelGeometry,
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

const PAD = 8;

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
function wrap(text: string, maxWidth: number, scale: number): string[] {
  const lines: string[] = [];
  for (const paragraph of asciiTitle(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (measureText(candidate, { scale }) <= maxWidth) line = candidate;
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
 * The largest scale, down to 1, at which `text` fits `width`.
 *
 * `drawLines` truncates a line to its box, so a scale picked from the box's
 * *height* alone silently loses characters off the right — a clock drawing
 * "08:3" for half past eight, which is not a smaller clock but a wrong one.
 * Every headline string picks its size through here, so the box shrinks the
 * type rather than the type losing its tail.
 */
function scaleToFit(text: string, width: number, max: number): number {
  for (let scale = Math.max(1, Math.floor(max)); scale > 1; scale -= 1) {
    if (measureText(text, { scale }) <= width) return scale;
  }
  return 1;
}

/**
 * Rows of differing sizes down a box, stopping at its foot — the 1-bit twin of
 * a card with a kicker, a headline and a detail line.
 */
function drawStack(
  fb: Framebuffer,
  box: Box,
  rows: readonly { readonly text: string; readonly scale: number }[],
  align: 'left' | 'center' | 'right',
): void {
  let y = box.y;
  for (const row of rows) {
    if (row.text === '') continue;
    const h = GLYPH_SIZE * row.scale;
    if (y + h > box.y + box.h) break;
    drawLines(fb, [row.text], { ...box, y, h }, row.scale, align);
    y += h + 4;
  }
}

/** Draw stacked lines within a box, clipped to its height and width, honouring align. */
function drawLines(fb: Framebuffer, lines: readonly string[], box: Box, scale: number, align: 'left' | 'center' | 'right'): void {
  const lineH = GLYPH_SIZE * scale + 4;
  let y = box.y;
  for (const raw of lines) {
    if (y + GLYPH_SIZE * scale > box.y + box.h) break;
    // Truncate to the box so a long line stops at its own edge rather than
    // bleeding into the widget beside it.
    const line = fit(raw, box.w, { scale });
    const w = measureText(line, { scale });
    const x =
      align === 'center' ? box.x + Math.floor((box.w - w) / 2) : align === 'right' ? box.x + box.w - w : box.x;
    drawText(fb, x, y, line, { scale });
    y += lineH;
  }
}

/** A widget's border and optional title bar; returns the inner content box. */
function drawFrame(fb: Framebuffer, box: Box, config: Config): Box {
  fb.strokeRect(box.x, box.y, box.w, box.h, true);
  let inner: Box = { x: box.x + PAD, y: box.y + PAD, w: box.w - PAD * 2, h: box.h - PAD * 2 };
  const title = str(config, 'title');
  if (config.showTitle === true && title !== undefined && title !== '') {
    drawText(fb, inner.x, inner.y, asciiTitle(title).toUpperCase(), { scale: 1, tracking: 1 });
    fb.hLine(inner.x, inner.x + inner.w, inner.y + 12, true);
    inner = { x: inner.x, y: inner.y + 20, w: inner.w, h: inner.h - 20 };
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
function drawClock(fb: Framebuffer, box: Box, model: EpaperModel, config: Config): void {
  const format = str(config, 'clockFormat');
  const time =
    format === '12' || format === '24'
      ? clockLabel(model.generatedAt, model.timezone, format === '24')
      : model.time;
  // Bounded by the height it has *and* the width it has: a box taller than it
  // is wide used to pick a size the time could not fit, and lost its last
  // digit to the truncation in `drawLines`.
  const byHeight = Math.max(2, Math.min(8, Math.floor(box.h / 18)));
  const timeScale = scaleToFit(time, box.w, byHeight);
  const align = alignOf(config);
  drawLines(fb, [time], { ...box, h: GLYPH_SIZE * timeScale }, timeScale, align);
  if (config['showDate'] === false) return;
  const dateScale = Math.max(1, Math.min(3, Math.floor(timeScale / 2)));
  const date = `${model.header.weekday} ${model.header.day} ${model.header.month}`;
  const dateTop = box.y + GLYPH_SIZE * timeScale + 8;
  drawLines(
    fb,
    wrap(date, box.w, dateScale),
    // The remaining height, not the whole box: measuring from the box's top
    // let the wrapped date run past its foot and into the widget below.
    { x: box.x, y: dateTop, w: box.w, h: Math.max(0, box.y + box.h - dateTop) },
    dateScale,
    align,
  );
}

function drawCountdown(fb: Framebuffer, box: Box, model: EpaperModel, config: Config): void {
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
  const scale = scaleToFit(big, box.w, Math.max(2, Math.min(9, Math.floor(box.h / 16))));
  drawLines(fb, [big], { ...box, h: GLYPH_SIZE * scale }, scale, 'center');
  const restTop = box.y + GLYPH_SIZE * scale + 6;
  drawLines(
    fb,
    [unit, asciiTitle(title)].filter((l) => l !== ''),
    { x: box.x, y: restTop, w: box.w, h: Math.max(0, box.y + box.h - restTop) },
    2,
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
function drawShift(fb: Framebuffer, box: Box, model: EpaperModel, config: Config): void {
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
    drawLines(fb, ['No shift today'], box, scaleToFit('No shift today', box.w, 2), 'left');
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
    const ROW_GAP = 4;
    const heightOf = (role: LadderRole): number =>
      (role === 'headline' ? GLYPH_SIZE * 2 : GLYPH_SIZE) + ROW_GAP;
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
      drawLines(fb, [compactLine(rows)], box, scaleToFit(compactLine(rows), box.w, 2), 'left');
      return;
    }

    // The headline takes whatever the surviving rows did not need.
    const others = kept.filter((row) => row.role !== 'headline');
    const headroom = Math.max(GLYPH_SIZE, box.h - others.length * (GLYPH_SIZE + ROW_GAP));
    const stack = kept.map((row) => {
      if (row.role !== 'headline') return { text: row.text, scale: 1 };
      const text = row.text.toUpperCase();
      return {
        text,
        scale: scaleToFit(text, box.w, Math.max(2, Math.min(7, Math.floor(headroom / GLYPH_SIZE)))),
      };
    });
    drawStack(
      fb,
      box,
      stack.map((row) => (row.scale === 1 ? { ...row, text: row.text.toUpperCase() } : row)),
      'left',
    );
    return;
  }

  // More than one person: a compact line each, sized so the longest still fits
  // rather than being cut at the box edge. The ladder decides which parts are
  // on the line and in what order, exactly as it decides the rows above.
  const lines = shifts.map((s) => compactLine(ladderRows(ladder, valuesFor(s), SHIFT_ROLES)));
  const scale = lines.reduce((smallest, line) => Math.min(smallest, scaleToFit(line, box.w, 2)), 2);
  drawLines(fb, lines, box, scale, 'left');
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

function drawTodo(fb: Framebuffer, box: Box, config: Config): void {
  const items = list(config, 'items').filter((x): x is string => typeof x === 'string');
  if (items.length === 0) {
    drawLines(fb, ['(nothing on the list)'], box, 2, 'left');
    return;
  }
  const rowH = 24;
  let y = box.y;
  for (const item of items) {
    if (y + 14 > box.y + box.h) break;
    fb.strokeRect(box.x, y + 2, 12, 12, true);
    drawText(fb, box.x + 20, y, fit(asciiTitle(item), box.w - 20, { scale: 2 }), { scale: 2 });
    y += rowH;
  }
}

function drawImage(fb: Framebuffer, box: Box, config: Config): void {
  const name = str(config, 'image');
  drawLines(
    fb,
    ['[ photo ]', name !== undefined ? fit(name, box.w, { scale: 1 }) : 'not shown on eInk yet'],
    { x: box.x, y: box.y + Math.max(0, Math.floor(box.h / 2) - 10), w: box.w, h: box.h },
    1,
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
}

/** Read the weather panel defensively — a module's shape is its own. */
function forecastDays(panel: unknown): EpaperForecastDay[] {
  if (panel === null || typeof panel !== 'object') return [];
  const raw = (panel as { days?: unknown }).days;
  if (!Array.isArray(raw)) return [];
  const out: EpaperForecastDay[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const day = entry as { name?: unknown; high?: unknown; low?: unknown; unit?: unknown };
    if (typeof day.name !== 'string') continue;
    const unit = typeof day.unit === 'string' ? asciiTitle(day.unit) : '';
    const degrees = (value: unknown): string =>
      typeof value === 'number' ? String(Math.round(value)) : '-';
    out.push({
      name: asciiTitle(day.name),
      high: degrees(day.high),
      low: `${degrees(day.low)}${unit}`,
    });
  }
  return out;
}

function drawWeather(fb: Framebuffer, box: Box, manifest: Manifest, config: Config): void {
  let days = forecastDays(manifest.panels['weather']);
  if (days.length === 0) {
    drawLines(fb, ['No weather yet'], box, scaleToFit('No weather yet', box.w, 2), 'left');
    return;
  }
  const wanted = config['count'];
  if (typeof wanted === 'number' && Number.isFinite(wanted) && wanted >= 1) {
    days = days.slice(0, Math.trunc(wanted));
  }

  const ladder = weatherLadder(config);
  const paired = pairsTemperatures(ladder);
  /*
   * `icon` never resolves here: the panel's font is 0x20–0x7E and a forecast
   * glyph is not in it, so the rung is simply dropped — the same way `run` is
   * dropped from a shift ladder on a screen that has never had a row for it.
   * The ladder is shared; the data is not.
   */
  const rowsFor = (day: EpaperForecastDay): readonly LadderRow<WeatherField>[] =>
    ladderRows(ladder, { name: day.name, high: day.high, low: day.low }, WEATHER_ROLES);

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
  if (columnWidth >= 56 && box.h >= 40) {
    const ROW_GAP = 6;
    const heightOf = (role: LadderRole): number =>
      (role === 'headline' ? GLYPH_SIZE * 3 : GLYPH_SIZE) + ROW_GAP;
    // Size comes from the *role*, never from the row's position. Putting the
    // temperatures above the day name must not make the day name enormous —
    // that is the ladder's own rule, and sizing by index broke it the moment a
    // household reordered anything. Found by rendering a reordered strip.
    const maxScale = (role: LadderRole): number => (role === 'headline' ? 3 : 1);

    const columns = days.map((day) => foldPairs(dropToFit(rowsFor(day), box.h, heightOf)));
    /*
     * One scale per row, across every column.
     *
     * `scaleToFit` answers per string, so "20  9C" fits a size that "24  13C"
     * does not and the strip came out with one column twice the size of its
     * neighbours — a forecast that reads as five unrelated widgets. Taking the
     * smallest that fits them all is what keeps a strip a strip.
     */
    const rowCount = columns.reduce((most, rows) => Math.max(most, rows.length), 0);
    const scales: number[] = [];
    for (let row = 0; row < rowCount; row++) {
      let scale = 0;
      for (const rows of columns) {
        const cell = rows[row];
        if (cell === undefined) continue;
        const fits = scaleToFit(cell.text, columnWidth - 4, maxScale(cell.role));
        scale = scale === 0 ? fits : Math.min(scale, fits);
      }
      scales.push(Math.max(1, scale));
    }

    columns.forEach((rows, index) => {
      const column: Box = { x: box.x + columnWidth * index, y: box.y, w: columnWidth - 4, h: box.h };
      drawStack(
        fb,
        column,
        rows.map((cell, row) => ({ text: cell.text, scale: scales[row] ?? 1 })),
        'left',
      );
    });
    return;
  }

  const lines = days.map((day) => foldPairs(rowsFor(day)).map((cell) => cell.text).join('  '));
  const scale = lines.reduce((smallest, line) => Math.min(smallest, scaleToFit(line, box.w, 2)), 2);
  drawLines(fb, lines, box, scale, 'left');
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
 * The icon rung resolves to nothing: a glyph is not in the 0x20–0x7E font, the
 * same way a forecast symbol is not. So `icon_state` and `presence` draw their
 * label and value here, which is the honest 1-bit reading of them.
 */
interface EpaperReading {
  readonly label: string;
  readonly value: string;
  readonly mode: string;
}

function houseReadings(panel: unknown): EpaperReading[] {
  if (panel === null || typeof panel !== 'object') return [];
  const raw = (panel as { readings?: unknown }).readings;
  if (!Array.isArray(raw)) return [];
  const out: EpaperReading[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as { label?: unknown; value?: unknown; mode?: unknown };
    if (typeof row.label !== 'string' || typeof row.value !== 'string') continue;
    out.push({
      label: asciiTitle(row.label),
      value: asciiTitle(row.value),
      mode: typeof row.mode === 'string' ? row.mode : 'label_value',
    });
  }
  return out;
}

function drawHouse(fb: Framebuffer, box: Box, manifest: Manifest, config: Config): void {
  const panel = manifest.panels['home'] ?? manifest.panels['homeassistant'];
  let readings = houseReadings(panel);
  if (readings.length === 0) {
    drawLines(fb, ['No readings yet'], box, 2, 'left');
    return;
  }
  // Which readings, by the label the household sees — the manifest carries no
  // entity id, exactly as the wall's widget reads it.
  const wanted = list(config, 'readings').filter((r): r is string => typeof r === 'string');
  if (wanted.length > 0) readings = readings.filter((r) => wanted.includes(r.label));
  if (readings.length === 0) {
    drawLines(fb, ['No readings yet'], box, 2, 'left');
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
  const lines = readings.map((reading) => {
    const rows = ladderRows(
      houseLadder(config, reading.mode),
      { label: reading.label, value: reading.value },
      HOUSE_ROLES,
    );
    const parts = rows.map((row) => row.text);
    if (rows[0]?.field === 'label' && parts.length > 1) {
      return `${parts[0]}: ${parts.slice(1).join('  ')}`;
    }
    return parts.join('  ');
  });

  const scale = lines.reduce((smallest, line) => Math.min(smallest, scaleToFit(line, box.w, 2)), 2);
  drawLines(fb, lines, box, scale, 'left');
}

function drawPanel(fb: Framebuffer, box: Box, panel: unknown, empty: string, rows?: number): void {
  // The box's own limit, and then the household's if they set a smaller one.
  const fits = Math.max(1, Math.floor(box.h / 24));
  const lines = panelLines(panel, rows === undefined ? fits : Math.min(fits, rows)).map(asciiTitle);
  drawLines(fb, lines.length > 0 ? lines : [empty], box, 2, 'left');
}

/**
 * A calendar widget, drawn the way the household asked.
 *
 * The mode is read *exactly* as `renderCalendarWidget` reads it on the wall,
 * and that is the whole of one bug: the editor stores the default (`month`) as
 * an absence, and this tested `=== 'month'` — so the commonest setting, the one
 * nobody changes, drew the agenda on every panel. Two renderers reading one
 * stored value opposite ways is the same fault as two renderers drawing one
 * canvas, and the cure is the same: one reading, written down.
 *
 * Every option the designer offers is answered here, because an option that
 * does nothing is a worse answer than an option that is not offered.
 */
function drawCalendarWidget(fb: Framebuffer, box: Box, model: EpaperModel, config: Config): void {
  const mode = str(config, 'mode');
  /*
   * `skyweek`/`skymonth` are a browser-side density choice, not a different
   * calendar: a 1-bit panel is already edge to edge with hairline rules and has
   * no padding to reclaim. So they draw the same week and month a panel already
   * draws, named explicitly rather than left to the `!== 'list'` fallthrough —
   * which is what silently turned every mode into the month grid before 0.33.2,
   * and would have turned `skyweek` into a month here.
   */
  if (mode === 'week' || mode === 'skyweek') return drawWeekBox(fb, model, box);
  if (mode !== 'list') return drawMonthBox(fb, model, box, { pills: str(config, 'cellEvents') === 'pills' });
  const calendars = strings(config, 'calendars');
  const count = num(config, 'count');
  return drawUpcomingBox(fb, model, box, {
    ...(calendars !== undefined ? { calendars } : {}),
    ...(count !== undefined ? { count } : {}),
  });
}

function drawWidget(fb: Framebuffer, type: string, box: Box, model: EpaperModel, manifest: Manifest, config: Config): void {
  switch (type) {
    case 'clock':
      return drawClock(fb, box, model, config);
    case 'calendar':
      return drawCalendarWidget(fb, box, model, config);
    case 'shift':
      return drawShift(fb, box, model, config);
    case 'countdown':
      return drawCountdown(fb, box, model, config);
    case 'notes':
      return drawLines(fb, wrap(str(config, 'text') ?? '', box.w, 2), box, 2, alignOf(config));
    case 'todo':
      return drawTodo(fb, box, config);
    case 'weather':
      return drawWeather(fb, box, manifest, config);
    case 'homeassistant':
      return drawHouse(fb, box, manifest, config);
    case 'external': {
      const mod = str(config, 'module');
      const rows = config['count'];
      return drawPanel(
        fb,
        box,
        mod !== undefined ? manifest.panels[mod] : undefined,
        'No data yet',
        typeof rows === 'number' && Number.isFinite(rows) && rows >= 1 ? Math.trunc(rows) : undefined,
      );
    }
    case 'image':
      return drawImage(fb, box, config);
    default:
      return drawLines(fb, [asciiTitle(type)], box, 2, 'left');
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
    const inner = drawFrame(fb, box, config);
    drawWidget(fb, widget.type, inner, model, manifest, config);
  }
  return fb;
}
