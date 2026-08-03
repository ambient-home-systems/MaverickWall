/**
 * Entity readings: parsing what Home Assistant says, and deciding how it reads.
 *
 * Pure. No database, no network, no clock beyond what is passed in — so what
 * the wall ends up showing can be argued about against a document rather than
 * a screenshot.
 *
 * The scope guardrail from the brief lives here in practice: this is a small
 * number of readings as ambient context, drawn typographically. It is not a
 * tile grid and it is not a card ecosystem. Lovelace exists, it is mature, and
 * a family calendar that happens to know the indoor temperature is a different
 * product from a dashboard.
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
  'calendar',
] as const;

export type SupportedDomain = (typeof SUPPORTED_DOMAINS)[number];

export type DisplayMode = 'value' | 'label_value' | 'icon_state' | 'presence';

export const DISPLAY_MODES: readonly { key: DisplayMode; label: string }[] = [
  { key: 'label_value', label: 'Name and reading — Kitchen 19.4 °C' },
  { key: 'value', label: 'Just the reading — 19.4 °C' },
  { key: 'icon_state', label: 'Symbol and state — ⌂ Closed' },
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
}

export function domainOf(entityId: string): string {
  const dot = entityId.indexOf('.');
  return dot < 0 ? '' : entityId.slice(0, dot);
}

export function isSupported(entityId: string): boolean {
  return (SUPPORTED_DOMAINS as readonly string[]).includes(domainOf(entityId));
}

interface RawState {
  readonly entity_id?: unknown;
  readonly state?: unknown;
  readonly last_changed?: unknown;
  readonly attributes?: unknown;
}

function attribute(attributes: unknown, name: string): string | null {
  if (typeof attributes !== 'object' || attributes === null) return null;
  const value = (attributes as Record<string, unknown>)[name];
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : null;
}

/**
 * Parse `/api/states`, keeping only what a wall can draw.
 *
 * Never throws and never partially fails: a single entity whose shape is
 * surprising is skipped, and the rest come through. One bad row in a house
 * with four hundred entities must not cost the other three hundred and
 * ninety-nine — the same lesson as one malformed VEVENT killing a feed.
 */
export function parseStates(body: string): HaState[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const states: HaState[] = [];
  for (const entry of parsed as RawState[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const entityId = entry.entity_id;
    if (typeof entityId !== 'string' || !isSupported(entityId)) continue;

    const changed = typeof entry.last_changed === 'string' ? Date.parse(entry.last_changed) : NaN;

    states.push({
      entityId,
      domain: domainOf(entityId),
      state: typeof entry.state === 'string' ? entry.state : '',
      friendlyName: attribute(entry.attributes, 'friendly_name') ?? entityId,
      unit: attribute(entry.attributes, 'unit_of_measurement'),
      deviceClass: attribute(entry.attributes, 'device_class'),
      lastChangedAt: Number.isFinite(changed) ? changed : null,
    });
  }
  return states;
}

/**
 * A character for a reading.
 *
 * Home Assistant names an icon like `mdi:thermometer`, which rule three
 * forbids the display from fetching — no icon font, no sprite sheet, nothing
 * from a third origin. So the device class is mapped to a character the wall
 * already has, the same trick the weather module uses for its forecast.
 */
export function iconFor(state: HaState): string {
  const known: Readonly<Record<string, string>> = {
    temperature: '🌡',
    humidity: '💧',
    pressure: '⏱',
    battery: '🔋',
    power: '⚡',
    energy: '⚡',
    illuminance: '☀',
    door: '🚪',
    garage_door: '🚪',
    window: '🪟',
    opening: '🚪',
    motion: '👣',
    occupancy: '👣',
    moisture: '💦',
    smoke: '🔥',
    gas: '🔥',
    problem: '⚠',
    lock: '🔒',
  };
  if (state.deviceClass !== null && state.deviceClass in known) {
    return known[state.deviceClass] as string;
  }
  if (state.domain === 'person' || state.domain === 'device_tracker') return '🧍';
  if (state.domain === 'weather') return '☁';
  if (state.domain === 'calendar') return '🗓';
  return '·';
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

/**
 * One reading, as the display receives it.
 *
 * Note what is *not* here: no entity id, no attributes, no address. The wall
 * gets the answer and nothing it could ask another question with. That is the
 * boundary the token's blast radius depends on — a compromised screen must not
 * be a way into the house.
 */
export interface EntityReading {
  readonly label: string;
  readonly value: string;
  readonly unit: string | null;
  readonly icon: string;
  readonly mode: DisplayMode;
  /** True when this reading is older than the wall should quietly trust. */
  readonly stale: boolean;
}

export interface WatchedEntity {
  readonly entityId: string;
  readonly label: string | null;
  readonly displayMode: DisplayMode;
  readonly sortOrder: number;
}

/** Beyond this a reading is labelled rather than shown as if it were current. */
export const STALE_AFTER_MS = 15 * 60_000;

export function toReading(state: HaState, watch: WatchedEntity, fetchedAt: number, now: number): EntityReading {
  const mode = watch.displayMode;
  return {
    label: watch.label ?? state.friendlyName,
    value: readState(state),
    // Duplicating the unit into the value would double it up in `value` mode,
    // where the whole point is that the unit is the only context there is.
    unit: state.unit,
    icon: iconFor(state),
    mode,
    stale: now - fetchedAt > STALE_AFTER_MS,
  };
}
