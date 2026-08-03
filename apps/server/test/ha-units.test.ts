import { describe, expect, it } from 'vitest';
import {
  domainOf,
  iconFor,
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
import {
  EDGE_WINDOW_MS,
  evaluateInterrupts,
  parseCondition,
  RULE_TEMPLATES,
  type InterruptRule,
  type Signal,
} from '../src/api/interrupts.js';

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
    expect(isSupported('calendar.family')).toBe(true);
    expect(isSupported('automation.morning')).toBe(false);
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

  it('draws a character it already has rather than fetching an icon', () => {
    // Rule three: Home Assistant offers an icon URL and the wall may not
    // fetch one, so the device class maps to a glyph.
    expect(iconFor(state({ deviceClass: 'temperature' }))).toBe('🌡');
    expect(iconFor(state({ deviceClass: 'moisture' }))).toBe('💦');
    expect(iconFor(state({ domain: 'person', deviceClass: null }))).toBe('🧍');
    expect(iconFor(state({ domain: 'sensor', deviceClass: 'unheard-of' }))).toBe('·');
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

describe('the interrupt evaluator', () => {
  function signal(over: Partial<Signal> = {}): Signal {
    return {
      source: 'ha_entity',
      key: 'binary_sensor.door',
      state: 'on',
      reading: 'Open',
      numeric: null,
      since: NOW - 10 * 60_000,
      label: 'Freezer door',
      ...over,
    };
  }

  function rule(over: Partial<InterruptRule> = {}): InterruptRule {
    return {
      id: 'r1',
      name: 'Freezer door open',
      trigger: 'ha_entity',
      action: 'banner',
      priority: 40,
      dismissAfterSeconds: null,
      condition: { key: 'binary_sensor.door', kind: 'equals', value: 'on', forSeconds: null },
      ...over,
    };
  }

  it('matches a state regardless of how it was typed', () => {
    const fired = evaluateInterrupts({
      rules: [rule({ condition: { key: 'binary_sensor.door', kind: 'equals', value: 'On', forSeconds: null } })],
      signals: [signal()],
      now: NOW,
    });
    expect(fired).toHaveLength(1);
  });

  it('holds a rule until its wait is up, then names the duration', () => {
    const held = rule({
      condition: { key: 'binary_sensor.door', kind: 'equals', value: 'on', forSeconds: 15 * 60 },
    });
    expect(evaluateInterrupts({ rules: [held], signals: [signal()], now: NOW })).toHaveLength(0);

    const fired = evaluateInterrupts({
      rules: [held],
      signals: [signal({ since: NOW - 20 * 60_000 })],
      now: NOW,
    });
    // "Open", not "on" — the same wording the panel uses, because this is the
    // one string a household actually reads.
    expect(fired[0]?.message).toBe('Freezer door open — Freezer door · Open for 20 minutes');
  });

  it('compares numbers, and only when there is one on both sides', () => {
    const above = rule({
      condition: { key: 'sensor.t', kind: 'above', value: '25', forSeconds: null },
    });
    const hot = signal({ key: 'sensor.t', state: '28.3', numeric: 28.3 });
    expect(evaluateInterrupts({ rules: [above], signals: [hot], now: NOW })).toHaveLength(1);

    const cool = signal({ key: 'sensor.t', state: '19.0', numeric: 19 });
    expect(evaluateInterrupts({ rules: [above], signals: [cool], now: NOW })).toHaveLength(0);

    // `unavailable` is not a number and must not compare as one.
    const gone = signal({ key: 'sensor.t', state: 'unavailable', numeric: null });
    expect(evaluateInterrupts({ rules: [above], signals: [gone], now: NOW })).toHaveLength(0);
  });

  it('treats changed_to as an edge, read from a timestamp', () => {
    const edge = rule({
      condition: { key: 'binary_sensor.door', kind: 'changed_to', value: 'on', forSeconds: null },
    });
    const justNow = signal({ since: NOW - 30_000 });
    expect(evaluateInterrupts({ rules: [edge], signals: [justNow], now: NOW })).toHaveLength(1);

    /*
     * Still 'on', but it became 'on' hours ago. There is no store of previous
     * states — deliberately — so the edge is read from when the state was
     * entered, and an edge outside the window is over.
     */
    const stale = signal({ since: NOW - EDGE_WINDOW_MS - 1 });
    expect(evaluateInterrupts({ rules: [edge], signals: [stale], now: NOW })).toHaveLength(0);
  });

  it('stops showing one that has auto-dismissed', () => {
    const brief = rule({ dismissAfterSeconds: 60 });
    expect(
      evaluateInterrupts({ rules: [brief], signals: [signal({ since: NOW - 30_000 })], now: NOW }),
    ).toHaveLength(1);
    expect(
      evaluateInterrupts({ rules: [brief], signals: [signal({ since: NOW - 120_000 })], now: NOW }),
    ).toHaveLength(0);
  });

  it('puts the loudest first, and settles ties without shuffling', () => {
    const fired = evaluateInterrupts({
      rules: [
        rule({ id: 'a', name: 'Freezer', priority: 40 }),
        rule({ id: 'b', name: 'Leak', priority: 100, action: 'takeover_and_wake' }),
        rule({ id: 'c', name: 'Amber', priority: 40 }),
      ],
      signals: [signal()],
      now: NOW,
    });
    // Sorted, and stable — an order that changed between polls would make the
    // wall flicker between two equal interrupts.
    expect(fired.map((entry) => entry.name)).toEqual(['Leak', 'Amber', 'Freezer']);
  });

  it('ignores a rule about an entity nothing is reading', () => {
    const orphan = rule({
      condition: { key: 'binary_sensor.gone', kind: 'equals', value: 'on', forSeconds: null },
    });
    expect(evaluateInterrupts({ rules: [orphan], signals: [signal()], now: NOW })).toEqual([]);
  });

  it('never puts an entity id in what the wall shows', () => {
    const fired = evaluateInterrupts({ rules: [rule()], signals: [signal()], now: NOW });
    expect(JSON.stringify(fired)).not.toContain('binary_sensor');
  });
});

describe('reading a stored condition', () => {
  it('accepts what the form writes, and both key spellings', () => {
    expect(
      parseCondition({ entityId: 'binary_sensor.door', condition: 'equals', value: 'on', forSeconds: 300 }),
    ).toEqual({ key: 'binary_sensor.door', kind: 'equals', value: 'on', forSeconds: 300 });

    // `key` rather than `entityId`, for a source that is not an entity.
    expect(parseCondition({ key: 'MDC013', condition: 'equals', value: 'Flood Warning' })).toEqual({
      key: 'MDC013',
      kind: 'equals',
      value: 'Flood Warning',
      forSeconds: null,
    });
  });

  it('reads a number written as one', () => {
    // `<input type="number">` and a hand-edited row disagree about this, and
    // storing 25 rather than "25" must not silently disable a rule.
    expect(parseCondition({ key: 'sensor.t', condition: 'above', value: 25 })?.value).toBe('25');
  });

  it('refuses anything it cannot act on', () => {
    expect(parseCondition(null)).toBeUndefined();
    expect(parseCondition('on')).toBeUndefined();
    expect(parseCondition({ condition: 'equals', value: 'on' })).toBeUndefined();
    expect(parseCondition({ key: 'a', condition: 'roughly', value: 'on' })).toBeUndefined();
    expect(parseCondition({ key: 'a', condition: 'equals' })).toBeUndefined();
    // A negative wait would fire immediately and read as deliberate.
    expect(parseCondition({ key: 'a', condition: 'equals', value: 'on', forSeconds: -5 })?.forSeconds).toBeNull();
  });
});

describe('the shipped templates', () => {
  it('gives a leak the whole wall and the freezer a banner', () => {
    // The hard part of a rule builder is not the fields, it is knowing what a
    // household would actually use it for.
    const byKey = new Map(RULE_TEMPLATES.map((template) => [template.key, template]));
    expect(byKey.get('leak')?.action).toBe('takeover_and_wake');
    expect(byKey.get('leak')?.condition.forSeconds).toBeNull();
    expect(byKey.get('freezer')?.action).toBe('banner');
    expect(byKey.get('freezer')?.condition.forSeconds).toBe(300);
    expect(byKey.get('garage')?.condition.forSeconds).toBe(1800);
  });

  it('orders them so a leak outranks a door', () => {
    const leak = RULE_TEMPLATES.find((template) => template.key === 'leak');
    const freezer = RULE_TEMPLATES.find((template) => template.key === 'freezer');
    expect((leak?.priority ?? 0) > (freezer?.priority ?? 0)).toBe(true);
  });
});
