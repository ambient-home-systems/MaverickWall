/**
 * Every Home Assistant service this application may call, and the one function
 * that can make a call from them (hard rule 12, RFC 018 §5).
 *
 * **A table, a constructor, a door.** `HA_SERVICES` names each permitted verb
 * once: the Home Assistant service it reaches, whether it reads or writes, who
 * may cause it, and the only data keys the server may send with it. `buildCall`
 * is the only function that turns a row into a call, and it is where every
 * limit RFC 018 sets is enforced — one entity, the right domain, an eligible
 * device class, a supported feature, a bounded value. `callService` in
 * `client.ts` is the only door a call leaves through, and it refuses any call
 * this module did not issue. `ha-write-boundary.test.ts` holds all three.
 *
 * **What the table cannot reach is the point of it.** There is no row for
 * `lock`, `alarm_control_panel`, `input_boolean`, `climate`, `button`,
 * `input_button`, `valve`, `siren`, `camera`, `automation`, `update`, `notify`,
 * `hassio` or `homeassistant`, and `buildCall` refuses an entity whose domain is
 * not its row's, so no argument can steer a row at one. A generic
 * `homeassistant.*` service would take an entity of any domain; there is none
 * here, and a test says so. A cover is refused unless its device class is one
 * of `COVER_CLASSES`, and an unset class is refused too: a garage door that
 * forgot to say so is still a garage door.
 *
 * **The wall never sends service data.** Every value a row carries is built
 * here from a number the caller bounded, so a wall that asks for brightness 300
 * is refused rather than clamped (rule five), and nothing a wall typed reaches
 * Home Assistant as a key.
 *
 * Phase 1 of RFC 018 landed this table; phase 2 wires the first control rows
 * to a route — the toggles in `WALL_ACTIONS` below, reached from `/d/ha/act`
 * through `control.ts`. Every other control row still has no caller.
 */

/** Whether a call can change anything in a house. */
export type ServiceKind = 'read' | 'write';

/**
 * Who may cause a call, which is a fact the route that receives a request
 * checks (RFC 018 §8): `server` is this process's own polling, `wall` is a
 * paired screen through `/d/*`, `companion` is the token-holding API and never
 * a wall.
 */
export type ServiceReach = 'server' | 'wall' | 'companion';

export interface ServiceRow {
  /** The Home Assistant service, as its URL path segment: `light/turn_on`. */
  readonly service: string;
  readonly kind: ServiceKind;
  readonly reach: ServiceReach;
  /** The only keys sent beside `entity_id`, in order. */
  readonly data: readonly string[];
  /** Home Assistant refuses a service that answers with data unless asked. */
  readonly returnResponse: boolean;
}

function row(
  service: string,
  kind: ServiceKind,
  reach: ServiceReach,
  data: readonly string[] = [],
  returnResponse = false,
): ServiceRow {
  return Object.freeze({ service, kind, reach, data: Object.freeze([...data]), returnResponse });
}

/**
 * The allowlist, frozen. Keyed by the action a caller names rather than by the
 * Home Assistant service, because one service carries several actions —
 * `light/turn_on` sets brightness, a colour or a colour temperature, each with
 * its own single data key — and the row is what decides which key may be sent.
 */
export const HA_SERVICES = Object.freeze({
  // RFC 012: the household's to-do lists.
  'todo.read': row('todo/get_items', 'read', 'server', ['status'], true),
  'todo.tick': row('todo/update_item', 'write', 'wall', ['item', 'status']),
  // RFC 018 §5.2 (MD10): from the companion API only, never a wall.
  'todo.add': row('todo/add_item', 'write', 'companion', ['item']),
  // RFC 018 §5: a read, for a household that picked a weather entity (M5.8).
  'weather.forecasts': row('weather/get_forecasts', 'read', 'server', ['type'], true),
  // RFC 018 §5: what a wall may operate, each behind three opt-ins.
  'light.toggle': row('light/toggle', 'write', 'wall'),
  'light.brightness': row('light/turn_on', 'write', 'wall', ['brightness_pct']),
  'light.colour': row('light/turn_on', 'write', 'wall', ['rgb_color']),
  'light.colour_temp': row('light/turn_on', 'write', 'wall', ['color_temp_kelvin']),
  'switch.toggle': row('switch/toggle', 'write', 'wall'),
  'fan.toggle': row('fan/toggle', 'write', 'wall'),
  'fan.speed': row('fan/set_percentage', 'write', 'wall', ['percentage']),
  'cover.open': row('cover/open_cover', 'write', 'wall'),
  'cover.close': row('cover/close_cover', 'write', 'wall'),
  'cover.stop': row('cover/stop_cover', 'write', 'wall'),
  'cover.position': row('cover/set_cover_position', 'write', 'wall', ['position']),
  'scene.run': row('scene/turn_on', 'write', 'wall'),
  'script.run': row('script/turn_on', 'write', 'wall'),
  'media_player.play_pause': row('media_player/media_play_pause', 'write', 'wall'),
  'media_player.next': row('media_player/media_next_track', 'write', 'wall'),
  'media_player.previous': row('media_player/media_previous_track', 'write', 'wall'),
  'media_player.volume': row('media_player/volume_set', 'write', 'wall', ['volume_level']),
} as const);

export type ServiceKey = keyof typeof HA_SERVICES;

/** The keys a wall may operate, which every take an entity's facts and maybe a value. */
export type ControlKey = Exclude<ServiceKey, 'todo.read' | 'todo.tick' | 'todo.add' | 'weather.forecasts'>;

/**
 * The only cover device classes a wall may move: things that shade a room.
 * Not `garage`, `gate`, `door`, `window` or `damper`, and not an unset class.
 */
export const COVER_CLASSES: readonly string[] = Object.freeze([
  'awning',
  'blind',
  'curtain',
  'shade',
  'shutter',
]);

/*
 * Feature bits, read from Home Assistant core's own `const.py` for each
 * domain. A row that needs a feature the entity does not report is refused
 * here rather than sent and refused by core in its own words.
 */
const COVER_OPEN = 1;
const COVER_CLOSE = 2;
const COVER_SET_POSITION = 4;
const COVER_STOP = 8;
const FAN_SET_SPEED = 1;
const MEDIA_PAUSE = 1;
const MEDIA_VOLUME_SET = 4;
const MEDIA_PREVIOUS_TRACK = 16;
const MEDIA_NEXT_TRACK = 32;
const MEDIA_PLAY = 16384;
const TODO_CREATE_ITEM = 1;

/** The colour modes that take an RGB colour. `color_temp` is its own row. */
const RGB_MODES: readonly string[] = ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'];

/**
 * The domains a wall may never reach (RFC 018 §5.1), by any route — directly,
 * or through a scene that sets one. A cover is judged by its device class,
 * below, because a blind is fine and a garage door is not.
 */
export const NEVER_DOMAINS: readonly string[] = Object.freeze([
  'lock', 'alarm_control_panel', 'climate', 'input_boolean', 'button', 'input_button', 'valve',
  'siren', 'camera', 'automation', 'update', 'notify', 'hassio', 'homeassistant',
]);

/** Whether a wall may never reach this entity, by any route (RFC 018 §5.1). */
export function neverFromAWall(entityId: string, deviceClass: string | null | undefined): boolean {
  const domain = domainOf(entityId);
  if (NEVER_DOMAINS.includes(domain)) return true;
  // A cover with no device class fails closed, as it does for a direct press.
  return domain === 'cover' && !COVER_CLASSES.includes(deviceClass ?? '');
}

/**
 * The first member of a scene a wall may never reach, or `undefined` when there
 * is none — or `null` when the scene does not say what it sets, which is
 * refused as though it set a lock (RFC 018 phase 4, decided 2026-10-05).
 *
 * A scene "sets every entity in it, including any lock or cover it names"
 * (§7.3), so running one from a wall is reaching each of its members. Home
 * Assistant lists them in the scene's `entity_id` attribute; each is judged by
 * the same rule a direct press is, with `classOf` answering a member's device
 * class from the house's current states. A script has no such list over the
 * REST API, which is why a script is warned about rather than checked.
 */
export function sceneReachesNever(
  sceneAttributes: unknown,
  classOf: (entityId: string) => string | null | undefined,
): string | undefined | null {
  const members =
    typeof sceneAttributes === 'object' && sceneAttributes !== null
      ? (sceneAttributes as Record<string, unknown>)['entity_id']
      : undefined;
  if (!Array.isArray(members) || members.some((member) => typeof member !== 'string')) return null;
  return (members as string[]).find((member) => neverFromAWall(member, classOf(member)));
}

/** A call this module issued. Opaque outside it: only `buildCall` makes one. */
export interface HaCall {
  readonly key: ServiceKey;
  readonly service: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly returnResponse: boolean;
}

/**
 * Every call `buildCall` has issued, so `callService` can refuse one it did
 * not. Weak, so a call is forgotten when its caller is.
 */
const ISSUED = new WeakSet<HaCall>();

/** Whether this module issued the call — the door asks before it opens. */
export function isIssuedCall(call: unknown): call is HaCall {
  return typeof call === 'object' && call !== null && ISSUED.has(call as HaCall);
}

export type CallRequest =
  | { readonly key: 'todo.read'; readonly entityId: string }
  | {
      readonly key: 'todo.tick';
      readonly entityId: string;
      /** Always the item's uid, never its summary (RFC 012 §3.4). */
      readonly item: string;
      readonly done: boolean;
    }
  | {
      readonly key: 'todo.add';
      readonly entityId: string;
      readonly text: string;
      /** The list's state attributes, for `supported_features`. */
      readonly attributes: unknown;
    }
  | {
      readonly key: 'weather.forecasts';
      readonly entityId: string;
      readonly type: 'daily' | 'hourly' | 'twice_daily';
    }
  | {
      readonly key: ControlKey;
      readonly entityId: string;
      /** The entity's state attributes as Home Assistant answered them, re-read at call time. */
      readonly attributes: unknown;
      /** A percentage (0–100), an RGB triple, or a colour temperature in kelvin. */
      readonly value?: number | readonly number[];
    };

export type RefusalCode =
  | 'unknown-service'
  | 'bad-entity'
  | 'wrong-domain'
  | 'not-eligible'
  | 'bad-value';

export type BuildResult =
  | { readonly ok: true; readonly call: HaCall }
  | { readonly ok: false; readonly code: RefusalCode; readonly message: string };

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

/** Item uids and to-do text: no control characters, at most 255 of anything else. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_TEXT = 255;

function refuse(code: RefusalCode, message: string): { readonly ok: false; readonly code: RefusalCode; readonly message: string } {
  return { ok: false, code, message };
}

function domainOf(entityId: string): string {
  return entityId.slice(0, entityId.indexOf('.'));
}

interface Facts {
  readonly deviceClass: string | undefined;
  readonly features: number;
  readonly colorModes: readonly string[];
  readonly minKelvin: number | undefined;
  readonly maxKelvin: number | undefined;
}

/** The attributes `buildCall` reads, read defensively: anything odd is absent. */
function factsOf(attributes: unknown): Facts {
  const a =
    typeof attributes === 'object' && attributes !== null
      ? (attributes as Record<string, unknown>)
      : {};
  const int = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
  const modes = Array.isArray(a['supported_color_modes'])
    ? a['supported_color_modes'].filter((m): m is string => typeof m === 'string')
    : [];
  return {
    deviceClass: typeof a['device_class'] === 'string' ? a['device_class'] : undefined,
    features: int(a['supported_features']) ?? 0,
    colorModes: modes,
    minKelvin: int(a['min_color_temp_kelvin']),
    maxKelvin: int(a['max_color_temp_kelvin']),
  };
}

function wholeNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

const NOT_ELIGIBLE = "That can't be operated from a wall.";
const BAD_VALUE = 'That setting is out of range.';

/**
 * Whether a control row may act on an entity with these facts, and the one data
 * value it would send. `undefined` data means a row that sends none.
 */
function controlData(
  key: ControlKey,
  facts: Facts,
  value: number | readonly number[] | undefined,
):
  | { readonly ok: true; readonly data: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly code: RefusalCode; readonly message: string } {
  const none = { ok: true as const, data: {} };
  const needs = (bit: number) => (facts.features & bit) !== 0;
  const notEligible = { ok: false as const, code: 'not-eligible' as const, message: NOT_ELIGIBLE };
  const badValue = { ok: false as const, code: 'bad-value' as const, message: BAD_VALUE };

  if (key.startsWith('cover.') && !COVER_CLASSES.includes(facts.deviceClass ?? '')) {
    return notEligible;
  }

  switch (key) {
    case 'light.toggle':
    case 'switch.toggle':
    case 'fan.toggle':
    case 'scene.run':
    case 'script.run':
      return none;
    case 'light.brightness': {
      if (!facts.colorModes.some((mode) => mode !== 'onoff')) return notEligible;
      const pct = wholeNumber(value, 1, 100);
      return pct === undefined ? badValue : { ok: true, data: { brightness_pct: pct } };
    }
    case 'light.colour': {
      if (!facts.colorModes.some((mode) => RGB_MODES.includes(mode))) return notEligible;
      if (!Array.isArray(value) || value.length !== 3) return badValue;
      const rgb = value.map((channel) => wholeNumber(channel, 0, 255));
      return rgb.some((channel) => channel === undefined)
        ? badValue
        : { ok: true, data: { rgb_color: rgb } };
    }
    case 'light.colour_temp': {
      const { minKelvin, maxKelvin } = facts;
      if (!facts.colorModes.includes('color_temp') || minKelvin === undefined || maxKelvin === undefined) {
        return notEligible;
      }
      const kelvin = wholeNumber(value, minKelvin, maxKelvin);
      return kelvin === undefined ? badValue : { ok: true, data: { color_temp_kelvin: kelvin } };
    }
    case 'fan.speed': {
      if (!needs(FAN_SET_SPEED)) return notEligible;
      const pct = wholeNumber(value, 0, 100);
      return pct === undefined ? badValue : { ok: true, data: { percentage: pct } };
    }
    case 'cover.open':
      return needs(COVER_OPEN) ? none : notEligible;
    case 'cover.close':
      return needs(COVER_CLOSE) ? none : notEligible;
    case 'cover.stop':
      return needs(COVER_STOP) ? none : notEligible;
    case 'cover.position': {
      if (!needs(COVER_SET_POSITION)) return notEligible;
      const position = wholeNumber(value, 0, 100);
      return position === undefined ? badValue : { ok: true, data: { position } };
    }
    case 'media_player.play_pause':
      // Core registers it for either feature, so either makes it eligible.
      return needs(MEDIA_PAUSE) || needs(MEDIA_PLAY) ? none : notEligible;
    case 'media_player.next':
      return needs(MEDIA_NEXT_TRACK) ? none : notEligible;
    case 'media_player.previous':
      return needs(MEDIA_PREVIOUS_TRACK) ? none : notEligible;
    case 'media_player.volume': {
      if (!needs(MEDIA_VOLUME_SET)) return notEligible;
      // The wall speaks percentages; Home Assistant speaks 0.0–1.0.
      const pct = wholeNumber(value, 0, 100);
      return pct === undefined ? badValue : { ok: true, data: { volume_level: pct / 100 } };
    }
  }
}

type Validated =
  | { readonly ok: true; readonly row: ServiceRow; readonly body: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly code: RefusalCode; readonly message: string };

/**
 * Every check `buildCall` makes, with nothing issued.
 *
 * Exported so the admin and the manifest can ask "could a wall operate this?"
 * with exactly the rule the door will apply, rather than a second opinion that
 * drifts from it — the shape this project keeps finding when two places hold
 * one rule. It registers nothing, so its answer cannot be posted.
 */
export function validateCall(request: CallRequest): Validated {
  const row = (HA_SERVICES as Record<string, ServiceRow | undefined>)[request.key];
  if (row === undefined) return refuse('unknown-service', 'That is not something this wall can do.');

  const { entityId } = request;
  if (typeof entityId !== 'string' || !ENTITY_ID.test(entityId)) {
    return refuse('bad-entity', 'That is not something in your house this wall knows about.');
  }
  const rowDomain = row.service.slice(0, row.service.indexOf('/'));
  if (domainOf(entityId) !== rowDomain) return refuse('wrong-domain', NOT_ELIGIBLE);

  let data: Readonly<Record<string, unknown>>;
  switch (request.key) {
    case 'todo.read':
      data = { status: ['needs_action', 'completed'] };
      break;
    case 'todo.tick': {
      const item = request.item;
      if (typeof item !== 'string' || item === '' || item.length > MAX_TEXT || CONTROL.test(item)) {
        return refuse('bad-value', 'That is not on the list any more.');
      }
      data = { item, status: request.done ? 'completed' : 'needs_action' };
      break;
    }
    case 'todo.add': {
      if ((factsOf(request.attributes).features & TODO_CREATE_ITEM) === 0) {
        return refuse('not-eligible', 'That list does not let anything be added from here.');
      }
      const text = typeof request.text === 'string' ? request.text.trim() : '';
      if (text === '' || text.length > MAX_TEXT || CONTROL.test(text)) {
        return refuse('bad-value', 'That item is empty or too long to add.');
      }
      data = { item: text };
      break;
    }
    case 'weather.forecasts': {
      if (!['daily', 'hourly', 'twice_daily'].includes(request.type)) {
        return refuse('bad-value', 'That is not a kind of forecast.');
      }
      data = { type: request.type };
      break;
    }
    default: {
      const control = controlData(request.key, factsOf(request.attributes), request.value);
      if (!control.ok) return refuse(control.code, control.message);
      data = control.data;
    }
  }

  return { ok: true, row, body: Object.freeze({ entity_id: entityId, ...data }) };
}

/**
 * Make a call from the table, or say why not. The only constructor of an
 * `HaCall` in this repository, and it never throws: every refusal is a code
 * for the route and a sentence for somebody standing in a kitchen.
 *
 * The body is always `{ entity_id: <one id>, ...the row's data }` — never an
 * `area_id`, `device_id`, `label_id` or `all`, and never a key the row does not
 * name.
 */
export function buildCall(request: CallRequest): BuildResult {
  const checked = validateCall(request);
  if (!checked.ok) return checked;
  const call: HaCall = Object.freeze({
    key: request.key,
    service: checked.row.service,
    body: checked.body,
    returnResponse: checked.row.returnResponse,
  });
  ISSUED.add(call);
  return { ok: true, call };
}

/**
 * What a wall may ask for, in its own words, and the row each word reaches per
 * domain — only the rows a route exists for (RFC 018 §12). Phase 2 is the
 * toggles; phase 3 is brightness, colour, white, fan speed and a shading
 * cover's open, close, stop and position. Scenes, scripts and media transport
 * land here as their phases do.
 *
 * Open, close and stop are in phase 3 although RFC 018's phase list names only
 * position: a blind has no toggle, so a blind whose panel could set a position
 * and could not open it would be a strange thing to hand a household, and the
 * three are rows phase 1 already built.
 */
export const WALL_ACTIONS: Readonly<Record<string, Readonly<Record<string, ControlKey>>>> = Object.freeze({
  toggle: Object.freeze({ light: 'light.toggle', switch: 'switch.toggle', fan: 'fan.toggle' }),
  brightness: Object.freeze({ light: 'light.brightness' }),
  colour: Object.freeze({ light: 'light.colour' }),
  colour_temp: Object.freeze({ light: 'light.colour_temp' }),
  speed: Object.freeze({ fan: 'fan.speed' }),
  open: Object.freeze({ cover: 'cover.open' }),
  close: Object.freeze({ cover: 'cover.close' }),
  stop: Object.freeze({ cover: 'cover.stop' }),
  position: Object.freeze({ cover: 'cover.position' }),
  // Phase 4: a scene or a script, run with no variables. The wall asks for a
  // press-and-hold before it sends this word; the server cannot tell a hold
  // from a tap and does not pretend to — the three switches are its check.
  run: Object.freeze({ scene: 'scene.run', script: 'script.run' }),
  // Phase 6: a media player's transport and its volume, the now-playing
  // card's controls (plan item M6.9) and nothing else a player can do.
  play_pause: Object.freeze({ media_player: 'media_player.play_pause' }),
  next: Object.freeze({ media_player: 'media_player.next' }),
  previous: Object.freeze({ media_player: 'media_player.previous' }),
  volume: Object.freeze({ media_player: 'media_player.volume' }),
});

/** The words that carry a value, and what shape it takes. */
export const WALL_ACTION_VALUES: Readonly<Record<string, 'number' | 'rgb'>> = Object.freeze({
  brightness: 'number',
  colour: 'rgb',
  colour_temp: 'number',
  speed: 'number',
  position: 'number',
  // 0-100 from the wall; `controlData` turns it into Home Assistant's 0.0-1.0.
  volume: 'number',
});

export type WallAction = keyof typeof WALL_ACTIONS;

/** The row a wall's word reaches for this entity, or `undefined`. */
export function wallActionKey(action: string, entityId: string): ControlKey | undefined {
  const byDomain = (WALL_ACTIONS as Record<string, Readonly<Record<string, ControlKey>> | undefined>)[action];
  return byDomain?.[entityId.slice(0, entityId.indexOf('.'))];
}

/**
 * The words a wall may use on this entity right now: every action with a route
 * whose row `validateCall` accepts for these attributes. Empty for a sensor, a
 * lock, a garage door, or anything a later phase has not wired yet.
 *
 * A row that takes a value is asked with none, so its answer is "out of range"
 * for an eligible entity and "not eligible" for one it may never reach — and
 * only the second is a no. That is the door's own rule, asked one step short of
 * the value, rather than a second list of which lights dim.
 */
export function wallActionsFor(entityId: string, attributes: unknown): readonly string[] {
  return Object.keys(WALL_ACTIONS).filter((action) => {
    const key = wallActionKey(action, entityId);
    if (key === undefined) return false;
    const checked = validateCall({ key, entityId, attributes });
    return checked.ok || (WALL_ACTION_VALUES[action] !== undefined && checked.code === 'bad-value');
  });
}
