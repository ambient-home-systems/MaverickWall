import type { DayModel, DisplayModel, EventModel, HorizonCell } from './viewmodel.js';

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
function paintShift(node: HTMLElement, token: string | undefined): void {
  if (token === undefined) return;
  node.style.setProperty('--sc', `var(${token}, var(--s-straight))`);
  node.style.setProperty('--sc-tint', `var(${token}-tint, var(--panel))`);
  node.classList.add('has-shift');
}

/* ---------------------------------------------------------------- NOW ---- */

function renderNow(model: DisplayModel): HTMLElement {
  const now = el('section', 'now');
  const top = el('div', 'now-top');

  const left = el('div');
  left.appendChild(el('div', 'clock', model.clock));
  left.appendChild(el('div', 'today-date', model.todayLabel));
  top.appendChild(left);

  /*
   * The badge, which the design calls the single most important element.
   *
   * Absent rather than empty when nobody is on a rota: a household with no
   * shift worker should see a calendar, not a hole where a feature would be.
   */
  const shift = model.todayShift;
  if (shift !== undefined) {
    const badge = el('div', 'shift-badge');
    paintShift(badge, shift.colorToken);
    /*
     * The picture, where the person already is.
     *
     * The design file predates avatars and says nothing about where one goes,
     * so this puts it beside the name in the badge rather than inventing a
     * place for it. Same-origin and behind the display token — rule three, and
     * the wall works with no internet.
     */
    const who = el('div', 'who');
    const avatar = shift.personAvatarUrl;
    if (avatar !== undefined && avatar !== null && avatar !== '') {
      const image = document.createElement('img');
      image.className = 'who-face';
      image.src = avatar;
      // Decorative: the name is right beside it, so a reader gains nothing
      // from hearing the filename.
      image.alt = '';
      who.appendChild(image);
    }
    who.appendChild(document.createTextNode(shift.personName));
    badge.appendChild(who);
    badge.appendChild(el('div', 'what', shift.label));
    if (model.shiftRun !== undefined) badge.appendChild(el('div', 'until', model.shiftRun));
    top.appendChild(badge);
  }

  now.appendChild(top);

  const events = el('div', 'today-events');
  if (model.today === undefined || model.today.events.length === 0) {
    events.appendChild(el('div', 'dr-empty', 'Nothing scheduled today.'));
  } else {
    for (const event of model.today.events) events.appendChild(renderTodayEvent(event));
    if (model.today.hiddenEventCount > 0) {
      events.appendChild(el('div', 'dr-empty', `+${model.today.hiddenEventCount} more`));
    }
  }
  now.appendChild(events);
  return now;
}

function renderTodayEvent(event: EventModel): HTMLElement {
  const classes = ['te'];
  if (event.isPast) classes.push('is-past');
  if (event.isNext) classes.push('is-next');
  const row = el('div', classes.join(' '));
  row.appendChild(el('div', 'te-time', event.allDay ? 'all day' : event.time));

  const title = el('div', 'te-title', event.title);
  if (event.location !== undefined && event.location !== '') {
    title.appendChild(el('span', 'te-where', event.location));
  }
  row.appendChild(title);
  return row;
}

/* ------------------------------------------------------------ WEATHER ---- */

/**
 * The forecast strip, in the design's own markup.
 *
 * The icon is a character rather than an image: the provider offers an icon
 * URL and rule three forbids the wall from fetching one, so the server maps
 * the forecast wording to a glyph the device already has.
 */
function renderWeather(model: DisplayModel): HTMLElement | undefined {
  if (model.weather.length === 0) return undefined;

  const strip = el('section', 'wx');
  for (const day of model.weather) {
    const cell = el('div', 'wx-day');
    cell.appendChild(el('div', 'wx-name', day.name));
    cell.appendChild(el('div', 'wx-ico', day.icon));
    const temp = el('div', 'wx-temp');
    temp.appendChild(document.createTextNode(`${day.high} `));
    temp.appendChild(el('span', 'lo', day.low));
    cell.appendChild(temp);
    strip.appendChild(cell);
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
function renderHouse(model: DisplayModel): HTMLElement | undefined {
  if (model.house.length === 0) return undefined;

  const strip = el('section', 'house');
  for (const reading of model.house) {
    const cell = el('div', `hs-item hs-${reading.mode}${reading.stale ? ' hs-stale' : ''}`);

    if (reading.mode === 'icon_state' || reading.mode === 'presence') {
      cell.appendChild(el('span', 'hs-ico', reading.icon));
    }
    if (reading.mode !== 'value') {
      cell.appendChild(el('span', 'hs-label', reading.label));
    }
    cell.appendChild(el('span', 'hs-value', reading.value));
    strip.appendChild(cell);
  }

  if (model.houseNote !== undefined) {
    strip.appendChild(el('div', 'hs-note', model.houseNote));
  }
  return strip;
}

/* --------------------------------------------------------------- NEXT ---- */

function renderNext(model: DisplayModel): HTMLElement {
  const next = el('section', 'next');
  next.appendChild(el('div', 'section-label', `Next ${model.next.length} days`));
  for (const day of model.next) next.appendChild(renderDayRow(day));
  return next;
}

function renderDayRow(day: DayModel): HTMLElement {
  const row = el('div', 'day-row');
  const shift = day.shifts[0];
  paintShift(row, shift?.colorToken);

  const when = el('div', 'dr-when');
  when.appendChild(el('div', 'dr-dow', day.weekday));
  when.appendChild(el('div', 'dr-num', day.dayNumber));
  if (shift !== undefined) when.appendChild(el('div', 'dr-shift', shift.label));
  row.appendChild(when);

  const events = el('div', 'dr-events');
  if (day.events.length === 0) {
    // A dash rather than nothing, so an empty day reads as "checked, nothing"
    // rather than as a row that failed to render.
    events.appendChild(el('div', 'dr-empty', '—'));
  } else {
    for (const event of day.events) {
      const entry = el('div', event.allDay ? 'dr-ev allday' : 'dr-ev');
      if (!event.allDay) entry.appendChild(el('div', 'dr-ev-time', event.time));
      entry.appendChild(el('div', 'dr-ev-title', event.title));
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

function renderCell(cell: HorizonCell): HTMLElement {
  const classes = ['hz-cell'];
  if (cell.isToday) classes.push('is-today');
  if (cell.isPast) classes.push('dim');
  if (!cell.inMonth) classes.push('outside');

  const node = el('div', classes.join(' '));
  paintShift(node, cell.shiftToken);
  node.appendChild(el('div', 'hz-num', cell.dayNumber));

  if (cell.eventCount > 0) {
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

function renderHorizon(model: DisplayModel): HTMLElement {
  const horizon = el('section', 'horizon');
  const grid = el('div', 'hz-grid');
  for (const name of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    grid.appendChild(el('div', 'hz-head', name));
  }
  for (const week of model.horizon) {
    for (const cell of week) grid.appendChild(renderCell(cell));
  }
  horizon.appendChild(grid);

  const legend = legendFor(model);
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

/* ------------------------------------------------------------- banners --- */

function renderBanners(model: DisplayModel): HTMLElement | undefined {
  /*
   * Interrupts lead, above the housekeeping notices.
   *
   * A stale feed and a water leak are both "things the wall wants to say", and
   * only one of them is worth reading first. They are already sorted by the
   * server; this only has to not bury them.
   */
  const messages: { level: string; message: string }[] = [
    ...model.interrupts.map((interrupt) => ({ level: 'alert', message: interrupt.message })),
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
    wrap.appendChild(el('div', `banner banner-${entry.level}`, entry.message));
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
export function render(root: HTMLElement, model: DisplayModel): void {
  /*
   * A takeover replaces the wall, and is drawn before anything else is built.
   *
   * The calendar is the product, so losing it is a real cost and the rule for
   * paying it has to be narrow: water on the floor, a garage open overnight.
   * A household chooses which of their rules is worth this, on the Home
   * Assistant screen, and everything else is a banner over a calendar that
   * still works.
   */
  const takeover = model.interrupts.filter((interrupt) => interrupt.takeover);
  if (takeover.length > 0) {
    const screen = el('div', 'screen screen-alert');
    const panel = el('section', 'alert');
    for (const interrupt of takeover) {
      panel.appendChild(el('p', 'alert-line', interrupt.message));
    }
    // The time stays. Somebody looking at a wall that has stopped being a
    // calendar still needs to know whether they are looking at something that
    // happened just now or at four in the morning.
    panel.appendChild(el('p', 'alert-clock', model.clock));
    screen.appendChild(panel);
    root.textContent = '';
    root.appendChild(screen);
    return;
  }

  const screen = el('div', 'screen');
  const banners = renderBanners(model);
  if (banners !== undefined) {
    /*
     * Stated as a class rather than left for CSS to infer.
     *
     * The landscape layout pins the month to the full height of the second
     * column, so an auto-placed banner has nowhere to go but underneath it —
     * the wall came out with the month above the notice and today's list
     * squeezed to nothing. Which row things start on depends on whether a
     * banner exists, and only the renderer knows that.
     */
    screen.classList.add('has-banners');
    screen.appendChild(banners);
  }
  /*
   * Drawn in the order the household asked for, and only the blocks they asked
   * for. DOM order is visual order in both layouts — portrait stacks these
   * directly, and landscape pins the month to its own column and lets the rest
   * fall in beside it — so there is one list to reason about rather than an
   * ordering rule per layout.
   */
  /*
   * Each block named, and nothing drawn for a name this bundle does not know.
   *
   * The trailing `else` this replaced drew the month for anything that was not
   * `now` or `next` — so the moment a fourth block existed, asking for weather
   * would have produced a second month grid.
   */
  for (const block of model.blocks) {
    if (block === 'now') {
      screen.appendChild(renderNow(model));
    } else if (block === 'weather') {
      // Absent rather than empty when no module contributed one: a strip of
      // dashes is worse than no strip.
      const strip = renderWeather(model);
      if (strip !== undefined) screen.appendChild(strip);
    } else if (block === 'home') {
      // Absent rather than empty, same as the forecast: a row of dashes where
      // a reading should be is worse than no row.
      const readings = renderHouse(model);
      if (readings !== undefined) screen.appendChild(readings);
    } else if (block === 'next') {
      screen.appendChild(renderNext(model));
    } else if (block === 'horizon') {
      screen.appendChild(renderHorizon(model));
    }
  }

  /*
   * How many rows the left column needs, stated for the stylesheet.
   *
   * Landscape pins the month to `grid-row: 1 / -1`, and `-1` only means the
   * end of the grid when the rows are explicit — so the template has to match
   * the number of blocks actually drawn. Hard-coding two rows was fine until a
   * third block existed, at which point the week ahead and the forecast were
   * drawn on top of each other.
   */
  const stacked = screen.querySelectorAll(':scope > *:not(.horizon)').length;
  screen.setAttribute('data-rows', String(Math.max(2, Math.min(5, stacked))));

  root.textContent = '';
  root.appendChild(screen);
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
