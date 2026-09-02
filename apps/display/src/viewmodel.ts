import type {
  CivilDate,
  Manifest,
  ManifestDay,
  ManifestEvent,
  ManifestPerson,
  ManifestShift,
} from './manifest.js';
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
  /**
   * Whose event this is, when its calendar has an owner — the per-event cue.
   * Absent for a shared ("Everyone") calendar. The colour is already the
   * owner's (owner colour wins in the manifest), so this carries the face.
   */
  readonly owner: PersonModel | undefined;
  /**
   * How far through a running event we are, 0..1 — absent unless it has started
   * and not ended. A bar on something that has not begun measures nothing, and
   * a full bar on something finished is just a line. Only ever set for today,
   * because only today has a `now` worth drawing against.
   */
  readonly progress: number | undefined;
  /**
   * "Day 2 of 4", for an event that spans more than one day. Absent otherwise.
   * `continues` already says an event carries on; this says how far in we are,
   * which is the thing somebody standing at the wall actually wants.
   */
  readonly span: string | undefined;
}

/**
 * A member of the household, for the legend that teaches the wall's colours and
 * for the avatar on an owned event. One shape serves both so a face and a
 * colour never disagree between the strip and the row it explains.
 */
export interface PersonModel {
  readonly id: string;
  readonly name: string;
  /** One or two letters, the fallback when there is no photo. */
  readonly initials: string;
  readonly color: string;
  readonly avatarUrl: string | undefined;
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

/**
 * One person's shift today, with the run already put into words.
 *
 * The run is resolved here rather than in the renderer for the usual reason:
 * `render.ts` builds nodes and does no thinking, and "Day 2 of 4 · 2 more" is a
 * decision about what a run means, not about how it is drawn.
 */
export interface TodayShiftModel {
  readonly shift: ManifestShift;
  /** "Day 2 of 4 · 2 more", when the run is known. */
  readonly run: string | undefined;
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
  /**
   * The forecast for this day, when there is one and the widget asked for it.
   * Joined by date in `buildModel`, so a day the forecast does not reach simply
   * has none rather than borrowing its neighbour's.
   */
  readonly weather: WeatherDayModel | undefined;
}

/**
 * A slim event for a month cell or a week column (RFC 005).
 *
 * The month grid's dots need only a count, but the Skylight-style `pills` and
 * `week` calendar-widget modes draw the events themselves — a coloured, labelled
 * bar per event. `sourceId` is carried so the week columns can honour the
 * widget's `calendars` filter, exactly as the agenda mode does; it is already in
 * the manifest, so it leaks nothing.
 */
export interface HorizonEvent {
  /**
   * The event's identity, the same on every date it touches — the server
   * buckets one row onto each of them. The month grid groups a multi-day
   * event's cells into one bar on this and never on the title, which two
   * unrelated "Bin day" entries a week apart would happily share.
   */
  readonly id: string;
  readonly title: string;
  readonly color: string;
  readonly allDay: boolean;
  /**
   * The server's own word for "covers more than one date", carried since the
   * manifest started bucketing an event onto each of its days and read by
   * nothing until `month-spans.ts`. With `allDay`, it is what makes a bar.
   */
  readonly continues: boolean;
  readonly sourceId: string;
  /**
   * "09:00", or "All day". Formatted here like every other time on the wall so
   * the household's 12/24-hour choice reaches a week column too — the dense
   * styles show it, the quiet ones ignore it.
   */
  readonly time: string;
}

export interface HorizonCell {
  readonly date: CivilDate;
  readonly weekday: string;
  /**
   * The same weekday spelled out, for the one tier with a column wide enough
   * for it.
   *
   * Derived here rather than travelling in the manifest: it is the household's
   * own zone and locale applied to a date this model already has, and adding a
   * field to the document would churn every stored ETag for a string the server
   * cannot spell better than the page can.
   */
  readonly weekdayLong: string;
  readonly dayNumber: string;
  /** The week this cell is in, when the server said. Drawn once per row. */
  readonly weekNumber: number | undefined;
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
  /**
   * A few of the day's events, for the `pills` and `week` calendar modes. Capped
   * because a cell or a column has room for a handful; `eventCount` above is the
   * true total the month dots and any "+N" read from.
   */
  readonly events: readonly HorizonEvent[];
}

export interface WeatherDayModel {
  readonly name: string;
  readonly icon: string;
  readonly high: string;
  readonly low: string;
  /**
   * The civil date this covers, or absent when the provider did not say — and
   * absent for a forecast cached by a server older than this field, which is
   * why nothing may assume it. Only the join uses it; the strip still labels
   * itself with `name`, which is the provider's own wording.
   */
  readonly date: string | undefined;
}

export type Staleness =
  | { readonly level: 'fresh' }
  | { readonly level: 'stale'; readonly message: string }
  | { readonly level: 'offline'; readonly message: string };

/**
 * The month a horizon grid is about, as "August 2026".
 *
 * Taken from the first cell the server marked `inMonth` rather than from today:
 * the two agree on every grid this bundle draws, but the grid's own cells are
 * what the title is a title *for*, and reading today would make the heading
 * disagree with the numbers under it the first time anything draws a horizon
 * that is not this month.
 */
function horizonMonthLabel(
  cells: readonly HorizonCell[],
  timezone: string,
): string | undefined {
  const anchor = cells.find((cell) => cell.inMonth) ?? cells[0];
  if (anchor === undefined) return undefined;
  const [year, month, day] = anchor.date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  // Noon UTC, so a timezone either side of the date line cannot roll the month.
  const at = new Date(Date.UTC(year, month - 1, day, 12));
  const formatter = new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    month: 'long',
    year: 'numeric',
  });
  const found = (type: string): string =>
    formatter.formatToParts(at).find((part) => part.type === type)?.value ?? '';
  const name = found('month');
  const yearText = found('year');
  return name === '' ? undefined : `${name} ${yearText}`.trim();
}

export interface DisplayModel {
  readonly timezone: string;
  readonly theme: string;
  readonly todayLabel: string;
  readonly clock: string;
  readonly today: DayModel | undefined;
  /**
   * The household, in their chosen order, for the legend strip that teaches
   * which colour is whose. Empty when nobody is defined — then the wall draws
   * no strip and reads exactly as it did before people existed.
   */
  readonly people: readonly PersonModel[];
  /**
   * The badge: the single most important element on the wall.
   *
   * One entry per person on a rota today, in the household's own order, because
   * a household can have more than one shift worker and the manifest has always
   * carried them all. This read `shifts[0]` until 0.45.0 — the wall drew the
   * first person sorted and there was no setting anywhere that could say
   * otherwise, while the panel renderer drew everybody. Two renderers
   * disagreeing about who is on nights is exactly the fault this shape removes.
   */
  readonly todayShifts: readonly TodayShiftModel[];
  readonly next: readonly DayModel[];
  readonly horizon: readonly (readonly HorizonCell[])[];
  /**
   * The month the horizon is *about*, spelled out — "August 2026".
   *
   * The grid spans five or six weeks and so usually straddles two months; the
   * one it is about is the one its `inMonth` cells belong to. Derived here
   * rather than in the renderer because this is where the timezone and `Intl`
   * live, and `render.ts` builds nodes and does no thinking. Undefined when the
   * horizon is empty, so a title is never drawn over nothing.
   */
  readonly horizonMonth: string | undefined;
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
  /** The chore board, when the household has any (RFC 008 phase 2). */
  readonly chores: ChoreBoardModel | undefined;
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
  /** Whether this screen may tick a chore off (RFC 008 phase 3). */
  readonly allowChores: boolean;
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

export interface ChoreItemModel {
  /**
   * What a tick posts back (RFC 008 phase 3). Opaque; never shown.
   *
   * Absent means this row cannot be ticked — it is still drawn, read-only,
   * which is exactly what a screen without permission shows anyway. Dropping
   * the chore instead would trade a missing control for missing information,
   * and rule nine is the other way round.
   */
  readonly id: string | undefined;
  readonly name: string;
  /** Whose chore it is, for the widget's filter. An id, never shown. */
  readonly personId: string | undefined;
  readonly person: string | undefined;
  readonly color: string | undefined;
  readonly dueTime: string | undefined;
  readonly done: boolean;
}

export interface ChoreDayModel {
  readonly date: CivilDate;
  readonly items: readonly ChoreItemModel[];
}

export interface ChoreBoardModel {
  readonly today: CivilDate;
  readonly days: readonly ChoreDayModel[];
}

/**
 * The chore panel, read defensively (RFC 008 phase 2).
 *
 * The same treatment `weatherFrom` and `houseFrom` give a slice: the server
 * validated it, and this reads it as untrusted anyway, because a wall can be a
 * version ahead of the server that is answering it. Every string is sanitised
 * and capped — a chore name is text a household typed, and it lands beside the
 * calendar on the highest-prominence surface in the product.
 *
 * A day whose shape is wrong is dropped; the rest of the week still draws. Days
 * with nothing due are **kept**, because the week view needs the empty columns
 * to line its days up and re-inventing them from a sparse list is how two
 * renderers start disagreeing about which day is which.
 */
export function choresFrom(panel: unknown): ChoreBoardModel | undefined {
  if (typeof panel !== 'object' || panel === null) return undefined;
  const raw = panel as { today?: unknown; days?: unknown };
  if (typeof raw.today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.today)) return undefined;
  if (!Array.isArray(raw.days)) return undefined;

  const days: ChoreDayModel[] = [];
  for (const entry of raw.days) {
    if (typeof entry !== 'object' || entry === null) continue;
    const day = entry as { date?: unknown; items?: unknown };
    if (typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue;

    const items: ChoreItemModel[] = [];
    if (Array.isArray(day.items)) {
      for (const candidate of day.items.slice(0, 40)) {
        if (typeof candidate !== 'object' || candidate === null) continue;
        const item = candidate as {
          id?: unknown; personId?: unknown; name?: unknown; person?: unknown;
          color?: unknown; dueTime?: unknown; done?: unknown;
        };
        const name = text(item.name, 60);
        if (name === undefined) continue;
        /*
         * The id is what a tick posts back, so a row without one simply cannot
         * be ticked — and is drawn read-only rather than dropped, which is what
         * a screen without permission shows anyway. Losing the control costs a
         * household nothing they had; losing the chore costs them the thing
         * they walked over to read.
         *
         * Not sanitised like the strings beside it: it is never rendered, only
         * sent, and it has to match the row byte for byte.
         */
        const id = typeof item.id === 'string' && item.id !== '' && item.id.length <= 64
          ? item.id
          : undefined;
        items.push({
          id,
          personId:
            typeof item.personId === 'string' && item.personId !== '' &&
            item.personId.length <= 64
              ? item.personId
              : undefined,
          name,
          person: text(item.person, 40),
          // Only a six-digit hex reaches a style attribute. Anything else is no
          // colour rather than a string handed to the renderer.
          color:
            typeof item.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(item.color)
              ? item.color
              : undefined,
          dueTime:
            typeof item.dueTime === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(item.dueTime)
              ? item.dueTime
              : undefined,
          done: item.done === true,
        });
      }
    }
    days.push({ date: day.date, items });
  }
  return days.length === 0 ? undefined : { today: raw.today, days };
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
      date?: unknown;
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
      // A cached forecast written before this field existed has no date, and a
      // provider can decline to give one. Both mean "cannot be joined", never
      // "join it to whatever is nearest".
      date: typeof day.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.date)
        ? day.date
        : undefined,
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

export function localTime(at: number, timezone: string, hour12 = false): string {
  // `hour12` defaults false (24-hour), which is the wall's original behaviour and
  // what the daytime-theme comparison needs; the clock and event times pass the
  // household's choice (RFC 005). `hour12` (not `hourCycle`) because the display
  // targets ES2019, whose lib types do not know `hourCycle`.
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12,
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

/**
 * The weekday spelled out, in the household's own zone.
 *
 * A formatter of its own rather than a second option on `parts`, because
 * `formatToParts` answers one width per call and every other reader of `parts`
 * wants the short one. Cached per zone: this runs 35 times a draw, once per
 * cell in the grid, and a fresh `Intl.DateTimeFormat` is not cheap.
 */
const LONG_WEEKDAYS = new Map<string, Intl.DateTimeFormat>();
function longWeekday(date: CivilDate, timezone: string): string {
  let formatter = LONG_WEEKDAYS.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long' });
    LONG_WEEKDAYS.set(timezone, formatter);
  }
  // Noon UTC, so the date cannot slide across a boundary in either direction
  // when it is reinterpreted in the household's zone — `parts`' own rule.
  return formatter.format(new Date(Date.parse(`${date}T12:00:00Z`)));
}

function eventTime(event: ManifestEvent, timezone: string, hour12: boolean): string {
  if (event.allDay) return 'All day';
  return localTime(event.startsAt, timezone, hour12);
}

/**
 * One or two letters for a face with no photo. The first letter of the first
 * two words, or the first two letters of a single-word name — "Sam" is "SA",
 * "Mary Jane" is "MJ". Upper-cased, because a legend chip is not a sentence.
 */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

function toPerson(person: ManifestPerson): PersonModel {
  return {
    id: person.id,
    name: person.name,
    initials: initialsOf(person.name),
    color: person.color,
    avatarUrl: person.avatarUrl ?? undefined,
  };
}

function daysBetween(from: CivilDate, to: CivilDate): number {
  return Math.round(
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000,
  );
}

/**
 * How far through, 0..1, or absent when the event is not running.
 *
 * All-day events are excluded deliberately. "73% through Tuesday" is true and
 * useless — the bar is there to answer "have I got time", which only means
 * something for an event with a clock on it. A zero-length event would divide
 * by zero, so it is treated as not running rather than as instantly complete.
 */
function runningProgress(event: ManifestEvent, now: number): number | undefined {
  if (event.allDay) return undefined;
  if (now < event.startsAt || now >= event.endsAt) return undefined;
  const length = event.endsAt - event.startsAt;
  if (length <= 0) return undefined;
  return (now - event.startsAt) / length;
}

/**
 * "Day 2 of 4" when an event spans more than one day.
 *
 * `endsAt` is exclusive — an all-day event on the 15th ends at midnight on the
 * 16th — so the last day it actually occupies is the one containing `endsAt`
 * minus a millisecond. That single subtraction is the difference between "Day
 * 1 of 1" on every birthday and "Day 1 of 2". It is also right for a timed
 * event that ends at midnight, which occupies the evening before and not the
 * day it technically touches.
 */
function spanLabel(
  event: ManifestEvent,
  onDate: CivilDate,
  timezone: string,
): string | undefined {
  const first = localDate(event.startsAt, timezone);
  const last = localDate(event.endsAt - 1, timezone);
  const total = daysBetween(first, last) + 1;
  if (total < 2) return undefined;
  const position = daysBetween(first, onDate) + 1;
  if (position < 1 || position > total) return undefined;
  return `Day ${position} of ${total}`;
}

interface EventContext {
  readonly isPast: boolean;
  readonly isNext: boolean;
  /** Corrected wall time, for the progress bar. */
  readonly now: number;
  /** Which day's row this is being drawn in, for the span label. */
  readonly onDate: CivilDate;
}

function toEvent(
  event: ManifestEvent,
  timezone: string,
  hour12: boolean,
  people: ReadonlyMap<string, PersonModel>,
  context: EventContext,
): EventModel {
  return {
    id: event.id,
    sourceId: event.sourceId,
    title: event.title,
    time: eventTime(event, timezone, hour12),
    allDay: event.allDay,
    color: event.color,
    location: event.location,
    continues: event.continues,
    isPast: context.isPast,
    isNext: context.isNext,
    owner: event.personId !== undefined ? people.get(event.personId) : undefined,
    progress: runningProgress(event, context.now),
    span: spanLabel(event, context.onDate, timezone),
  };
}

/**
 * Mark what has been and what is next.
 *
 * Only today's list gets this. An all-day event is never "next" — it has no
 * time to be next at, and highlighting it would push the actual next thing
 * down the page.
 */
function markToday(
  events: readonly ManifestEvent[],
  now: number,
  timezone: string,
  hour12: boolean,
  people: ReadonlyMap<string, PersonModel>,
): EventModel[] {
  let foundNext = false;
  return events.map((event) => {
    const past = !event.allDay && event.endsAt <= now;
    const isNext = !past && !event.allDay && !foundNext && event.startsAt > now;
    if (isNext) foundNext = true;
    return toEvent(event, timezone, hour12, people, {
      isPast: past,
      isNext,
      now,
      onDate: localDate(now, timezone),
    });
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

function toDay(
  day: ManifestDay,
  today: CivilDate,
  now: number,
  timezone: string,
  hour12: boolean,
  limit: number,
  people: ReadonlyMap<string, PersonModel>,
  weatherByDate: ReadonlyMap<string, WeatherDayModel> = new Map(),
): DayModel {
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
    events: shown.map((event) =>
      toEvent(event, timezone, hour12, people, {
        isPast: false,
        isNext: false,
        now,
        onDate: day.date,
      }),
    ),
    hiddenEventCount: day.events.length - shown.length,
    weather: weatherByDate.get(day.date),
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

function weekdayIndex(date: CivilDate, weekStart: 'sunday' | 'monday'): number {
  // How many days `date` sits past the start of its week. `getUTCDay` is
  // Sunday-first (0 = Sunday); a Monday-first week rotates it by one.
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekStart === 'monday' ? (day + 6) % 7 : day;
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
  // 24-hour by default (the wall's original behaviour); 12-hour only when the
  // household has explicitly turned the setting off (RFC 005).
  const hour12 = chosen?.clock24 === false;
  // Sunday-start by default (and for a server too old to send the field); the
  // household can pick Monday on the Display screen.
  const weekStart: 'sunday' | 'monday' = chosen?.weekStart === 'monday' ? 'monday' : 'sunday';

  // The household, once, for the legend strip and the per-event owner cue. The
  // map is keyed by id so an event resolves its owner in one lookup; the list
  // keeps the server's order for the strip.
  const people = manifest.people.map(toPerson);
  const peopleById = new Map(people.map((person) => [person.id, person]));

  const byDate = new Map<CivilDate, ManifestDay>();
  for (const day of manifest.days) byDate.set(day.date, day);

  const todayDay = byDate.get(today);

  /*
   * The forecast, read once and indexed by date so a day can carry its own.
   *
   * Above the day building rather than beside the other panels below, because
   * `toDay` joins against it. A day with no forecast (beyond the window, or a
   * provider that gave no date) gets none — never its neighbour's, which is the
   * failure that would put tomorrow's rain on today's row and be believed.
   */
  const weather = weatherFrom(manifest.panels?.['weather']);
  const weatherByDate = new Map<string, WeatherDayModel>();
  for (const day of weather.days) {
    if (day.date !== undefined && !weatherByDate.has(day.date)) weatherByDate.set(day.date, day);
  }

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
    next.push(toDay(day, today, now, timezone, hour12, NEXT_EVENT_LIMIT, peopleById, weatherByDate));
  }

  // The horizon starts on the first day of the week containing today (Sunday or
  // Monday, per the household), so the grid lines up with how a month is read
  // rather than with when this happened to be fetched.
  const start = addDays(today, -weekdayIndex(today, weekStart));
  const cells: HorizonCell[] = [];
  const todayMonth = today.slice(0, 7);
  for (let offset = 0; offset < horizonWeeks * 7; offset++) {
    const date = addDays(start, offset);
    const day = byDate.get(date);
    // The first shift of the day, whether or not it is a working one.
    const shift = day?.shifts[0];
    /*
     * The grid's own events, which are not always the day's.
     *
     * A calendar with "Show on the calendar grid" turned off keeps every event
     * in the agenda and contributes none here — the server decided that and
     * stamped each event, so this only honours it. Filtered before `eventCount`
     * is taken, deliberately: the count is the true total a cell's "+N" reads
     * from, so counting the day and drawing the grid's would put a "+3" on a
     * cell whose three events are a standup nobody asked to see.
     */
    const events = (day?.events ?? []).filter((event) => event.showInGrid !== false);
    cells.push({
      date,
      // Short weekday for the week-columns header (Mon, Tue, …).
      weekday: parts(date, timezone).weekday,
      weekdayLong: longWeekday(date, timezone),
      dayNumber: String(Number(date.slice(8, 10))),
      weekNumber: day?.weekNumber,
      isToday: date === today,
      isPast: date < today,
      inMonth: date.slice(0, 7) === todayMonth,
      shiftToken: shift?.colorToken,
      shiftColor: shift?.color,
      shiftCode: shift?.shortCode,
      shiftLabel: shift?.label,
      eventCount: events.length,
      /*
       * Enough for the densest cell any style draws, and the *renderer* does
       * the cutting.
       *
       * Four was the old cap, chosen for a month cell that shows three. An
       * edge-to-edge week column is much taller than that and could show eight,
       * so capping here would have meant a household asking for a dense week
       * and getting four — the same shape as the agenda that was pre-cut to six
       * and could never honour a request for twelve.
       */
      events: events.slice(0, 12).map((e) => ({
        id: e.id,
        title: e.title,
        color: e.color,
        allDay: e.allDay,
        continues: e.continues,
        sourceId: e.sourceId,
        time: eventTime(e, timezone, hour12),
      })),
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

  const house = houseFrom(manifest.panels?.['home']);
  const chores = choresFrom(manifest.panels?.['chores']);

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
    clock: localTime(now, timezone, hour12),
    today:
      todayDay === undefined
        ? undefined
        : {
            ...toDay(todayDay, today, now, timezone, hour12, todayLimit, peopleById, weatherByDate),
            events: markToday(todayDay.events.slice(0, todayLimit), now, timezone, hour12, peopleById),
          },
    people,
    todayShifts: (todayDay?.shifts ?? []).map((shift) => ({
      shift,
      run: describeRun(byDate, today, shift),
    })),
    next,
    horizon: intoWeeks(cells),
    horizonMonth: horizonMonthLabel(cells, timezone),
    weather: weather.days,
    weatherNote: weather.note,
    externalPanels,
    chores,
    house: house.readings,
    houseNote: house.note,
    now,
    interrupts: interruptsFrom(manifest.interrupts),
    allowDismiss: manifest.screen?.allowDismiss === true,
    allowChores: manifest.screen?.allowChores === true,
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
  shift: ManifestShift,
): string | undefined {
  /*
   * The server's answer, when it has one.
   *
   * It resolves the rota itself and can follow a run to both its ends. What
   * follows is the old local count, kept only for a manifest from a server
   * older than that field — including one sitting in IndexedDB from before the
   * upgrade, which a wall can draw for months.
   *
   * The local count is wrong and cannot be made right here: it walks the days
   * *in the manifest*, and the manifest carries a single day of history, so it
   * cannot tell "the run started here" from "I ran out of data" and every run
   * longer than a day reads "Day 2 of N". It is a floor, not a fallback worth
   * trusting.
   */
  const run = shift.run;
  if (run !== undefined) {
    const after = run.total - run.position;
    if (after === 0) return `Last of ${run.total}`;
    return `Day ${run.position} of ${run.total} · ${after} more`;
  }

  /*
   * Matched on the person as well as the shift, because a day can carry an
   * entry for each of them and position in that list means nothing: with two
   * people on rotas, `shifts[0]` is whoever sorts first, not whoever this run
   * belongs to.
   */
  const sameAs = (date: CivilDate): boolean =>
    (byDate.get(date)?.shifts ?? []).some(
      (other) => other.personId === shift.personId && other.key === shift.key,
    );

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
