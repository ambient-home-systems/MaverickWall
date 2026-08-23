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
import type { EpaperModel } from './viewmodel.js';

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

function drawClock(fb: Framebuffer, box: Box, model: EpaperModel, config: Config): void {
  // Bounded by the height it has *and* the width it has: a box taller than it
  // is wide used to pick a size the time could not fit, and lost its last
  // digit to the truncation in `drawLines`.
  const byHeight = Math.max(2, Math.min(8, Math.floor(box.h / 18)));
  const timeScale = scaleToFit(model.time, box.w, byHeight);
  const align = alignOf(config);
  drawLines(fb, [model.time], { ...box, h: GLYPH_SIZE * timeScale }, timeScale, align);
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

function drawShift(fb: Framebuffer, box: Box, model: EpaperModel): void {
  if (model.todayShifts.length === 0) {
    drawLines(fb, ['No shift today'], box, 2, 'left');
    return;
  }
  const [only] = model.todayShifts;
  // One person, and a box with room: the wall's card — who it is, then the
  // shift's *name* at whatever size the box affords, then its hours. The name
  // is the label ("Straights"), not the short code: a code is an abbreviation
  // for a month cell, and a widget given a whole box should spend it on the
  // word rather than leaving "Daddy: S" alone in the white.
  if (model.todayShifts.length === 1 && only !== undefined && box.h >= 44) {
    const name = asciiTitle(only.label !== '' ? only.label : only.code).toUpperCase();
    // Reserve the two small rows so the headline never squeezes them out.
    const headroom = Math.max(GLYPH_SIZE, box.h - (GLYPH_SIZE + 4) * 2);
    const nameScale = scaleToFit(name, box.w, Math.max(2, Math.min(7, Math.floor(headroom / GLYPH_SIZE))));
    drawStack(
      fb,
      box,
      [
        { text: asciiTitle(only.person).toUpperCase(), scale: 1 },
        { text: name, scale: nameScale },
        { text: only.time, scale: 1 },
      ],
      'left',
    );
    return;
  }
  // More than one person: a compact line each, sized so the longest still fits
  // rather than being cut at the box edge.
  const lines = model.todayShifts.map((s) => {
    const rest = [s.label !== '' ? s.label : s.code, s.time].filter((p) => p !== '').join('  ');
    return asciiTitle(`${s.person}: ${rest}`);
  });
  const scale = lines.reduce((smallest, line) => Math.min(smallest, scaleToFit(line, box.w, 2)), 2);
  drawLines(fb, lines, box, scale, 'left');
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

function drawPanel(fb: Framebuffer, box: Box, panel: unknown, empty: string): void {
  const lines = panelLines(panel, Math.max(1, Math.floor(box.h / 24))).map(asciiTitle);
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
function drawChores(fb: Framebuffer, box: Box, panel: unknown, config: Config): void {
  const board = readChorePanel(panel);
  if (board === undefined) {
    drawLines(fb, ['(no chores yet)'], box, 2, 'left');
    return;
  }

  const mode = str(config, 'mode') ?? '';
  const wanted = strings(config, 'people');
  const keep = (items: readonly ChoreLine[]): ChoreLine[] =>
    wanted === undefined
      ? [...items]
      : items.filter((item) => item.person !== undefined && wanted.includes(item.person));

  const rowH = 22;
  const bottom = box.y + box.h;
  let y = box.y;

  /** One chore: an empty box, or a filled one when it is done, then its name. */
  const drawRow = (item: ChoreLine, indent: number): void => {
    const left = box.x + indent;
    // Done is a *filled* box rather than a drawn tick: at 1-bit a 12px tick is
    // four pixels of ink that reads as a smudge from two metres, and solid
    // against empty is the strongest contrast the medium has.
    fb.strokeRect(left, y + 3, 12, 12, true);
    if (item.done) fb.fillRect(left + 3, y + 6, 6, 6, true);
    const width = box.w - indent - 20;
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
    const label = measureText(withOwner, { scale: 2 }) <= width ? withOwner : name;
    drawText(fb, left + 20, y, fit(label, width, { scale: 2 }), { scale: 2 });
    y += rowH;
  };

  if (mode === 'week') {
    for (const day of board.days) {
      const items = keep(day.items);
      // Empty days are skipped, the same as the wall's week view. The panel
      // keeps them so a caller drawing a grid can line them up; neither of
      // these two draws a grid.
      if (items.length === 0) continue;
      if (y + 14 > bottom) break;
      const heading = day.date === board.today ? 'TODAY' : weekdayOf(day.date).toUpperCase();
      drawText(fb, box.x, y, fit(heading, box.w, { scale: 1 }), { scale: 1 });
      y += 12;
      for (const item of items) {
        if (y + 14 > bottom) break;
        drawRow(item, 8);
      }
      y += 6;
    }
    if (y === box.y) drawLines(fb, ['(nothing due this week)'], box, 2, 'left');
    return;
  }

  const today = keep(board.days[0]?.items ?? []);
  if (today.length === 0) {
    drawLines(fb, ['(nothing due today)'], box, 2, 'left');
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
      if (y + 14 > bottom) return;
      drawText(fb, box.x, y, fit(asciiTitle(name).toUpperCase(), box.w, { scale: 1 }), { scale: 1 });
      y += 12;
      for (const item of items) {
        if (y + 14 > bottom) break;
        // The name is already the heading; repeating it on every row would
        // spend a third of a narrow box saying it twice.
        drawRow({ ...item, person: undefined }, 8);
      }
      y += 6;
    };
    for (const [name, items] of groups) draw(name, items);
    if (loose !== undefined) draw('Anyone', loose);
    return;
  }

  // Today, the default, and what an absent `mode` means — the wall's rule.
  for (const item of today) {
    if (y + 14 > bottom) break;
    drawRow(item, 0);
  }
}

interface ChoreLine {
  readonly name: string;
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
      const item = candidate as { name?: unknown; person?: unknown; done?: unknown };
      if (typeof item.name !== 'string' || item.name === '') continue;
      items.push({
        name: item.name,
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

function drawWidget(fb: Framebuffer, type: string, box: Box, model: EpaperModel, manifest: Manifest, config: Config): void {
  switch (type) {
    case 'clock':
      return drawClock(fb, box, model, config);
    case 'calendar':
      return drawCalendarWidget(fb, box, model, config);
    case 'shift':
      return drawShift(fb, box, model);
    case 'countdown':
      return drawCountdown(fb, box, model, config);
    case 'notes':
      return drawLines(fb, wrap(str(config, 'text') ?? '', box.w, 2), box, 2, alignOf(config));
    case 'todo':
      return drawTodo(fb, box, config);
    case 'chores':
      return drawChores(fb, box, manifest.panels['chores'], config);
    case 'weather':
      return drawPanel(fb, box, manifest.panels['weather'], 'No weather yet');
    case 'homeassistant':
      return drawPanel(fb, box, manifest.panels['home'] ?? manifest.panels['homeassistant'], 'No readings yet');
    case 'external': {
      const mod = str(config, 'module');
      return drawPanel(fb, box, mod !== undefined ? manifest.panels[mod] : undefined, 'No data yet');
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
    const inner = drawFrame(fb, box, widget.config);
    drawWidget(fb, widget.type, inner, model, manifest, widget.config);
  }
  return fb;
}
