import type {
  ChoreItemModel,
  DayModel,
  DisplayModel,
  EventModel,
  HorizonCell,
  InterruptModel,
  TodayShiftModel,
} from './viewmodel.js';
import { localDate, localTime } from './viewmodel.js';
import {
  agendaTimeFitsBeside,
  MIN_CALENDAR_SCALE,
  MIN_CHORE_SCALE,
  weekColumnsFit,
} from './density.js';
import type { PanelData, PanelReading } from './viewmodel.js';
import type { ManifestWidget, CanvasBackground } from './manifest.js';
import { shiftTint } from './theme.js';
import {
  HOUSE_ROLES,
  SHIFT_ROLES,
  WEATHER_ROLES,
  ladderRows,
  houseLadder,
  pairsTemperatures,
  weatherLadder,
  type HouseField,
  type ShiftField,
  type WeatherField,
} from './ladder.js';
import {
  clockWidgetView,
  panelRowLimit,
  shiftWidgetView,
  weatherWidgetView,
  type ShiftWidgetView,
} from './widget-options.js';
import { calendarView } from './widget-views.js';
import { densitySteps, monthSpans } from './month-spans.js';

/**
 * The DOM, and no decisions.
 *
 * Structure and class names follow `maverick-wall-design-directions.html`, so
 * the stylesheet next to this is recognisably the design file's rather than a
 * reinterpretation of it. Everything about *what* to show was settled in the
 * view model.
 *
 * Nodes, never HTML strings: event titles come from calendars the household
 * does not control, and `textContent` cannot be talked into executing one.
 */

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The shift colour for a row or cell, as the design sets it: one custom
 * property that everything else reads.
 *
 * `--sc` is the hue and `--sc-tint` the wash behind it. The tint is pre-mixed
 * per theme because `color-mix()` is too new for the browsers rule two exists
 * to keep working.
 */
function paintShift(node: HTMLElement, token: string | undefined, color?: string): void {
  // An explicit per-type colour: the theme owns no token for it, so set the hue
  // directly and derive its wash here against the *current* background — which
  // changes with the theme and the daytime switch, so it cannot be baked in the
  // manifest. `shiftTint` is the same maths the theme's own shift tints use.
  if (color !== undefined) {
    const background = getComputedStyle(node).getPropertyValue('--bg').trim() || '#0B0E11';
    node.style.setProperty('--sc', color);
    node.style.setProperty('--sc-tint', shiftTint(color, background));
    node.classList.add('has-shift');
    return;
  }
  if (token === undefined) return;
  node.style.setProperty('--sc', `var(${token}, var(--s-straight))`);
  node.style.setProperty('--sc-tint', `var(${token}-tint, var(--panel))`);
  node.classList.add('has-shift');
}

/** The shift's `HH:MM` window as one line, or undefined when it has no times. */
function shiftWindow(shift: { readonly startTime?: string; readonly endTime?: string }): string | undefined {
  if (shift.startTime !== undefined && shift.endTime !== undefined) {
    return `${shift.startTime}–${shift.endTime}`;
  }
  if (shift.startTime !== undefined) return `from ${shift.startTime}`;
  if (shift.endTime !== undefined) return `until ${shift.endTime}`;
  return undefined;
}

/**
 * One person's shift badge.
 *
 * Built per entry rather than per model, because a household can have more than
 * one person on a rota and the wall used to draw only whoever sorted first.
 * What it is allowed to say is decided in `shiftWidgetView`, not here.
 */
function shiftBadge(
  entry: TodayShiftModel,
  options: ShiftWidgetView,
  ladder: readonly ShiftField[] = options.ladder,
): HTMLElement {
  const shift = entry.shift;
  const badge = el('div', 'shift-badge');
  paintShift(badge, shift.colorToken, shift.color);

  for (const row of ladderRows(ladder, shiftValues(entry, options), SHIFT_ROLES)) {
    if (row.field === 'person') {
      /*
       * The picture, where the person already is. Same-origin and behind the
       * display token — rule three, and the wall works with no internet.
       */
      const who = el('div', 'who');
      const avatar = shift.personAvatarUrl;
      if (options.face && avatar !== undefined && avatar !== null && avatar !== '') {
        const image = document.createElement('img');
        image.className = 'who-face';
        image.src = avatar;
        // Decorative: the name is right beside it, so a reader gains nothing
        // from hearing the filename.
        image.alt = '';
        who.appendChild(image);
      }
      who.appendChild(document.createTextNode(row.text));
      badge.appendChild(who);
      continue;
    }
    badge.appendChild(el('div', SHIFT_ROW_CLASS[row.field], row.text));
  }
  return badge;
}

/**
 * The badge as one line, when the box has room for exactly one row.
 *
 * Dropping to a single rung would spend the same room on strictly less: "Amy"
 * where "Amy · Days · 07:00–19:00" fits. The panel renderer has always
 * collapsed rather than truncated in this case, and this is the wall saying the
 * same thing — the two renderers agreeing about a small box is the whole point
 * of there being one ladder.
 *
 * The person keeps a colon when they lead, because "Amy: Days" reads as an
 * attribution and "Amy Days" reads as a mistake; anywhere else they are just
 * another part, since "Days: Amy" attributes the wrong way round.
 */
function shiftLineBadge(
  entry: TodayShiftModel,
  options: ShiftWidgetView,
  ladder: readonly ShiftField[],
): HTMLElement {
  const rows = ladderRows(ladder, shiftValues(entry, options), SHIFT_ROLES);
  const parts = rows.map((row) => row.text);
  const head = rows[0];
  const text =
    head !== undefined && head.field === 'person' && parts.length > 1
      ? `${parts[0]}: ${parts.slice(1).join(' · ')}`
      : parts.join(' · ');

  const badge = el('div', 'shift-badge is-line');
  paintShift(badge, entry.shift.colorToken, entry.shift.color);
  badge.appendChild(el('div', 'what', text));
  return badge;
}

/** The class each ladder row keeps, so the stylesheet is unchanged by ordering. */
const SHIFT_ROW_CLASS: Readonly<Record<ShiftField, string>> = {
  person: 'who',
  shift: 'what',
  hours: 'shift-when',
  run: 'until',
};

/**
 * What each row would say, or nothing when the day has nothing for it.
 *
 * Absent is different from switched off: an untimed shift has no hours and a
 * run the server could not establish has no position, and neither is the
 * household asking for a gap. `ladderRows` drops those.
 */
function shiftValues(
  entry: TodayShiftModel,
  options: ShiftWidgetView,
): Partial<Record<ShiftField, string>> {
  const shift = entry.shift;
  const name = options.name === 'code' ? shift.shortCode : shift.label;
  const values: Partial<Record<ShiftField, string>> = {
    person: shift.personName,
    shift: name,
  };
  const window = shiftWindow(shift);
  if (window !== undefined) values.hours = window;
  if (entry.run !== undefined) values.run = entry.run;
  return values;
}

/**
 * The colour-and-face that marks whose event this is.
 *
 * Three cases, quietest to loudest: a plain colour dot for a calendar nobody
 * owns (its own colour, so the agenda is still colour-coded); the owner's
 * initials in their colour when they have no photo; the photo itself when they
 * do. The colour is always `event.color`, which the manifest has already
 * resolved to the owner's when the calendar has one — so the dot, the chip and
 * the legend can never disagree about who is which colour.
 *
 * Same-origin and behind the display token, like the shift face — rule three,
 * and the wall still draws with no internet.
 */
function ownerMark(event: EventModel, className: string): HTMLElement {
  const owner = event.owner;
  if (owner !== undefined && owner.avatarUrl !== undefined && owner.avatarUrl !== '') {
    const image = document.createElement('img');
    image.className = `${className} ev-face`;
    image.src = owner.avatarUrl;
    // Decorative: the title is right beside it and the legend names the face.
    image.alt = '';
    return image;
  }
  if (owner !== undefined) {
    const chip = el('span', `${className} ev-initials`, owner.initials);
    chip.style.setProperty('--ev', event.color);
    return chip;
  }
  const dot = el('span', `${className} ev-dot`);
  dot.style.setProperty('--ev', event.color);
  return dot;
}

/* ------------------------------------------------------------ WEATHER ---- */

/**
 * The forecast strip, in the design's own markup.
 *
 * The icon is a character rather than an image: the provider offers an icon
 * URL and rule three forbids the wall from fetching one, so the server maps
 * the forecast wording to a glyph the device already has.
 */
/** The class each forecast row keeps, so the stylesheet is unchanged by order. */
const WEATHER_ROW_CLASS: Readonly<Record<WeatherField, string>> = {
  name: 'wx-name',
  icon: 'wx-ico',
  high: 'wx-temp',
  low: 'wx-temp',
};

/**
 * One day of the strip, from the ladder.
 *
 * The high and the low share a row when the household left them next to each
 * other, because a temperature range reads as one thing and that is how this
 * strip has always drawn it. `pairsTemperatures` is where that rule lives; here
 * it only decides whether the second of the pair is skipped as its own row.
 *
 * A column down to its last row is *not* collapsed onto one line the way a
 * shift badge is, and that is deliberate rather than an omission. A badge is
 * one wide card, so joining its rows spends the same room on more; a forecast
 * column is narrow by construction — a fifth of the box — so "Today 24° 13°C"
 * in one would truncate rather than inform. The panel makes the same call by
 * column width in `drawWeather`, not by row count.
 */
function weatherColumn(
  rows: readonly { readonly field: WeatherField; readonly text: string }[],
  paired: boolean,
): HTMLElement {
  const cell = el('div', 'wx-day');
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const next = rows[index + 1];
    if (paired && (row.field === 'high' || row.field === 'low') && next !== undefined &&
        (next.field === 'high' || next.field === 'low')) {
      const temp = el('div', 'wx-temp');
      temp.appendChild(document.createTextNode(`${row.text} `));
      temp.appendChild(el('span', 'lo', next.text));
      cell.appendChild(temp);
      index++;
      continue;
    }
    // A low on its own row keeps the quieter treatment it has when it rides
    // beside the high: its emphasis is a property of the field, not of whether
    // the household happened to put it next to something.
    const cls = row.field === 'low' ? `${WEATHER_ROW_CLASS[row.field]} lo` : WEATHER_ROW_CLASS[row.field];
    cell.appendChild(el('div', cls, row.text));
  }
  return cell;
}

function renderWeather(
  model: DisplayModel,
  config?: unknown,
  ladder: readonly WeatherField[] = weatherLadder(config),
): HTMLElement | undefined {
  const view = weatherWidgetView(model.weather, config);
  if (view.days.length === 0) return undefined;

  const paired = pairsTemperatures(ladder);
  const strip = el('section', 'wx');
  for (const day of view.days) {
    const rows = ladderRows(
      ladder,
      { name: day.name, icon: day.icon, high: day.high, low: day.low },
      WEATHER_ROLES,
    );
    strip.appendChild(weatherColumn(rows, paired));
  }

  if (model.weatherNote !== undefined) {
    strip.appendChild(el('div', 'wx-note', model.weatherNote));
  }
  return strip;
}

/* -------------------------------------------------------------- HOUSE ---- */

/**
 * A few readings from the house, drawn typographically.
 *
 * Four display modes and no tiles. The brief is explicit that this is ambient
 * context on a family calendar rather than a dashboard, and the difference
 * shows up here: a grid of cards would be competing with Lovelace, badly.
 *
 * Note what this function receives — a label, a value, a character. There is
 * no entity id in the model and no way to ask for one. That boundary is what
 * keeps a compromised wall from being a way into somebody's house.
 */
function renderHouse(model: DisplayModel, config?: unknown): HTMLElement | undefined {
  // Which readings to show, by label — the manifest carries no entity id, so a
  // per-widget selection can only ever be by the label the household sees.
  // Empty means all, which is the default and what a bare widget draws.
  const wanted = configStrings(widgetConfig(config)['readings']);
  const readings =
    wanted.length === 0 ? model.house : model.house.filter((r) => wanted.includes(r.label));
  if (readings.length === 0) return undefined;

  const strip = el('section', 'house');
  for (const reading of readings) {
    const cell = el('div', `hs-item hs-${reading.mode}${reading.stale ? ' hs-stale' : ''}`);
    /*
     * Which parts this reading shows, from the widget's own list when it has
     * one and otherwise from the entity's `display_mode`. The two `if`
     * statements this replaces *were* the mode's meaning, written down nowhere
     * else — which is how the panel came to ignore it entirely.
     */
    const rows = ladderRows(
      houseLadder(config, reading.mode),
      { icon: reading.icon, label: reading.label, value: reading.value },
      HOUSE_ROLES,
    );
    for (const row of rows) cell.appendChild(el('span', HOUSE_ROW_CLASS[row.field], row.text));
    strip.appendChild(cell);
  }

  if (model.houseNote !== undefined) {
    strip.appendChild(el('div', 'hs-note', model.houseNote));
  }
  return strip;
}

/** The class each reading's row keeps, so the stylesheet is unchanged by order. */
const HOUSE_ROW_CLASS: Readonly<Record<HouseField, string>> = {
  icon: 'hs-ico',
  label: 'hs-label',
  value: 'hs-value',
};

/* --------------------------------------------------------------- NEXT ---- */

function renderDayRow(day: DayModel, showWeather = false, showShifts = true): HTMLElement {
  const row = el('div', day.isToday ? 'day-row is-today' : 'day-row');
  const shift = showShifts ? day.shifts[0] : undefined;
  paintShift(row, shift?.colorToken, shift?.color);

  const when = el('div', 'dr-when');
  when.appendChild(el('div', 'dr-dow', day.weekday));
  when.appendChild(el('div', 'dr-num', day.dayNumber));
  // The month under the number, so a row read on its own is unambiguous. A
  // wall is looked at in glances, and "14" a fortnight out is a question.
  when.appendChild(el('div', 'dr-mon', day.month));
  // The day's numbers under its date, when the household asked for them — the
  // forecast strip's information without the strip's row of the wall.
  if (showWeather && day.weather !== undefined) {
    const wx = el('div', 'dr-wx');
    wx.appendChild(el('span', 'dr-wx-icon', day.weather.icon));
    wx.appendChild(el('span', 'dr-wx-high', day.weather.high));
    wx.appendChild(el('span', 'dr-wx-low', day.weather.low));
    when.appendChild(wx);
  }
  if (shift !== undefined) {
    when.appendChild(el('div', 'dr-shift', shift.label));
    const window = shiftWindow(shift);
    if (window !== undefined) when.appendChild(el('div', 'dr-when', window));
  }
  row.appendChild(when);

  const events = el('div', 'dr-events');
  /*
   * An empty day draws its date and nothing else.
   *
   * It used to say "Nothing on", on the argument that an absence and a stated
   * fact are different things — which is right about a *rest day*, where the
   * rota genuinely knows something, and wrong here. A day with no events is
   * the only thing an empty day can be, so the words carry no information at
   * all, and on this wall they are not free: a line of italic in every quiet
   * day's row is a line the days that do have something on them wanted. An
   * empty day is the information.
   *
   * The section's own "Nothing coming up." is untouched and is a different
   * claim — that the *list* found nothing, which is a fact about the search
   * rather than about a day.
   */
  if (day.events.length > 0) {
    /*
     * Where "now" falls in today's list — a rule across the column, no label.
     *
     * Only today, and only when the day holds something with a clock on it:
     * the rule separates what has happened from what has not, and a day of
     * nothing but all-day events has no such division to draw. It goes above
     * the next event due, which is where `isNext` already points, and at the
     * foot of the list when everything timed has been and gone.
     *
     * It was meant to complement the `.te.is-next` accent — the accent says
     * *which* event is next, the rule says where the day has got to — and that
     * is still the design. It is worth writing down that the accent is not
     * currently on the glass: `.te.is-next` is a stylesheet rule matching an
     * element nothing in this file emits, left behind when the day block was
     * retired. So the rule is the only "now" the wall draws today, and it is
     * drawn to stand on its own rather than to lean on a partner that is not
     * there.
     */
    const nowRule = day.isToday && day.events.some((event) => !event.allDay);
    /*
     * Which event the rule is drawn against, and it is drawn *on* that event
     * rather than between two of them.
     *
     * A row of its own is the obvious shape and it costs the agenda a whole
     * grid gap — measured on the shipped Classic wall, 11.6px of an 816px
     * section, which took the rota chip from 22.5px to 21.6px and under this
     * product's own legibility floor. A hairline that costs a word is not a
     * hairline. So it is absolutely positioned into the gap it sits in, which
     * costs nothing at all, and the event it hangs from is the next one due —
     * or the last one, when everything with a clock on it has been.
     */
    const nextIndex = nowRule ? day.events.findIndex((event) => event.isNext) : -1;
    const ruleOn = nowRule ? (nextIndex >= 0 ? nextIndex : day.events.length - 1) : -1;
    const ruleAtEnd = nowRule && nextIndex < 0;
    let index = -1;
    for (const event of day.events) {
      index += 1;
      const entry = el('div', event.allDay ? 'dr-ev allday' : 'dr-ev');
      if (index === ruleOn) entry.appendChild(el('div', ruleAtEnd ? 'dr-now at-end' : 'dr-now'));
      // The accent rule, in the calendar's own colour — the one cue that says
      // whose event this is without spending a word on it. Set on the entry
      // rather than the title so timed and all-day events line up on one edge.
      entry.style.setProperty('--ec', event.color);
      if (!event.allDay) entry.appendChild(el('div', 'dr-ev-time', event.time));
      const title = el('div', 'dr-ev-title');
      title.appendChild(ownerMark(event, 'dr-ev-mark'));
      title.appendChild(document.createTextNode(event.title));
      entry.appendChild(title);
      if (event.span !== undefined) {
        entry.appendChild(el('div', 'dr-ev-span', event.span));
      }
      if (event.progress !== undefined) {
        const bar = el('div', 'dr-ev-bar');
        const fill = el('div', 'dr-ev-bar-fill');
        // Clamped rather than trusted: the fraction is computed from a server
        // clock and a corrected wall clock, and a bar wider than its track
        // would paint over the row beside it.
        const pct = Math.max(0, Math.min(1, event.progress)) * 100;
        fill.style.width = `${pct.toFixed(1)}%`;
        bar.appendChild(fill);
        entry.appendChild(bar);
      }
      events.appendChild(entry);
    }
    if (day.hiddenEventCount > 0) {
      events.appendChild(el('div', 'dr-empty', `+${day.hiddenEventCount} more`));
    }
  }
  row.appendChild(events);
  return row;
}

/* ------------------------------------------------------------ HORIZON ---- */

/**
 * How a month cell draws what is on that day.
 *
 * `text` is the default and the reason this list has four entries rather than
 * three. Measured on a 1080x1920 wall carrying three ordinary family calendars,
 * `pills` drew 37 event names and cut 32 of them: 972px of usable width over
 * seven columns leaves a pill about 100px, which at the type floor is eight
 * characters, so "Year 6 trip to the Science Museum" and "Year 6 sports day"
 * were the same five letters on the glass. A truncation that deep is not a
 * shortened title, it is a *different string*, and two of them can be the same
 * different string.
 *
 * `text` gives the words the cell's own width, lets them wrap, and draws only
 * the ones that fit whole — see `trimCellRows`. `pills` is kept because it is a
 * look a household can choose and because canvases have it stored; `dots` is
 * kept as the quiet option and is now stored explicitly, since absence means
 * the default and the default is no longer "say nothing".
 */
export type CellStyle = 'dots' | 'pills' | 'swiss' | 'text';

/** What the week's span bars leave a cell to do. */
interface CellSpans {
  /** How many lanes the bars above this cell reserve. */
  readonly lanes: number;
  /** Event ids a bar already draws here, which this cell must not repeat. */
  readonly drawn: readonly string[];
  /** This cell's ordinal in the grid, so the trim can find it from a bar. */
  readonly index: number;
}

function renderCell(
  cell: HorizonCell,
  style: CellStyle = 'text',
  showShifts = true,
  spans: CellSpans = { lanes: 0, drawn: [], index: -1 },
): HTMLElement {
  const classes = ['hz-cell'];
  if (cell.isToday) classes.push('is-today');
  if (cell.isPast) classes.push('dim');
  if (!cell.inMonth) classes.push('outside');

  const node = el('div', classes.join(' '));
  if (showShifts) paintShift(node, cell.shiftToken, cell.shiftColor);
  /*
   * The numeral and the density mark share one line, and that is measured
   * rather than chosen.
   *
   * The mark started in flow *under* the numeral, which is where the brief put
   * it and where it reads best — and the density ratchet caught what that cost:
   * on the shipped Classic wall in landscape it took the month grid from
   * naming 7 events to naming 3. A cell there has room for one row, so a few
   * pixels of scaffolding is a row, and a mark that says how busy a day is at
   * the price of not saying what is on it has spent more than it bought.
   *
   * Beside the numeral it costs nothing: the row's height is the numeral's,
   * the mark is three pixels bottom-aligned into it, and a two-digit date
   * leaves most of the cell's width for the bar to grow across. The wrapper is
   * what makes that one line rather than two.
   */
  const head = el('div', 'hz-top');
  head.appendChild(el('div', 'hz-num', cell.dayNumber));
  node.appendChild(head);

  /*
   * The true total, stamped on every cell that has anything on it.
   *
   * Not the number of rows below it, and that is the point: the model caps its
   * slim list at twelve, so a day with twenty must be able to say "+17" rather
   * than "+9". Every treatment carries it — the trim pass reads it, and a
   * measurement of what the grid claims can be checked against what the day
   * actually holds.
   */
  if (cell.eventCount > 0) node.setAttribute('data-count', String(cell.eventCount));

  if (style === 'text' || style === 'swiss') {
    if (spans.index >= 0) node.setAttribute('data-cell', String(spans.index));
    /*
     * Room for the bars crossing this cell, between the number and the rows.
     *
     * A bar is not inside the cell — it is one absolutely placed item in the
     * grid, so that it can actually cross the gaps between columns — which
     * means the cell has to be told to leave it a lane. Told, not measured:
     * the arithmetic is `month-spans.ts`'s, taken once for the whole week, and
     * a cell working it out from what is drawn over it would be the second
     * opinion this file keeps paying for.
     */
    if (spans.lanes > 0) {
      node.style.setProperty('--hz-lanes', String(spans.lanes));
      node.setAttribute('data-spans', String(spans.drawn.length));
    }
    /*
     * The density mark: how busy the day is, with no legible text at all.
     *
     * This is what carries from a doorway — busy days, today's position, and
     * the shape of a span across a week — on a wall where the type floor and
     * a 129px cell together mean most cells can name one thing or nothing.
     * It replaces `hz-dots` as the *default* treatment's quiet layer; `dots`
     * itself is untouched, because it is a look a household has stored.
     *
     * Zero events draws nothing whatever. An empty day is a fact, and a mark
     * of no length is still a mark.
     */
    const steps = densitySteps(cell.eventCount);
    /*
     * `spans.lanes` is in the condition and not only `steps`, and it is
     * load-bearing rather than defensive: the mark is what carries the lane
     * reservation down the cell, so a cell crossed by a bar and drawing no
     * mark would put its rows *under* the bar. A cell a bar crosses always has
     * that event on it, so `steps` is already positive — this makes the
     * invariant the code's rather than the reader's.
     */
    if (steps > 0 || spans.lanes > 0) {
      const mark = el('div', 'hz-mark');
      mark.style.setProperty('--hz-fill', String(steps));
      head.appendChild(mark);
    }
    /*
     * Flat rows of plain text under the number: no bubble, no ground, no
     * radius, and the words get the cell's own width instead of a pill's
     * inside.
     *
     * Every event the model carries is rendered; nothing is cut here. What
     * fits is a question about the *box*, and only layout can answer it, so
     * `trimCellRows` does the cutting after the wall has a size. That is the
     * same seam `fitToBox` uses and the same rule: a drawing decision, never a
     * saved one, so a widened box brings the rows straight back.
     *
     * `el` sets textContent, so a stranger's event title is drawn and never
     * interpreted.
     */
    /*
     * Everything a bar is not already drawing.
     *
     * The half of "drawn once" that lives here: a seven-day half term is one
     * bar across the week, so the seven cells under it must not each add a row
     * saying the same two words. Skipped by *id*, which is the same on every
     * date the event touches; skipping by title would take an unrelated "Bin
     * day" off the wall with it.
     */
    const rows =
      spans.drawn.length === 0
        ? cell.events
        : cell.events.filter((ev) => spans.drawn.indexOf(ev.id) < 0);
    if (rows.length > 0) {
      const list = el('div', 'hz-rows');
      /*
       * In the order the manifest sent them, which is all-day first and then by
       * start time — `buildManifest` sorts it there and says why ("a day's
       * banner belongs above its agenda"). Re-sorting here would be the same
       * decision in two places, which is how a wall and a panel come to
       * disagree about one stored value; the order matters more than it used to
       * only because the trim now cuts from the bottom, so what sorts first is
       * what survives a cell with no room.
       */
      for (const ev of rows) {
        const row = el('div', ev.allDay ? 'hz-row allday' : 'hz-row');
        /*
         * A timed event is marked by a dot in its calendar's colour; an all-day
         * one by a rule down its left edge, which is the grammar the agenda and
         * the pill style already use. The difference is not decoration: a dot
         * is a column the words do not get, and an all-day title is the one
         * that most needs them.
         */
        if (!ev.allDay) {
          const dot = el('span', 'hz-rowdot');
          dot.style.setProperty('--pc', ev.color);
          row.appendChild(dot);
        } else {
          row.style.setProperty('--pc', ev.color);
        }
        row.appendChild(el('span', 'hz-rowtext', ev.title));
        list.appendChild(row);
      }
      node.appendChild(list);
      // Always present, empty until the trim pass has something to report —
      // measuring is easier against a node that already exists, and an empty
      // one draws nothing.
      node.appendChild(el('div', 'hz-more'));
    }
    return node;
  }

  if (style === 'pills') {
    // Skylight-style: a coloured, labelled bar per event, in the owning
    // calendar's colour (`--pc`). `el` uses textContent, so a stranger's title
    // is drawn, never interpreted. Three fit a cell; the rest read as "+N".
    if (cell.events.length > 0) {
      const list = el('div', 'hz-pills');
      for (const ev of cell.events.slice(0, 3)) {
        const pill = el('div', ev.allDay ? 'hz-pill allday' : 'hz-pill', ev.title);
        pill.style.setProperty('--pc', ev.color);
        list.appendChild(pill);
      }
      if (cell.eventCount > 3) list.appendChild(el('div', 'hz-pill-more', `+${cell.eventCount - 3}`));
      node.appendChild(list);
    }
  } else if (cell.eventCount > 0) {
    const dots = el('div', 'hz-dots');
    // Three at most. Beyond that the count stops being countable at a glance
    // and the cell only needs to read as "busy".
    for (let index = 0; index < Math.min(cell.eventCount, 3); index++) {
      dots.appendChild(el('span', 'hz-dot'));
    }
    node.appendChild(dots);
  }
  return node;
}

function renderHorizon(
  model: DisplayModel,
  opts: {
    readonly cells?: CellStyle;
    readonly weekNumbers?: boolean;
    readonly shifts?: boolean;
  } = {},
): HTMLElement {
  const style: CellStyle = opts.cells ?? 'text';
  const showShifts = opts.shifts !== false;
  const variant =
    style === 'pills'
      ? 'horizon horizon-pills'
      : style === 'swiss'
        ? 'horizon horizon-swiss'
        : style === 'text'
          ? 'horizon horizon-text'
          : 'horizon';
  const horizon = el('section', variant);
  /*
   * The month, oversized, in the top-left corner.
   *
   * Swiss only, and the asymmetry is the point: a centred title over a
   * symmetrical grid is the arrangement this style exists to argue against. It
   * is drawn before the grid so it is also the first thing a screen reader and
   * the DOM order agree on.
   */
  if (style === 'swiss' && model.horizonMonth !== undefined) {
    horizon.appendChild(el('h1', 'hz-title', model.horizonMonth));
  }
  /*
   * Week numbers get a column of their own rather than a corner of the first
   * cell: a number tucked into Monday reads as something about Monday. Only
   * when every row can actually be labelled — a manifest from an older server
   * carries none, and a grid with gaps down its first column is worse than one
   * with no column at all.
   */
  const weekNumbers =
    opts.weekNumbers === true &&
    model.horizon.length > 0 &&
    model.horizon.every((week) => week[0]?.weekNumber !== undefined);
  const grid = el('div', weekNumbers ? 'hz-grid has-weeks' : 'hz-grid');
  // The weekday headers come from the first week's own cells rather than a fixed
  // Mon–Sun array: that follows the household's week-start (Sunday or Monday)
  // with no second source of truth, and localises for free since each cell
  // already carries its short weekday name.
  const headerWeek = model.horizon[0] ?? [];
  // The corner above the numbers stays empty: "WK" over a column of numbers is
  // a heading nobody needs and a word competing with the weekdays beside it.
  if (weekNumbers) grid.appendChild(el('div', 'hz-head'));
  for (const cell of headerWeek) grid.appendChild(el('div', 'hz-head', cell.weekday));

  /*
   * Which multi-day events are one bar, resolved for the whole grid at once.
   *
   * Only the treatments that draw words: `dots` says nothing and `pills` is a
   * stored look with its own three-and-a-counter arithmetic, and changing
   * either would move a wall somebody has already hung.
   */
  const spans =
    style === 'text' || style === 'swiss'
      ? monthSpans(model.horizon.map((week) => week.map((cell) => cell.events)))
      : undefined;
  /*
   * Which grid column the week's first day is in, 1-based, because a span bar
   * is placed by line number and there may or may not be a week-number column
   * in front of the seven. Getting this wrong draws every bar one day early on
   * exactly the walls that asked for week numbers.
   */
  const firstDayColumn = weekNumbers ? 2 : 1;
  let cellIndex = 0;
  model.horizon.forEach((week, weekIndex) => {
    if (weekNumbers) grid.appendChild(el('div', 'hz-wk', String(week[0]?.weekNumber ?? '')));
    const weekSpans = spans?.[weekIndex];
    week.forEach((cell, column) => {
      grid.appendChild(
        renderCell(cell, style, showShifts, {
          lanes: weekSpans?.lanes[column] ?? 0,
          drawn: weekSpans?.drawn[column] ?? [],
          index: cellIndex,
        }),
      );
      cellIndex += 1;
    });
    /*
     * The bars, after the cells they cross.
     *
     * They are grid items rather than children of a cell, because a cell
     * clips and a bar has to run over the gaps between columns. They are
     * *absolutely positioned* grid items, which is what keeps them out of
     * auto-placement — an ordinary item placed on row 3 would push the cells
     * that had not been placed yet into different squares, and the grid would
     * come apart one week at a time.
     *
     * Row `weekIndex + 2`: the weekday headers are row 1.
     */
    for (const bar of weekSpans?.bars ?? []) {
      const node = el('div', bar.leading ? 'hz-span' : 'hz-span is-cont');
      node.style.setProperty('--pc', bar.color);
      node.style.setProperty('--hz-lane-index', String(bar.lane));
      node.style.gridRow = String(weekIndex + 2);
      node.style.gridColumn = `${firstDayColumn + bar.column} / span ${bar.span}`;
      // Which cells this covers, so the trim can put their counts right if the
      // row turns out to be too short to draw it.
      const covers: number[] = [];
      for (let column = bar.column; column < bar.column + bar.span; column++) {
        covers.push(weekIndex * week.length + column);
      }
      node.setAttribute('data-cover', covers.join(' '));
      // The event, so a continuation bar can be attributed to the run it
      // belongs to by something other than the title it deliberately lacks.
      node.setAttribute('data-span', bar.id);
      /*
       * Only the first bar of a run carries the words. A continuation is the
       * same event still being true, and printing the title again on the next
       * row is the bug this whole rule exists to end — one row down instead of
       * seven columns across.
       *
       * It still needs the name for anything that is not looking at pixels, so
       * the continuation carries it as a label rather than as text.
       */
      if (bar.leading) node.appendChild(el('span', 'hz-spantext', bar.title));
      else node.setAttribute('aria-label', bar.title);
      grid.appendChild(node);
    }
  });
  horizon.appendChild(grid);

  // The key goes with the colours it explains. A legend under a grid with no
  // rota tints is a key to nothing.
  const legend = showShifts ? legendFor(model) : undefined;
  if (legend !== undefined) horizon.appendChild(legend);
  return horizon;
}

/**
 * The rotation legend.
 *
 * Built from the cells actually in the grid above it, not from the week ahead.
 * It used to read the latter, which was fine until the week ahead could be
 * switched off — the legend then explained one colour while the grid showed
 * three. A key has to describe the thing it sits under.
 *
 * Only colours that appear, too: explaining four when the household ever sees
 * two is noise on a surface with no room for any.
 */
function legendFor(model: DisplayModel): HTMLElement | undefined {
  const seen = new Map<string, string>();
  for (const week of model.horizon) {
    for (const cell of week) {
      if (cell.shiftToken !== undefined && cell.shiftLabel !== undefined) {
        seen.set(cell.shiftToken, cell.shiftLabel);
      }
    }
  }
  if (seen.size === 0) return undefined;

  const legend = el('div', 'legend');
  seen.forEach((label, token) => {
    const entry = el('span');
    const swatch = el('i');
    swatch.style.setProperty('--sc', `var(${token}, var(--s-straight))`);
    entry.appendChild(swatch);
    entry.appendChild(document.createTextNode(label));
    legend.appendChild(entry);
  });
  return legend;
}

/* -------------------------------------------------------------- ALERT --- */

/**
 * The takeover: one warning, the whole wall.
 *
 * Every string here goes in through `el`, which uses `textContent` — never
 * `innerHTML`, anywhere, at any prominence. That is not a general hygiene note:
 * this is the one place in the product where text a stranger wrote is drawn at
 * maximum size, and a headline is exactly the field somebody would try it in.
 *
 * What is drawn, and why in this order: the event name, because it is what
 * somebody reads from the doorway; the instruction, because "move to an
 * interior room on the lowest floor" is the only line that tells them what to
 * do; the area, so they know whether it is them; then the countdown and the
 * office, small, because those answer "should I still care" rather than "what
 * is happening".
 */
function renderAlert(interrupt: InterruptModel, model: DisplayModel): HTMLElement {
  const screen = el('div', `screen screen-alert alert-${interrupt.severity.toLowerCase()}`);
  const panel = el('section', 'alert');

  panel.appendChild(el('p', 'alert-kind', interrupt.severity));
  panel.appendChild(el('h1', 'alert-line', interrupt.title));
  if (interrupt.headline !== undefined) {
    panel.appendChild(el('p', 'alert-what', interrupt.headline));
  }
  if (interrupt.area !== undefined) {
    panel.appendChild(el('p', 'alert-area', interrupt.area));
  }

  if (model.allowDismiss && interrupt.dismissible) {
    panel.appendChild(acknowledgeButton(interrupt));
  }

  const foot = el('div', 'alert-foot');
  // The time stays. Somebody looking at a wall that has stopped being a
  // calendar still needs to know whether this is now or four in the morning.
  foot.appendChild(el('span', 'alert-clock', model.clock));
  if (interrupt.expiresAt !== undefined) {
    foot.appendChild(el('span', 'alert-until', untilText(interrupt.expiresAt, model.now)));
  }
  if (interrupt.sender !== undefined) {
    foot.appendChild(el('span', 'alert-office', interrupt.sender));
  }
  panel.appendChild(foot);

  screen.appendChild(panel);
  return screen;
}

/**
 * The acknowledge control.
 *
 * A real `<button>`, so a touchscreen works and so the browser gives it focus
 * behaviour for free — but the button is not really how this gets pressed. A
 * television remote's OK key arrives as `Enter`, and D-pad focus navigation is
 * inconsistent across the WebViews that end up on walls. So `main.ts` also
 * listens for the key directly and acknowledges the loudest thing showing,
 * which is the one mental model that works with every remote: point at the
 * wall, press OK.
 *
 * `data-dismiss` carries the key rather than a closure, because the whole
 * screen is rebuilt on every draw and a listener per render would leak.
 */
function acknowledgeButton(interrupt: InterruptModel, compact = false): HTMLElement {
  // The long form only where there is room for it. A banner is already the
  // smaller statement and does not need a sentence explaining its own button.
  const button = el('button', 'alert-ack', compact ? 'OK' : 'OK · press the remote to acknowledge');
  button.setAttribute('type', 'button');
  button.setAttribute('data-dismiss', interrupt.key);
  /*
   * Not `autofocus`. That attribute only applies while the browser is parsing
   * the document, and every node here is built in script and appended after
   * load — so it did nothing at all, silently. `main.ts` focuses the control
   * once, when the thing being acknowledged changes.
   */
  return button;
}

/**
 * "Until 14:35 · 42 minutes left", as one string.
 *
 * A countdown rather than a timestamp, because the question is "is this still
 * happening" and a household should not have to do the arithmetic from across
 * a room. It re-renders on the same tick as the clock, so it stays honest
 * without a timer of its own.
 */
export function untilText(expiresAt: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return 'Ending now';
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${hours} hour${hours === 1 ? '' : 's'} left`
    : `${hours}h ${rest}m left`;
}

/* ------------------------------------------------------------- banners --- */

function renderBanners(model: DisplayModel): HTMLElement | undefined {
  /*
   * Interrupts lead, above the housekeeping notices.
   *
   * A stale feed and a water leak are both "things the wall wants to say", and
   * only one of them is worth reading first. They are already sorted by the
   * server; this only has to not bury them.
   */
  const messages: { level: string; message: string; dismissKey?: string }[] = [
    ...model.interrupts
      .filter((interrupt) => !interrupt.takeover)
      .map((interrupt) => ({
        level: 'alert',
        message:
          interrupt.headline === undefined
            ? interrupt.title
            : `${interrupt.title} — ${interrupt.headline}`,
        // Only where the screen has something to press with, and only where
        // the rule said it may be cleared at all.
        ...(model.allowDismiss && interrupt.dismissible ? { dismissKey: interrupt.key } : {}),
      })),
    ...model.notices,
  ];
  if (model.staleness.level !== 'fresh') {
    messages.unshift({
      level: model.staleness.level === 'offline' ? 'warn' : 'info',
      message: model.staleness.message,
    });
  }
  if (messages.length === 0) return undefined;

  const wrap = el('div', 'banners');
  for (const entry of messages) {
    const banner = el('div', `banner banner-${entry.level}`, entry.message);
    if (entry.dismissKey !== undefined) {
      banner.appendChild(acknowledgeButton({ key: entry.dismissKey } as InterruptModel, true));
    }
    wrap.appendChild(banner);
  }
  return wrap;
}

/**
 * Replace the screen in one go.
 *
 * Built detached and swapped in a single assignment, so a slow render is never
 * seen half-finished. A wall is watched continuously; a flicker at the top of
 * every minute is the sort of thing that makes a household unplug it.
 */
/* ----------------------------------------------------------- FREEFORM --- */

/** The clock, as a widget: the time the today block already shows, on its own. */
function renderClockWidget(model: DisplayModel, config?: unknown): HTMLElement {
  const view = clockWidgetView(config);
  const box = el('div', 'fw-clock');
  /*
   * `model.clock` is already in the household's own format, so following it
   * costs nothing; an override re-reads the same corrected wall time through
   * the same formatter, rather than trying to reformat a rendered string.
   */
  const time =
    view.format === 'follow'
      ? model.clock
      : localTime(model.now, model.timezone, view.format === '12');
  const face = el('div', 'clock', time);
  // The type is sized per character (see `.fw-clock .clock`): "08:26 pm" is
  // eight of them and "20:26" is five, and one constant cannot serve both.
  face.style.setProperty('--clock-chars', String(Math.max(1, time.length)));
  box.appendChild(face);
  if (view.date) box.appendChild(el('div', 'today-date', model.todayLabel));
  return box;
}

/**
 * The shift, as a widget: a badge for each person the household asked for.
 *
 * Undefined when nobody the widget is watching is on a rota today, exactly like
 * weather and house on a day with no data — so `renderFreeform` draws the one
 * box-relative "nothing yet" note for all three, rather than this one scaling a
 * note that is already sized to its box and ending up drawn twice as small.
 *
 * "Nobody the widget is watching" is the honest empty here: a household who
 * pointed this box at one person should see that box say nothing on the days
 * they are off, not quietly promote somebody else's nights into it.
 */
function renderShiftWidget(model: DisplayModel, config?: unknown): HTMLElement | undefined {
  const view = shiftWidgetView(model.todayShifts, config);
  if (view.entries.length === 0) return undefined;
  const box = el('div', view.entries.length > 1 ? 'fw-shift is-several' : 'fw-shift');
  for (const entry of view.entries) box.appendChild(shiftBadge(entry, view));
  return box;
}

/**
 * What a placed widget draws — first-party modules only.
 *
 * Every arm reuses the same renderer the responsive layout does, so a calendar
 * on the canvas is the same month grid it is in the pyramid. A type with no arm
 * never reaches here — the server drops it — and the `default` is only a
 * belt: an unknown type on a newer server draws nothing rather than throwing.
 */
export function renderWidget(
  type: string,
  model: DisplayModel,
  config?: unknown,
  mediaBase: string = MEDIA_BASE,
): HTMLElement | undefined {
  switch (type) {
    case 'clock':
      return renderClockWidget(model, config);
    case 'calendar':
      return renderCalendarWidget(model, config);
    case 'weather':
      return renderWeather(model, config);
    case 'homeassistant':
      return renderHouse(model, config);
    case 'shift':
      return renderShiftWidget(model, config);
    case 'countdown':
      return renderCountdownWidget(model, config);
    case 'external':
      return renderExternalWidget(model, config);
    case 'notes':
      return renderNotesWidget(config);
    case 'todo':
      return renderTodoWidget(config);
    case 'chores':
      return renderChoresWidget(model, config);
    case 'image':
      return renderImageWidget(config, mediaBase);
    default:
      return undefined;
  }
}

/**
 * The Image widget: an uploaded picture, covering its box (RFC 005 Phase 3b).
 *
 * Drawn as a background on a div, not an `<img>`, so `cover` handles any aspect
 * without stretching — the same treatment the canvas background uses. The name
 * is a stored hash the server validated; `url()` around it and nothing else, so
 * there is no path and no external origin (rule three). Empty until a picture is
 * chosen, which it says rather than drawing a blank box.
 */
function renderImageWidget(config: unknown, mediaBase: string): HTMLElement {
  const name = widgetConfig(config)['image'];
  if (typeof name !== 'string' || name === '') {
    return el('div', 'cd-empty', 'Choose a picture in this widget’s options.');
  }
  const box = el('div', 'fw-image');
  box.style.backgroundImage = `url("${mediaBase}${name}")`;
  return box;
}

/**
 * The Notes widget: free text the household typed, drawn as written.
 *
 * `textContent` line by line — never `innerHTML` — so a note can carry no markup,
 * and its own line breaks are kept (a note is written in lines). Empty until the
 * household types something, which it says rather than drawing a blank box.
 */
function renderNotesWidget(config: unknown): HTMLElement {
  const text = widgetConfig(config)['text'];
  if (typeof text !== 'string' || text.trim() === '') {
    return el('div', 'cd-empty', 'Add a note in this widget’s options.');
  }
  const notes = el('div', 'nt');
  for (const line of text.split('\n')) {
    // A blank line is a paragraph break, kept as an empty row so the spacing the
    // household typed survives.
    notes.appendChild(el('div', line.trim() === '' ? 'nt-gap' : 'nt-line', line));
  }
  return notes;
}

/**
 * The To-do widget: a static checklist the household typed.
 *
 * The wall is read-only, so items are shown rather than ticked — the list is
 * edited in the admin. Each line is drawn through `textContent`, so an item can
 * carry no markup.
 */
function renderTodoWidget(config: unknown): HTMLElement {
  const items = configStrings(widgetConfig(config)['items']).filter((item) => item.trim() !== '');
  if (items.length === 0) {
    return el('div', 'cd-empty', 'Add items in this widget’s options.');
  }
  const list = el('div', 'td');
  for (const item of items) {
    const row = el('div', 'td-row');
    row.appendChild(el('span', 'td-box'));
    row.appendChild(el('span', 'td-text', item));
    list.appendChild(row);
  }
  return list;
}

/**
 * A registered module's panel, placed as a widget (docs/rfc-001-module-framework.md).
 *
 * The same `renderGenericPanel` the stacked block uses — only the placement
 * differs. The module id in the config points at the `ext:<id>` panel the
 * manifest already carries. A widget whose module has no panel yet (not chosen,
 * disabled, or not polled) says so rather than drawing an empty box.
 */
function renderExternalWidget(model: DisplayModel, config: unknown): HTMLElement {
  const id = widgetConfig(config)['module'];
  const panel = typeof id === 'string' ? model.externalPanels[`ext:${id}`] : undefined;
  if (panel === undefined) return el('div', 'cd-empty', 'Pick a module in this widget’s options.');
  return renderGenericPanel(panel, panelRowLimit(config));
}

/**
 * A countdown to a date the household set.
 *
 * Days are counted from the wall's own clock reading against the target — and
 * `model.now` is the *server's* time, not the tablet's, so a countdown does not
 * drift with a screen whose clock is two hours out. The label is the widget's
 * title. A date not yet set says so rather than drawing a bare zero.
 */
function renderCountdownWidget(model: DisplayModel, config: unknown): HTMLElement {
  const c = widgetConfig(config);
  const target = typeof c['target'] === 'string' ? c['target'] : '';
  const label = typeof c['title'] === 'string' ? (c['title'] as string).trim() : '';

  const box = el('section', 'cd');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
    box.appendChild(el('div', 'cd-empty', 'Set a date in this widget’s options.'));
    return box;
  }

  const today = localDate(model.now, model.timezone);
  const days = Math.round(
    (Date.parse(`${target}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000,
  );
  const abs = Math.abs(days);

  if (days === 0) {
    box.appendChild(el('div', 'cd-num', 'Today'));
  } else {
    box.appendChild(el('div', 'cd-num', String(abs)));
    box.appendChild(el('div', 'cd-unit', `${abs === 1 ? 'day' : 'days'}${days < 0 ? ' ago' : ''}`));
  }
  if (label !== '') box.appendChild(el('div', 'cd-label', label));
  return box;
}

/**
 * A widget's stored options, read defensively.
 *
 * The server has already validated the shape (rule five, in `layoutWidgetBody`),
 * but the renderer reads what this process wrote as untrusted all the same — a
 * manifest one version ahead costs the widget its options, not the wall.
 */
/**
 * A civil date's short weekday, for a board that carries dates and no labels.
 *
 * Parsed at UTC midnight and formatted in UTC — the string is a *calendar date*
 * with no zone in it, so reading it as a local instant would slide it a day for
 * anybody west of Greenwich. The same reasoning as `DTEND` being exclusive, and
 * the same trap.
 */
function weekdayOfDate(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(at);
  } catch {
    return '';
  }
}

/**
 * One chore, as a row: its box, its name, whose it is, and when by.
 *
 * The box is a `<span>` on a screen that may not tick, and a real `<button>` on
 * one that may (RFC 008 phase 3). A real button rather than a tappable div
 * because a wall is reached by a fingertip, a keyboard and a television remote,
 * and only one of those three is served by a click handler on a box — the same
 * argument that made the interrupt's acknowledge control a button.
 *
 * `data-chore` is what `main.ts` listens for. The row is marked rather than the
 * page wired per node, so a redraw between polls does not have to re-attach
 * anything.
 */
function choreRow(item: ChoreItemModel, withPerson: boolean, tickable = false): HTMLElement {
  const row = el('div', `ch-row${item.done ? ' ch-done' : ''}`);
  // A row with no id cannot be ticked whatever the screen is allowed to do, so
  // it draws the read-only box. That is a degraded row, not a missing one.
  const canTick = tickable && item.id !== undefined;
  const box = canTick
    ? el('button', `ch-box ch-tick${item.done ? ' ch-box-on' : ''}`)
    : el('span', `ch-box${item.done ? ' ch-box-on' : ''}`);
  if (canTick) {
    (box as HTMLButtonElement).type = 'button';
    box.setAttribute('data-chore', item.id as string);
    box.setAttribute('aria-pressed', item.done ? 'true' : 'false');
    // Named, because "button" is what a screen reader would otherwise say for
    // every row on the board.
    box.setAttribute('aria-label', `${item.done ? 'Undo' : 'Done'}: ${item.name}`);
  }
  // The person's colour marks the box rather than the text: a chore name has to
  // stay legible from across a room, and tinting it would trade that away for a
  // cue the swatch already carries.
  if (item.color !== undefined) box.style.setProperty('--who', item.color);
  row.appendChild(box);
  row.appendChild(el('span', 'ch-name', item.name));
  if (withPerson && item.person !== undefined) {
    const who = el('span', 'ch-who', item.person);
    if (item.color !== undefined) who.style.setProperty('--who', item.color);
    row.appendChild(who);
  }
  if (item.dueTime !== undefined) row.appendChild(el('span', 'ch-time', item.dueTime));
  return row;
}

/**
 * The Chores widget (RFC 008 phase 2) — three views over one board.
 *
 * **Read-only, and that is the design rather than a stage it is passing
 * through.** It says what is due and what is done and offers no way to tick
 * anything: a box here is a marker, not a control. Making it one is phase 3,
 * and it lands with a per-screen gate and a POST behind the display token,
 * because a wall in a hallway and a tablet at elbow height are not the same
 * hardware.
 *
 * The view is read from `mode` exactly as `renderCalendarWidget` reads it, and
 * the default is an **absence**. Both halves matter: the e-paper calendar
 * shipped testing `mode === 'month'` against a default nobody stores, so all
 * three of its settings drew the same thing and the commonest one was the one
 * that broke. The panel's `drawChores` reads this identically, and a test holds
 * the two to each other.
 */
function renderChoresWidget(model: DisplayModel, config?: unknown): HTMLElement {
  const board = model.chores;
  if (board === undefined) {
    return el('div', 'cd-empty', 'No chores yet — add some on the Chores page.');
  }

  const cfg = widgetConfig(config);
  const mode = typeof cfg['mode'] === 'string' ? (cfg['mode'] as string) : '';
  /*
   * Whether this screen offers the control at all.
   *
   * Per screen and off by default, because it is a fact about the hardware: a
   * tablet at elbow height is what it is for, a panel behind glass has nothing
   * to press it with, and a screen a sleeve brushes would mark the bins done
   * on the way past. Hiding it is only a courtesy — the endpoint checks the
   * same flag, because the display token is on the wall.
   */
  const tickable = model.allowChores;
  // Whose chores to show, by person id — the same key and the same meaning the
  // Shift widget's picker uses. None chosen shows everybody, including the
  // chores nobody owns, which is what a bare widget draws.
  const wanted = configStrings(cfg['people']);
  const keep = (items: readonly ChoreItemModel[]): ChoreItemModel[] =>
    wanted.length === 0
      ? [...items]
      : items.filter((item) => item.personId !== undefined && wanted.includes(item.personId));

  const today = board.days[0];

  if (mode === 'week') {
    const list = el('div', 'ch ch-week');
    let drawn = 0;
    for (const day of board.days) {
      const items = keep(day.items);
      // Days with nothing are skipped here, though the panel keeps them: a
      // column of blanks tells a household nothing, which is the same call the
      // days-ahead block makes. They are kept in the *panel* because a caller
      // drawing a grid needs them to line its days up.
      if (items.length === 0) continue;
      const group = el('div', 'ch-day');
      const head = el('div', 'ch-day-head');
      head.appendChild(el('span', 'ch-dow', day.date === board.today ? 'Today' : weekdayOfDate(day.date)));
      group.appendChild(head);
      for (const item of items) group.appendChild(choreRow(item, true, tickable));
      list.appendChild(group);
      drawn++;
    }
    if (drawn === 0) return el('div', 'cd-empty', 'Nothing due this week.');
    return list;
  }

  if (mode === 'people') {
    const items = keep(today?.items ?? []);
    if (items.length === 0) return el('div', 'cd-empty', 'Nothing due today.');

    /*
     * A column per person, in the order their chores appear.
     *
     * Derived from the board rather than from the household's people list, so a
     * column only exists when somebody has something due — a board of five
     * names and two chores is a wall spending its width on emptiness. Anyone's
     * chores go last, under a heading that says so rather than under a blank.
     */
    const columns = new Map<string, ChoreItemModel[]>();
    for (const item of items) {
      const key = item.person ?? '';
      const column = columns.get(key);
      if (column === undefined) columns.set(key, [item]);
      else column.push(item);
    }
    const unassigned = columns.get('');
    columns.delete('');

    const board_ = el('div', 'ch-people');
    const column = (name: string, list: readonly ChoreItemModel[]): void => {
      const col = el('div', 'ch-col');
      const head = el('div', 'ch-col-head', name);
      const colour = list.find((item) => item.color !== undefined)?.color;
      if (colour !== undefined) head.style.setProperty('--who', colour);
      col.appendChild(head);
      for (const item of list) col.appendChild(choreRow(item, false, tickable));
      board_.appendChild(col);
    };
    for (const [name, list] of columns) column(name, list);
    if (unassigned !== undefined) column('Anyone', unassigned);
    return board_;
  }

  // Today, the default, and the one an absent `mode` means.
  const items = keep(today?.items ?? []);
  if (items.length === 0) return el('div', 'cd-empty', 'Nothing due today.');
  const list = el('div', 'ch');
  for (const item of items) list.appendChild(choreRow(item, true, tickable));
  return list;
}

function widgetConfig(config: unknown): Record<string, unknown> {
  return typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
}
function configStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The box-level format a widget carries — decorative only, so it is safe on
 * every type and never changes what the section draws. The server has already
 * validated the shape; this reads it back defensively all the same.
 */
function applyWidgetFormat(box: HTMLElement, config: unknown): void {
  const c = widgetConfig(config);
  if (c['align'] === 'center' || c['align'] === 'right' || c['align'] === 'left') {
    box.style.textAlign = c['align'];
  }
  if (typeof c['background'] === 'string' && HEX6.test(c['background'])) {
    const raw = c['opacity'];
    const opacity = typeof raw === 'number' ? Math.min(100, Math.max(0, raw)) : 100;
    box.style.background = hexToRgba(c['background'], opacity / 100);
  }
  if (c['corners'] === 'rounded') {
    box.style.borderRadius = '0.6rem';
    box.style.overflow = 'hidden';
  }
  // The drop shadow control is gone: a shadow bands on e-ink, burns in on
  // OLED, and buys nothing at reading distance. `c['shadow']` is deliberately
  // never read — a widget with `shadow: true` already in its stored config
  // simply draws without one, rather than needing a migration to remove it.
}

/** Wrap a widget body with its title when one is set to show, else pass through. */
function contentWithTitle(body: HTMLElement, config: unknown): HTMLElement {
  const c = widgetConfig(config);
  const title = typeof c['title'] === 'string' ? c['title'].trim() : '';
  if (c['showTitle'] !== true || title === '') return body;
  const wrap = el('div', 'fw-content');
  wrap.appendChild(el('div', 'fw-title', title));
  wrap.appendChild(body);
  return wrap;
}

/**
 * The Calendar widget: one of three views, at one of two densities.
 *
 * `month` (the default) is the same grid the responsive layout draws — flat
 * event names by default, quiet `dots`, or Skylight-style event `pills`. `week`
 * is the current Monday–Sunday week as vertical day columns. `list` is an agenda
 * of what is coming up, and the reason a widget has options at all: it can be
 * limited to some calendars (`calendars`, by source id — already in the
 * manifest, so filtering here leaks nothing) and to a number of events. A
 * calendar the household did not select is simply not counted.
 *
 * **Density is the second axis, and it used to be two more views.** `compact`
 * draws the same month and the same week edge to edge — hairline rules instead
 * of gaps and cards — and it is what a canvas storing `skymonth` or `skyweek`
 * has always drawn. Those values are still read, for ever, and nothing rewrites
 * them: `calendarView` is the one place a stored config becomes a (view,
 * density) pair, and `epaper/widgets.ts` asks it the same question. The agenda
 * has one density, so there is nothing to choose there and the editor offers
 * nothing — an option that does nothing is worse than an option not offered.
 */
function renderCalendarWidget(model: DisplayModel, config: unknown): HTMLElement {
  const c = widgetConfig(config);
  const { view, density } = calendarView(config);
  // Absence means on: the rota's colours predate this option (see the schema).
  // Read before the dispatch, because every style below consults it.
  const showShifts = c['showShifts'] !== false;
  if (view === 'week') {
    return density === 'compact' ? renderSkyWeek(model, config) : renderWeekColumns(model, config);
  }
  if (view === 'month') {
    if (density === 'compact') return renderSkyMonth(model, config);
    /*
     * Absence is `text`, and that is the change worth reading twice.
     *
     * It used to be `dots` — a cell that says a day is busy and never says what
     * is on it. Flat names are the default now, so a wall nobody has configured
     * draws the calendar rather than a density map, and a household who wants
     * the quiet grid asks for `dots` by name. The panel reads the same absence
     * the same way (`epaper/widgets.ts`); one stored value must not mean two
     * things on two screens.
     */
    const cellEvents = c['cellEvents'];
    return renderHorizon(model, {
      cells:
        cellEvents === 'pills'
          ? 'pills'
          : cellEvents === 'swiss'
            ? 'swiss'
            : cellEvents === 'dots'
              ? 'dots'
              : 'text',
      weekNumbers: c['showWeekNumbers'] === true,
      shifts: showShifts,
    });
  }

  const calendars = configStrings(c['calendars']);
  const keep = (event: EventModel): boolean =>
    calendars.length === 0 || calendars.includes(event.sourceId);

  const limit =
    typeof c['count'] === 'number' && c['count'] >= 1 ? Math.min(50, Math.trunc(c['count'])) : 12;
  const showWeather = c['showWeather'] === true;
  const source = [model.today, ...model.next].filter(
    (day): day is DayModel => day !== undefined,
  );

  const section = el('section', 'next');
  section.appendChild(el('div', 'section-label', 'Upcoming'));
  let budget = limit;
  let any = false;
  for (const day of source) {
    if (budget <= 0) break;
    const events = day.events.filter(keep).slice(0, budget);
    // Today always shows (even empty) so "nothing on today" reads as checked;
    // an empty future day is skipped rather than drawn as a blank row.
    if (events.length === 0 && !day.isToday) continue;
    budget -= events.length;
    any = any || events.length > 0;
    section.appendChild(
      renderDayRow({ ...day, events, hiddenEventCount: 0 }, showWeather, showShifts),
    );
  }
  if (!any) section.appendChild(el('div', 'dr-empty', 'Nothing coming up.'));
  return section;
}

/**
 * The Calendar widget's `week` mode: the current week as vertical day columns.
 *
 * The first horizon week already starts on the Monday of the week containing
 * today (`viewmodel.ts`), so it is exactly the Skylight-style seven columns —
 * reused rather than re-derived, so a week and the month grid agree on which
 * week is current. Each column headers its weekday and date and stacks its
 * events as coloured pills; today's column is picked out and past days dimmed.
 * The `calendars` filter is honoured, the same as the agenda mode.
 */
function renderWeekColumns(model: DisplayModel, config: unknown): HTMLElement {
  const calendars = configStrings(widgetConfig(config)['calendars']);
  const keep = (sourceId: string): boolean =>
    calendars.length === 0 || calendars.includes(sourceId);

  const week = model.horizon[0] ?? [];
  const section = el('section', 'weekcols');
  // One number for the whole strip, because a week column view *is* one week.
  const number = week[0]?.weekNumber;
  if (widgetConfig(config)['showWeekNumbers'] === true && number !== undefined) {
    section.appendChild(el('div', 'wc-week', `Week ${number}`));
  }
  const grid = el('div', 'wc-grid');
  for (const cell of week) {
    const col = el('div', `wc-col${cell.isToday ? ' is-today' : ''}${cell.isPast ? ' dim' : ''}`);
    const head = el('div', 'wc-head');
    head.appendChild(el('span', 'wc-wd', cell.weekday));
    head.appendChild(el('span', 'wc-num', cell.dayNumber));
    col.appendChild(head);
    for (const ev of cell.events.filter((e) => keep(e.sourceId))) {
      const pill = el('div', ev.allDay ? 'wc-ev allday' : 'wc-ev', ev.title);
      pill.style.setProperty('--pc', ev.color);
      col.appendChild(pill);
    }
    grid.appendChild(col);
  }
  section.appendChild(grid);
  return section;
}

/**
 * The generic module panel — the one renderer every module's data flows
 * through (see docs/rfc-001-module-framework.md). `textContent` throughout, no
 * `innerHTML` anywhere: a module supplies strings and this draws them, so it can
 * never inject markup, an origin, or a script. The shape is already validated
 * and sanitised (`panelFrom`); this only lays it out.
 */
export function renderGenericPanel(data: PanelData, rows?: number): HTMLElement {
  const section = el('section', `gp gp-${data.kind}`);
  if (data.title !== undefined) section.appendChild(el('div', 'gp-title', data.title));

  /*
   * How many of the module's rows to draw.
   *
   * The module decides its panel's shape and may send twelve readings; the
   * household decides how many of them fit the box they dragged. Applies only
   * to the two list kinds — a stat has one value and text is one paragraph, so
   * there is nothing there to take the first three of.
   */
  const take = <T,>(items: readonly T[]): readonly T[] =>
    rows === undefined ? items : items.slice(0, rows);

  /*
   * 'stat' and 'tiles' used to draw as an oversized numeral and a strip of
   * tiles — exactly the kind of outsized treatment this wall's type hierarchy
   * exists to remove, and on a widget a household merely dragged into place.
   * Both draw as label/value rows now, the same as 'readings': a third-party
   * module that already sends `kind: 'stat'` or `kind: 'tiles'` still draws
   * something on upgrade rather than going blank (rule nine) — only the
   * treatment changed, not the data shape a module may send.
   */
  if (data.kind === 'readings' || data.kind === 'stat' || data.kind === 'tiles') {
    const items: readonly PanelReading[] =
      data.kind === 'readings'
        ? data.items
        : data.kind === 'stat'
          ? [{ label: data.caption ?? '', value: data.value }]
          : data.items;
    const list = el('div', 'gp-readings');
    for (const reading of take(items)) {
      const row = el('div', 'gp-reading');
      if (reading.icon !== undefined) row.appendChild(el('span', 'gp-ico', reading.icon));
      row.appendChild(el('span', 'gp-label', reading.label));
      row.appendChild(el('span', 'gp-value', reading.value));
      list.appendChild(row);
    }
    section.appendChild(list);
  } else {
    section.appendChild(el('div', 'gp-text', data.text));
  }
  return section;
}

/**
 * The free-form canvas.
 *
 * The household placed these boxes at an authored aspect; the canvas keeps that
 * aspect and letterboxes on a screen of a different shape, so what was dragged
 * is what is drawn. The letterbox is pure CSS against the frame the geometry
 * already sized and rotated (`--frame-w/h`), so this does no measuring and
 * stays correct through a quarter turn.
 *
 * A takeover still wins — a warning is a warning, canvas or no canvas — and a
 * banner still draws over the top, the same as it does over the blocks.
 */
/**
 * Where media (uploaded images) is served from. The wall reads it behind its
 * display token at `/d/media/`; the editor preview, on the admin page, reads the
 * same bytes behind the session at `admin/media/`. Passed in so one renderer
 * draws for both (RFC 005 Phase 3b).
 */
const MEDIA_BASE = '/d/media/';

/**
 * A canvas background as a CSS `background` value, or undefined for none.
 *
 * `#rrggbb` and the stored image name are validated server-side; this only
 * shapes them. A solid is the colour; a gradient is a two-stop `linear-gradient`
 * at the stored angle; an image covers the canvas, served from the media store —
 * `url()` around the name only, never anything a stranger wrote (rule three; the
 * name is 64 hex the server minted).
 */
function backgroundCss(background: CanvasBackground | undefined, mediaBase: string): string | undefined {
  if (background === undefined) return undefined;
  if (background.type === 'solid') return background.color;
  if (background.type === 'gradient') {
    return `linear-gradient(${background.angle}deg, ${background.from}, ${background.to})`;
  }
  // An image with no picture yet (a transient editor state) is no background.
  if (background.image === '') return undefined;
  return `center / cover no-repeat url("${mediaBase}${background.image}")`;
}


/**
 * Cut each flat-text month cell to the rows it can actually *say*.
 *
 * The cell is a fixed height, so "how many fit" looks like arithmetic — and it
 * is not, twice over. A row is one line or two depending on the words in it,
 * and a calendar widget in a free-form box
 * is whatever size the household dragged it to, and the same grid is drawn at
 * 1080x1920, on a 1280px television and inside a 200px preview. Any constant
 * here would be a second opinion about what fits, which is the fault this
 * project keeps finding. So it measures, exactly as `fitToBox` does, and for
 * the same reason.
 *
 * Two passes, and the first is the new one.
 *
 * **Across.** A row is drawn only if its whole title is on the glass. Measured
 * on a real wall, seven columns of a 1080px portrait canvas leave about 115px
 * per cell, which at the type floor is eleven characters a line — so the old
 * single ellipsised line rendered "Year 6 trip to the Science Museum" and
 * "Year 6 sports day" as the same five letters. That is not a shortened title,
 * it is a different string, and two events can share it. Titles wrap to
 * `--cell-lines` lines now, and one that needs more is *hidden* rather than
 * cut: it becomes part of the "+N", which is honest, where "Year 6…" is not.
 *
 * **Down.** What is left is walked from the top and stopped at the box, which
 * is the pass this function always had. Two things the arithmetic would get
 * wrong even at a fixed size. The "+N" is itself a line and has to be paid for
 * out of the same budget, so a cell that overflows shows one *fewer* row than
 * one that does not. And the count is `data-count` — the day's true total —
 * not the number of rows rendered: the model caps its slim list at twelve, so a
 * day with twenty events must say "+17" and not "+9".
 *
 * Reads are batched ahead of writes on purpose. Hiding a row moves every row
 * under it, so deciding and hiding in one loop would measure positions that the
 * previous iteration had already invalidated — and would ask the browser for a
 * fresh layout once per row, forty-two cells over.
 *
 * A drawing decision, never a saved one. Nothing here writes to the model, so
 * widening the box brings the rows straight back on the next draw.
 */
export function trimCellRows(root: HTMLElement): void {
  const cells = root.querySelectorAll('.horizon-text .hz-cell, .horizon-swiss .hz-cell');

  /*
   * The bars first, because what they draw is what the cells under them owe.
   *
   * A bar is an absolutely placed grid item, so nothing clips it to its week:
   * a row too short for the lane it was given would paint a coloured band
   * across the *next* week's numbers, which is the one failure a month grid
   * must never have. The lane arithmetic is declared in the stylesheet and
   * cannot know the box, so this is where it is checked — measured, like every
   * other fit on this wall, and a bar that does not fit is hidden and its
   * event handed back to the cells as a row.
   */
  const spanned = new Map<string, number>();
  const bars = root.querySelectorAll('.horizon-text .hz-span, .horizon-swiss .hz-span');
  const dropped: HTMLElement[] = [];
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index] as HTMLElement;
    bar.style.display = '';
    const cover = (bar.getAttribute('data-cover') ?? '').split(' ').filter((one) => one !== '');
    const under = cover
      .map((key) => root.querySelector(`.hz-cell[data-cell="${key}"]`))
      .filter((one): one is HTMLElement => one instanceof HTMLElement);
    const floor = Math.min(...under.map((one) => one.getBoundingClientRect().bottom));
    if (under.length > 0 && bar.getBoundingClientRect().bottom > floor + 0.5) {
      dropped.push(bar);
      continue;
    }
    for (const key of cover) spanned.set(key, (spanned.get(key) ?? 0) + 1);
  }
  for (const bar of dropped) bar.style.display = 'none';

  interface Pending {
    readonly cell: HTMLElement;
    readonly more: HTMLElement;
    readonly rows: readonly HTMLElement[];
    /** The day's true total, stamped by the renderer from the model. */
    readonly total: number;
    /** How many of that total a span bar is already drawing over this cell. */
    readonly spans: number;
    /** The room the cell has, measured once. */
    readonly limit: number;
    /** The rows whose whole title is on the glass, after the pass across. */
    visible: HTMLElement[];
  }
  const pending: Pending[] = [];

  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index] as HTMLElement;
    const list = cell.querySelector('.hz-rows') as HTMLElement | null;
    const more = cell.querySelector('.hz-more') as HTMLElement | null;
    if (list === null || more === null) continue;

    const rows: HTMLElement[] = [];
    for (let r = 0; r < list.children.length; r++) rows.push(list.children[r] as HTMLElement);
    if (rows.length === 0) continue;

    const style = getComputedStyle(cell);
    /*
     * The room the cell has, measured rather than added up.
     *
     * Summing row heights was the first approach and it was short by exactly
     * the things that are not heights: the flex `gap` between rows, and the
     * counter's own top margin. That left today's cell overflowing by 2px on
     * two of three screen sizes — small enough to look like a rounding error
     * and big enough to clip the last row's descenders. `offsetTop` already
     * carries the gaps, the margins and the date number above, so reading it
     * removes the arithmetic instead of correcting it.
     *
     * `clientHeight` is the padding box and a child's `offsetTop` is measured
     * from that box's top edge — the cell is `position:relative`, so it is the
     * offsetParent — which is what lets the two be compared directly.
     */
    pending.push({
      cell,
      more,
      rows,
      total: Number(cell.getAttribute('data-count') ?? rows.length),
      spans: spanned.get(cell.getAttribute('data-cell') ?? '') ?? 0,
      limit: cell.clientHeight - parseFloat(style.paddingBottom),
      visible: [],
    });
  }
  if (pending.length === 0) return;

  const bottomOf = (node: HTMLElement): number => node.offsetTop + node.offsetHeight;
  /** How many of a cell's rows are actually on the glass right now. */
  const shownIn = (entry: Pending): number =>
    entry.visible.filter((row) => row.style.display !== 'none').length;
  /** The last row still on the glass, which is where a counter can ride. */
  const lastShown = (entry: Pending): HTMLElement | undefined => {
    for (let index = entry.visible.length - 1; index >= 0; index--) {
      const row = entry.visible[index] as HTMLElement;
      if (row.style.display !== 'none') return row;
    }
    return undefined;
  };

  /**
   * Hide, from the top down, every row whose bottom is past the budget.
   *
   * Rows are not a uniform height — a title may take one line or two — and that
   * breaks the walk this used to do. "Stop at the first row that does not fit"
   * is only correct when every row is the same size: with mixed heights, a
   * two-line title that does not fit says nothing at all about the one-line one
   * under it. Measured on a 1280x720 wall, that cost six cells every name they
   * had, each showing "+2" and not one of its two events.
   *
   * So a row that does not fit is hidden and the walk *continues*. Hiding one
   * pulls everything under it up, and this project does not do that arithmetic
   * — it measures — so it is done in rounds: hide the first row that overflows,
   * let the browser lay out again, look again. Reads are batched across every
   * cell and so are the writes, so a round is two layouts for the whole grid
   * rather than two per cell.
   */
  const pack = (entries: readonly Pending[], budgetOf: (entry: Pending) => number): void => {
    let working = entries.slice();
    // Bounded by the model's own cap on how many events a cell can carry, so
    // the loop cannot outlive the data even if a measurement never settles.
    for (let round = 0; round < 12 && working.length > 0; round++) {
      const hiding: { entry: Pending; row: HTMLElement }[] = [];
      for (const entry of working) {
        const budget = budgetOf(entry);
        for (const row of entry.visible) {
          if (row.style.display === 'none') continue;
          if (bottomOf(row) > budget) {
            hiding.push({ entry, row });
            break;
          }
        }
      }
      if (hiding.length === 0) return;
      for (const { row } of hiding) row.style.display = 'none';
      working = hiding.map(({ entry }) => entry);
    }
  };

  /**
   * The pass across: a row survives only if its whole title is on the glass.
   *
   * `allowed` is how many lines the words may take. A title that needs more is
   * *hidden* rather than cut, because "Year 6…" is a different string from
   * "Year 6 trip to the Science Museum" and two events can share it — where
   * "+1" is simply true.
   */
  /**
   * Whether this row's whole title is on the glass — the one predicate, so the
   * pass across and the counter's re-check cannot come to different answers
   * about the same row.
   */
  const fitsWhole = (row: HTMLElement, allowed: number): boolean => {
    const text = row.querySelector('.hz-rowtext') as HTMLElement | null;
    if (text === null) return true;
    /*
     * How many lines the words actually took. `scrollHeight` is the content's
     * own height whatever the box was clamped to, so this reads the same
     * whether or not the stylesheet's `max-height` belt is in force.
     *
     * Half a line of slack, never a whole one: a line either happened or it did
     * not, and sub-pixel rounding on a wrapped box is worth less than that. A
     * pixel of slack would make a 2.02-line title read as three.
     */
    const style = getComputedStyle(text);
    const lineHeight = parseFloat(style.lineHeight);
    const line =
      Number.isFinite(lineHeight) && lineHeight > 0
        ? lineHeight
        : parseFloat(style.fontSize) * 1.25;
    return (
      text.scrollHeight <= line * allowed + line / 2 &&
      // A word wider than the column on its own. `overflow-wrap` breaks those
      // rather than letting them overhang, so this is the belt — but a belt
      // that costs nothing and catches the case where it cannot.
      text.scrollWidth <= text.clientWidth + 1
    );
  };

  const across = (entries: readonly Pending[], allowed: number): void => {
    const keeping: Set<HTMLElement>[] = [];
    for (const entry of entries) {
      const keep = new Set<HTMLElement>();
      for (const row of entry.rows) if (fitsWhole(row, allowed)) keep.add(row);
      keeping.push(keep);
    }
    entries.forEach((entry, index) => {
      const keep = keeping[index] as Set<HTMLElement>;
      entry.visible = entry.rows.filter((row) => keep.has(row));
      for (const row of entry.rows) row.style.display = keep.has(row) ? '' : 'none';
    });
  };

  /** Across, then down, then the counter into whatever room is left over. */
  const settle = (entries: readonly Pending[], allowed: number): void => {
    for (const entry of entries) {
      for (const row of entry.rows) row.style.display = '';
      entry.more.textContent = '';
      entry.more.className = 'hz-more';
      // Back out of whichever row last held it, so a re-settle measures the
      // rows at their own width rather than at the width a counter left them.
      if (entry.more.parentElement !== entry.cell) entry.cell.appendChild(entry.more);
    }
    across(entries, allowed);

    /*
     * The names, at the cell's whole budget.
     *
     * The counter used to be paid for *before* this, out of the same budget —
     * so a cell with room for exactly one row spent it on "+3" and drew
     * neither of its events. Measured at 800x480, thirteen cells drew a
     * counter and not one name. A count is a summary of what is missing; it
     * cannot be worth more than the thing itself, so it is placed afterwards
     * and only into room the names did not want.
     */
    pack(entries, (entry) => entry.limit);

    /*
     * A cell that says nothing says nothing.
     *
     * With no name on the glass a "+3" is the cell's entire content — a number
     * with no subject, which is the failure this grid has already shipped once
     * in the other direction. The density mark under the numeral is what such
     * a cell draws instead: it needs no legible text, it is already there, and
     * it says the one thing a "+3" was saying.
     */
    const counted = entries.filter(
      (entry) => shownIn(entry) > 0 && shownIn(entry) + entry.spans < entry.total,
    );
    if (counted.length === 0) return;

    /*
     * What the names managed on their own, which the counter may not reduce.
     *
     * This is rule 2 stated as an experiment rather than as a fallback, and it
     * is what a first draft got wrong. That draft dropped the counter whenever
     * sharing the last row cost that row its title — and measured on a
     * 1280x720 wall it turned "Yoga · +1" into "Year 6 trip to the Science
     * Museum" over two lines and *no count at all*. Which is not a name saved:
     * it is the same one name, longer, with the household no longer told there
     * is a second event. The rule is about how many names a cell shows, so the
     * check has to be a comparison against how many it showed without one.
     */
    const baseline = new Map<Pending, Set<HTMLElement>>();
    for (const entry of counted) {
      baseline.set(entry, new Set(entry.visible.filter((row) => row.style.display !== 'none')));
    }

    /*
     * "+N" rides on the last row it is counting for, hard right.
     *
     * It is `display:none` while empty, so it needs content before it has a
     * size at all. `+0` is a placeholder of the right *shape* — the digits are
     * tabular, so the box a two-digit count needs is the box it is measured
     * with.
     *
     * A counter is `flex: 0 0 auto`, so the words beside it lose its width —
     * enough, on a 115px cell, to push a title that fitted onto a line it has
     * not got. When that happens the row is set aside and the cell is packed
     * *again* from the across pass's state, which is what lets a shorter title
     * underneath take its place: the two-line "Year 6 trip…" makes way and
     * "Yoga · +1" fits where neither fitted before. Rounds rather than
     * arithmetic, and reads batched against writes, for the reason the pass
     * above is: hiding one row relays out the whole grid.
     */
    const banned = new Map<Pending, Set<HTMLElement>>();
    for (const entry of counted) banned.set(entry, new Set());
    for (let round = 0; round < 4; round++) {
      for (const entry of counted) {
        const out = banned.get(entry) as Set<HTMLElement>;
        for (const row of entry.visible) row.style.display = out.has(row) ? 'none' : '';
        entry.more.className = 'hz-more';
        entry.more.textContent = '';
        if (entry.more.parentElement !== entry.cell) entry.cell.appendChild(entry.more);
      }
      pack(counted, (entry) => entry.limit);
      for (const entry of counted) {
        const row = lastShown(entry);
        if (row === undefined) continue;
        entry.more.className = 'hz-more in-row';
        entry.more.textContent = '+0';
        row.appendChild(entry.more);
      }
      const spilled = counted.filter((entry) => {
        const row = lastShown(entry);
        return row !== undefined && !fitsWhole(row, allowed);
      });
      if (spilled.length === 0) break;
      for (const entry of spilled) {
        const row = lastShown(entry);
        if (row !== undefined) (banned.get(entry) as Set<HTMLElement>).add(row);
      }
    }

    /*
     * Where sharing could not be had without costing a name, the counter takes
     * a line of its own — out of the room the names have just declined to use.
     *
     * Sharing is the design and this is the fallback, in that order, and the
     * order is what the rule is about rather than the placement. Measured on
     * the 1080x1920 wall, a cell holding "Grandma's 80th birthday" over two
     * lines has room for a third line but not for a third *line of that
     * title*: sharing pushes the words onto a line the cell has not got, and a
     * counter underneath them fits exactly. Dropping it there — which a first
     * draft did — loses the household the fact that the day holds something
     * else, and buys nothing at all.
     */
    const failed = counted.filter((entry) => {
      const before = baseline.get(entry) as Set<HTMLElement>;
      const row = lastShown(entry);
      // Out of rounds with the words still cut is a failure too, and not the
      // same one: the cell kept its name count and broke "whole or not at all"
      // to do it. The own-line placement gives that row its width back.
      return row === undefined || shownIn(entry) < before.size || !fitsWhole(row, allowed);
    });
    if (failed.length > 0) {
      for (const entry of failed) {
        for (const row of entry.visible) row.style.display = '';
        entry.more.className = 'hz-more';
        entry.more.textContent = '+0';
        if (entry.more.parentElement !== entry.cell) entry.cell.appendChild(entry.more);
      }
      pack(failed, (entry) => {
        const style = getComputedStyle(entry.more);
        return entry.limit - entry.more.offsetHeight - parseFloat(style.marginTop);
      });
    }

    /*
     * And where neither placement could be had without costing a name, the
     * cell keeps the name and says nothing.
     *
     * There is nothing a "+2" can say that is worth the word it would cost,
     * and the mark under the numeral already says the day is busy. Restored
     * from the state the names reached on their own rather than re-packed,
     * because that state is known and a second packing is a second opinion.
     */
    for (const entry of failed) {
      const before = baseline.get(entry) as Set<HTMLElement>;
      if (shownIn(entry) >= before.size) continue;
      for (const one of entry.visible) one.style.display = before.has(one) ? '' : 'none';
      entry.more.textContent = '';
    }

    for (const entry of counted) {
      if (entry.more.textContent === '') continue;
      const hidden = entry.total - shownIn(entry) - entry.spans;
      entry.more.textContent = hidden > 0 ? `+${hidden}` : '';
    }
  };

  const allowed = (): number => {
    const first = pending[0]?.rows[0]?.querySelector('.hz-rowtext');
    if (!(first instanceof HTMLElement)) return 2;
    const declared = parseFloat(getComputedStyle(first).getPropertyValue('--cell-lines'));
    return Number.isFinite(declared) && declared >= 1 ? Math.round(declared) : 2;
  };

  settle(pending, allowed());

  /*
   * And a cell that ended up saying nothing gets one more go, on one line.
   *
   * The wrap allowance is a *maximum*, not a promise, and this is where that
   * matters. Measured on the shipped Classic wall in portrait — a month box
   * 972x864, so cells of 114x129 — a 22px two-line row is 55px and the counter
   * another 26, which does not fit under a 22px date number. Seven of nine
   * cells with events drew "+3" and not one name: truthful, and a month grid
   * that has stopped saying what is on, which is the exact failure this whole
   * change exists to end.
   *
   * On one line those same cells hold "Dentist" and "Bin day" — a short title
   * whole, which is worth more than a number. A title that needs two lines is
   * hidden here as it always was, so nothing is cut; the cell just stops
   * reserving room it cannot use. Only cells that would otherwise be silent pay
   * for this pass, so a wall with room is untouched.
   *
   * The same shape as the shift ladder dropping a rung and asking again, and
   * the same rule: a drawing decision, never a saved one.
   */
  if (allowed() > 1) {
    const silent = pending.filter((entry) => entry.total > 0 && shownIn(entry) === 0);
    if (silent.length > 0) settle(silent, 1);
  }
}

/**
 * The day-sized groups a section can be cut on, or nothing if it has none.
 *
 * Two sections are a stack of days: a chore week (`.ch-day` under `.ch-week`)
 * and an agenda (`.day-row` under `.next`). They are listed here together
 * rather than trimmed in two places because the rule is one rule — a section
 * too tall for its box gives up whole days from the bottom — and the two
 * renderers of a chore board are already the project's example of what happens
 * when one decision lives in two spots.
 *
 * Anything else answers with an empty list and is left to clip at the floor,
 * which is the right answer for a section with no boundary to cut on: a
 * weather strip or a shift badge is one thing, not a list of things.
 */
function dayGroups(scale: HTMLElement): readonly HTMLElement[] {
  const stack =
    scale.querySelector('.ch-week') ?? scale.querySelector('section.next');
  if (stack === null) return [];
  const selector = stack.classList.contains('ch-week') ? '.ch-day' : '.day-row';
  /*
   * Only the days actually drawn.
   *
   * `display.css` hides `.day-row:nth-child(n + 6)` on a short landscape
   * screen, so on a 1024x600 tablet the last rows of an agenda are in the DOM
   * with a zero rect. Left in this list they are worse than useless: the trim
   * walks up from the bottom and stops at the first day that fits, and a
   * zero-height row "fits" trivially — so the whole pass stopped on its first
   * iteration and nothing was ever trimmed, on exactly the screens that needed
   * it most. Filtering here also restores what the loop assumes, that each day
   * ends below the one before it.
   */
  return ([...stack.querySelectorAll(selector)] as HTMLElement[]).filter(
    (group) => group.getBoundingClientRect().height > 0,
  );
}

/**
 * Fit a reused section to its box, then cut it to whole days and fit again.
 *
 * Cut on a day, never through one. A section holds a legible floor and clips
 * below it, which is right — but `overflow: hidden` cuts wherever the pixel
 * falls, and a row sliced across the middle reads as a broken renderer rather
 * than as a list that ran out of room. Same fault as the month grid losing its
 * last week, and visible only by measuring.
 *
 * Then fit again, because what is left is smaller than what was measured. The
 * first fit scaled every day down to the floor and clipped; with the days that
 * did not fit now gone, that scale is a section drawn at its floor in a box
 * with room to spare — the exact "cramped, just in a bigger box" fault
 * `fitToBox` was rewritten to stop. Trimming and re-fitting is one pass each
 * way: **fewer days, drawn larger**, which is the whole argument (RFC 009 1.3).
 *
 * The head always survives, clipped if it comes to that, the same rule the
 * shift ladder keeps: a household who dragged a box too small should see the
 * thing at the top of it — today — rather than an empty rectangle (rule nine).
 * That is new for the chore week, which trimmed from the last group to the
 * first and so could take itself away entirely in a box too small for one day.
 *
 * A drawing decision, never a saved one. Nothing here writes to the model, so
 * widening the box brings the days straight back on the next draw.
 */
function fitAndTrimToDays(box: HTMLElement, scale: HTMLElement, min: number): void {
  fitToBox(box, scale, { min });

  const groups = dayGroups(scale);
  if (groups.length === 0) return;

  /*
   * Measured against the **box**, which is the element that clips. The first
   * attempt measured `.fw-content`, which sits *inside* the transform and is
   * sized to its own content — so its bottom is always past the last row and
   * nothing was ever trimmed. The frame looked identical, which is exactly how
   * that kind of mistake survives.
   */
  const style = getComputedStyle(box);
  const limit = box.getBoundingClientRect().bottom - parseFloat(style.paddingBottom || '0');
  let trimmed = false;
  for (let index = groups.length - 1; index >= 1; index--) {
    const group = groups[index] as HTMLElement;
    if (group.getBoundingClientRect().bottom <= limit + 1) break;
    /*
     * Hidden, not removed, which `trimCellRows` also does and which is
     * load-bearing here for a reason nothing in this function can see.
     * `display.css` hides `.day-row:nth-child(n + 6)` on a short landscape
     * screen — a *positional* rule — so taking a row out of the document
     * renumbers the rest and hands the hidden ones back. Measured on a
     * 1024x600 tablet: removing the two days that did not fit promoted the two
     * the stylesheet had hidden, which then did not fit either, and the trim
     * had undone itself while looking like it had worked.
     *
     * The cost is the closing hairline: `.day-row:last-child` matches a hidden
     * row, so the last day drawn has no rule under it. A missing 1px line is
     * the better half of that trade.
     */
    group.style.display = 'none';
    trimmed = true;
  }

  if (trimmed) fitToBox(box, scale, { min });
}

export function renderFreeform(
  root: HTMLElement,
  model: DisplayModel,
  layout: {
    readonly aspect: number;
    readonly widgets: readonly ManifestWidget[];
    readonly background?: CanvasBackground;
  },
  mediaBase: string = MEDIA_BASE,
): void {
  const takeover = model.interrupts.find((interrupt) => interrupt.takeover);
  if (takeover !== undefined) {
    root.textContent = '';
    root.appendChild(renderAlert(takeover, model));
    return;
  }

  const screen = el('div', 'screen freeform');
  const canvas = el('div', 'canvas');
  canvas.style.setProperty('--aspect', String(layout.aspect));
  // The canvas background (RFC 005 Phase 3): a solid colour or a gradient behind
  // the widgets. `background` is a shorthand, so it overrides the theme's wall
  // colour on this canvas only; absent leaves the theme showing through.
  const bg = backgroundCss(layout.background, mediaBase);
  if (bg !== undefined) canvas.style.background = bg;

  // Widgets whose body is a section from the responsive layout are scaled to
  // their box after they are on screen — see below. Each carries a readable
  // floor: below it the section clips at the box edge rather than shrinking to
  // an illegible size.
  const toFit: {
    readonly box: HTMLElement;
    readonly scale: HTMLElement;
    readonly min: number;
  }[] = [];

  // Week-column calendars, to be re-checked once they have a real width. Seven
  // columns cannot reflow: unlike every other section they do not get narrower
  // type, they get narrower columns, so a small box produces seven slivers with
  // a letter in each. Measured after layout, because a box's width is a
  // percentage of a canvas that is itself letterboxed into the frame.
  const weekBoxes: { readonly box: HTMLElement; readonly widget: ManifestWidget }[] = [];

  // Agenda sections, to be re-checked for whether they kept room for a time
  // column. Includes the ones the week fallback below produces. Each carries
  // the box and the scaled node it lives in, because that check can change the
  // layout and the fit then has to be taken again.
  const agendas: {
    readonly section: HTMLElement;
    readonly box: HTMLElement;
    readonly scale: HTMLElement;
  }[] = [];

  // Widgets with a field ladder, to be re-checked once they have a real size.
  // The ladder's bottom rungs are given up one at a time when the box cannot
  // hold them — measured after layout for the same reason the week columns are,
  // and by the same rule: a drawing decision, never a saved one.
  const ladderBoxes: { readonly box: HTMLElement; readonly widget: ManifestWidget }[] = [];

  for (const widget of layout.widgets) {
    const box = el('div', `fw fw-${widget.type}`);
    /*
     * Which widget this box is, for anything that has to find it again after
     * layout. The editor reads it to show how much of a ladder actually
     * survived in the real preview; nothing on a wall reads it.
     */
    box.dataset['widgetId'] = widget.id;
    // Percentages of the canvas, so the same layout fills any resolution of
    // the authored aspect.
    box.style.left = `${widget.x * 100}%`;
    box.style.top = `${widget.y * 100}%`;
    box.style.width = `${widget.w * 100}%`;
    box.style.height = `${widget.h * 100}%`;
    box.style.zIndex = String(widget.z);
    // The box's own size, as fractions of the canvas — read in CSS as
    // `--bw`/`--bh` by the clock, which sizes its text against its box.
    box.style.setProperty('--bw', String(widget.w));
    box.style.setProperty('--bh', String(widget.h));

    // Box-level format the household chose — a background, corners, a shadow,
    // alignment. Applied whatever the widget draws inside.
    applyWidgetFormat(box, widget.config);

    const body = renderWidget(widget.type, model, widget.config, mediaBase);
    if (body === undefined) {
      // A box the household placed but that has no data yet says so, rather
      // than being an empty rectangle nobody can explain from the kitchen.
      box.appendChild(el('div', 'fw-empty', 'Nothing to show yet.'));
    } else if (widget.type === 'clock' || widget.type === 'image') {
      // The clock sizes itself to its box, and the image covers it — both fill
      // the box on their own and would only be fought by the scale-to-fit.
      box.appendChild(body);
    } else if (widget.type === 'calendar' && calendarGridFills(widget.config)) {
      // The month and week grids fill their box: their rows/cells stretch to the
      // box height rather than keeping the rem-based natural height the stacked
      // layout gives the grid. Scale-to-fit sized the whole month grid to ~30%
      // of the wall (the height the design chose for it as one block among
      // several), then dropped it into an 88%-tall freeform box — leaving two
      // thirds of the box empty and the cells so small only a dot fit. Filling
      // the box means a large calendar is a large calendar, with room for
      // labelled event pills.
      box.classList.add('fw-fill');
      box.appendChild(contentWithTitle(body, widget.config));
      /*
       * Only the *comfortable* week gets the narrow-box fallback below.
       *
       * `MIN_WEEK_COLUMN_REM` is 5rem and it was measured against these
       * columns — the ones with gaps, cards and padding in them. The dense week
       * gives all three up precisely so it fits in less room, so its floor is a
       * different number and nobody has measured it. Applying this one to it
       * would substitute an agenda for a week that is still perfectly readable,
       * on the walls already hanging that store `skyweek`.
       */
      const shape = calendarView(widget.config);
      if (shape.view === 'week' && shape.density === 'comfortable') {
        weekBoxes.push({ box, widget });
      }
    } else {
      /*
       * Everything else reuses a section built for a full-width strip or grid,
       * sized against the whole wall — the weather, house and shift widgets, and
       * a calendar in list (agenda) mode, whose rows are rem-sized to the wall
       * and would otherwise draw at full size and clip in a small box (the very
       * bug that made a small "Upcoming" widget show one giant, half-cut row).
       * Rather than re-derive every font size for a box — which fights the
       * design and still guesses — the section is laid out at its box width and
       * scaled as one to fill the box, up or down, keeping the design's own
       * proportions. The scale is measured once it is on screen, at the foot of
       * this function.
       */
      const scale = el('div', 'fw-scale');
      // The title rides inside the scaled content, so it shrinks with the
      // section and the fit measurement already accounts for it.
      scale.appendChild(contentWithTitle(body, widget.config));
      box.appendChild(scale);
      toFit.push({ box, scale, min: minScaleFor(widget.type) });
      if (widget.type === 'calendar' && body.classList.contains('next')) {
        agendas.push({ section: body, box, scale });
      }
      if (widget.type === 'shift' || widget.type === 'weather') {
        ladderBoxes.push({ box, widget });
      }
    }
    canvas.appendChild(box);
  }

  // A canvas with nothing on it — a display started blank and not yet arranged,
  // or a stale pre-migration cache read by a newer bundle — says so rather than
  // being a blank rectangle nobody can explain from the kitchen (rule nine). It
  // is the whole-canvas twin of the per-widget "nothing to show yet" note.
  if (layout.widgets.length === 0) {
    canvas.appendChild(el('div', 'canvas-empty', 'Nothing on this wall yet.'));
  }

  screen.appendChild(canvas);

  const banners = renderBanners(model);
  if (banners !== undefined) {
    screen.classList.add('has-banners');
    screen.appendChild(banners);
  }

  root.textContent = '';
  root.appendChild(screen);

  // A flat-text month grid cuts its rows to the box, and has to do it before
  // the fits below: a calendar widget is one of the sections `fitToBox` scales,
  // and scaling it first would measure rows that are about to be hidden.
  trimCellRows(root);

  // Now that everything has a size, fit each reused section to its box.
  for (const { box, scale, min } of toFit) {
    fitAndTrimToDays(box, scale, min);
  }

  /*
   * A badge with no room for its whole ladder gives up its bottom rung.
   *
   * The wall has no fixed line heights to do this arithmetic against — a badge
   * is `rem`-sized against a canvas that is itself letterboxed into the frame —
   * so it is measured rather than predicted: fit, and if the section still
   * overflows at its floor, drop the last row and fit again. `fitToBox` clamps
   * at `minScaleFor('shift')` and clips below it, which is exactly the state
   * this replaces with something readable.
   *
   * The same shape as the week-columns fallback below, and the same rule: a
   * *drawing* decision, not a saved one. The ladder still says four rows, the
   * editor still shows four rows, and widening the box brings them straight
   * back. The head of the ladder always survives — a household who dragged a
   * box too small should see the thing they put first, clipped if it comes to
   * that, rather than an empty rectangle (rule nine).
   */
  for (const { box, widget } of ladderBoxes) {
    const shift = widget.type === 'shift';
    const view = shift ? shiftWidgetView(model.todayShifts, widget.config) : undefined;
    /*
     * The house widget is not in the drop loop's own list: its ladder is per
     * *reading* — each one resolves from its own `display_mode` — so there is
     * no single list here to take a rung off. It scales like everything else
     * and clips at the floor, which is what it has always done.
     */
    let ladder: readonly string[] = shift
      ? (view?.ladder ?? [])
      : weatherLadder(widget.config);
    const full = ladder.length;
    let scale = box.querySelector('.fw-scale');
    while (
      ladder.length > 1 &&
      scale instanceof HTMLElement &&
      fitToBox(box, scale, { min: minScaleFor(widget.type) })
    ) {
      ladder = ladder.slice(0, -1);
      let body: HTMLElement | undefined;
      if (shift && view !== undefined) {
        const rebuilt = el('div', view.entries.length > 1 ? 'fw-shift is-several' : 'fw-shift');
        // Down to one row where the ladder asked for more: a line, not a word.
        const line = ladder.length === 1 && full > 1;
        for (const entry of view.entries) {
          rebuilt.appendChild(
            line
              ? shiftLineBadge(entry, view, view.ladder)
              : shiftBadge(entry, view, ladder as readonly ShiftField[]),
          );
        }
        body = rebuilt;
      } else {
        body = renderWeather(model, widget.config, ladder as readonly WeatherField[]);
      }
      if (body === undefined) break;
      const next = el('div', 'fw-scale');
      next.appendChild(contentWithTitle(body, widget.config));
      box.textContent = '';
      box.appendChild(next);
      fitToBox(box, next, { min: minScaleFor(widget.type) });
      scale = next;
    }
  }

  /*
   * A week too narrow to read becomes the agenda instead.
   *
   * The household asked for "this week"; seven unreadable columns answer that
   * question with nothing, and the same events down a list answer it. This is
   * the one place the wall overrides a stored choice, so it is deliberately a
   * *drawing* decision and not a saved one — the setting still says Week
   * columns, the editor still shows Week columns, and widening the box brings
   * them straight back. Same shape as `orientation.ts`: a computed answer from
   * what is really on screen, not a media query and not a guess at authoring
   * time, because the same canvas is drawn on a tablet and a television.
   */
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  for (const { box, widget } of weekBoxes) {
    if (weekColumnsFit(box.clientWidth, rem)) continue;
    box.classList.remove('fw-fill');
    box.textContent = '';
    const agenda = renderCalendarWidget(model, { ...widgetConfig(widget.config), mode: 'list' });
    const scale = el('div', 'fw-scale');
    scale.appendChild(contentWithTitle(agenda, widget.config));
    box.appendChild(scale);
    // Trimmed to whole days like any other agenda: this one is here *because*
    // its box is narrow, which is exactly where the days do not all fit.
    fitAndTrimToDays(box, scale, minScaleFor('calendar'));
    agendas.push({ section: agenda, box, scale });
  }

  // Finally: any agenda with no room for a time column stacks it above the
  // title. Last, so the sections the fallback just produced are included and
  // are measured at the width they actually ended up.
  for (const { section, box, scale } of agendas) {
    if (agendaTimeFitsBeside(section.clientWidth, rem)) continue;
    section.classList.add('narrow');
    /*
     * And then fit again, because this is a layout change and not a restyling:
     * the time moves from beside the title to above it, so every event row
     * gains a line. The fit this section was given — and the days that were
     * trimmed to it — were measured against an arrangement that no longer
     * exists, which at the calendar's floor means a day sliced through rather
     * than a section that shrinks a little further.
     *
     * One pass, like the week fallback that feeds it: `agendaTimeFitsBeside`
     * is asked once, of the layout the household's box actually produced.
     */
    fitAndTrimToDays(box, scale, minScaleFor('calendar'));
  }
}

/**
 * Whether a calendar widget's view is a grid that should fill its box (month or
 * week columns, at either density) rather than an agenda list that scales to
 * fit. The month grid's cells and the week columns are built to reflow into
 * whatever space they get; the list's rows are fixed rem and want scaling like
 * the other strips.
 *
 * Through `calendarView` rather than off `mode`, so this and the dispatch
 * cannot disagree about what a stored value means — `mode !== 'list'` happened
 * to give the right answer for `skymonth`, and a second reading that is right
 * by luck is the shape of every bug in this file's history.
 */
function calendarGridFills(config: unknown): boolean {
  return calendarView(config).view !== 'list';
}

/* ------------------------------------------------------- SKY (dense) ---- */

/**
 * The dense styles: the same week and month, drawn to spend every pixel.
 *
 * They are a *density* choice rather than a different calendar — same cells,
 * same colours, same week start — so they read the household's settings
 * identically and differ only in what they give up: the gaps between cells, the
 * rounded cards, and the breathing room inside them. A wall bolted to a kitchen
 * has a fixed number of pixels and no scrollbar, so trading that space for two
 * more events a day is the whole point.
 *
 * Dividers are hairlines *between* cells rather than gaps around them, which is
 * what actually reclaims the room: a 0.35rem gap on a seven-column grid spends
 * six gaps of it on nothing, twice over in a six-row month.
 */
function skyCalendars(config: unknown): (sourceId: string) => boolean {
  const calendars = configStrings(widgetConfig(config)['calendars']);
  return (sourceId: string): boolean =>
    calendars.length === 0 || calendars.includes(sourceId);
}

function renderSkyWeek(model: DisplayModel, config: unknown): HTMLElement {
  const keep = skyCalendars(config);
  const week = model.horizon[0] ?? [];
  const section = el('section', 'sky skyweek');
  const grid = el('div', 'sk-grid');
  for (const cell of week) {
    const classes = ['sk-col'];
    if (cell.isToday) classes.push('is-today');
    if (cell.isPast) classes.push('dim');
    const col = el('div', classes.join(' '));

    const head = el('div', 'sk-head');
    head.appendChild(el('span', 'sk-wd', cell.weekday));
    head.appendChild(el('span', 'sk-num', cell.dayNumber));
    col.appendChild(head);

    const body = el('div', 'sk-body');
    // All-day first: they belong to the whole column, not to a time in it.
    const events = cell.events.filter((e) => keep(e.sourceId));
    for (const ev of [...events.filter((e) => e.allDay), ...events.filter((e) => !e.allDay)]) {
      const chip = el('div', ev.allDay ? 'sk-ev allday' : 'sk-ev');
      chip.style.setProperty('--pc', ev.color);
      // The time above the title rather than beside it: a seventh of a wall is
      // narrow, and side by side is what left the agenda breaking words.
      if (!ev.allDay) chip.appendChild(el('span', 'sk-ev-time', ev.time));
      chip.appendChild(el('span', 'sk-ev-title', ev.title));
      body.appendChild(chip);
    }
    col.appendChild(body);
    grid.appendChild(col);
  }
  section.appendChild(grid);
  return section;
}

function renderSkyMonth(model: DisplayModel, config: unknown): HTMLElement {
  const keep = skyCalendars(config);
  const showShifts = widgetConfig(config)['showShifts'] !== false;
  const section = el('section', 'sky skymonth');
  const grid = el('div', 'sk-mgrid');

  // The weekday headings come from the first week's own cells, the same way the
  // quiet month grid does it — so the household's week start has one source.
  for (const cell of model.horizon[0] ?? []) {
    grid.appendChild(el('div', 'sk-mhead', cell.weekday));
  }

  for (const week of model.horizon) {
    for (const [index, cell] of week.entries()) {
      const classes = ['sk-cell'];
      // The row's first cell owns no left hairline. Marked here rather than
      // matched with `nth-child(7n + 1)`, which only lines up while the heading
      // row is exactly seven cells — add a week-number column later and every
      // divider silently shifts by one.
      if (index === 0) classes.push('row-start');
      if (cell.isToday) classes.push('is-today');
      if (cell.isPast) classes.push('dim');
      if (!cell.inMonth) classes.push('outside');
      const node = el('div', classes.join(' '));
      if (showShifts) paintShift(node, cell.shiftToken, cell.shiftColor);
      node.appendChild(el('div', 'sk-mnum', cell.dayNumber));

      const events = cell.events.filter((e) => keep(e.sourceId));
      if (events.length > 0) {
        const list = el('div', 'sk-bars');
        for (const ev of events) {
          const bar = el('div', ev.allDay ? 'sk-bar allday' : 'sk-bar', ev.title);
          bar.style.setProperty('--pc', ev.color);
          list.appendChild(bar);
        }
        node.appendChild(list);
      }
      grid.appendChild(node);
    }
  }
  section.appendChild(grid);
  return section;
}

/**
 * The smallest scale a widget is allowed to shrink to before it clips at the
 * box edge instead (recommendation #3). A weather reading at a tenth of its size
 * is a smudge, not information; a note or a list can go a little smaller before
 * it stops being legible. Below the floor the box's `overflow: hidden` clips,
 * which degrades to "showing less" rather than "showing nothing readable".
 */
function minScaleFor(type: string): number {
  switch (type) {
    case 'weather':
    case 'homeassistant':
    case 'countdown':
    case 'shift':
      return 0.4;
    case 'notes':
    case 'todo':
      return 0.3;
    /*
     * A chore board holds its type far harder than a note does — see
     * `MIN_CHORE_SCALE`, which carries the measurement and the reason it is not
     * the 0.3 the note and the checklist use.
     */
    case 'chores':
      return MIN_CHORE_SCALE;
    /*
     * And the calendar holds its type as hard as the chore board does — see
     * `MIN_CALENDAR_SCALE`, which lands on the same number by its own
     * measurement. It used to fall through to the `default` below, which is how
     * the one thing the product exists to show came to be drawn at a quarter
     * size on a wall where nothing else was (RFC 009 1.3).
     */
    case 'calendar':
      return MIN_CALENDAR_SCALE;
    default:
      return 0.2;
  }
}

/**
 * Fit a reused section (weather, house, shift, notes, an agenda…) to fill its
 * widget box — up or down.
 *
 * The old version scaled *down only*, capped at 1: a compact strip in a large
 * box kept its wall-relative size, pinned to the top-left corner, and left the
 * rest of the box empty — "cramped, just in a bigger box". This fills instead.
 *
 * The trick to growing a width-filling section is that it must be laid out
 * *narrower* than the box first, or the width ratio pins the scale at 1. So:
 * measure at the box width; if there is room to grow, re-flow at a width chosen
 * so the section's aspect matches the box, then scale up to fill. Wrapping
 * content (a note, a list) gets taller as it narrows, so it grows only as far as
 * it can without spilling — which is the behaviour you want. Scaling is uniform,
 * so the design's proportions are never distorted; the section is then centred,
 * so slack on the unfilled axis sits evenly rather than pooling after it.
 *
 * `min` is a readable floor: below it the section clips at the box edge rather
 * than shrinking to an illegible size (rule nine — degrade, never smear).
 */
/**
 * Scale a section to its box, and say whether it still did not fit.
 *
 * The return value is what lets a caller do something better than clipping —
 * the shift ladder gives up its bottom rung and asks again. Everything else
 * ignores it, because clipping at the floor is the right answer when there is
 * nothing to give up.
 *
 * Idempotent: it re-measures from layout (`scrollWidth`/`scrollHeight`), which
 * a transform does not affect, so calling it twice on the same nodes is the
 * same as calling it once.
 */
export function fitToBox(
  box: HTMLElement,
  scale: HTMLElement,
  opts: { readonly min?: number; readonly max?: number } = {},
): boolean {
  const min = opts.min ?? 0.25;
  // A ceiling so a one-word note in a huge box grows to fill without becoming a
  // caricature of itself; well above any sane fill factor, so it rarely bites.
  const max = opts.max ?? 6;

  const style = getComputedStyle(box);
  const padL = parseFloat(style.paddingLeft);
  const padT = parseFloat(style.paddingTop);
  const availW = box.clientWidth - padL - parseFloat(style.paddingRight);
  const availH = box.clientHeight - padT - parseFloat(style.paddingBottom);
  if (availW <= 0 || availH <= 0) return false;

  // Baseline: lay the section out at the full box width and measure it.
  scale.style.width = `${availW}px`;
  let contentW = scale.scrollWidth;
  let contentH = scale.scrollHeight;
  if (contentH <= 0) return false;

  if (contentW <= availW && contentH <= availH) {
    // Room to grow: re-flow at an aspect-matched width and re-measure.
    const targetW = Math.max(1, Math.min(availW, (contentH * availW) / availH));
    scale.style.width = `${targetW}px`;
    contentW = scale.scrollWidth;
    contentH = scale.scrollHeight;
  }

  let factor = Math.min(availW / contentW, availH / contentH);
  factor = Math.max(min, Math.min(max, factor));

  // Centre the scaled section in the box's content area (`.fw-scale` is
  // absolutely positioned, so left/top override its 0/0 default). Clamped at 0
  // so content larger than the box (the floor clipping) stays in the corner and
  // clips its far edges rather than being pushed off the near ones.
  const scaledW = contentW * factor;
  const scaledH = contentH * factor;
  scale.style.left = `${padL + Math.max(0, (availW - scaledW) / 2)}px`;
  scale.style.top = `${padT + Math.max(0, (availH - scaledH) / 2)}px`;
  scale.style.transform = `scale(${factor})`;

  // Rounded by a pixel: a section one subpixel over its box is a rounding
  // artefact, not a badge that needs a row taken off it.
  return scaledW > availW + 1 || scaledH > availH + 1;
}

/**
 * The screen shown before the first manifest arrives, and when this screen is
 * not paired. Never a blank rectangle — rule nine.
 */
export function renderMessage(root: HTMLElement, heading: string, detail: string): void {
  const screen = el('div', 'screen screen-message');
  const panel = el('section', 'message');
  panel.appendChild(el('h1', undefined, heading));
  panel.appendChild(el('p', undefined, detail));
  screen.appendChild(panel);
  root.textContent = '';
  root.appendChild(screen);
}

/** What the code-entry form reports back after a submission. */
export interface PairingOutcome {
  readonly ok: boolean;
  readonly message?: string;
}

/**
 * The pairing screen, with a field to type the short code.
 *
 * This is the whole answer to "a wall television cannot scan a QR". The admin's
 * pairing page shows an eight-character code; the wall shows a box to type it
 * into, and `submit` is what posts it. On success the caller reloads, so the
 * normal boot path picks up the freshly set cookie — this function never has to
 * know what a paired wall looks like.
 *
 * Built to be driven from a television remote as much as a touchscreen: the
 * field takes focus immediately so the first key press lands in it, `Enter`
 * submits (a form with a submit button does that for free), and the code is
 * upper-cased as it is typed because the alphabet is.
 */
export function renderPairing(
  root: HTMLElement,
  submit: (code: string) => Promise<PairingOutcome>,
): void {
  const screen = el('div', 'screen screen-message');
  const panel = el('section', 'message pairing');
  panel.appendChild(el('h1', undefined, 'Pair this wall'));
  panel.appendChild(
    el(
      'p',
      undefined,
      'On another device, open Maverick Wall, add this wall under Walls, ' +
        'and type the pairing code it shows.',
    ),
  );

  const form = document.createElement('form');
  form.className = 'pair-form';

  const input = document.createElement('input');
  input.className = 'pair-input';
  input.type = 'text';
  // A code, not prose: no autocorrect, no capitalised-first-letter, no
  // dictionary. `characters` matches the alphabet the code is drawn from.
  input.autocapitalize = 'characters';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Pairing code');
  input.setAttribute('placeholder', 'ABCD-EFGH');
  // Eight characters plus the dash a person copies off the screen.
  input.maxLength = 12;

  const button = el('button', 'pair-submit', 'Pair') as HTMLButtonElement;
  button.type = 'submit';

  const status = el('p', 'pair-status');

  form.appendChild(input);
  form.appendChild(button);
  panel.appendChild(form);
  panel.appendChild(status);
  screen.appendChild(panel);
  root.textContent = '';
  root.appendChild(screen);

  let busy = false;
  const onSubmit = async (): Promise<void> => {
    if (busy) return;
    const code = input.value.trim();
    if (code === '') {
      status.textContent = 'Type the code shown in the admin.';
      return;
    }
    busy = true;
    button.disabled = true;
    status.textContent = 'Pairing…';
    let outcome: PairingOutcome;
    try {
      outcome = await submit(code);
    } catch {
      outcome = { ok: false, message: 'Could not reach the server. Try again.' };
    }
    if (outcome.ok) {
      // Leave "Pairing…" up; the caller reloads and the wall replaces it.
      status.textContent = 'Paired. Loading your wall…';
      return;
    }
    status.textContent = outcome.message ?? 'That code is not right, or it has expired.';
    busy = false;
    button.disabled = false;
    input.focus();
    input.select();
  };

  form.addEventListener('submit', (event: Event) => {
    event.preventDefault();
    void onSubmit();
  });

  input.focus();
}
