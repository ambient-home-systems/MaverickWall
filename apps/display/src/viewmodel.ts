import type { CivilDate, Manifest, ManifestDay, ManifestEvent, ManifestShift } from './manifest.js';
export type { ManifestShift };

/**
 * Manifest to something drawable, with no DOM in sight.
 *
 * Every decision about what is shown and what is dropped happens here, so it
 * can be tested against a document rather than against a screenshot. The
 * renderer below it does no thinking at all.
 *
 * The shape is a pyramid: one day in full, a few days in summary, the rest as
 * colour. That is what "zoom" means on a wall — the further away a day is, the
 * less of it is worth the space, but the shape of the month still has to be
 * visible from the doorway.
 */

/*
 * Density, when the manifest does not say.
 *
 * These are the defaults, not the policy: the household owns these numbers now
 * and sets them on the Display screen, because the right answer depends on a
 * room nobody writing this can see. A ten-inch tablet in a hallway and a 43"
 * panel in a kitchen want different ones, and so do a family with one
 * appointment a week and one with six a day.
 *
 * They stay here because an older server, or a manifest that predates the
 * field, must still produce a sensible wall rather than an empty one.
 */
export const TODAY_EVENT_LIMIT = 8;
/** "Next six days", per the design. Empty days are shown, not skipped. */
export const NEXT_DAY_COUNT = 6;
export const NEXT_EVENT_LIMIT = 4;
/** Five weeks of horizon, not six: the design gives the rest to the day itself. */
export const HORIZON_WEEKS = 5;

/** Everything a wall can show, and the order it shows them in by default. */
export type DisplayBlock = 'now' | 'weather' | 'home' | 'next' | 'horizon' | `ext:${string}`;
export const DEFAULT_BLOCKS: readonly DisplayBlock[] = [
  'now',
  'weather',
  'home',
  'next',
  'horizon',
];
const BUILT_IN_BLOCKS: readonly DisplayBlock[] = ['now', 'weather', 'home', 'next', 'horizon'];

/**
 * The order to draw in, from whatever the manifest said.
 *
 * Unknown names are dropped rather than trusted — this bundle can only render
 * what it has a renderer for, and a block named by a newer server would
 * otherwise be a gap on the wall. An empty result falls back to all three,
 * because a wall drawing nothing is the outcome rule nine exists to prevent.
 */
export function resolveBlocks(requested: readonly string[] | undefined): DisplayBlock[] {
  if (requested === undefined) return [...DEFAULT_BLOCKS];
  const blocks: DisplayBlock[] = [];
  for (const name of requested) {
    // A built-in, or a registered third-party block (`ext:<id>`). An `ext:` key
    // with no panel in the manifest draws nothing, the same as a built-in whose
    // module is off.
    if (!BUILT_IN_BLOCKS.includes(name as DisplayBlock) && !name.startsWith('ext:')) continue;
    if (blocks.includes(name as DisplayBlock)) continue;
    blocks.push(name as DisplayBlock);
  }
  return blocks.length === 0 ? [...DEFAULT_BLOCKS] : blocks;
}

/** Older than this and the wall says so rather than quietly lying. */
export const STALE_AFTER_MS = 30 * 60_000;

export interface EventModel {
  readonly id: string;
  /**
   * Which calendar this came from. Already in the manifest (the `sources`
   * legend carries it), so keeping it on the event leaks nothing new — it lets
   * a per-widget layout show only some calendars without the server building a
   * separate document per widget.
   */
  readonly sourceId: string;
  readonly title: string;
  readonly time: string;
  readonly allDay: boolean;
  readonly color: string;
  readonly location: string | undefined;
  readonly continues: boolean;
  /** Already happened. Dimmed rather than removed — it is still context. */
  readonly isPast: boolean;
  /** The next one due. The only thing on the wall that is highlighted. */
  readonly isNext: boolean;
}

export interface ShiftModel {
  readonly personName: string;
  readonly personAvatarUrl: string | null;
  readonly personColor: string;
  readonly label: string;
  readonly shortCode: string;
  readonly colorToken: string;
  /** An explicit per-type colour that overrides the token, or absent for it. */
  readonly color?: string;
  /** Optional `HH:MM` window for the shift, drawn on the wall. */
  readonly startTime?: string;
  readonly endTime?: string;
  readonly isWorking: boolean;
}

export interface DayModel {
  readonly date: CivilDate;
  readonly weekday: string;
  readonly dayNumber: string;
  readonly month: string;
  readonly isToday: boolean;
  readonly isPast: boolean;
  readonly shifts: readonly ShiftModel[];
  readonly events: readonly EventModel[];
  /** Events beyond the limit, so the wall can say how many it is not showing. */
  readonly hiddenEventCount: number;
}

export interface HorizonCell {
  readonly date: CivilDate;
  readonly dayNumber: string;
  readonly isToday: boolean;
  readonly isPast: boolean;
  readonly inMonth: boolean;
  /**
   * The colour token for the day.
   *
   * Every shift tints its cell, working or not: the horizon is the *shape* of
   * the rotation, and a rest day is part of that shape. Undefined means no
   * rota resolved for that day at all, which is a different fact and looks
   * different.
   */
  readonly shiftToken: string | undefined;
  /** An explicit per-type colour for this cell, or undefined to use the token. */
  readonly shiftColor: string | undefined;
  readonly shiftCode: string | undefined;
  /** The full name, for the legend that sits under the grid. */
  readonly shiftLabel: string | undefined;
  readonly eventCount: number;
}

export interface WeatherDayModel {
  readonly name: string;
  readonly icon: string;
  readonly high: string;
  readonly low: string;
}

export type Staleness =
  | { readonly level: 'fresh' }
  | { readonly level: 'stale'; readonly message: string }
  | { readonly level: 'offline'; readonly message: string };

export interface DisplayModel {
  readonly timezone: string;
  readonly theme: string;
  readonly todayLabel: string;
  readonly clock: string;
  readonly today: DayModel | undefined;
  /** The badge: the single most important element on the wall. */
  readonly todayShift: ManifestShift | undefined;
  /** "Day 2 of 4 · 2 more", or undefined when there is no rota today. */
  readonly shiftRun: string | undefined;
  readonly next: readonly DayModel[];
  readonly horizon: readonly (readonly HorizonCell[])[];
  readonly notices: readonly { readonly level: string; readonly message: string }[];
  readonly staleness: Staleness;
  /** Which blocks to draw, in order. The renderer walks this and nothing else. */
  readonly blocks: readonly DisplayBlock[];
  /** The weather panel, when a module contributed one. */
  readonly weather: readonly WeatherDayModel[];
  /** Something quiet to say about the forecast, such as its age. */
  readonly weatherNote: string | undefined;
  /** Third-party module panels, keyed by their `ext:<id>` block key. */
  readonly externalPanels: Readonly<Record<string, PanelData>>;
  /** Readings from the house, when a module contributed any. */
  readonly house: readonly HouseReadingModel[];
  /** Something quiet to say about them, such as a connection that is failing. */
  readonly houseNote: string | undefined;
  /**
   * Server time for this document, so a countdown does not trust the device.
   *
   * A wall tablet's clock drifts and some never get NTP at all. "42 minutes
   * left" computed against a clock two hours out is worse than no countdown.
   */
  readonly now: number;
  /**
   * Anything drawn over the calendar, most important first.
   *
   * Already decided by the server; nothing here re-evaluates a rule. A
   * `takeover` replaces the wall, a `banner` sits above it.
   */
  readonly interrupts: readonly InterruptModel[];
  /**
   * Whether this screen may offer a way to acknowledge an interrupt.
   *
   * A fact about the hardware: a hall television has a remote, a panel screwed
   * to a wall has no input at all, and a kitchen tablet has a touchscreen a
   * passing sleeve can press.
   */
  readonly allowDismiss: boolean;
}

export interface HouseReadingModel {
  readonly label: string;
  readonly value: string;
  readonly icon: string;
  readonly mode: string;
  readonly stale: boolean;
}

export interface InterruptModel {
  /** The event name. Drawn largest. */
  readonly title: string;
  /** What to actually do, when the source said. */
  readonly headline: string | undefined;
  /** Which counties or rooms it covers. */
  readonly area: string | undefined;
  /** Who said so — the issuing office. */
  readonly sender: string | undefined;
  readonly takeover: boolean;
  readonly severity: string;
  readonly expiresAt: number | undefined;
  readonly dismissible: boolean;
  /** `ruleId:signalKey`, the only thing the dismiss endpoint accepts. */
  readonly key: string;
}

/**
 * The house panel, read defensively.
 *
 * Same contract as the forecast: a module's slice arrives as `unknown` and is
 * shaped here rather than trusted, so a server one version ahead costs this
 * panel and nothing else.
 */
export function houseFrom(panel: unknown): {
  readings: HouseReadingModel[];
  note: string | undefined;
} {
  if (typeof panel !== 'object' || panel === null) return { readings: [], note: undefined };
  const raw = (panel as { readings?: unknown }).readings;
  if (!Array.isArray(raw)) return { readings: [], note: undefined };

  const readings: HouseReadingModel[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const reading = entry as {
      label?: unknown; value?: unknown; unit?: unknown; icon?: unknown;
      mode?: unknown; stale?: unknown;
    };
    /*
     * Through the same sanitiser the alert text uses.
     *
     * These are Home Assistant *attributes* — a friendly name and a state that
     * some integration wrote, and that a household may have typed. The same
     * rule applies as to a CAP headline: capped, and stripped of the invisible
     * characters that would otherwise let a device name reverse the reading
     * order of the line it sits in. `textContent` is what prevents injection;
     * this is what keeps a reading legible.
     */
    const label = text(reading.label, 60);
    const value = text(reading.value, 60);
    if (label === undefined || value === undefined) continue;
    const unit = text(reading.unit, 16) ?? '';
    readings.push({
      label,
      // The unit is joined here rather than kept apart, because every mode
      // that shows a value shows it with its unit and nothing styles them
      // differently. A degree sign gets no space; a word does.
      value: unit === '' ? value : `${value}${unit.startsWith('°') ? '' : ' '}${unit}`,
      // One character, and one this bundle chose. A glyph is a token rather
      // than a sentence, so a long "icon" is a mistake rather than a reading.
      icon: text(reading.icon, 4) ?? '·',
      mode: typeof reading.mode === 'string' ? reading.mode : 'label_value',
      stale: reading.stale === true,
    });
  }

  return { readings, note: text((panel as { note?: unknown }).note, 200) };
}

/**
 * Interrupts, read defensively and capped.
 *
 * Two is the limit, and it is not arbitrary: a wall with five things shouting
 * at it has communicated nothing, and the server has already sorted them by
 * priority so the two that survive are the two that matter. The rest are still
 * true — they are just not what somebody walking past needs to be told first.
 */
export function interruptsFrom(raw: unknown): InterruptModel[] {
  if (!Array.isArray(raw)) return [];
  const model: InterruptModel[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const interrupt = entry as Record<string, unknown>;
    const title = text(interrupt['title'], 120);
    if (title === undefined) continue;

    const ruleId = typeof interrupt['ruleId'] === 'string' ? interrupt['ruleId'] : '';
    const key = typeof interrupt['key'] === 'string' ? interrupt['key'] : '';

    model.push({
      title,
      headline: text(interrupt['headline'], 600),
      area: text(interrupt['area'], 300),
      sender: text(interrupt['sender'], 120),
      takeover:
        interrupt['action'] === 'takeover' || interrupt['action'] === 'takeover_and_wake',
      severity: typeof interrupt['severity'] === 'string' ? interrupt['severity'] : 'Unknown',
      expiresAt: typeof interrupt['expiresAt'] === 'number' ? interrupt['expiresAt'] : undefined,
      dismissible: interrupt['dismissible'] === true && ruleId !== '' && key !== '',
      key: `${ruleId}:${key}`,
    });
    if (model.length === 3) break;
  }
  return model;
}

/**
 * Text from somebody else, made safe to draw.
 *
 * The server already strips and caps what it stores, and this does it again on
 * the way out. Not belt and braces for its own sake: the display also draws
 * Home Assistant attributes and a manifest it read out of IndexedDB months
 * ago, and neither of those went through the alert parser. The rule that
 * actually prevents injection is `textContent` in the renderer — this is about
 * a headline being *legible*, which a string of zero-width marks is not.
 */
function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Whitespace collapses first: a newline is a control character, and
  // stripping before collapsing joins the words either side of a line break.
  const cleaned = value
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return undefined;
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 1)}…`;
}

/**
 * A generic module panel — the vocabulary a module (first- or third-party) may
 * put on the wall. See docs/rfc-001-module-framework.md. Deliberately small:
 * it is the safety boundary and what keeps a panel looking like the wall.
 */
export interface PanelReading {
  readonly label: string;
  readonly value: string;
  readonly icon?: string;
}
export interface PanelTile {
  readonly label: string;
  readonly value: string;
}
export type PanelData =
  | { readonly kind: 'readings'; readonly title?: string; readonly items: readonly PanelReading[] }
  | { readonly kind: 'stat'; readonly title?: string; readonly value: string; readonly caption?: string }
  | { readonly kind: 'tiles'; readonly title?: string; readonly items: readonly PanelTile[] }
  | { readonly kind: 'text'; readonly title?: string; readonly text: string };

function readPanelItems(raw: unknown, withIcon: boolean): PanelReading[] {
  if (!Array.isArray(raw)) return [];
  const items: PanelReading[] = [];
  for (const entry of raw.slice(0, 12)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const label = text(row['label'], 60);
    const value = text(row['value'], 60);
    if (label === undefined || value === undefined) continue;
    const icon = withIcon ? text(row['icon'], 4) : undefined;
    items.push(icon === undefined ? { label, value } : { label, value, icon });
  }
  return items;
}

/**
 * Shape a module panel defensively.
 *
 * The server has already validated the module's body against the schema, but
 * this reads it as untrusted all the same — the same treatment `houseFrom` and
 * `weatherFrom` give a manifest slice, so a wall a version ahead of the server
 * still draws something sane. Every string is sanitised (`text`) and capped;
 * anything that does not fit the vocabulary returns null and nothing is drawn.
 */
export function panelFrom(raw: unknown): PanelData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const panel = raw as Record<string, unknown>;
  const title = text(panel['title'], 60);
  const base = title === undefined ? {} : { title };

  switch (panel['kind']) {
    case 'readings': {
      const items = readPanelItems(panel['items'], true);
      return items.length === 0 ? null : ({ kind: 'readings', items, ...base } as PanelData);
    }
    case 'stat': {
      const value = text(panel['value'], 60);
      if (value === undefined) return null;
      const caption = text(panel['caption'], 60);
      return {
        kind: 'stat',
        value,
        ...(caption === undefined ? {} : { caption }),
        ...base,
      } as PanelData;
    }
    case 'tiles': {
      const items = readPanelItems(panel['items'], false);
      return items.length === 0 ? null : ({ kind: 'tiles', items, ...base } as PanelData);
    }
    case 'text': {
      const body = text(panel['text'], 280);
      return body === undefined ? null : ({ kind: 'text', text: body, ...base } as PanelData);
    }
    default:
      return null;
  }
}

/**
 * The weather panel, read defensively.
 *
 * A module's slice arrives as `unknown` and is shaped here rather than trusted:
 * a server one version ahead, or a provider that changed a field, must cost
 * the panel and nothing else.
 */
export function weatherFrom(panel: unknown): {
  days: WeatherDayModel[];
  note: string | undefined;
} {
  if (typeof panel !== 'object' || panel === null) return { days: [], note: undefined };
  const raw = (panel as { days?: unknown }).days;
  if (!Array.isArray(raw)) return { days: [], note: undefined };

  const days: WeatherDayModel[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const day = entry as {
      name?: unknown; icon?: unknown; high?: unknown; low?: unknown; unit?: unknown;
    };
    if (typeof day.name !== 'string') continue;
    const unit = typeof day.unit === 'string' ? day.unit : '';
    const degrees = (value: unknown): string =>
      typeof value === 'number' ? `${Math.round(value)}°` : '—';
    days.push({
      name: day.name,
      icon: typeof day.icon === 'string' ? day.icon : '·',
      high: degrees(day.high),
      // The unit rides on the low so the row reads "84° 69°F" rather than
      // repeating itself five times across the strip.
      low: `${degrees(day.low)}${unit === '' ? '' : unit}`,
    });
  }

  const note = (panel as { note?: unknown }).note;
  return { days, note: typeof note === 'string' && note !== '' ? note : undefined };
}

/** A whole number inside a range, or the fallback when it is not one at all. */
function bounded(value: number | undefined, low: number, high: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(high, Math.max(low, Math.round(value)));
}

/**
 * The civil date in a zone, from `Intl` rather than from arithmetic.
 *
 * The whole application anchors on this: a wall showing the wrong day is worse
 * than a wall showing nothing, because nobody doubts it.
 */
export function localDate(at: number, timezone: string): CivilDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const find = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${find('year')}-${find('month')}-${find('day')}`;
}

export function localTime(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(at));
}

function parts(date: CivilDate, timezone: string): { weekday: string; day: string; month: string } {
  // Noon UTC, so the date cannot slide across a boundary in either direction
  // when it is reinterpreted in the household's zone.
  const at = Date.parse(`${date}T12:00:00Z`);
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).formatToParts(new Date(at));
  const find = (type: string): string => formatted.find((part) => part.type === type)?.value ?? '';
  return { weekday: find('weekday'), day: find('day'), month: find('month') };
}

function eventTime(event: ManifestEvent, timezone: string): string {
  if (event.allDay) return 'All day';
  return localTime(event.startsAt, timezone);
}

function toEvent(
  event: ManifestEvent,
  timezone: string,
  marks: { isPast: boolean; isNext: boolean } = { isPast: false, isNext: false },
): EventModel {
  return {
    id: event.id,
    sourceId: event.sourceId,
    title: event.title,
    time: eventTime(event, timezone),
    allDay: event.allDay,
    color: event.color,
    location: event.location,
    continues: event.continues,
    isPast: marks.isPast,
    isNext: marks.isNext,
  };
}

/**
 * Mark what has been and what is next.
 *
 * Only today's list gets this. An all-day event is never "next" — it has no
 * time to be next at, and highlighting it would push the actual next thing
 * down the page.
 */
function markToday(events: readonly ManifestEvent[], now: number, timezone: string): EventModel[] {
  let foundNext = false;
  return events.map((event) => {
    const past = !event.allDay && event.endsAt <= now;
    const isNext = !past && !event.allDay && !foundNext && event.startsAt > now;
    if (isNext) foundNext = true;
    return toEvent(event, timezone, { isPast: past, isNext });
  });
}

function toShift(shift: ManifestShift): ShiftModel {
  return {
    personName: shift.personName,
    personAvatarUrl: shift.personAvatarUrl ?? null,
    personColor: shift.personColor,
    label: shift.label,
    shortCode: shift.shortCode,
    colorToken: shift.colorToken,
    ...(shift.color !== undefined ? { color: shift.color } : {}),
    ...(shift.startTime !== undefined ? { startTime: shift.startTime } : {}),
    ...(shift.endTime !== undefined ? { endTime: shift.endTime } : {}),
    isWorking: shift.isWorking,
  };
}

function toDay(day: ManifestDay, today: CivilDate, timezone: string, limit: number): DayModel {
  const { weekday, day: dayNumber, month } = parts(day.date, timezone);
  const shown = day.events.slice(0, limit);
  return {
    date: day.date,
    weekday,
    dayNumber,
    month,
    isToday: day.date === today,
    isPast: day.date < today,
    shifts: day.shifts.map(toShift),
    events: shown.map((event) => toEvent(event, timezone)),
    hiddenEventCount: day.events.length - shown.length,
  };
}

/**
 * Group the window into calendar weeks starting Monday.
 *
 * Padded at both ends so the grid is rectangular. A ragged first row reads as
 * a rendering fault from across a room, even though it is technically honest.
 */
function intoWeeks(cells: readonly HorizonCell[]): HorizonCell[][] {
  const weeks: HorizonCell[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7) as HorizonCell[]);
  }
  return weeks;
}

function weekdayIndex(date: CivilDate): number {
  // Monday first. `getUTCDay` is Sunday-first, and a household's week is not.
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return (day + 6) % 7;
}

function addDays(date: CivilDate, days: number): CivilDate {
  const at = Date.parse(`${date}T12:00:00Z`) + days * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}

export interface BuildOptions {
  readonly manifest: Manifest;
  /** Corrected wall time. Never the tablet's own clock. */
  readonly now: number;
  /** When the manifest on screen was last confirmed by the server. */
  readonly lastConfirmedAt: number;
  readonly offline: boolean;
}

export function buildModel(options: BuildOptions): DisplayModel {
  const { manifest, now } = options;
  const timezone = manifest.timezone;
  const today = localDate(now, timezone);

  // The household's numbers when the server sends them, this bundle's when it
  // does not. Guarded rather than trusted: the server clamps them too, and a
  // wall asked for two hundred weeks should still draw something.
  const chosen = manifest.display;
  const todayLimit = bounded(chosen?.todayEvents, 1, 20, TODAY_EVENT_LIMIT);
  const nextDays = bounded(chosen?.nextDays, 0, 14, NEXT_DAY_COUNT);
  const horizonWeeks = bounded(chosen?.horizonWeeks, 1, 8, HORIZON_WEEKS);
  const blocks = resolveBlocks(chosen?.blocks);

  const byDate = new Map<CivilDate, ManifestDay>();
  for (const day of manifest.days) byDate.set(day.date, day);

  const todayDay = byDate.get(today);

  /*
   * The next few days that have anything on them.
   *
   * Skipping empty days rather than showing them: three blank panels tell
   * nobody anything, and the horizon below already says those days are empty.
   */
  const next: DayModel[] = [];
  const wantsNext = blocks.includes('next');
  for (let offset = 1; wantsNext && offset <= nextDays; offset++) {
    const date = addDays(today, offset);
    if (date > manifest.window.to) break;
    const day = byDate.get(date) ?? { date, shifts: [], events: [] };
    next.push(toDay(day, today, timezone, NEXT_EVENT_LIMIT));
  }

  // The horizon starts on the Monday of the week containing today, so the grid
  // lines up with how a month is read rather than with when this happened to
  // be fetched.
  const start = addDays(today, -weekdayIndex(today));
  const cells: HorizonCell[] = [];
  const todayMonth = today.slice(0, 7);
  for (let offset = 0; offset < horizonWeeks * 7; offset++) {
    const date = addDays(start, offset);
    const day = byDate.get(date);
    // The first shift of the day, whether or not it is a working one.
    const shift = day?.shifts[0];
    cells.push({
      date,
      dayNumber: String(Number(date.slice(8, 10))),
      isToday: date === today,
      isPast: date < today,
      inMonth: date.slice(0, 7) === todayMonth,
      shiftToken: shift?.colorToken,
      shiftColor: shift?.color,
      shiftCode: shift?.shortCode,
      shiftLabel: shift?.label,
      eventCount: day?.events.length ?? 0,
    });
  }

  const age = Math.max(0, now - options.lastConfirmedAt);
  let staleness: Staleness = { level: 'fresh' };
  if (options.offline) {
    staleness = {
      level: 'offline',
      message: `Not reaching the server. Showing what was last known, ${describeAge(age)}.`,
    };
  } else if (age > STALE_AFTER_MS) {
    staleness = { level: 'stale', message: `Last updated ${describeAge(age)}.` };
  }

  const weather = weatherFrom(manifest.panels?.['weather']);
  const house = houseFrom(manifest.panels?.['home']);

  // Third-party module panels: every `ext:*` slice, read through the same
  // defensive parser (docs/rfc-001-module-framework.md). A slice that does not
  // fit the vocabulary is dropped, so its block simply draws nothing.
  const externalPanels: Record<string, PanelData> = {};
  const panels = manifest.panels ?? {};
  for (const key of Object.keys(panels)) {
    if (!key.startsWith('ext:')) continue;
    const panel = panelFrom(panels[key]);
    if (panel !== null) externalPanels[key] = panel;
  }

  const { weekday, day: dayNumber, month } = parts(today, timezone);

  return {
    timezone,
    theme: manifest.theme.active,
    todayLabel: `${weekday} ${dayNumber} ${month}`,
    clock: localTime(now, timezone),
    today:
      todayDay === undefined
        ? undefined
        : {
            ...toDay(todayDay, today, timezone, todayLimit),
            events: markToday(todayDay.events.slice(0, todayLimit), now, timezone),
          },
    todayShift: todayDay?.shifts[0],
    shiftRun: todayDay === undefined ? undefined : describeRun(byDate, today, timezone),
    next,
    horizon: intoWeeks(cells),
    weather: weather.days,
    weatherNote: weather.note,
    externalPanels,
    house: house.readings,
    houseNote: house.note,
    now,
    interrupts: interruptsFrom(manifest.interrupts),
    allowDismiss: manifest.screen?.allowDismiss === true,
    notices: manifest.notices.map((notice) => ({ level: notice.level, message: notice.message })),
    staleness,
    blocks,
  };
}

/**
 * How far through a run of the same shift today is.
 *
 * The question a shift worker's household actually asks of a wall is not
 * "what is he on today" but "how many more of these" — so the badge says
 * "Day 2 of 4 · 2 more" rather than repeating the label.
 */
function describeRun(
  byDate: Map<CivilDate, ManifestDay>,
  today: CivilDate,
  _timezone: string,
): string | undefined {
  const key = byDate.get(today)?.shifts[0]?.key;
  if (key === undefined) return undefined;

  const sameAs = (date: CivilDate): boolean => byDate.get(date)?.shifts[0]?.key === key;

  let before = 0;
  while (before < 14 && sameAs(addDays(today, -(before + 1)))) before++;
  let after = 0;
  while (after < 14 && sameAs(addDays(today, after + 1))) after++;

  const total = before + after + 1;
  const position = before + 1;
  if (after === 0) return `Last of ${total}`;
  return `Day ${position} of ${total} · ${after} more`;
}

/** "12 minutes ago" reads better on a wall than a timestamp nobody can parse. */
export function describeAge(ageMs: number): string {
  // Floored, not rounded. Rounding turns 30 seconds into "1 minute ago", which
  // is a wall claiming to be staler than it is — and the whole point of this
  // line is that it can be trusted.
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}
