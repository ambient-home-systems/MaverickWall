import type {
  DayModel,
  DisplayModel,
  EventModel,
  HorizonCell,
  InterruptModel,
} from './viewmodel.js';
import { localDate } from './viewmodel.js';
import type { PanelData } from './viewmodel.js';
import type { ManifestWidget, CanvasBackground } from './manifest.js';
import { shiftTint } from './theme.js';

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
  const badge = shiftBadge(model);
  if (badge !== undefined) top.appendChild(badge);

  now.appendChild(top);

  // The family, across the top of the calendar the way Skylight puts them —
  // it teaches which colour is whose before the eye reaches the agenda below.
  const strip = renderPeopleStrip(model);
  if (strip !== undefined) now.appendChild(strip);

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

/**
 * The shift badge, shared by the today block and the free-form shift widget.
 *
 * Absent when nobody is on a rota — the same statement in both places, so a
 * household with no shift worker never sees a hole where a feature would be.
 */
function shiftBadge(model: DisplayModel): HTMLElement | undefined {
  const shift = model.todayShift;
  if (shift === undefined) return undefined;

  const badge = el('div', 'shift-badge');
  paintShift(badge, shift.colorToken, shift.color);
  /*
   * The picture, where the person already is. Same-origin and behind the
   * display token — rule three, and the wall works with no internet.
   */
  const who = el('div', 'who');
  const avatar = shift.personAvatarUrl;
  if (avatar !== undefined && avatar !== null && avatar !== '') {
    const image = document.createElement('img');
    image.className = 'who-face';
    image.src = avatar;
    // Decorative: the name is right beside it, so a reader gains nothing from
    // hearing the filename.
    image.alt = '';
    who.appendChild(image);
  }
  who.appendChild(document.createTextNode(shift.personName));
  badge.appendChild(who);
  badge.appendChild(el('div', 'what', shift.label));
  const window = shiftWindow(shift);
  if (window !== undefined) badge.appendChild(el('div', 'shift-when', window));
  if (model.shiftRun !== undefined) badge.appendChild(el('div', 'until', model.shiftRun));
  return badge;
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

function renderTodayEvent(event: EventModel): HTMLElement {
  const classes = ['te'];
  if (event.isPast) classes.push('is-past');
  if (event.isNext) classes.push('is-next');
  const row = el('div', classes.join(' '));
  row.appendChild(el('div', 'te-time', event.allDay ? 'all day' : event.time));

  const title = el('div', 'te-title');
  title.appendChild(ownerMark(event, 'te-mark'));
  title.appendChild(document.createTextNode(event.title));
  if (event.location !== undefined && event.location !== '') {
    title.appendChild(el('span', 'te-where', event.location));
  }
  row.appendChild(title);
  return row;
}

/**
 * The legend that teaches the wall's colours: the household, each as a face or
 * a colour dot and their name. Absent when nobody is defined, so a wall with no
 * people reads exactly as it did before.
 */
function renderPeopleStrip(model: DisplayModel): HTMLElement | undefined {
  if (model.people.length === 0) return undefined;
  const strip = el('div', 'people-strip');
  for (const person of model.people) {
    const chip = el('div', 'person-chip');
    if (person.avatarUrl !== undefined && person.avatarUrl !== '') {
      const image = document.createElement('img');
      image.className = 'pc-face';
      image.src = person.avatarUrl;
      image.alt = '';
      chip.appendChild(image);
    } else {
      const dot = el('span', 'pc-dot');
      dot.style.setProperty('--pc', person.color);
      chip.appendChild(dot);
    }
    chip.appendChild(el('span', 'pc-name', person.name));
    strip.appendChild(chip);
  }
  return strip;
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
  paintShift(row, shift?.colorToken, shift?.color);

  const when = el('div', 'dr-when');
  when.appendChild(el('div', 'dr-dow', day.weekday));
  when.appendChild(el('div', 'dr-num', day.dayNumber));
  if (shift !== undefined) {
    when.appendChild(el('div', 'dr-shift', shift.label));
    const window = shiftWindow(shift);
    if (window !== undefined) when.appendChild(el('div', 'dr-when', window));
  }
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
      const title = el('div', 'dr-ev-title');
      title.appendChild(ownerMark(event, 'dr-ev-mark'));
      title.appendChild(document.createTextNode(event.title));
      entry.appendChild(title);
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

function renderCell(cell: HorizonCell, pills = false): HTMLElement {
  const classes = ['hz-cell'];
  if (cell.isToday) classes.push('is-today');
  if (cell.isPast) classes.push('dim');
  if (!cell.inMonth) classes.push('outside');

  const node = el('div', classes.join(' '));
  paintShift(node, cell.shiftToken, cell.shiftColor);
  node.appendChild(el('div', 'hz-num', cell.dayNumber));

  if (pills) {
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

function renderHorizon(model: DisplayModel, opts: { readonly pills?: boolean } = {}): HTMLElement {
  const pills = opts.pills === true;
  const horizon = el('section', pills ? 'horizon horizon-pills' : 'horizon');
  const grid = el('div', 'hz-grid');
  for (const name of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    grid.appendChild(el('div', 'hz-head', name));
  }
  for (const week of model.horizon) {
    for (const cell of week) grid.appendChild(renderCell(cell, pills));
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
function renderClockWidget(model: DisplayModel): HTMLElement {
  const box = el('div', 'fw-clock');
  box.appendChild(el('div', 'clock', model.clock));
  box.appendChild(el('div', 'today-date', model.todayLabel));
  return box;
}

/**
 * The shift, as a widget: the badge alone.
 *
 * Undefined on a day with no rota, exactly like weather and house on a day with
 * no data — so `renderFreeform` draws the one box-relative "nothing yet" note
 * for all three, rather than this one scaling a note that is already sized to
 * its box and ending up drawn twice as small.
 */
function renderShiftWidget(model: DisplayModel): HTMLElement | undefined {
  const badge = shiftBadge(model);
  if (badge === undefined) return undefined;
  const box = el('div', 'fw-shift');
  box.appendChild(badge);
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
      return renderClockWidget(model);
    case 'calendar':
      return renderCalendarWidget(model, config);
    case 'weather':
      return renderWeather(model);
    case 'homeassistant':
      return renderHouse(model, config);
    case 'shift':
      return renderShiftWidget(model);
    case 'countdown':
      return renderCountdownWidget(model, config);
    case 'external':
      return renderExternalWidget(model, config);
    case 'notes':
      return renderNotesWidget(config);
    case 'todo':
      return renderTodoWidget(config);
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
  return renderGenericPanel(panel);
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
  if (c['shadow'] === true) box.style.boxShadow = '0 6px 20px rgba(0, 0, 0, 0.35)';
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
 * The Calendar widget, in one of three modes.
 *
 * `month` (the default) is the same grid the responsive layout draws — with
 * quiet dots, or Skylight-style event `pills` when `cellEvents: 'pills'`. `week`
 * is the current Monday–Sunday week as vertical day columns. `list` is an agenda
 * of what is coming up, and the reason a widget has options at all: it can be
 * limited to some calendars (`calendars`, by source id — already in the
 * manifest, so filtering here leaks nothing) and to a number of events. A
 * calendar the household did not select is simply not counted.
 */
function renderCalendarWidget(model: DisplayModel, config: unknown): HTMLElement {
  const c = widgetConfig(config);
  const mode = c['mode'];
  if (mode === 'week') return renderWeekColumns(model, config);
  if (mode !== 'list') return renderHorizon(model, { pills: c['cellEvents'] === 'pills' });

  const calendars = configStrings(c['calendars']);
  const keep = (event: EventModel): boolean =>
    calendars.length === 0 || calendars.includes(event.sourceId);

  const limit =
    typeof c['count'] === 'number' && c['count'] >= 1 ? Math.min(50, Math.trunc(c['count'])) : 12;
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
    section.appendChild(renderDayRow({ ...day, events, hiddenEventCount: 0 }));
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
export function renderGenericPanel(data: PanelData): HTMLElement {
  const section = el('section', `gp gp-${data.kind}`);
  if (data.title !== undefined) section.appendChild(el('div', 'gp-title', data.title));

  if (data.kind === 'readings') {
    const list = el('div', 'gp-readings');
    for (const reading of data.items) {
      const row = el('div', 'gp-reading');
      if (reading.icon !== undefined) row.appendChild(el('span', 'gp-ico', reading.icon));
      row.appendChild(el('span', 'gp-label', reading.label));
      row.appendChild(el('span', 'gp-value', reading.value));
      list.appendChild(row);
    }
    section.appendChild(list);
  } else if (data.kind === 'stat') {
    section.appendChild(el('div', 'gp-stat-value', data.value));
    if (data.caption !== undefined) section.appendChild(el('div', 'gp-stat-caption', data.caption));
  } else if (data.kind === 'tiles') {
    const strip = el('div', 'gp-tiles');
    for (const tile of data.items) {
      const cell = el('div', 'gp-tile');
      cell.appendChild(el('div', 'gp-tile-value', tile.value));
      cell.appendChild(el('div', 'gp-tile-label', tile.label));
      strip.appendChild(cell);
    }
    section.appendChild(strip);
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
  // their box after they are on screen — see below.
  const toFit: { readonly box: HTMLElement; readonly scale: HTMLElement }[] = [];

  for (const widget of layout.widgets) {
    const box = el('div', `fw fw-${widget.type}`);
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
    } else if (widget.type === 'calendar') {
      // The calendar fills its box: its rows stretch to the box height rather
      // than keeping the rem-based natural height the stacked layout gives it.
      // Scale-to-fit sized the whole month grid to ~30% of the wall (the height
      // the design chose for it as one block among several), then dropped it
      // into an 88%-tall freeform box — leaving two thirds of the box empty and
      // the cells so small only a dot fit. Filling the box means a large
      // calendar is a large calendar, with room for labelled event pills.
      box.classList.add('fw-fill');
      box.appendChild(contentWithTitle(body, widget.config));
    } else {
      /*
       * The calendar, weather, house and shift widgets reuse sections built
       * for a full-width strip or grid, sized against the whole wall. Rather
       * than re-derive every font size for a box — which fights the design and
       * still guesses — the section is rendered at its natural size and scaled
       * as one to fit the box. The proportions the design chose are kept; only
       * the whole thing gets smaller. The scale is measured once it is on
       * screen, at the foot of this function.
       */
      const scale = el('div', 'fw-scale');
      // The title rides inside the scaled content, so it shrinks with the
      // section and the fit measurement already accounts for it.
      scale.appendChild(contentWithTitle(body, widget.config));
      box.appendChild(scale);
      toFit.push({ box, scale });
    }
    canvas.appendChild(box);
  }

  screen.appendChild(canvas);

  const banners = renderBanners(model);
  if (banners !== undefined) {
    screen.classList.add('has-banners');
    screen.appendChild(banners);
  }

  root.textContent = '';
  root.appendChild(screen);

  // Now that everything has a size, scale each reused section to fit its box.
  // The reference is the whole canvas width, so a grid's columns have the room
  // they get on a full wall before the whole thing is shrunk into the box.
  const canvasWidth = canvas.clientWidth;
  for (const { box, scale } of toFit) fitToBox(box, scale, canvasWidth);
}

/**
 * Scale a reused section to fit its widget box.
 *
 * The section is first laid out at the *canvas* width — the width it would have
 * filling the wall — so a seven-column month grid resolves its `fr` tracks with
 * room to spare instead of being squeezed until a column clips. Then the whole
 * thing is scaled down uniformly to the box, from the top-left, so the design's
 * proportions are kept and only its size changes. The width reference means the
 * factor is at most one, so nothing is ever blown up past its natural scale.
 */
export function fitToBox(box: HTMLElement, scale: HTMLElement, canvasWidth: number): void {
  const style = getComputedStyle(box);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const availW = box.clientWidth - padX;
  const availH = box.clientHeight - padY;
  if (canvasWidth <= 0 || availW <= 0 || availH <= 0) return;

  // Lay the section out at the full canvas width, then measure how tall it is.
  scale.style.width = `${canvasWidth}px`;
  const contentH = scale.scrollHeight;
  if (contentH <= 0) return;

  const factor = Math.min(availW / canvasWidth, availH / contentH);
  scale.style.transform = `scale(${factor})`;
}

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
  const takeover = model.interrupts.find((interrupt) => interrupt.takeover);
  if (takeover !== undefined) {
    root.textContent = '';
    root.appendChild(renderAlert(takeover, model));
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
    } else if (block.startsWith('ext:')) {
      // A third-party module's block. Absent rather than empty when the module
      // has not answered yet — a blank row is worse than no row.
      const panel = model.externalPanels[block];
      if (panel !== undefined) screen.appendChild(renderGenericPanel(panel));
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
  panel.appendChild(el('h1', undefined, 'Pair this screen'));
  panel.appendChild(
    el(
      'p',
      undefined,
      'On another device, open Maverick Wall, add this screen under Screens, ' +
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
