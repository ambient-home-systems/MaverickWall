import { parseJsonOr, z } from '../../validation.js';
import { isGlyphKey, type GlyphKey } from '../../glyphs.js';
import { haReadingHandle } from '../../api/manifest.js';

/**
 * Entity readings: parsing what Home Assistant says, and deciding how it reads.
 *
 * Pure. No database, no network, no clock beyond what is passed in — so what
 * the wall ends up showing can be argued about against a document rather than
 * a screenshot.
 *
 * The scope guardrail from the brief lives here in practice: this is a small
 * number of readings as ambient context. Lovelace exists, it is mature, and a
 * family calendar that happens to know the indoor temperature is a different
 * product from a dashboard — which is a sentence about what the wall *does*,
 * and it still holds.
 *
 * What changed on 2026-09-24 is the *look* and not the reach. This header used
 * to go on to say the wall would never draw a grid of tiles, because tiles
 * were Lovelace's; decision D4 (`docs/plan-2026-09-household-review.md`, P5.3)
 * adopts a Home Assistant tile-card look for a wall that wants one, and the
 * display draws it (`variant: 'tile'`). That is why a reading carries a `tone`,
 * a `changedAt` and, where its words carry a percentage, a `level` — a tile's
 * circle is coloured by the first, its "5 min ago" is read off the second and
 * its read-only bar is the third. Hard rule 12 is untouched: a tile shows a
 * state and controls nothing — no toggle, no slider, no tap action — and the
 * wall still receives a resolved value and never an entity id, an attribute,
 * the token or the address.
 */

/**
 * The domains a wall has any use for.
 *
 * Everything else is ignored — not hidden behind a filter somebody can widen,
 * just never read. A household with four hundred entities should see a picker
 * with the readable ones in it, and `automation.morning_routine` is not a
 * reading.
 */
export const SUPPORTED_DOMAINS = [
  'sensor',
  'binary_sensor',
  'weather',
  'person',
  'device_tracker',
  /*
   * Seven domains a household can *see* the state of, read-only (Q8, P5.3).
   *
   * Every one of them is also a domain Home Assistant can *control*, and that
   * is exactly why the sentence above matters here: reading a state is a GET of
   * `/api/states`, which this module has always made, and hard rule 12 governs
   * service calls. Watching `lock.front_door` puts "Unlocked" on the wall; it
   * gives the wall, or this process, no new way to change it. `HA_SERVICES`
   * stays exactly its two to-do members, and `ha-write-boundary.test.ts` is
   * what says so.
   */
  'light',
  'switch',
  'input_boolean',
  'fan',
  'cover',
  'lock',
  'climate',
] as const;

/*
 * `calendar` was in this list, and it was the wrong shape of answer.
 *
 * A calendar entity's *state* is `on` or `off`, meaning "an event is happening
 * right now" — so adding one here put a chip on the wall reading "Bins · On",
 * which is not a reading anybody wants and is not the calendar they were
 * after. It is the "Garage · on" fault again, except here no wording would
 * have rescued it: the thing a household means by "show my Home Assistant
 * calendar" is the events, and those already have a path — a calendar entity
 * becomes a real `calendar_sources` row (see `calendars.ts`) and is drawn by
 * the Calendar widgets like any other feed.
 *
 * So it is not offered as a reading at all rather than offered and useless.
 * The Home Assistant screen says where calendars go instead, and migration
 * 0031 un-watches the ones added before this.
 */

export type SupportedDomain = (typeof SUPPORTED_DOMAINS)[number];

export type DisplayMode = 'value' | 'label_value' | 'icon_state' | 'presence';

export const DISPLAY_MODES: readonly { key: DisplayMode; label: string }[] = [
  { key: 'label_value', label: 'Name and reading — Kitchen 19.4 °C' },
  { key: 'value', label: 'Just the reading — 19.4 °C' },
  { key: 'icon_state', label: 'Symbol and state — a door, then Closed' },
  { key: 'presence', label: 'Who is in — Ada · home' },
];

export interface HaState {
  readonly entityId: string;
  readonly domain: string;
  readonly state: string;
  readonly friendlyName: string;
  readonly unit: string | null;
  readonly deviceClass: string | null;
  /** Epoch milliseconds, or null when Home Assistant did not say. */
  readonly lastChangedAt: number | null;
  /** The allowlisted attributes and nothing else — see `ATTRIBUTE_ALLOWLIST`. */
  readonly attributes: HaAttributes;
}

/**
 * The attributes a reading may use, per domain, and nothing beyond them.
 *
 * The cache used to store one attribute, `device_class`, because that was all
 * a binary sensor needed to read "Open" rather than "on". The seven domains Q8
 * added each need one or three more to say what a tile says — a light's
 * brightness, a blind's position, what the heating is doing — and the tempting
 * shortcut is to cache the whole attributes object and read what is wanted
 * later. That would put an arbitrary integration's every field into a table a
 * backup carries and a diagnostics export sits beside: `entity_picture` is a
 * URL on the household's own Home Assistant, `rgb_color` is harmless until an
 * integration puts something that is not in the same object, and a camera
 * integration's `access_token` is an attribute too. So it is an allowlist, read
 * at the one place a state enters (`parseStates`) *and* at the one place it
 * leaves the cache (`pickAttributes` again, in `stateFrom`), and a key that is
 * not named here never reaches either side.
 *
 * `device_class` is not in this table because every domain keeps it, as it
 * always has.
 */
export const ATTRIBUTE_ALLOWLIST: Readonly<Partial<Record<SupportedDomain, readonly AttributeKey[]>>> = {
  light: ['brightness'],
  cover: ['current_position'],
  climate: ['current_temperature', 'temperature', 'hvac_action'],
  fan: ['percentage'],
};

export type AttributeKey =
  | 'brightness'
  | 'current_position'
  | 'current_temperature'
  | 'temperature'
  | 'hvac_action'
  | 'percentage';

export type HaAttributes = Readonly<Partial<{
  /** Home Assistant's 0-255, not a percentage. */
  brightness: number;
  /** 0-100, where 100 is fully open. */
  current_position: number;
  current_temperature: number;
  /** The set point. */
  temperature: number;
  /** What the device is doing (`heating`), as distinct from its mode (`heat`). */
  hvac_action: string;
  /** 0-100. */
  percentage: number;
}>>;

/**
 * One schema per allowlisted attribute, and each refuses rather than coerces.
 *
 * A brightness of `"153"` or `300` is an integration being wrong, and turning
 * it into a number or clamping it would put a confident "On · 100%" on the wall
 * over a value nobody sent. A refused attribute is an absent one: the reading
 * still draws, it just draws "On" — the same trade `attributeValue` makes for a
 * friendly name, and the same reason one bad field must not cost the entity.
 */
const ATTRIBUTE_SCHEMAS: Readonly<Record<AttributeKey, z.ZodType<number | string>>> = {
  brightness: z.number().int().min(0).max(255),
  current_position: z.number().int().min(0).max(100),
  current_temperature: z.number().finite().min(-100).max(200),
  temperature: z.number().finite().min(-100).max(200),
  hvac_action: z.string().regex(/^[a-z_]{1,32}$/),
  percentage: z.number().finite().min(0).max(100),
};

/**
 * The allowlisted attributes of one entity, from whatever object arrived.
 *
 * Total: an unknown domain, a non-object, and an object with none of the keys
 * all answer `{}`. Used on the way in from Home Assistant and again on the way
 * out of the cache, so a row written by an older release — or by hand — cannot
 * carry anything onward that this table does not name.
 */
export function pickAttributes(domain: string, raw: unknown): HaAttributes {
  const allowed = (ATTRIBUTE_ALLOWLIST as Readonly<Record<string, readonly AttributeKey[]>>)[domain];
  if (allowed === undefined || typeof raw !== 'object' || raw === null) return {};
  const picked: Record<string, number | string> = {};
  for (const key of allowed) {
    const shaped = ATTRIBUTE_SCHEMAS[key].safeParse((raw as Record<string, unknown>)[key]);
    if (shaped.success) picked[key] = shaped.data;
  }
  return picked as HaAttributes;
}

/**
 * What the cache's `attributes` column holds for one state.
 *
 * `device_class` first and always, so a reading from a domain with no
 * allowlist is stored exactly as it was before the allowlist existed —
 * `{"device_class":"door"}`, byte for byte.
 */
export function cachedAttributes(state: HaState): string {
  return JSON.stringify({ device_class: state.deviceClass, ...state.attributes });
}

export function domainOf(entityId: string): string {
  const dot = entityId.indexOf('.');
  return dot < 0 ? '' : entityId.slice(0, dot);
}

export function isSupported(entityId: string): boolean {
  return (SUPPORTED_DOMAINS as readonly string[]).includes(domainOf(entityId));
}

/**
 * An attribute, as some integration wrote it.
 *
 * Numbers are accepted and stringified because a unit or a friendly name
 * arriving as a number is a thing that happens, and refusing it would lose a
 * reading over a type. Anything else is absent.
 */
const attributeValue = z
  .union([z.string(), z.number().transform((n) => String(n))])
  .nullable()
  .catch(null);

/**
 * One entity from `/api/states`.
 *
 * Loose, because a house has integrations nobody here has heard of and every
 * one of them adds fields. `entity_id` is the only thing that must be present:
 * without it there is nothing to match a rule or a watch against.
 */
const haState = z.looseObject({
  entity_id: z.string().min(1),
  state: z.string().catch(''),
  last_changed: z.string().optional(),
  // Loose, so the allowlisted attributes are still here for `pickAttributes`
  // to read — and only for that: nothing downstream sees this object.
  attributes: z
    .looseObject({
      friendly_name: attributeValue,
      unit_of_measurement: attributeValue,
      device_class: attributeValue,
    })
    .catch({ friendly_name: null, unit_of_measurement: null, device_class: null }),
});

const haStates = z.array(z.unknown()).catch([]);

/**
 * Parse `/api/states`, keeping only what a wall can draw.
 *
 * Never throws and never partially fails: a single entity whose shape is
 * surprising is skipped, and the rest come through. One bad row in a house
 * with four hundred entities must not cost the other three hundred and
 * ninety-nine — the same lesson as one malformed VEVENT killing a feed.
 */
export function parseStates(body: string): HaState[] {
  const states: HaState[] = [];

  for (const entry of parseJsonOr(haStates, body, [])) {
    const shaped = haState.safeParse(entry);
    // One entity with a surprising shape must not cost the other three
    // hundred and ninety-nine in a real house.
    if (!shaped.success) continue;
    const record = shaped.data;
    if (!isSupported(record.entity_id)) continue;

    const changed = record.last_changed === undefined ? NaN : Date.parse(record.last_changed);

    states.push({
      entityId: record.entity_id,
      domain: domainOf(record.entity_id),
      state: record.state,
      friendlyName: record.attributes.friendly_name ?? record.entity_id,
      unit: record.attributes.unit_of_measurement,
      deviceClass: record.attributes.device_class,
      lastChangedAt: Number.isFinite(changed) ? changed : null,
      attributes: pickAttributes(domainOf(record.entity_id), record.attributes),
    });
  }
  return states;
}

/**
 * A glyph for a reading, by device class.
 *
 * Home Assistant names an icon like `mdi:thermometer`, which rule three forbids
 * the display from fetching — no icon font, no sprite sheet, nothing from a
 * third origin. What used to be here was an emoji per device class, which is
 * the same rule broken more quietly: the image ships no emoji font, so an
 * emoji is a third-party asset resolved on the device. It came out as one
 * vendor's cartoon in full colour on a tablet, another vendor's on the tablet
 * beside it, and nothing at all on a panel, where `asciiTitle` drops it.
 *
 * So what travels is a **key** from the first-party vocabulary, and each
 * renderer draws it. A device class with no glyph gets `null` and the wall
 * draws no glyph at all, which is the honest reading — the middle dot this used
 * to answer with was a character standing in for a picture nobody had.
 */
export function glyphFor(state: HaState): GlyphKey | null {
  const known: Readonly<Record<string, GlyphKey>> = {
    temperature: 'temperature',
    humidity: 'humidity',
    pressure: 'pressure',
    battery: 'battery',
    power: 'power',
    energy: 'power',
    illuminance: 'illuminance',
    door: 'door',
    // Its own glyph now rather than a second door: a garage is the one opening
    // in a house somebody drives at, and it is the reading a household checks.
    garage_door: 'garage',
    window: 'window',
    opening: 'door',
    // Two device classes the emoji drew as one pair of footprints. They answer
    // different questions — something moved, and somebody is here — and a wall
    // that cannot tell them apart is a wall reporting the cat as the family.
    motion: 'motion',
    occupancy: 'occupancy',
    moisture: 'moisture',
    // Likewise `smoke` and `gas`, which were both a flame.
    smoke: 'smoke',
    gas: 'gas',
    problem: 'problem',
    lock: 'lock',
  };
  if (state.deviceClass !== null && state.deviceClass in known) {
    return known[state.deviceClass] as GlyphKey;
  }
  if (state.domain === 'person' || state.domain === 'device_tracker') return 'person';
  if (state.domain === 'weather') return 'cloudy';
  // The seven read-only domains (Q8). A cover's device class has already
  // answered above when it is a door or a window; `garage` is a *cover* device
  // class, where the binary sensor's is `garage_door`, so it is named here.
  const byDomain: Readonly<Record<string, GlyphKey>> = {
    light: 'light',
    switch: 'switch',
    // A helper toggle is a switch nobody wired to anything, and reads as one.
    input_boolean: 'switch',
    fan: 'fan',
    cover: state.deviceClass === 'garage' ? 'garage' : 'cover',
    lock: 'lock',
    climate: 'thermostat',
  };
  return byDomain[state.domain] ?? null;
}

/**
 * Home Assistant's own words for a binary state, in English.
 *
 * `on`/`off` is what the API says and it is meaningless on a wall: a door
 * sensor reading "on" means open. The device class is what carries the
 * meaning, so it is what decides the wording.
 */
export function readState(state: HaState): string {
  /*
   * Presence has its own two words, and `not_home` is not one of them.
   *
   * Home Assistant answers `home` / `not_home` for a person, and anything
   * else is the name of a zone the household defined — "School", "Work" —
   * which is already the right thing to show and must be passed through
   * untouched.
   */
  if (state.domain === 'person' || state.domain === 'device_tracker') {
    if (state.state === 'home') return 'Home';
    if (state.state === 'not_home') return 'Away';
    return state.state;
  }

  const own = readOwnDomain(state);
  if (own !== undefined) return own;

  if (state.domain !== 'binary_sensor') return state.state;

  const pairs: Readonly<Record<string, readonly [string, string]>> = {
    door: ['Open', 'Closed'],
    garage_door: ['Open', 'Closed'],
    window: ['Open', 'Closed'],
    opening: ['Open', 'Closed'],
    lock: ['Unlocked', 'Locked'],
    moisture: ['Wet', 'Dry'],
    motion: ['Motion', 'Clear'],
    occupancy: ['Occupied', 'Empty'],
    smoke: ['Smoke', 'Clear'],
    gas: ['Gas', 'Clear'],
    problem: ['Problem', 'OK'],
    battery: ['Low', 'OK'],
    presence: ['Home', 'Away'],
  };

  const pair = state.deviceClass === null ? undefined : pairs[state.deviceClass];
  if (pair === undefined) return state.state === 'on' ? 'On' : state.state === 'off' ? 'Off' : state.state;
  return state.state === 'on' ? pair[0] : state.state === 'off' ? pair[1] : state.state;
}

/** First letter up, underscores to spaces — `heat_cool` is "Heat cool". */
function word(raw: string): string {
  const spaced = raw.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A reading's number, to one place and no trailing `.0`. */
function figure(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** The words a wall may pass on as they are; anything else is the raw state. */
const OWN_WORDS: Readonly<Record<string, readonly string[]>> = {
  light: ['on', 'off'],
  switch: ['on', 'off'],
  input_boolean: ['on', 'off'],
  fan: ['on', 'off'],
  cover: ['open', 'closed', 'opening', 'closing'],
  lock: ['locked', 'unlocked', 'locking', 'unlocking', 'jammed', 'open', 'opening'],
  climate: ['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only'],
};

/**
 * The seven read-only domains (Q8), in a household's words, or `undefined` for
 * a domain this does not speak for.
 *
 * Each says what a tile card says: "On · 60%", "Open · 40%", "Heating · 21°".
 * A state outside the domain's own vocabulary — `unavailable`, `unknown`, a
 * value an integration invented — is passed through untouched, for the reason
 * the binary sensor's `unavailable` is: inventing a word for it would be a lie.
 * And an attribute is appended only when it arrived and survived its schema,
 * so a light whose integration reports no brightness reads "On" rather than
 * "On · 0%".
 */
function readOwnDomain(state: HaState): string | undefined {
  const words = OWN_WORDS[state.domain];
  if (words === undefined) return undefined;
  if (!words.includes(state.state)) return state.state;
  const { attributes } = state;

  switch (state.domain) {
    case 'light': {
      const level = attributes.brightness;
      // 0-255 to a percentage, and never "0%" for a light that is on: a
      // brightness of 1 is a light somebody can see.
      if (state.state !== 'on' || level === undefined || level === 0) return word(state.state);
      return `On · ${Math.max(1, Math.round((level / 255) * 100))}%`;
    }
    case 'fan': {
      const speed = attributes.percentage;
      if (state.state !== 'on' || speed === undefined || speed === 0) return word(state.state);
      return `On · ${Math.round(speed)}%`;
    }
    case 'cover': {
      // A closed blind is at 0 by definition, so its position says nothing.
      const at = attributes.current_position;
      if (state.state === 'closed' || at === undefined) return word(state.state);
      return `${word(state.state)} · ${at}%`;
    }
    case 'climate': {
      /*
       * What it is *doing* before what it is *set to*.
       *
       * The state is the mode — `heat` means "allowed to heat" — and
       * `hvac_action` is whether it is heating right now, which is the thing a
       * household standing in a cold hallway wants to know. The mode is the
       * fallback for an integration that reports no action. The temperature is
       * the room's rather than the set point: a tile reading "Heating · 21°"
       * over a room at 17 would be describing the thermostat's wishes.
       */
      const doing = attributes.hvac_action;
      const lead = doing !== undefined ? word(doing) : word(state.state);
      const room = attributes.current_temperature;
      return room === undefined ? lead : `${lead} · ${figure(room)}°`;
    }
    default:
      return word(state.state);
  }
}

/**
 * How a tile should colour a reading: something is on, something is wrong, or
 * neither.
 *
 * `active` and `alert` are two different claims and the table keeps them
 * apart. A light being on is `active` — a fact, drawn in the accent. A door
 * being open is `alert`, because the reason anybody puts a door on a wall is to
 * be told when it is. Everything a table does not name is `null`, which is the
 * idle tile and the honest answer for a temperature: 19.4 °C is not on or off.
 */
export type ReadingTone = 'active' | 'alert';

/** A binary sensor's device class, when `on`. */
const BINARY_TONES: Readonly<Record<string, ReadingTone>> = {
  door: 'alert',
  window: 'alert',
  garage_door: 'alert',
  opening: 'alert',
  // `on` for a lock class means unlocked — `readState` says "Unlocked".
  lock: 'alert',
  moisture: 'alert',
  smoke: 'alert',
  gas: 'alert',
  safety: 'alert',
  problem: 'alert',
  motion: 'active',
  occupancy: 'active',
  presence: 'active',
};

/** A domain, and the states of it that carry a tone. */
const DOMAIN_TONES: Readonly<Record<string, Readonly<Record<string, ReadingTone>>>> = {
  /*
   * "Unlocked is alert", read as the lock entity's *states*: `open` is a lock
   * whose latch is drawn back, which is more unlocked than unlocked, and
   * `jammed` is a lock that cannot say it is locked. `locking` and `unlocking`
   * last a second and carry no tone.
   */
  lock: { unlocked: 'alert', open: 'alert', jammed: 'alert' },
  person: { home: 'active' },
  device_tracker: { home: 'active' },
  light: { on: 'active' },
  switch: { on: 'active' },
  fan: { on: 'active' },
  input_boolean: { on: 'active' },
  cover: { open: 'active' },
};

/** What a thermostat is doing that makes it `active`. Its mode never does. */
const CLIMATE_ACTIVE: readonly string[] = ['heating', 'cooling'];

export function toneFor(state: HaState): ReadingTone | null {
  if (state.domain === 'binary_sensor') {
    if (state.state !== 'on' || state.deviceClass === null) return null;
    return BINARY_TONES[state.deviceClass] ?? null;
  }
  if (state.domain === 'climate') {
    const doing = state.attributes.hvac_action;
    return doing !== undefined && CLIMATE_ACTIVE.includes(doing) ? 'active' : null;
  }
  return DOMAIN_TONES[state.domain]?.[state.state] ?? null;
}

/**
 * How far along a light, a fan or a blind is, 0-100, for a tile's read-only
 * bar (plan item P5.3) — or `null` for a reading that has no such number.
 *
 * **Exactly when `readOwnDomain` puts a percentage in the words, and the same
 * number.** A bar is a picture of "On · 60%", and a bar that disagreed with the
 * words under it — drawn for a light whose integration reports no brightness,
 * or at 0 for a light that is on — would be the wall saying two things about
 * one lamp. So each branch is `readOwnDomain`'s own condition, restated rather
 * than shared because that function returns words and the list's words must
 * not move (`ha-readings-before-tiles.json` is the pin), and `ha-units.test.ts`
 * holds the two to each other over every case: a level is present if and only
 * if the value ends in that level and a per-cent sign.
 *
 * A thermostat has no level, deliberately: its words carry a temperature, and a
 * bar from nothing to 21° is a scale nobody chose.
 */
export function levelFor(state: HaState): number | null {
  const words = OWN_WORDS[state.domain];
  if (words === undefined || !words.includes(state.state)) return null;
  const { attributes } = state;
  switch (state.domain) {
    case 'light': {
      const level = attributes.brightness;
      if (state.state !== 'on' || level === undefined || level === 0) return null;
      return Math.max(1, Math.round((level / 255) * 100));
    }
    case 'fan': {
      const speed = attributes.percentage;
      if (state.state !== 'on' || speed === undefined || speed === 0) return null;
      return Math.round(speed);
    }
    case 'cover': {
      const at = attributes.current_position;
      if (state.state === 'closed' || at === undefined) return null;
      return at;
    }
    default:
      return null;
  }
}

/**
 * Domains whose value already carries its own unit — a percentage, a degree —
 * so a `unit_of_measurement` an integration happened to set would be drawn
 * twice ("Heating · 21° °C").
 */
const VALUE_CARRIES_UNIT: readonly string[] = ['light', 'fan', 'cover', 'climate'];

/**
 * One reading, as the display receives it.
 *
 * Note what is *not* here: no entity id, no attributes, no address. The wall
 * gets the answer and nothing it could ask another question with. That is the
 * boundary the token's blast radius depends on — a compromised screen must not
 * be a way into the house.
 */
export interface EntityReading {
  /**
   * The handle a widget's `readings` resolves to (`haReadingHandle`, P1.3) —
   * minted here from the entity id, so the wall can match a reading a widget
   * picked without ever holding the id it was picked by, and a rename, which
   * changes `label`, cannot change it.
   */
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly unit: string | null;
  /** A glyph key, or `null` for a reading this vocabulary has no picture for. */
  readonly glyph: GlyphKey | null;
  readonly mode: DisplayMode;
  /** True when this reading is older than the wall should quietly trust. */
  readonly stale: boolean;
  /** `toneFor`'s answer: how a tile colours this reading, or `null` for idle. */
  readonly tone: ReadingTone | null;
  /**
   * When the *state* last changed, in epoch milliseconds, or `null` when Home
   * Assistant did not say.
   *
   * Home Assistant's `last_changed`, which moves only when the state does —
   * not `last_updated`, which moves on every attribute. That is what lets a
   * tile say "Open · 5 min ago" and still leave the manifest's ETag alone for
   * as long as the door stays open: the wall works out the "5 min ago" on its
   * own tick, and the document carries the instant, which does not move.
   */
  readonly changedAt: number | null;
  /**
   * `levelFor`'s answer, **only when there is one**: a light, a fan or a blind
   * whose words already carry a percentage. Absent rather than `null` on every
   * other reading, so a house with no dimmer on its wall sends the document it
   * sent before a tile had a bar — no ETag moves for a field nothing draws.
   */
  readonly level?: number;
}

export interface WatchedEntity {
  readonly entityId: string;
  readonly label: string | null;
  readonly displayMode: DisplayMode;
  readonly sortOrder: number;
  /**
   * The picture the household chose on the Readings screen, or nothing for the
   * automatic one (P5.3). Read defensively — a stored key a later release no
   * longer draws is the automatic picture, never a blank.
   */
  readonly glyph?: string | null;
}

/** Beyond this a reading is labelled rather than shown as if it were current. */
export const STALE_AFTER_MS = 15 * 60_000;

export function toReading(state: HaState, watch: WatchedEntity, fetchedAt: number, now: number): EntityReading {
  const mode = watch.displayMode;
  const level = levelFor(state);
  return {
    key: haReadingHandle(watch.entityId),
    label: watch.label ?? state.friendlyName,
    value: readState(state),
    // Duplicating the unit into the value would double it up in `value` mode,
    // where the whole point is that the unit is the only context there is.
    unit: VALUE_CARRIES_UNIT.includes(state.domain) ? null : state.unit,
    // The household's own picture first, when it is one this vocabulary still
    // draws; the device class's otherwise. On every look and both media, like
    // the label: one reading, one picture.
    glyph: isGlyphKey(watch.glyph) ? watch.glyph : glyphFor(state),
    mode,
    stale: now - fetchedAt > STALE_AFTER_MS,
    tone: toneFor(state),
    changedAt: state.lastChangedAt,
    ...(level === null ? {} : { level }),
  };
}
