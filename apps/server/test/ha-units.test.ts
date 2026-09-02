import { describe, expect, it } from 'vitest';
import {
  domainOf,
  glyphFor,
  isSupported,
  parseStates,
  readState,
  type HaState,
} from '../src/modules/homeassistant/entities.js';
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
    expect(isSupported('light.kitchen')).toBe(false);
    // Nothing that could be mistaken for a control surface.
    expect(isSupported('switch.boiler')).toBe(false);
    expect(isSupported('lock.front_door')).toBe(false);
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
