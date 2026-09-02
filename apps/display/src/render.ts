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
import { agendaTimeFitsBeside, weekColumnsFit } from './density.js';
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
import {
  TYPE_SPECIMEN,
  linesAt,
  listRowsAt,
  namesAt,
  promoted,
  spanIsLabelled,
  tierFor,
  tierNamed,
  weekdayHead,
  type CalendarTier,
} from './tiers.js';
import {
  WEATHER_COLUMN_CH,
  WIDGET_TIERS,
  columnsAt,
  itemsAt,
  laddersToOneLine,
  rungsAt,
  rungsByPriority,
  widgetTierFor,
  type WidgetTier,
} from './widget-tiers.js';

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
/**
 * Which parts of a reading survive a box too narrow for all of them.
 *
 * The value first, always: a reading whose value has been given up is a widget
 * saying "Front door" and not what the front door is doing. See `HOUSE_TIERS`,
 * which argues why this is the one ladder cut by role rather than by position.
 */
const HOUSE_FIELD_PRIORITY: readonly HouseField[] = ['value', 'label', 'icon'];

function renderHouse(
  model: DisplayModel,
  config?: unknown,
  tier?: WidgetTier,
): HTMLElement | undefined {
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
    const resolved = houseLadder(config, reading.mode);
    const rows = ladderRows(
      tier === undefined ? resolved : rungsByPriority(tier, resolved, HOUSE_FIELD_PRIORITY),
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
 * the ones the tier affords — see `applyMonthTier`. `pills` is kept because it
 * is a look a household can choose and because canvases have it stored; `dots`
 * is kept as the quiet option and is now stored explicitly, since absence means
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
     * The all-day colour at the cell's own edge — what M0 draws instead of a
     * row, and nothing at any other tier.
     *
     * A cell with no room for a name still has room for a colour, and whose day
     * it is is most of what a family wall is for: a birthday, a bin day, a half
     * term. Out of flow (the cell is `position: relative`), so it costs no row
     * anywhere and takes nothing off the density mark beside the numeral —
     * "nothing that annotates an event costs it a row", which this project has
     * paid for twice.
     */
    const banner = cell.events.find((ev) => ev.allDay);
    if (banner !== undefined) {
      const mark = el('div', 'hz-edge');
      mark.style.setProperty('--pc', banner.color);
      node.appendChild(mark);
    }
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
     * `spans.lanes` is in the condition and not only `steps`, and it is now a
     * belt rather than the load-bearing half it once was.
     *
     * The mark used to sit in the column between the numeral and the rows and
     * carry the lane reservation down it, so a cell crossed by a bar and
     * drawing no mark would have put its rows *under* the bar. The reservation
     * moved to `.hz-rows` when the mark moved onto the numeral's line, which is
     * where it costs nothing. What survives is the invariant it was written
     * for: a cell a bar crosses has that event on it, so `steps` is already
     * positive and this clause has nothing left to catch.
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
     * `applyMonthTier` picks the form after the wall has a size. That is the
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
        /*
         * The clock, for the one tier with a column to spare for it.
         *
         * Emitted always and shown only at M4, because whether it is drawn is a
         * fact about the *box* and the box has no size until the grid is on
         * screen — the same seam every other decision in this grid is taken at.
         * An all-day event has no time to draw, and "All day" is what the
         * colour rule down its edge already says.
         */
        if (!ev.allDay && ev.time !== '') row.appendChild(el('span', 'hz-rowtime', ev.time));
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
  for (const cell of headerWeek) {
    const head = el('div', 'hz-head', cell.weekday);
    /*
     * Both forms travel on the node, because how much of a weekday a column has
     * room for is a fact about the box and the box has no size yet. Cutting a
     * string the model supplied is also the only honest way a *pure* module can
     * answer it: a zone and a locale are the household's, and `Intl` is not
     * `tiers.ts`'s to reach for.
     */
    head.setAttribute('data-weekday', cell.weekday);
    head.setAttribute('data-weekday-long', cell.weekdayLong);
    grid.appendChild(head);
  }

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
/**
 * The events an agenda draws when the household has not said.
 *
 * Named because two readers want it now — the widget that draws the list and
 * the tier pass that decides how many of them the box affords — and one number
 * written twice is one number that can drift.
 */
const AGENDA_COUNT_DEFAULT = 12;

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
    typeof c['count'] === 'number' && c['count'] >= 1
      ? Math.min(50, Math.trunc(c['count']))
      : AGENDA_COUNT_DEFAULT;
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
/* ------------------------------------------------------ WIDGET TIERS ---- */

/**
 * One placed widget whose body takes a form from its box.
 *
 * `body` is replaced when a tier redraws it, so every pass after this one —
 * the belt, the editor's read-back — sees what is actually drawn.
 */
interface TieredWidget {
  readonly box: HTMLElement;
  readonly widget: ManifestWidget;
  body: HTMLElement;
}

/**
 * Which run each widget's tier is stated in, and where to plant a probe for it.
 *
 * The class is the widget's **primary text role** — argued for at each table in
 * `widget-tiers.ts` — and the selector is the node whose cascade that run
 * actually inherits. Two of them are descendant rules (`.shift-badge .what`),
 * so a probe planted on the box would measure the wrong size and the tier would
 * be read off a run nothing draws.
 */
const WIDGET_PRIMARY: Readonly<Record<string, { readonly cls: string; readonly host: string }>> = {
  weather: { cls: 'wx-temp', host: '.wx-day' },
  shift: { cls: 'what', host: '.shift-badge' },
  homeassistant: { cls: 'hs-value', host: '.hs-item' },
  notes: { cls: 'nt-line', host: '.nt' },
  todo: { cls: 'td-text', host: '.td' },
  chores: { cls: 'ch-name', host: '.ch, .ch-people' },
};

/**
 * Draw each placed widget at the form its own box affords.
 *
 * **The replacement for `fitToBox`, and the question is the other way round.**
 * That laid a section out at one size and wrote a uniform `transform: scale()`
 * on it, which is photographic enlargement: it changed how big a widget looked
 * and could never change what it said. Measured on the shipped Classic wall,
 * the forecast drew five days and the rota badge three rows at every size from
 * a 450x800 e-ink panel to a 3.7-megapixel television. This asks the box first.
 *
 * Three things are decided here and they are deliberately separate:
 *
 *  - **The tier**, from the box's inner size in `ch` and `em` of the widget's
 *    own primary role (`widget-tiers.ts`). A pure table, no DOM in it.
 *  - **The form**, which is the tier's rung count applied to the household's
 *    own ladder — never a rung the household did not ask for, and never fewer
 *    than one. Where that lands on one rung out of several, a badge draws a
 *    *line* rather than a word, which is the ladder's own rule kept word for
 *    word.
 *  - **How many**, which is the tier's number as a floor and the box's measured
 *    capacity above it. Measured off the drawn item, because what an item costs
 *    is a fact about markup that changes whenever a row does.
 *
 * And then one geometric belt, which is not a fourth decision but the promise
 * the other three cannot make: **whatever the arithmetic said, nothing may end
 * past the foot of its box.** `overflow: hidden` cuts where the pixel falls,
 * and a row sliced through the middle reads as a broken renderer rather than
 * as a list that ran out of room — the fault `density.ts` recorded for the
 * chore board and the month grid shipped once before that.
 *
 * A drawing decision, never a saved one. Nothing here writes to the model, so
 * widening a box brings the rows straight back on the next draw.
 */
function applyWidgetTiers(
  entries: readonly TieredWidget[],
  model: DisplayModel,
  mediaBase: string,
): void {
  for (const entry of entries) {
    const table = WIDGET_TIERS[entry.widget.type];
    const primary = WIDGET_PRIMARY[entry.widget.type];
    if (table === undefined || primary === undefined) {
      // Not one of the six. It still may not be cut through a row.
      beltGenericRows(entry);
      continue;
    }
    const host = entry.box.querySelector(primary.host);
    if (!(host instanceof HTMLElement)) continue;
    const inner = innerBox(entry.box);
    const { chPx, emPx } = typeMetrics(host, primary.cls);
    if (!(chPx > 0) || !(emPx > 0)) continue;

    switch (entry.widget.type) {
      case 'weather':
        tierWeather(entry, model, table, inner, chPx, emPx);
        break;
      case 'shift':
        tierShift(entry, model, table, inner, chPx, emPx);
        break;
      case 'homeassistant':
        tierHouse(entry, model, table, inner, chPx, emPx);
        break;
      default:
        tierList(entry, table, inner, chPx, emPx);
        break;
    }
  }
  // The title, if the household asked for one, is not a widget row and is never
  // what a belt gives up: it rides above the body and is the last thing to go,
  // which is `contentWithTitle`'s own placement rather than a rule here.
  void mediaBase;
}

/** Stamp the tier a box resolved to, so the editor can read it back. */
function stampTier(box: HTMLElement, tier: WidgetTier, items: number): void {
  box.setAttribute('data-tier', tier.tier);
  box.setAttribute('data-tier-items', String(items));
}

/**
 * The forecast: how many days across, and how much each day says.
 *
 * **Width buys days and height buys rungs**, which is the shape of a strip and
 * is why `WEATHER_COLUMN_CH` is one constant rather than a `minCh` per rung —
 * conflating them would let a wide short box draw one enormous day. The tier is
 * then read off *one column*, because that is the box a day is drawn in.
 *
 * Rebuilt rather than hidden, and that is not a preference: the high and the
 * low share a row while they are adjacent, so the DOM has fewer rows than the
 * ladder has entries and "hide the last two children" is not the same cut as
 * "keep the first two rungs". `renderWeather` already takes a ladder, and
 * `weatherWidgetView` already reads `count`, so the cut is expressed where both
 * rules already live.
 */
function tierWeather(
  entry: TieredWidget,
  model: DisplayModel,
  table: readonly WidgetTier[],
  inner: { readonly w: number; readonly h: number },
  chPx: number,
  emPx: number,
): void {
  const config = widgetConfig(entry.widget.config);
  const drawn = entry.body.querySelectorAll('.wx-day').length;
  if (drawn === 0) return;
  const columns = Math.min(drawn, columnsAt(inner.w, chPx, WEATHER_COLUMN_CH));
  const tier = widgetTierFor(table, inner.w / columns, inner.h, chPx, emPx);
  const full = weatherLadder(config);
  const ladder = rungsAt(tier, full);
  stampTier(entry.box, tier, columns);

  if (columns !== drawn || ladder.length !== full.length) {
    const rebuilt = renderWeather(model, { ...config, count: columns }, ladder as readonly WeatherField[]);
    if (rebuilt !== undefined) replaceBody(entry, rebuilt);
  }
  entry.body.style.setProperty('--wx-days', String(columns));
  /*
   * The belt goes on the rows **inside** each column and never on the columns.
   *
   * A strip is one row of boxes with identical tops and identical bottoms, so
   * "hide every item that ends past the foot" would hide the whole forecast the
   * moment any of it overflowed — measured, and it is how the first version of
   * this pass drew a five-day strip as one day. The vertical unit here is a
   * rung, and every column has the same rungs at the same heights, so cutting
   * each column independently cuts all of them in the same place.
   */
  for (const column of [...entry.body.querySelectorAll('.wx-day')] as HTMLElement[]) {
    beltItems(entry.box, [...column.children] as HTMLElement[]);
  }
}

/**
 * The rota badge: how much one badge says, and how many of them there are.
 *
 * At one rung out of several the badge is a **line** rather than a word — the
 * ladder's rule, and the reason `laddersToOneLine` is a predicate in the table
 * rather than an `if` in here: two renderers holding one rule is this project's
 * most repeated bug.
 */
function tierShift(
  entry: TieredWidget,
  model: DisplayModel,
  table: readonly WidgetTier[],
  inner: { readonly w: number; readonly h: number },
  chPx: number,
  emPx: number,
): void {
  const view = shiftWidgetView(model.todayShifts, entry.widget.config);
  if (view.entries.length === 0) return;
  const tier = widgetTierFor(table, inner.w, inner.h, chPx, emPx);
  const ladder = rungsAt(tier, view.ladder);
  const line = laddersToOneLine(tier, view.ladder.length);
  stampTier(entry.box, tier, view.entries.length);
  if (ladder.length === view.ladder.length && !line) {
    beltShift(entry);
    return;
  }
  const rebuilt = el('div', view.entries.length > 1 ? 'fw-shift is-several' : 'fw-shift');
  for (const person of view.entries) {
    rebuilt.appendChild(
      line
        ? shiftLineBadge(person, view, view.ladder)
        : shiftBadge(person, view, ladder as readonly ShiftField[]),
    );
  }
  replaceBody(entry, rebuilt);
  beltShift(entry);
}

/**
 * The badges, and then the rows inside the last one still standing.
 *
 * Two units, because a rota with two people on it is a stack of cards and each
 * card is a stack of rows: a card half-drawn and a row half-drawn are both the
 * sliced-through-a-row fault, one nesting apart.
 */
function beltShift(entry: TieredWidget): void {
  const badges = [...entry.box.querySelectorAll('.shift-badge')] as HTMLElement[];
  beltItems(entry.box, badges);
  for (const badge of badges) {
    if (badge.style.display === 'none') continue;
    beltItems(entry.box, [...badge.children] as HTMLElement[]);
  }
}

/**
 * The house: how much one reading says, and how many of them fit.
 *
 * The rungs come off by **role** here rather than by position — see
 * `HOUSE_TIERS`, which argues it: a reading is one row read left to right and
 * its ladder puts the value last, so taking the last entry would leave a widget
 * saying "Front door" and not what the front door is doing.
 */
function tierHouse(
  entry: TieredWidget,
  model: DisplayModel,
  table: readonly WidgetTier[],
  inner: { readonly w: number; readonly h: number },
  chPx: number,
  emPx: number,
): void {
  const tier = widgetTierFor(table, inner.w, inner.h, chPx, emPx);
  const readings = entry.box.querySelectorAll('.hs-item').length;
  stampTier(entry.box, tier, readings);
  if (tier.rungs < HOUSE_FIELD_PRIORITY.length) {
    const rebuilt = renderHouse(model, entry.widget.config, tier);
    if (rebuilt !== undefined) replaceBody(entry, rebuilt);
  }
  beltItems(entry.box, [...entry.body.querySelectorAll('.hs-item')] as HTMLElement[]);
}

/**
 * A list of one kind of thing: a note's lines, a checklist, a chore board.
 *
 * Hidden rather than rebuilt, which is the opposite call from the forecast and
 * for the opposite reason: these rows are homogeneous, so "the first N" is
 * exactly the cut the tier asks for, and leaving the rest in the document keeps
 * the geometry of what *is* drawn identical between two draws of the same box.
 * `measureWall` and `measureMonthGrid` both filter on computed `display`, which
 * is why hiding is a safe way to say "not drawn" in this codebase.
 *
 * **The chore week board's unit is a whole day**, which is this rule reading
 * the same table through a different selector rather than a second mechanism.
 * `density.ts` recorded what the board did without one: 28 rows shrunk to 8.1px
 * on a 1280px wall, and then, once a floor stopped that, a box clipping through
 * a row.
 */
function tierList(
  entry: TieredWidget,
  table: readonly WidgetTier[],
  inner: { readonly w: number; readonly h: number },
  chPx: number,
  emPx: number,
): void {
  const tier = widgetTierFor(table, inner.w, inner.h, chPx, emPx);
  const groups = listGroups(entry.body);
  let total = 0;
  for (const group of groups) {
    const capacity = boxCapacity(inner.h, group.items);
    const many = itemsAt(tier, capacity);
    for (let index = 0; index < group.items.length; index++) {
      (group.items[index] as HTMLElement).style.display = index < many ? '' : 'none';
    }
    total = Math.max(total, Math.min(many, group.items.length));
  }
  stampTier(entry.box, tier, total);
  for (const group of groups) beltItems(entry.box, group.items);
}

/**
 * The rows a list widget draws, grouped by the box each of them stacks in.
 *
 * One group for the ordinary lists, and one **per column** for the by-person
 * chore board — a column is its own stack, so a board of a busy column and a
 * quiet one must not be told it has room for two rows because the quiet one
 * does. The chore week board is a stack of *days*, which is why `.ch-day` is
 * matched ahead of `.ch-row`.
 */
function listGroups(body: HTMLElement): readonly { readonly items: HTMLElement[] }[] {
  const columns = [...body.querySelectorAll('.ch-col')] as HTMLElement[];
  if (columns.length > 0) {
    return columns.map((column) => ({
      items: [...column.querySelectorAll('.ch-row')] as HTMLElement[],
    }));
  }
  for (const selector of ['.ch-day', '.ch-row', '.td-row', '.nt-line, .nt-gap']) {
    const found = [...body.querySelectorAll(selector)] as HTMLElement[];
    if (found.length > 0) return [{ items: found }];
  }
  return [];
}

/**
 * How many of these items a box of this height holds, from the drawn item.
 *
 * Measured rather than divided out of a declared row height, for the reason
 * `agendaEventsAt` already had to learn: what a row costs is a fact about
 * markup, and this project has moved it twice in one widget without touching a
 * font size. The first item is the specimen, and its offset inside the stack is
 * what carries the gap — so the arithmetic cannot be short by a `row-gap`,
 * which is one of the three faults `trimCellRows` shipped.
 *
 * `Infinity` where there is nothing to measure, which `itemsAt` reads as "the
 * tier's own number" — the honest answer for a box nothing has been drawn in.
 */
function boxCapacity(innerH: number, items: readonly HTMLElement[]): number {
  const first = items[0];
  if (first === undefined) return Number.POSITIVE_INFINITY;
  const second = items[1];
  const pitch =
    second === undefined
      ? first.offsetHeight
      : Math.max(first.offsetHeight, second.offsetTop - first.offsetTop);
  if (!(pitch > 0)) return Number.POSITIVE_INFINITY;
  return Math.floor((innerH - first.offsetTop) / pitch);
}

/**
 * The belt: nothing may end past the foot of the box.
 *
 * One read and no rounds, the same shape as the month cell's: hiding an item
 * moves only the items under it, and those are going too. Read against the
 * **box**, which is the element that clips — `fitAndTrimToDays` measured the
 * scaled content instead and so never trimmed anything at all, which is
 * exactly how that kind of mistake survives.
 *
 * Half a pixel of slack, never a whole one: a row one subpixel over its box is
 * a rounding artefact rather than a row that has to go.
 */
function beltItems(box: HTMLElement, items: readonly HTMLElement[]): void {
  if (items.length === 0) return;
  const foot = box.getBoundingClientRect().bottom - parseFloat(getComputedStyle(box).paddingBottom || '0');
  let cutting = false;
  for (let index = 0; index < items.length; index++) {
    const item = items[index] as HTMLElement;
    if (item.style.display === 'none') continue;
    if (!cutting && item.getBoundingClientRect().bottom <= foot + 0.5) continue;
    // The first item always survives, clipped if it comes to that: a widget
    // that resolves to nothing is the one outcome rule nine forbids.
    if (index === 0) continue;
    cutting = true;
    item.style.display = 'none';
  }
}

/**
 * The belt alone, for the placed widgets with no table of their own.
 *
 * A countdown is one reading and there is nothing in it to give up — it sizes
 * itself to its box the way the clock does, in `display.css`, which is the
 * right mechanism for a widget whose whole content is one number. A module's
 * panel is a list, but the rows are the *module's* and how many of them are
 * worth drawing is the household's `count`; giving it a table of ours would be
 * this renderer having an opinion about somebody else's data. Both still get
 * the promise every widget gets: cut between rows, never through one.
 *
 * A calendar in agenda mode comes through here too and finds nothing to belt,
 * which is correct rather than an oversight: its own unit is a *day*, and
 * `beltDays` is what holds it, after its tier has chosen how many events there
 * are to hold.
 */
function beltGenericRows(entry: TieredWidget): void {
  beltItems(entry.box, [...entry.box.querySelectorAll('.gp-reading')] as HTMLElement[]);
}

/** Swap a widget's drawn body, keeping its title wrapper if it has one. */
function replaceBody(entry: TieredWidget, rebuilt: HTMLElement): void {
  entry.body.replaceWith(rebuilt);
  entry.body = rebuilt;
}

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
 * A section's own type metrics, in the units the tier table is stated in.
 *
 * Both terms are read **untransformed** — `offsetWidth` and the cascade's
 * `font-size`, never a client rect — because the tier is two *ratios* and a
 * transform that scales the box scales the type with it. Measuring one through
 * a rect and the other through the cascade is how a month grid drawn inside the
 * editor's scaled preview would resolve to a different tier from the same grid
 * on the wall, which is the two-opinions fault this whole seam exists to stop.
 *
 * The probe is a specimen rather than a household's title: `TYPE_SPECIMEN` is
 * the same 43 characters on every wall, so what comes back is a property of the
 * face. It is planted inside a real node so it inherits the exact cascade the
 * run it stands for has — a font-size stated in `var(--t-wall-event, …)` cannot
 * be resolved anywhere else.
 */
function typeMetrics(host: HTMLElement, className: string): { readonly chPx: number; readonly emPx: number } {
  const probe = document.createElement('span');
  probe.className = className;
  probe.textContent = TYPE_SPECIMEN;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.display = 'inline-block';
  probe.style.whiteSpace = 'pre';
  probe.style.maxHeight = 'none';
  probe.style.overflow = 'visible';
  probe.style.left = '0';
  probe.style.top = '0';
  host.appendChild(probe);
  const emPx = parseFloat(getComputedStyle(probe).fontSize);
  const chPx = probe.offsetWidth / TYPE_SPECIMEN.length;
  probe.remove();
  return { chPx, emPx };
}

/**
 * The room left under a section inside its box, in the cascade's own units.
 *
 * `offsetTop` is measured from the box's own padding edge (`.fw` is
 * `position: absolute`, so it is the offset parent), which is what makes this
 * right in the presence of a widget title: a titled widget's section starts
 * lower and the title's height is already in the number rather than having to
 * be added back. `scrollHeight` is the content's own height whatever the box
 * clipped it to, so a section already overflowing answers a negative and the
 * caller can give something up.
 */
function spareBelow(box: HTMLElement, node: HTMLElement): number {
  const pad = parseFloat(getComputedStyle(box).paddingBottom || '0');
  return box.clientHeight - pad - node.offsetTop - node.scrollHeight;
}

/** A box's content area, padding taken off, in the cascade's own units. */
function innerBox(node: HTMLElement): { readonly w: number; readonly h: number } {
  const style = getComputedStyle(node);
  return {
    w: node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    h: node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
  };
}

/**
 * Draw each month grid at the tier its own cells afford.
 *
 * **This replaces `trimCellRows`, and the difference is the question asked.**
 * That function drew every event in every cell, measured the result, and hid
 * what spilled — so the grid could only ever subtract, and a widget with more
 * room drew the same thing less cut about. Its three recorded faults are all
 * shapes of the same thing: it subtracted `cell.offsetTop`, which is the cell's
 * position in the grid and has nothing to do with its inside; it summed row
 * heights and was short by the flex gap and the counter's margin; and it once
 * drew "+6" and none of the six events, with every measurement passing and
 * every counter truthful, because nothing it measured asked whether anything
 * was *shown*.
 *
 * None of the three can come back here. There is no vertical budget arithmetic
 * at all — the tier is read from the cell's own inner box and the table
 * (`tiers.ts`) — nothing is summed, and a counter exists only where a name
 * does, because it rides on the last row it counts for and there is no branch
 * that draws one without one. The third fault's assertion is carried over
 * whole: what a measurement of this grid has to check is that something is
 * *shown*, not that nothing spilled.
 *
 * What it *does* still measure is two things about the box and one about the
 * words, each read once and never in rounds:
 *
 *  - **A bar's lane.** A span bar is an absolutely placed grid item, so nothing
 *    clips it to its week and one given a row too short paints a coloured band
 *    across the next week's numbers. That is the one failure a month grid must
 *    never have, and it is a fact about the box.
 *  - **A row's foot.** The tier's row arithmetic is optimistic by design (the
 *    wrap allowance is a maximum, not a promise), so a cell whose titles all
 *    wrap can end a row past its own content box. Clipping *through* a row
 *    reads as a broken renderer rather than as a list that ran out — the
 *    month-grid fault this project has already shipped once. Rows are hidden
 *    from the first that ends past the foot, downwards, which needs no relayout
 *    at all: hiding a row moves only the rows under it, and those are going too.
 *  - **A title's own length**, once, through `titleFitsWhole`.
 *
 * A drawing decision, never a saved one. Nothing here writes to the model, so
 * widening the box brings the rows straight back on the next draw.
 *
 * Returns the tier each grid resolved to, in document order — the demotion half
 * of RFC's promotion rule: a month that names nothing hands its attention to
 * the agendas beside it, and the caller is what knows they exist.
 */
export function applyMonthTier(root: HTMLElement): readonly CalendarTier[] {
  const grids = root.querySelectorAll('.horizon-text .hz-grid, .horizon-swiss .hz-grid');
  const resolved: CalendarTier[] = [];
  for (let index = 0; index < grids.length; index++) {
    resolved.push(tierOneGrid(grids[index] as HTMLElement));
  }
  return resolved;
}

function tierOneGrid(grid: HTMLElement): CalendarTier {
  const cells: HTMLElement[] = [];
  const found = grid.querySelectorAll('.hz-cell');
  for (let index = 0; index < found.length; index++) cells.push(found[index] as HTMLElement);
  const first = cells[0];
  if (first === undefined) return tierNamed('M0');

  /*
   * One cell decides the grid, because a `1fr` grid draws seven identical
   * columns and the rows are the same height as each other. Asking each cell
   * separately would let two squares of the same size answer differently on a
   * sub-pixel rounding, which is a grid that looks broken rather than dense.
   */
  const inner = innerBox(first);
  const { chPx, emPx } = typeMetrics(first, 'hz-rowtext');
  const tier = tierFor(inner.w, inner.h, chPx, emPx);
  const names = namesAt(tier, inner.h, emPx);
  const lines = linesAt(tier, inner.h, emPx);

  /*
   * Stamped so the editor can say which tier a household's box landed on
   * without measuring the preview a second time — one decider, read back.
   * Never *read* by the renderer: this project has shipped a bug where the
   * class was right and the pixels were wrong.
   */
  const section = grid.parentElement;
  if (section !== null) {
    section.setAttribute('data-tier', tier.tier);
    section.setAttribute('data-tier-names', String(names));
  }
  grid.style.setProperty('--tier-lines', String(Math.max(1, lines)));

  // The weekday heads, cut to what the tier has room for.
  const heads = grid.querySelectorAll('.hz-head');
  for (let index = 0; index < heads.length; index++) {
    const head = heads[index] as HTMLElement;
    const short = head.getAttribute('data-weekday') ?? '';
    if (short === '') continue;
    head.textContent = weekdayHead(short, head.getAttribute('data-weekday-long') ?? '', tier.weekdayLetters);
  }

  const spanned = tierSpans(grid, tier, chPx);

  for (const cell of cells) {
    tierOneCell(cell, tier, names, lines, spanned.get(cell.getAttribute('data-cell') ?? '') ?? 0);
  }
  return tier;
}

/**
 * The bars: which are drawn, which carry words, and which do not fit.
 *
 * A bar's *label* is asked of the bar's own width rather than of the cell's
 * tier, and that is the one place this file departs from the table it is
 * written from — see `CALENDAR_TIERS`. A bar is `n` cells wide, so on a 7.5"
 * panel whose cells are 4.7ch a five-day half term is 26ch and names itself
 * perfectly well.
 */
function tierSpans(grid: HTMLElement, tier: CalendarTier, chPx: number): Map<string, number> {
  const spanned = new Map<string, number>();
  const bars = grid.querySelectorAll('.hz-span');
  const dropped: HTMLElement[] = [];
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index] as HTMLElement;
    bar.style.display = tier.spans ? '' : 'none';
    if (!tier.spans) continue;

    const label = bar.querySelector('.hz-spantext') as HTMLElement | null;
    if (label !== null) label.style.display = spanIsLabelled(innerBox(bar).w, chPx) ? '' : 'none';

    const cover = (bar.getAttribute('data-cover') ?? '').split(' ').filter((one) => one !== '');
    const under: HTMLElement[] = [];
    for (const key of cover) {
      const cell = grid.querySelector(`.hz-cell[data-cell="${key}"]`);
      if (cell instanceof HTMLElement) under.push(cell);
    }
    if (under.length === 0) continue;
    let floor = Number.POSITIVE_INFINITY;
    for (const cell of under) floor = Math.min(floor, cell.getBoundingClientRect().bottom);
    if (bar.getBoundingClientRect().bottom > floor + 0.5) {
      dropped.push(bar);
      continue;
    }
    for (const key of cover) spanned.set(key, (spanned.get(key) ?? 0) + 1);
  }
  for (const bar of dropped) bar.style.display = 'none';
  return spanned;
}

function tierOneCell(
  cell: HTMLElement,
  tier: CalendarTier,
  names: number,
  lines: number,
  spans: number,
): void {
  const edge = cell.querySelector('.hz-edge') as HTMLElement | null;
  if (edge !== null) edge.style.display = tier.allDay === 'edge' ? '' : 'none';

  const times = cell.querySelectorAll('.hz-rowtime');
  for (let index = 0; index < times.length; index++) {
    (times[index] as HTMLElement).style.display = tier.times ? '' : 'none';
  }

  const list = cell.querySelector('.hz-rows') as HTMLElement | null;
  const more = cell.querySelector('.hz-more') as HTMLElement | null;
  if (list === null || more === null) return;
  const rows: HTMLElement[] = [];
  for (let index = 0; index < list.children.length; index++) rows.push(list.children[index] as HTMLElement);

  // Back to a known state before anything is decided, so a redraw that lands on
  // a different tier is not reading the last one's leftovers.
  more.textContent = '';
  more.className = 'hz-more';
  if (more.parentElement !== cell) cell.appendChild(more);
  for (const row of rows) row.style.display = '';
  if (names <= 0) {
    for (const row of rows) row.style.display = 'none';
    return;
  }

  /*
   * Every row measured once, with all of them on screen, and then one decision.
   *
   * `lineCount` is what the words actually took at this cell's width, which is
   * the single question about the *content* that survives the tier: a title
   * needing more lines than the allowance is hidden and counted rather than
   * cut, because "Year 6…" is a different string from "Year 6 trip to the
   * Science Museum" and two events can share it, where "+1" is simply true.
   */
  const gap = parseFloat(getComputedStyle(list).rowGap);
  const budget = cell.clientHeight - parseFloat(getComputedStyle(cell).paddingBottom) - list.offsetTop;
  interface Candidate {
    readonly row: HTMLElement;
    readonly at: number;
    readonly lines: number;
    readonly height: number;
  }
  const candidates: Candidate[] = [];
  for (let at = 0; at < rows.length; at++) {
    const row = rows[at] as HTMLElement;
    const took = lineCount(row);
    if (took > lines) continue;
    candidates.push({ row, at, lines: took, height: row.offsetHeight });
  }

  /*
   * **A two-line title never costs a name**, which is the overflow counter's
   * own rule one line down and is the whole of why the order here is not the
   * document's.
   *
   * The wrap allowance is a maximum rather than a promise (the shift ladder's
   * rule, one widget along), and a cell that spends its whole budget on one
   * wrapped title has spent two names' worth of room on one name. Measured on
   * the shipped portrait wall, the 2nd draws "Swimming lesson" over two lines
   * and says nothing else, where the same box holds "Assembly", "Standup" and a
   * "+1". So the shortest rows are *chosen* first and then drawn back in the
   * model's own order — all-day first and then by start time, which
   * `buildManifest` decided and this does not re-decide.
   *
   * Arithmetic rather than rounds of hide-and-look, and the gap is read off the
   * list rather than assumed: summing row heights and forgetting the flex gap
   * is one of the three faults `trimCellRows` shipped, and it is the one that
   * cost today's cell 2px on two screen sizes out of three.
   */
  const order = candidates.slice().sort((a, b) => (a.lines - b.lines) || (a.at - b.at));
  const chosen: Candidate[] = [];
  let used = 0;
  for (const candidate of order) {
    if (chosen.length >= names) break;
    const next = used + (chosen.length === 0 ? 0 : gap) + candidate.height;
    if (next > budget + 0.5) continue;
    chosen.push(candidate);
    used = next;
  }
  chosen.sort((a, b) => a.at - b.at);

  const keep = chosen.map((candidate) => candidate.row);
  for (const row of rows) row.style.display = keep.indexOf(row) < 0 ? 'none' : '';

  /*
   * And the belt: whatever the arithmetic said, nothing may end past the foot
   * of the cell. `overflow: hidden` cuts where the pixel falls, and a row
   * sliced through the middle reads as a broken renderer rather than as a list
   * that ran out of room — the month grid's own recorded fault. One read, no
   * rounds: hiding a row moves only the rows under it, and those go with it.
   */
  const limit = cell.clientHeight - parseFloat(getComputedStyle(cell).paddingBottom);
  let shown = 0;
  for (const row of keep) {
    if (row.offsetTop + row.offsetHeight > limit + 0.5) break;
    shown += 1;
  }
  for (let index = shown; index < keep.length; index++) (keep[index] as HTMLElement).style.display = 'none';
  if (shown === 0) return;

  /*
   * The counter rides on the last name it is counting for, and never costs one.
   *
   * There is no experiment here and no rounds, because under a tier there is
   * nothing to experiment with: the row set is already decided, so dropping the
   * counter cannot buy a longer title the way it once could. If sharing the row
   * costs that row its words — the counter is `flex: 0 0 auto`, so the title
   * loses its width — the counter goes rather than the name. The density mark
   * beside the numeral has already said the day is busy.
   */
  const total = Number(cell.getAttribute('data-count') ?? String(shown));
  const hidden = total - shown - spans;
  if (hidden <= 0) return;
  const last = keep[shown - 1] as HTMLElement;
  more.className = 'hz-more in-row';
  more.textContent = `+${hidden}`;
  last.appendChild(more);
  if (lineCount(last) > lines || last.offsetTop + last.offsetHeight > limit + 0.5) {
    /*
     * Sharing cost that row its words, so the counter takes a line of its own —
     * out of room the names have already declined, never out of theirs. Where
     * there is none it says nothing at all: the mark beside the numeral has
     * already said the day is busy, and "+3" on its own is a number with no
     * subject, which is the fault this grid shipped once in the other
     * direction.
     */
    more.className = 'hz-more';
    cell.appendChild(more);
    if (more.offsetTop + more.offsetHeight > limit + 0.5) more.textContent = '';
  }
}

/**
 * How many lines this row's title actually took at the cell's own width.
 *
 * `scrollHeight` is the content's own height whatever the stylesheet clamped
 * the box to, so this reads the same with the wrap allowance in force or not.
 * Half a line of slack, never a whole one: a line either happened or it did
 * not, and a pixel of slack would make a 2.02-line title read as two.
 *
 * A word wider than the column on its own counts as one line more than it took,
 * which is what puts it out of every allowance: `overflow-wrap` breaks those
 * rather than letting them overhang, and this is the belt for the case where
 * it cannot.
 */
function lineCount(row: HTMLElement): number {
  const text = row.querySelector('.hz-rowtext') as HTMLElement | null;
  if (text === null) return 1;
  const style = getComputedStyle(text);
  const declared = parseFloat(style.lineHeight);
  const line =
    Number.isFinite(declared) && declared > 0 ? declared : parseFloat(style.fontSize) * 1.25;
  if (line <= 0) return 1;
  const took = Math.max(1, Math.round(text.scrollHeight / line));
  return text.scrollWidth > text.clientWidth + 1 ? took + 1 : took;
}


/**
 * The tier an agenda's box affords, and the events it draws at it.
 *
 * **The `factor` this used to carry is gone with the transform it read.** The
 * comment that stood here explained why the type had to be measured *after* a
 * fit: an agenda was laid out at its box width and then scaled by up to 1.89,
 * so asking how many rows fit against the declared type answered 23 for a box
 * that holds six. Nothing scales now, so the declared type *is* the drawn type
 * and there is no correction to apply — which is the same sentence
 * `browser-font-race` now makes about the fonts.
 *
 * `count` is the household's own cap and still binds where they have set one:
 * the tier says what the box affords and the household says what they asked
 * for, and the drawn number is the lesser.
 */
function agendaEventsAt(
  box: HTMLElement,
  section: HTMLElement,
  promote: number,
): { readonly tier: CalendarTier; readonly rows: number } {
  const inner = innerBox(box);
  const { chPx, emPx } = typeMetrics(section, 'dr-ev-title');
  const drawnEm = emPx;
  const tier = promoted(tierFor(inner.w, inner.h, chPx, drawnEm), promote);

  /*
   * How tall one entry actually is, which a month cell's arithmetic cannot
   * answer for a list.
   *
   * `ROW_EM` in `tiers.ts` is a row of a month cell: one line of the event's own
   * type and the gap under it. An agenda entry is not that — it carries a time,
   * a title, sometimes a "Day 2 of 3", and it sits inside a day group with a
   * date column beside it. Measured on the shipped portrait wall, an entry is
   * 2.6 title-ems, so the cell's constant answers nine for a box that holds six
   * and the section would be drawn smaller to fit rows it was told would fit.
   *
   * So the tier is what the box *affords* and this is what an entry *costs*,
   * and the count is the lesser. Measured rather than declared, because the
   * cost is a fact about markup that changes when a row does — which the
   * current-time rule and the progress bar have both already done once.
   */
  const entry = section.querySelector('.dr-ev') as HTMLElement | null;
  const entryPx = entry === null ? 0 : entry.offsetHeight;
  const drawn = section.querySelectorAll('.dr-ev').length;
  /*
   * Counted from what is on the glass rather than from a division, and that
   * correction is worth the two extra reads.
   *
   * `inner.h / entryPx` answers five for a box drawing six: an agenda is not a
   * stack of entries, it is a stack of *days*, each a date column beside its
   * events, under a section label — so the arithmetic is short by everything
   * that is not an entry and rounds the wrong way. What is already drawn is
   * known to fit; what the leftover holds is the only open question.
   *
   * Negative slack is the other half and is what makes this both a floor and a
   * ceiling. A section is drawn at its role's size and clipped by its box, so
   * an agenda too tall for its box is genuinely being cut and the honest answer
   * is fewer events — the design rule *give up content, not points*, which is
   * what the day trim used to say and what the scale floor under it used to
   * contradict. The old reading had to ask the fit whether it had clipped,
   * because above the floor a scale-to-fit section filled its box to the pixel
   * and the slack was zero by construction; there is no fit to ask now, so the
   * measurement is the measurement.
   */
  const spare = spareBelow(box, section);
  // Truncated toward zero, which is the difference between "this box is one
  // entry too small" and "this box is a few pixels too small". An overflow
  // under one entry costs more to fix than it costs to leave: dropping an event
  // to recover 30px of a 64px row buys type nobody asked for at a price this
  // project has already refused once, on this exact panel.
  const holds = entryPx > 0 ? drawn + Math.trunc(spare / entryPx) : Number.POSITIVE_INFINITY;
  /*
   * The **larger** of the two, and it is an upper bound rather than an answer.
   *
   * Neither estimate can be trusted on its own and they fail in opposite
   * directions. `listRowsAt` divides the box by a row of the month cell's own
   * arithmetic, which knows nothing about a date column. `holds` charges one
   * entry for the next event, which is right when it lands in a day already
   * drawn and wrong by a whole date column when it opens a new one — measured
   * on the 1080x1920 Classic seed, six events fit and seven do not, and the
   * marginal cost of the seventh is 177px against the 45px this charges. So a
   * first draft that took the *lesser* of the two and stopped oscillated
   * between six, seven and eight across its rounds and landed wherever it ran
   * out of them.
   *
   * The caller draws this and then steps down until the last day actually fits,
   * which is the only reading that cannot be wrong: an over-estimate costs a
   * redraw and an under-estimate costs the household an event they had room
   * for.
   */
  return { tier, rows: Math.max(1, Math.min(AGENDA_MAX_EVENTS, Math.max(listRowsAt(tier, inner.h, drawnEm), holds))) };
}

/**
 * The most events an agenda will ever be asked to draw.
 *
 * The same 50 the household's own `count` is clamped to, so the box cannot ask
 * for more than a person could — and, more usefully, so the step-down below is
 * bounded by a number rather than by whatever a measurement of a detached node
 * happens to produce.
 */
const AGENDA_MAX_EVENTS = 50;

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

  // Widgets whose body is a section from the responsive layout. Each takes a
  // *form* from its box once it is on screen (`applyWidgetTiers`) rather than
  // being laid out at one size and scaled into place, which is what made a
  // 3.7-megapixel television draw the same five days as a 7.5" panel.
  const tiered: TieredWidget[] = [];

  // Week-column calendars, to be re-checked once they have a real width. Seven
  // columns cannot reflow: unlike every other section they do not get narrower
  // type, they get narrower columns, so a small box produces seven slivers with
  // a letter in each. Measured after layout, because a box's width is a
  // percentage of a canvas that is itself letterboxed into the frame.
  const weekBoxes: { readonly box: HTMLElement; readonly widget: ManifestWidget }[] = [];

  // Agenda sections, to be re-checked for whether they kept room for a time
  // column, and then redrawn at the number of events their box affords.
  // Includes the ones the week fallback below produces.
  const agendas: {
    /** Replaced when the tier redraws it, so the passes below see what is drawn. */
    section: HTMLElement;
    readonly box: HTMLElement;
    /** The widget's own config, which carries the household's `count` cap. */
    readonly widget: ManifestWidget;
  }[] = [];

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
      // the box on their own, in CSS, with no measurement here at all.
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
       * and it is drawn **in** the box rather than scaled into it.
       *
       * It used to be wrapped in an absolutely positioned `.fw-scale`, laid out
       * at the box width and given a uniform `transform: scale()`. That kept the
       * design's proportions and could never change what the widget said: a
       * transform multiplies straight through a font size, so a forecast in a
       * box twice the area was the same five days drawn larger. The type is its
       * role now — the reader's own angle where the household has measured the
       * wall, the canvas-relative rem where they have not — and the *form* comes
       * from the box, at the foot of this function.
       */
      box.appendChild(contentWithTitle(body, widget.config));
      tiered.push({ box, widget, body });
      if (widget.type === 'calendar' && body.classList.contains('next')) {
        agendas.push({ section: body, box, widget });
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

  /*
   * Every month grid is drawn at the tier its own cells afford, first: a grid
   * fills its box, so its cells only have a size once the canvas does, and
   * every pass below measures a widget beside it.
   */
  const monthTiers = applyMonthTier(root);

  /*
   * And every other placed widget takes the form *its* box affords.
   *
   * This is where `fitToBox` used to run. It is deliberately before the two
   * passes below rather than after: both of them change a widget's *layout*
   * (an agenda replacing a week, a time column moving above its title), and a
   * form chosen against a layout that no longer exists is the fault the old
   * re-fit-after-narrow existed to paper over.
   */
  applyWidgetTiers(tiered, model, mediaBase);

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
    box.appendChild(contentWithTitle(agenda, widget.config));
    agendas.push({ section: agenda, box, widget });
  }

  /*
   * Then any agenda with no room for a time column stacks it above the title.
   *
   * Before the tier below rather than after, which is the opposite order from
   * the one this pass used to run in and is the whole reason the old code had
   * to fit a second time here. Moving the time is a *layout* change — every
   * event row gains a line — so an event count chosen against the wide
   * arrangement is a count for a section that no longer exists. Ask the
   * question first, then count what the answer costs.
   */
  for (const { section } of agendas) {
    if (agendaTimeFitsBeside(section.clientWidth, rem)) continue;
    section.classList.add('narrow');
  }

  /*
   * And every agenda is redrawn at the number of events *its* box affords —
   * which is where a month grid that can name nothing pays for itself.
   *
   * **This is the one place the renderer has an opinion about the household's
   * arrangement**, and it is a drawing decision and nothing else. A month at M0
   * says the words it holds cannot be read at that size, and on a 7.5" panel
   * that is the whole grid; the attention has to go somewhere, so every agenda
   * on the same canvas is promoted a rung and shows more of what the month
   * cannot. Nothing is written back to the canvas, so widening the month brings
   * its own names back and takes the promotion away on the very next draw —
   * the rule the week-columns fallback keeps too.
   *
   * Last, so the sections the week fallback produced are included and every one
   * of them is measured at the arrangement it actually ended up with.
   */
  const promote = monthTiers.some((tier) => tier.names === 0) ? 1 : 0;
  for (const entry of agendas) retierAgenda(entry, model, promote);
}

/**
 * Redraw one agenda at the number of events its box affords.
 *
 * **The replacement for `fitAndTrimToDays`'s day trim, and the question is the
 * other way round.** That drew a section, scaled it, and then took whole days
 * off the bottom of what was already too big — so a wall could only ever end up
 * with less than the household asked for, and a bigger box bought a bigger
 * picture of the same six events. This asks the box first.
 *
 * The old version had a *fit before* and a *fit after* and a bounded loop
 * between them, all of which existed because the type on the glass depended on
 * how much was drawn: fewer events meant a shorter section meant a larger scale
 * factor, so the measurement moved every time the answer did. Measured then, a
 * 576x259 box answered "one event" on the first round and "five" on the second,
 * and a box of twice the area answered the same one. None of that is true of a
 * section drawn at its role's own size — the type is fixed, so one measurement
 * settles it and a second round could only ever repeat the first.
 *
 * What survives is the rest of the rule. A section that already draws what its
 * box affords is left alone. The household's `count` still binds where they
 * have set one. And the belt is geometric and last: whatever the arithmetic
 * said, no day may end past the foot of the box, because `overflow: hidden`
 * cuts where the pixel falls and a row sliced through the middle reads as a
 * broken renderer rather than as a list that ran out of room.
 */
function retierAgenda(
  entry: { section: HTMLElement; readonly box: HTMLElement; readonly widget: ManifestWidget },
  model: DisplayModel,
  promote: number,
): void {
  const { box, widget } = entry;
  const config = widgetConfig(widget.config);
  /*
   * The household's own cap, where they have set one — and **absence now means
   * "what the box affords" rather than twelve.**
   *
   * `AGENDA_COUNT_DEFAULT` was a legibility budget standing in for a box
   * measurement, exactly as Classic's own `count: 6` was, and it is the same
   * argument one layer along: a constant that says how many events are legible
   * can only ever be right on one screen. It stays as the cap on what the model
   * is asked for rather than on what the box may draw — `renderCalendarWidget`
   * still reads it for the first, pre-tier draw, which is the one that has no
   * measurement yet.
   */
  const asked =
    typeof config['count'] === 'number' && config['count'] >= 1
      ? Math.min(50, Math.trunc(config['count']))
      : Number.POSITIVE_INFINITY;

  /*
   * An upper bound, then a step down until the last day genuinely fits.
   *
   * The loop this replaces asked the same estimate over and over and stopped
   * when two rounds agreed. It could not converge, and the reason is the shape
   * of the thing rather than the arithmetic: **an agenda is a stack of days,
   * not a stack of events.** Each day carries a date column beside its events,
   * so the marginal event is nearly free when it lands in a day already drawn
   * and costs a whole column when it opens a new one — measured on the
   * 1080x1920 Classic seed, six events fit, seven do not, and the estimator
   * charged 45px for a seventh that costs 177. Round to round that produced
   * 6 → 8 → 7 → 6 → 8, and the answer was whichever round the loop happened
   * to end on.
   *
   * So the estimate is used for the only thing an estimate can be trusted with
   * — a bound — and the box is the referee. Monotone, terminating, and it lands
   * on the largest count whose last day is whole, which is the number this
   * widget has been trying to name since it was written.
   *
   * The overflow question is asked of the **last day-row against the box**, not
   * of the section's own scroll height: the Panels theme gives `.next` a card
   * inset, so its `scrollHeight` runs past its content by that padding and a
   * section with nothing sliced reads as ten pixels over. That is the same
   * measurement the belt below takes, deliberately — two opinions about "does
   * this fit" is how the old day trim came to measure the wrong element.
   */
  const afford = agendaEventsAt(box, entry.section, promote);
  box.setAttribute('data-tier', afford.tier.tier);
  redrawAgenda(entry, model, config, Math.min(asked, afford.rows));
  for (let step = 0; step < AGENDA_MAX_EVENTS; step++) {
    const drawn = drawnEventCount(entry.section);
    if (drawn <= 1 || !agendaOverflows(box, entry.section)) break;
    redrawAgenda(entry, model, config, drawn - 1);
  }
  beltDays(box, entry.section);
  box.setAttribute('data-tier-events', String(drawnEventCount(entry.section)));
}

/** Redraw one agenda at `count` events, keeping the narrow arrangement it had. */
function redrawAgenda(
  entry: { section: HTMLElement; readonly widget: ManifestWidget },
  model: DisplayModel,
  config: Record<string, unknown>,
  count: number,
): void {
  if (count === drawnEventCount(entry.section)) return;
  const rebuilt = renderCalendarWidget(model, { ...config, mode: 'list', count });
  if (entry.section.classList.contains('narrow')) rebuilt.classList.add('narrow');
  entry.section.replaceWith(rebuilt);
  entry.section = rebuilt;
}

/**
 * Whether the last day drawn ends past the foot of the box.
 *
 * The referee for the step-down above and the same question the belt asks, so
 * the two cannot disagree. Asked of a **day**, because that is the unit the
 * agenda gives up in.
 */
function agendaOverflows(box: HTMLElement, section: HTMLElement): boolean {
  const rows = [...section.querySelectorAll('.day-row')] as HTMLElement[];
  let last: HTMLElement | undefined;
  for (const row of rows) if (row.style.display !== 'none') last = row;
  if (last === undefined) return false;
  const foot = box.getBoundingClientRect().bottom - parseFloat(getComputedStyle(box).paddingBottom || '0');
  return last.getBoundingClientRect().bottom > foot + 0.5;
}

/**
 * The agenda's belt: cut on a day, and inside a day on an event, never through
 * one.
 *
 * Two units rather than one, and the second is what the old day trim could not
 * do. A day group is a date column *beside* its events, so hiding every event
 * in it does not make the row short enough to fit — the date is still there.
 * So: give up events from the bottom of the last day that overflows, and if the
 * row still ends past the foot, give up the row. Read fresh each time, because
 * hiding an event moves every row under it up and one of them may now fit.
 *
 * Hidden rather than removed, which `fitAndTrimToDays` had to learn the hard
 * way: `display.css` hides `.day-row:nth-child(n + 6)` on a short landscape
 * screen — a *positional* rule — so taking a row out of the document renumbers
 * the rest and hands the hidden ones back. Measured on a 1024x600 tablet then,
 * removing the two days that did not fit promoted the two the stylesheet had
 * hidden, which then did not fit either, and the trim had undone itself while
 * looking like it had worked.
 *
 * Today always survives, clipped if it comes to that: a household who dragged a
 * box too small should see the thing at the top of it rather than an empty
 * rectangle (rule nine).
 */
function beltDays(box: HTMLElement, section: HTMLElement): void {
  const rows = [...section.querySelectorAll('.day-row')] as HTMLElement[];
  if (rows.length === 0) return;
  const foot = box.getBoundingClientRect().bottom - parseFloat(getComputedStyle(box).paddingBottom || '0');
  for (let index = rows.length - 1; index >= 1; index--) {
    const row = rows[index] as HTMLElement;
    if (row.style.display === 'none') continue;
    if (row.getBoundingClientRect().bottom <= foot + 0.5) break;
    const events = [...row.querySelectorAll('.dr-ev')] as HTMLElement[];
    for (let at = events.length - 1; at >= 0; at--) {
      if (row.getBoundingClientRect().bottom <= foot + 0.5) break;
      (events[at] as HTMLElement).style.display = 'none';
    }
    if (row.getBoundingClientRect().bottom > foot + 0.5) row.style.display = 'none';
  }
}

/** How many event rows a drawn agenda is currently showing. */
function drawnEventCount(section: HTMLElement): number {
  let shown = 0;
  const events = section.querySelectorAll('.dr-ev');
  for (let index = 0; index < events.length; index++) {
    if ((events[index] as HTMLElement).style.display !== 'none') shown += 1;
  }
  return shown;
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
