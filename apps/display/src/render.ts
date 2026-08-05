import type {
  DayModel,
  DisplayModel,
  EventModel,
  HorizonCell,
  InterruptModel,
} from './viewmodel.js';
import type { ManifestWidget } from './manifest.js';

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
  const badge = shiftBadge(model);
  if (badge !== undefined) top.appendChild(badge);

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
  paintShift(badge, shift.colorToken);
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
  if (model.shiftRun !== undefined) badge.appendChild(el('div', 'until', model.shiftRun));
  return badge;
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
function renderWidgetBody(type: string, model: DisplayModel): HTMLElement | undefined {
  switch (type) {
    case 'clock':
      return renderClockWidget(model);
    case 'calendar':
      return renderHorizon(model);
    case 'weather':
      return renderWeather(model);
    case 'homeassistant':
      return renderHouse(model);
    case 'shift':
      return renderShiftWidget(model);
    default:
      return undefined;
  }
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
export function renderFreeform(
  root: HTMLElement,
  model: DisplayModel,
  layout: { readonly aspect: number; readonly widgets: readonly ManifestWidget[] },
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

    const body = renderWidgetBody(widget.type, model);
    if (body === undefined) {
      // A box the household placed but that has no data yet says so, rather
      // than being an empty rectangle nobody can explain from the kitchen.
      box.appendChild(el('div', 'fw-empty', 'Nothing to show yet.'));
    } else if (widget.type === 'clock') {
      // The clock already sizes itself to its box; nothing to scale.
      box.appendChild(body);
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
      scale.appendChild(body);
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
function fitToBox(box: HTMLElement, scale: HTMLElement, canvasWidth: number): void {
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
