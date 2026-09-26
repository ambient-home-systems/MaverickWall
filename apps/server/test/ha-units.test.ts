import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATTRIBUTE_ALLOWLIST,
  cachedAttributes,
  domainOf,
  glyphFor,
  isSupported,
  parseStates,
  pickAttributes,
  readState,
  SUPPORTED_DOMAINS,
  toneFor,
  toReading,
  type DisplayMode,
  type HaAttributes,
  type HaState,
  type ReadingTone,
} from '../src/modules/homeassistant/entities.js';
import { isGlyphKey } from '../src/glyphs.js';
import {
  eventsPath,
  parseCalendarEvents,
  parseCalendarList,
} from '../src/modules/homeassistant/calendars.js';
import { RULE_TEMPLATES } from '../src/http/rule-templates.js';

/**
 * The pure half of the Home Assistant integration.
 *
 * The end-to-end file next door proves the wiring against a real socket; this
 * one is about the shapes that are hard to produce on demand — a calendar with
 * no uid, a reversed date pair, an edge that happened three hours ago.
 */

const NOW = Date.parse('2026-08-02T12:00:00Z');

function state(over: Partial<HaState> = {}): HaState {
  return {
    entityId: 'binary_sensor.door',
    domain: 'binary_sensor',
    state: 'on',
    friendlyName: 'Door',
    unit: null,
    deviceClass: 'door',
    lastChangedAt: NOW - 60_000,
    attributes: {},
    ...over,
  };
}

describe('reading entities', () => {
  it('keeps only the domains a wall has any use for', () => {
    expect(isSupported('sensor.temperature')).toBe(true);
    expect(isSupported('binary_sensor.door')).toBe(true);
    expect(isSupported('automation.morning')).toBe(false);
    /*
     * A calendar is not a reading, and it used to be one.
     *
     * Its state is `on`/`off`, meaning "an event is happening right now", so
     * adding `calendar.bins` here put "Bins · On" on the wall — not a reading
     * anybody wants and not the calendar they were after. A household reported
     * exactly that. Calendar entities have their own path (`calendars.ts`,
     * which turns one into a real `calendar_sources` row), so this domain is
     * refused rather than offered and useless.
     */
    expect(isSupported('calendar.family')).toBe(false);
    /*
     * Seven domains a household can see the state of, since Q8 (P5.3).
     *
     * This assertion said the opposite until then — "nothing that could be
     * mistaken for a control surface" — and the reason it could be reversed is
     * the reason it was written: a *reading* is a GET of `/api/states`, and a
     * control is a service call, which hard rule 12 governs and
     * `ha-write-boundary.test.ts` holds to two to-do members. Watching a lock
     * puts "Unlocked" on the wall and no way to change it anywhere.
     */
    for (const domain of ['light', 'switch', 'input_boolean', 'fan', 'cover', 'lock', 'climate']) {
      expect(isSupported(`${domain}.thing`), domain).toBe(true);
    }
    // And still not the rest of rule 12's list, nor anything else that is a
    // control and nothing but: these have no state a wall has a use for.
    for (const domain of ['alarm_control_panel', 'scene', 'script', 'automation', 'camera', 'button']) {
      expect(isSupported(`${domain}.thing`), domain).toBe(false);
    }
    expect(SUPPORTED_DOMAINS).toHaveLength(12);
    expect(domainOf('no-dot-here')).toBe('');
  });

  it('skips one surprising entity rather than losing the rest', () => {
    // The same lesson as one malformed VEVENT killing a whole feed.
    const body = JSON.stringify([
      { entity_id: 'sensor.a', state: '1', attributes: { friendly_name: 'A' } },
      null,
      { entity_id: 42 },
      { state: 'orphan' },
      { entity_id: 'sensor.b', state: '2', attributes: null },
    ]);
    expect(parseStates(body).map((entry) => entry.entityId)).toEqual(['sensor.a', 'sensor.b']);
  });

  it('falls back to the entity id when nothing named it', () => {
    const parsed = parseStates(JSON.stringify([{ entity_id: 'sensor.b', state: '2' }]));
    expect(parsed[0]?.friendlyName).toBe('sensor.b');
    expect(parsed[0]?.lastChangedAt).toBeNull();
  });

  it('returns nothing at all for a body that is not a state list', () => {
    expect(parseStates('not json')).toEqual([]);
    expect(parseStates('null')).toEqual([]);
    expect(parseStates('{"message":"Unauthorized"}')).toEqual([]);
  });

  it('says what a binary sensor means rather than what it says', () => {
    // `on` for a door means open, and only the device class knows that. A wall
    // reading "on" has told a household nothing.
    expect(readState(state({ deviceClass: 'door', state: 'on' }))).toBe('Open');
    expect(readState(state({ deviceClass: 'door', state: 'off' }))).toBe('Closed');
    expect(readState(state({ deviceClass: 'moisture', state: 'on' }))).toBe('Wet');
    expect(readState(state({ deviceClass: 'lock', state: 'off' }))).toBe('Locked');
    // No device class: still better than the raw value.
    expect(readState(state({ deviceClass: null, state: 'on' }))).toBe('On');
    // `unavailable` is neither, and inventing a word for it would be a lie.
    expect(readState(state({ state: 'unavailable' }))).toBe('unavailable');
    // Anything not a binary sensor is passed through untouched.
    expect(readState(state({ domain: 'sensor', state: '19.4' }))).toBe('19.4');
  });

  it("says Home and Away, and leaves a household's own zone alone", () => {
    expect(readState(state({ domain: 'person', state: 'home' }))).toBe('Home');
    expect(readState(state({ domain: 'person', state: 'not_home' }))).toBe('Away');
    expect(readState(state({ domain: 'device_tracker', state: 'not_home' }))).toBe('Away');
    // A zone the household named. Already the right thing to show.
    expect(readState(state({ domain: 'person', state: 'School' }))).toBe('School');
  });

  it('names a first-party glyph rather than fetching an icon', () => {
    // Rule three: Home Assistant offers an icon URL and the wall may not fetch
    // one — and an emoji is a fetch too, resolved on the device out of a font
    // this image does not ship. So the device class names a key both renderers
    // draw themselves.
    expect(glyphFor(state({ deviceClass: 'temperature' }))).toBe('temperature');
    expect(glyphFor(state({ deviceClass: 'moisture' }))).toBe('moisture');
    expect(glyphFor(state({ domain: 'person', deviceClass: null }))).toBe('person');
  });

  it('tells apart the pairs the emoji drew as one picture', () => {
    // Two footprints for `motion` and `occupancy`, one flame for `smoke` and
    // `gas`, one door for a door and a garage. Each pair answers a different
    // question and a wall that cannot separate them reports the cat as family.
    expect(glyphFor(state({ deviceClass: 'motion' }))).not.toBe(
      glyphFor(state({ deviceClass: 'occupancy' })),
    );
    expect(glyphFor(state({ deviceClass: 'smoke' }))).not.toBe(
      glyphFor(state({ deviceClass: 'gas' })),
    );
    expect(glyphFor(state({ deviceClass: 'garage_door' }))).not.toBe(
      glyphFor(state({ deviceClass: 'door' })),
    );
  });

  it('answers null for a device class with no glyph, never a stand-in character', () => {
    // The middle dot this used to answer with was a character standing in for a
    // picture nobody had drawn. Nothing at all is the honest reading, and it is
    // what lets the renderer give the rung's room back.
    expect(glyphFor(state({ domain: 'sensor', deviceClass: 'unheard-of' }))).toBeNull();
  });
});

/**
 * The tone table, written out as rows before anything asserts about it.
 *
 * Table-first because the table *is* the decision (P5.3, D4): each row is one
 * sentence a household would agree with or not — a door open is worth
 * noticing, a light on is merely a fact, a temperature is neither — and a row
 * is where an argument about one of them belongs. `toneFor` is held to every
 * row, so changing a tone is changing a line here.
 */
const TONES: readonly (readonly [
  domain: string,
  deviceClass: string | null,
  state: string,
  attributes: HaAttributes,
  tone: ReadingTone | null,
])[] = [
  // Openings: open is an alert, closed is idle.
  ['binary_sensor', 'door', 'on', {}, 'alert'],
  ['binary_sensor', 'door', 'off', {}, null],
  ['binary_sensor', 'window', 'on', {}, 'alert'],
  ['binary_sensor', 'garage_door', 'on', {}, 'alert'],
  ['binary_sensor', 'opening', 'on', {}, 'alert'],
  ['binary_sensor', 'opening', 'off', {}, null],
  // A lock: unlocked is an alert, whichever of the two entities says so.
  ['binary_sensor', 'lock', 'on', {}, 'alert'],
  ['binary_sensor', 'lock', 'off', {}, null],
  ['lock', null, 'unlocked', {}, 'alert'],
  ['lock', null, 'open', {}, 'alert'],
  ['lock', null, 'jammed', {}, 'alert'],
  ['lock', null, 'locked', {}, null],
  ['lock', null, 'locking', {}, null],
  ['lock', null, 'unlocking', {}, null],
  // Hazards.
  ['binary_sensor', 'moisture', 'on', {}, 'alert'],
  ['binary_sensor', 'moisture', 'off', {}, null],
  ['binary_sensor', 'smoke', 'on', {}, 'alert'],
  ['binary_sensor', 'gas', 'on', {}, 'alert'],
  ['binary_sensor', 'safety', 'on', {}, 'alert'],
  ['binary_sensor', 'problem', 'on', {}, 'alert'],
  ['binary_sensor', 'problem', 'off', {}, null],
  // Somebody, or something, is here.
  ['binary_sensor', 'motion', 'on', {}, 'active'],
  ['binary_sensor', 'motion', 'off', {}, null],
  ['binary_sensor', 'occupancy', 'on', {}, 'active'],
  ['binary_sensor', 'presence', 'on', {}, 'active'],
  ['person', null, 'home', {}, 'active'],
  ['person', null, 'not_home', {}, null],
  // A zone the household named is somewhere, and not home.
  ['person', null, 'School', {}, null],
  ['device_tracker', null, 'home', {}, 'active'],
  ['device_tracker', null, 'not_home', {}, null],
  // Things that are on.
  ['light', null, 'on', { brightness: 153 }, 'active'],
  ['light', null, 'off', {}, null],
  ['switch', 'outlet', 'on', {}, 'active'],
  ['switch', null, 'off', {}, null],
  ['fan', null, 'on', { percentage: 40 }, 'active'],
  ['fan', null, 'off', {}, null],
  ['input_boolean', null, 'on', {}, 'active'],
  ['input_boolean', null, 'off', {}, null],
  ['cover', 'blind', 'open', { current_position: 40 }, 'active'],
  ['cover', 'blind', 'closed', {}, null],
  ['cover', 'garage', 'open', {}, 'active'],
  // A thermostat is active while it is heating or cooling — never for its mode.
  ['climate', null, 'heat', { hvac_action: 'heating' }, 'active'],
  ['climate', null, 'cool', { hvac_action: 'cooling' }, 'active'],
  ['climate', null, 'heat', { hvac_action: 'idle' }, null],
  ['climate', null, 'heat', {}, null],
  ['climate', null, 'off', { hvac_action: 'off' }, null],
  // A reading is neither.
  ['sensor', 'temperature', '19.4', {}, null],
  ['sensor', 'power', '1200', {}, null],
  ['weather', null, 'sunny', {}, null],
  // A binary sensor the table does not name, or with no class, is neither too:
  // `on` for "battery" is low, and low battery is not what a tile shouts about.
  ['binary_sensor', 'battery', 'on', {}, null],
  ['binary_sensor', null, 'on', {}, null],
  // Nothing is a tone while Home Assistant does not know.
  ['light', null, 'unavailable', {}, null],
  ['binary_sensor', 'door', 'unavailable', {}, null],
  ['lock', null, 'unknown', {}, null],
];

describe('the tone table', () => {
  it.each(TONES)('%s (%s) reading %s %o is %s', (domain, deviceClass, value, attributes, tone) => {
    expect(toneFor(state({ domain, deviceClass, state: value, attributes }))).toBe(tone);
  });

  it('covers every domain a wall can watch', () => {
    // A domain added to the list with no row here would be a tile nobody had
    // decided the colour of. It would read idle, which is the right *default*,
    // and a row is still the place that says so on purpose.
    const tabled = new Set(TONES.map(([domain]) => domain));
    for (const domain of SUPPORTED_DOMAINS) expect(tabled.has(domain), domain).toBe(true);
  });
});

describe('the seven read-only domains, in a household\'s words', () => {
  const read = (domain: string, value: string, attributes: HaAttributes = {}, deviceClass: string | null = null): string =>
    readState(state({ domain, state: value, attributes, deviceClass }));

  it('says what a light, a switch and a fan are doing', () => {
    // 153 of 255 is 60%, which is how a household would say it.
    expect(read('light', 'on', { brightness: 153 })).toBe('On · 60%');
    expect(read('light', 'on', { brightness: 255 })).toBe('On · 100%');
    // A brightness of 1 is a light somebody can see, and "0%" would say not.
    expect(read('light', 'on', { brightness: 1 })).toBe('On · 1%');
    expect(read('light', 'on')).toBe('On');
    expect(read('light', 'off', { brightness: 153 })).toBe('Off');
    expect(read('switch', 'on')).toBe('On');
    expect(read('switch', 'off')).toBe('Off');
    expect(read('input_boolean', 'on')).toBe('On');
    expect(read('fan', 'on', { percentage: 40 })).toBe('On · 40%');
    expect(read('fan', 'on')).toBe('On');
    expect(read('fan', 'off', { percentage: 40 })).toBe('Off');
  });

  it('says where a blind is, and not for a closed one', () => {
    expect(read('cover', 'open', { current_position: 40 }, 'blind')).toBe('Open · 40%');
    expect(read('cover', 'open', {}, 'blind')).toBe('Open');
    expect(read('cover', 'closing', { current_position: 70 })).toBe('Closing · 70%');
    // Closed is 0 by definition, so the position would say nothing.
    expect(read('cover', 'closed', { current_position: 0 })).toBe('Closed');
  });

  it('says what a lock is', () => {
    expect(read('lock', 'locked')).toBe('Locked');
    expect(read('lock', 'unlocked')).toBe('Unlocked');
    expect(read('lock', 'jammed')).toBe('Jammed');
  });

  it('says what the heating is doing, then how warm the room is', () => {
    expect(read('climate', 'heat', { hvac_action: 'heating', current_temperature: 21, temperature: 23 })).toBe(
      'Heating · 21°',
    );
    // The room, never the set point: "Heating · 23°" over a room at 17 would be
    // describing what the thermostat wants.
    expect(read('climate', 'heat', { hvac_action: 'idle', current_temperature: 20.5 })).toBe('Idle · 20.5°');
    // An integration that reports no action falls back to the mode.
    expect(read('climate', 'heat_cool', { current_temperature: 19.25 })).toBe('Heat cool · 19.3°');
    expect(read('climate', 'off')).toBe('Off');
  });

  it('passes a state it has no word for through untouched', () => {
    // The binary sensor's rule: inventing a word for `unavailable` is a lie.
    expect(read('light', 'unavailable', { brightness: 153 })).toBe('unavailable');
    expect(read('climate', 'unknown', { current_temperature: 21 })).toBe('unknown');
    expect(read('cover', 'stopped', { current_position: 40 })).toBe('stopped');
  });

  it('names a first-party glyph for each', () => {
    const glyph = (domain: string, deviceClass: string | null = null): unknown =>
      glyphFor(state({ domain, deviceClass }));
    expect(glyph('light')).toBe('light');
    expect(glyph('switch')).toBe('switch');
    expect(glyph('switch', 'outlet')).toBe('switch');
    expect(glyph('input_boolean')).toBe('switch');
    expect(glyph('fan')).toBe('fan');
    expect(glyph('cover', 'blind')).toBe('cover');
    // A cover's device classes say more than its domain does. `garage` is the
    // cover's spelling; the binary sensor's is `garage_door`.
    expect(glyph('cover', 'garage')).toBe('garage');
    expect(glyph('cover', 'door')).toBe('door');
    expect(glyph('cover', 'window')).toBe('window');
    expect(glyph('lock')).toBe('lock');
    expect(glyph('climate')).toBe('thermostat');
    for (const domain of SUPPORTED_DOMAINS) {
      const key = glyph(domain);
      if (key !== null) expect(isGlyphKey(key), domain).toBe(true);
    }
  });
});

describe('the attributes a reading may keep', () => {
  it('keeps the allowlisted ones and nothing else', () => {
    const [light, climate] = parseStates(
      JSON.stringify([
        {
          entity_id: 'light.lounge',
          state: 'on',
          attributes: {
            friendly_name: 'Lounge',
            brightness: 153,
            rgb_color: [255, 0, 0],
            entity_picture: '/api/image_proxy/light.lounge?token=secret',
          },
        },
        {
          entity_id: 'climate.hall',
          state: 'heat',
          attributes: {
            hvac_action: 'heating',
            current_temperature: 21,
            temperature: 22,
            hvac_modes: ['heat', 'off'],
            access_token: 'nope',
          },
        },
      ]),
    );
    expect(light?.attributes).toEqual({ brightness: 153 });
    expect(climate?.attributes).toEqual({ hvac_action: 'heating', current_temperature: 21, temperature: 22 });
  });

  it('keeps none for a domain with no allowlist, whatever it sends', () => {
    // A sensor sending `brightness` is not a light, and its attributes are not
    // the table's to widen.
    const [sensor] = parseStates(
      JSON.stringify([{ entity_id: 'sensor.lux', state: '400', attributes: { brightness: 200, device_class: 'illuminance' } }]),
    );
    expect(sensor?.attributes).toEqual({});
    expect(pickAttributes('switch', { brightness: 1 })).toEqual({});
  });

  it('refuses a value of the wrong shape rather than coercing it', () => {
    // Rule five. "153" is not 153, and 300 is not a brightness: turning either
    // into "On · 100%" would be a confident reading nobody sent.
    expect(pickAttributes('light', { brightness: '153' })).toEqual({});
    expect(pickAttributes('light', { brightness: 300 })).toEqual({});
    expect(pickAttributes('light', { brightness: 12.5 })).toEqual({});
    expect(pickAttributes('cover', { current_position: -1 })).toEqual({});
    expect(pickAttributes('climate', { hvac_action: 'Heating <b>now</b>', current_temperature: 'warm' })).toEqual({});
    expect(pickAttributes('fan', null)).toEqual({});
    // One refused attribute costs that attribute, not its neighbours.
    expect(pickAttributes('climate', { hvac_action: 'heating', current_temperature: 'warm' })).toEqual({
      hvac_action: 'heating',
    });
  });

  it('stores a binary sensor exactly as it stored one before the allowlist existed', () => {
    // Every cache row already hanging reads back unchanged, and every row this
    // release writes for an old domain is byte-identical to the last release's.
    expect(cachedAttributes(state({ deviceClass: 'door' }))).toBe('{"device_class":"door"}');
    expect(cachedAttributes(state({ domain: 'sensor', deviceClass: null }))).toBe('{"device_class":null}');
    expect(cachedAttributes(state({ domain: 'light', deviceClass: null, attributes: { brightness: 9 } }))).toBe(
      '{"device_class":null,"brightness":9}',
    );
  });

  it('names only the four domains that need one', () => {
    expect(Object.keys(ATTRIBUTE_ALLOWLIST).sort()).toEqual(['climate', 'cover', 'fan', 'light']);
  });
});

describe('a reading, for a tile', () => {
  const watch = { entityId: 'x.y', label: null, displayMode: 'label_value' as DisplayMode, sortOrder: 0 };

  it('carries its tone and when its state last changed', () => {
    const reading = toReading(state({ state: 'on', deviceClass: 'door', lastChangedAt: NOW - 300_000 }), watch, NOW, NOW);
    expect(reading.tone).toBe('alert');
    expect(reading.changedAt).toBe(NOW - 300_000);
    expect(toReading(state({ lastChangedAt: null }), watch, NOW, NOW).changedAt).toBeNull();
  });

  it('never draws a unit twice beside a value that carries its own', () => {
    const climate = state({
      domain: 'climate',
      state: 'heat',
      deviceClass: null,
      unit: '°C',
      attributes: { hvac_action: 'heating', current_temperature: 21 },
    });
    expect(toReading(climate, watch, NOW, NOW)).toMatchObject({ value: 'Heating · 21°', unit: null });
  });

  /**
   * The list widget draws `label`, `value`, `unit`, `glyph`, `mode` and
   * `stale`, and picks readings by `key` (P1.3). For every reading it could
   * already show, those seven must be exactly what they were.
   *
   * The fixture is the pre-P5.3 `toReading` *run*, not written down: `main`'s
   * `entities.ts` from just before this change, compiled beside this one and
   * walked over every domain, every device class either renderer names and
   * every state that matters, with its answers kept. So this is a measurement
   * of what shipped rather than a second opinion about it.
   */
  it('gives every reading the last release could show the same seven fields', () => {
    const fixture = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ha-readings-before-tiles.json'), 'utf8'),
    ) as {
      domain: string; state: string; deviceClass: string | null; unit: string | null;
      label: string | null; mode: DisplayMode; fetchedAt: number;
      reading: Record<string, unknown>;
    }[];
    expect(fixture.length).toBe(222);
    for (const row of fixture) {
      const now = Date.parse('2026-08-02T12:00:00Z');
      const reading = toReading(
        {
          entityId: `${row.domain}.thing`, domain: row.domain, state: row.state, friendlyName: 'The thing',
          unit: row.unit, deviceClass: row.deviceClass, lastChangedAt: now - 300_000, attributes: {},
        },
        { entityId: `${row.domain}.thing`, label: row.label, displayMode: row.mode, sortOrder: 0 },
        row.fetchedAt,
        now,
      );
      const { tone: _tone, changedAt: _changedAt, ...before } = reading;
      expect(before, JSON.stringify(row)).toEqual(row.reading);
    }
  });
});

describe('calendar entities', () => {
  it('keeps only real calendar entities from the list', () => {
    const body = JSON.stringify([
      { entity_id: 'calendar.family', name: 'Family' },
      { entity_id: 'sensor.not_a_calendar', name: 'No' },
      { entity_id: 'calendar.unnamed' },
      'nonsense',
    ]);
    expect(parseCalendarList(body)).toEqual([
      { entityId: 'calendar.family', name: 'Family' },
      { entityId: 'calendar.unnamed', name: 'calendar.unnamed' },
    ]);
  });

  it('anchors an all-day boundary in the household zone, exclusively', () => {
    const [event] = parseCalendarEvents({
      body: JSON.stringify([
        { summary: 'Bin day', start: { date: '2026-08-05' }, end: { date: '2026-08-06' } },
      ]),
      entityId: 'calendar.family',
      timezone: 'Europe/London',
    });

    expect(event?.allDay).toBe(true);
    // Local midnight in London in August is 23:00 UTC the day before.
    expect(event?.startUtc.toISOString()).toBe('2026-08-04T23:00:00.000Z');
    // Exclusive: the boundary is the start of the 6th, not the end of the 5th.
    expect(event?.endUtc.toISOString()).toBe('2026-08-05T23:00:00.000Z');
  });

  it('takes a timed event at the offset it carries', () => {
    const [event] = parseCalendarEvents({
      body: JSON.stringify([
        {
          summary: 'Swimming',
          start: { dateTime: '2026-08-05T17:30:00+01:00' },
          end: { dateTime: '2026-08-05T18:30:00+01:00' },
          location: 'The pool',
          uid: 'swim-1',
        },
      ]),
      entityId: 'calendar.family',
      timezone: 'Europe/London',
    });

    expect(event?.allDay).toBe(false);
    expect(event?.startUtc.toISOString()).toBe('2026-08-05T16:30:00.000Z');
    expect(event?.location).toBe('The pool');
    expect(event?.uid).toBe('swim-1');
  });

  it('gives two unnamed events distinct identities', () => {
    /*
     * Several integrations answer with no uid. The row id is built from it, so
     * two events without one would collide on the same source and one would
     * silently vanish from the wall.
     */
    const events = parseCalendarEvents({
      body: JSON.stringify([
        { summary: 'One', start: { date: '2026-08-05' }, end: { date: '2026-08-06' } },
        { summary: 'Two', start: { date: '2026-08-05' }, end: { date: '2026-08-06' } },
      ]),
      entityId: 'calendar.family',
      timezone: 'UTC',
    });
    expect(events).toHaveLength(2);
    expect(events[0]?.uid).not.toBe(events[1]?.uid);
  });

  it('drops what it cannot read and keeps what it can', () => {
    const events = parseCalendarEvents({
      body: JSON.stringify([
        { summary: 'Good', start: { date: '2026-08-05' }, end: { date: '2026-08-06' } },
        { summary: 'No end', start: { date: '2026-08-05' } },
        { summary: '', start: { date: '2026-08-05' }, end: { date: '2026-08-06' } },
        { start: { date: 'not-a-date' }, end: { date: '2026-08-06' }, summary: 'Bad date' },
        null,
      ]),
      entityId: 'calendar.family',
      timezone: 'UTC',
    });
    expect(events.map((event) => event.title)).toEqual(['Good']);
  });

  it('never produces an event that ends before it starts', () => {
    // A reversed pair would give a negative span and a row that lands on no
    // day at all — invisible, rather than wrong in a way anybody would notice.
    const [event] = parseCalendarEvents({
      body: JSON.stringify([
        {
          summary: 'Backwards',
          start: { dateTime: '2026-08-05T18:00:00Z' },
          end: { dateTime: '2026-08-05T09:00:00Z' },
        },
      ]),
      entityId: 'calendar.family',
      timezone: 'UTC',
    });
    expect(event?.endUtc.getTime()).toBe(event?.startUtc.getTime());
  });

  it('escapes the entity id into the path', () => {
    const path = eventsPath('calendar.family', new Date(0), new Date(86_400_000));
    expect(path).toBe(
      '/calendars/calendar.family?start=1970-01-01T00%3A00%3A00.000Z&end=1970-01-02T00%3A00%3A00.000Z',
    );
  });
});


describe('the templates offered on the form', () => {
  it('gives a leak the whole wall and the freezer a banner', () => {
    // The hard part of a rule builder is not the fields, it is knowing what a
    // household would actually use it for.
    const byKey = new Map(RULE_TEMPLATES.map((template) => [template.key, template]));
    expect(byKey.get('leak')?.action).toBe('takeover_and_wake');
    expect(byKey.get('leak')?.minDwellSec).toBe(0);
    // And it may not be cleared by a hand moving before its owner is awake.
    expect(byKey.get('leak')?.dismissible).toBe(false);
    expect(byKey.get('freezer')?.action).toBe('banner');
    expect(byKey.get('freezer')?.minDwellSec).toBe(300);
  });

  it('makes the garage template about the hour, as the brief asks', () => {
    // "Garage door open after 23:00" is one of the three named examples, and a
    // duration alone cannot express it — it fires just as readily at noon.
    const garage = RULE_TEMPLATES.find((template) => template.key === 'garage');
    expect(garage?.condition.between).toEqual({ from: '23:00', to: '06:00' });
  });
});
