import { describe, expect, it } from 'vitest';
import {
  buildModel,
  describeAge,
  localDate,
  NEXT_DAY_COUNT,
  TODAY_EVENT_LIMIT,
  houseFrom,
  interruptsFrom,
} from '../src/viewmodel.js';
import type { Manifest, ManifestDay, ManifestEvent } from '../src/manifest.js';

/**
 * The view model, which is where every decision about what the wall shows
 * lives. Testing it against a document rather than a screenshot is the whole
 * reason the renderer below it does no thinking.
 */

const TZ = 'Europe/London';

function event(partial: Partial<ManifestEvent> & { title: string; startsAt: number }): ManifestEvent {
  return {
    id: partial.title,
    uid: `${partial.title}@test`,
    title: partial.title,
    startsAt: partial.startsAt,
    endsAt: partial.startsAt + 3_600_000,
    allDay: partial.allDay ?? false,
    sourceId: 'src-1',
    color: partial.color ?? '#4C7FD1',
    status: 'CONFIRMED',
    continues: partial.continues ?? false,
    ...(partial.location !== undefined ? { location: partial.location } : {}),
    ...(partial.personId !== undefined ? { personId: partial.personId } : {}),
    // Absent unless the fixture asks for it — which is exactly how the server
    // sends it, and the reason the wall must read `!== false`.
    ...(partial.showInGrid === false ? { showInGrid: false as const } : {}),
  };
}

function day(date: string, events: ManifestEvent[] = [], shifts: ManifestDay['shifts'] = []): ManifestDay {
  return { date, events, shifts };
}

function manifest(days: ManifestDay[], overrides: Partial<Manifest> = {}): Manifest {
  return {
    manifestVersion: 1,
    appVersion: '0.1.0-test',
    generatedAt: Date.parse('2026-07-15T09:00:00Z'),
    timezone: TZ,
    theme: { active: 'board' },
    window: { from: '2026-07-14', to: '2026-08-24' },
    days,
    people: [],
    sources: [],
    notices: [],
    weather: null,
    interrupts: [],
    ...overrides,
  };
}

const NOON = Date.parse('2026-07-15T11:00:00Z');

function model(days: ManifestDay[], overrides: Partial<Manifest> = {}, now = NOON) {
  return buildModel({
    manifest: manifest(days, overrides),
    now,
    lastConfirmedAt: now,
    offline: false,
  });
}

describe('which day is today', () => {
  it('comes from the household zone, not the device', () => {
    // 23:30 UTC on the 15th is already the 16th in Sydney. A wall that gets
    // this wrong shows the wrong day and nobody doubts it.
    const at = Date.parse('2026-07-15T23:30:00Z');
    expect(localDate(at, 'Europe/London')).toBe('2026-07-16');
    expect(localDate(at, 'America/New_York')).toBe('2026-07-15');
    expect(localDate(at, 'Australia/Sydney')).toBe('2026-07-16');
  });

  it('marks the right cell as today across a zone boundary', () => {
    const at = Date.parse('2026-07-15T23:30:00Z');
    const built = buildModel({
      manifest: manifest([day('2026-07-15'), day('2026-07-16')], { timezone: 'America/New_York' }),
      now: at,
      lastConfirmedAt: at,
      offline: false,
    });
    const cells = built.horizon.flat();
    expect(cells.find((cell) => cell.isToday)?.date).toBe('2026-07-15');
  });
});

describe('today', () => {
  it('shows the day and its events', () => {
    const built = model([
      day('2026-07-15', [
        event({ title: 'Dentist', startsAt: Date.parse('2026-07-15T14:00:00Z') }),
      ]),
    ]);
    expect(built.today?.date).toBe('2026-07-15');
    expect(built.today?.events[0]?.title).toBe('Dentist');
    // 14:00 UTC is 15:00 in London, and the wall shows the household's clock.
    expect(built.today?.events[0]?.time).toBe('15:00');
  });

  it('labels an all-day event rather than inventing a time', () => {
    const built = model([
      day('2026-07-15', [
        event({ title: 'Birthday', startsAt: Date.parse('2026-07-15T00:00:00Z'), allDay: true }),
      ]),
    ]);
    expect(built.today?.events[0]?.time).toBe('All day');
  });

  it('caps the list and says how many it is holding back', () => {
    // The density opinion. Past six lines the count is more useful than the
    // titles, because "+4 more" tells somebody to walk closer.
    const events = Array.from({ length: 10 }, (_, index) =>
      event({ title: `Event ${index}`, startsAt: Date.parse('2026-07-15T09:00:00Z') }),
    );
    const built = model([day('2026-07-15', events)]);
    expect(built.today?.events).toHaveLength(TODAY_EVENT_LIMIT);
    expect(built.today?.hiddenEventCount).toBe(10 - TODAY_EVENT_LIMIT);
  });

  it('survives a manifest with no entry for today at all', () => {
    // Never an exception. A window that does not cover today is a server bug,
    // and the wall still has to draw something.
    const built = model([day('2026-07-20')]);
    expect(built.today).toBeUndefined();
    expect(built.horizon.flat().some((cell) => cell.isToday)).toBe(true);
  });
});

describe('the next few days', () => {
  it('shows every day, including the empty ones', () => {
    // The rows carry the rota colour down their left edge, so a skipped day
    // would put a hole in the pattern the wall exists to show.
    const built = model([
      day('2026-07-15'),
      day('2026-07-16'),
      day('2026-07-17', [event({ title: 'Swimming', startsAt: Date.parse('2026-07-17T17:00:00Z') })]),
    ]);
    expect(built.next.map((entry) => entry.date)).toEqual([
      '2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19', '2026-07-20', '2026-07-21',
    ]);
    expect(built.next[0]?.events).toHaveLength(0);
  });

  it('never shows more days than it has room for', () => {
    const days = Array.from({ length: 10 }, (_, index) => {
      const date = `2026-07-${String(16 + index).padStart(2, '0')}`;
      return day(date, [event({ title: `Day ${index}`, startsAt: Date.parse(`${date}T10:00:00Z`) })]);
    });
    const built = model([day('2026-07-15'), ...days]);
    expect(built.next).toHaveLength(NEXT_DAY_COUNT);
  });

  it('marks what has already happened today and what is next', () => {
    // The only highlight on the wall, so it has to be the right line.
    const built = model([
      day('2026-07-15', [
        event({ title: 'Breakfast', startsAt: Date.parse('2026-07-15T07:00:00Z') }),
        event({ title: 'Dentist', startsAt: Date.parse('2026-07-15T14:00:00Z') }),
        event({ title: 'Swimming', startsAt: Date.parse('2026-07-15T17:00:00Z') }),
      ]),
    ]);
    const [breakfast, dentist, swimming] = built.today?.events ?? [];
    // 11:00 UTC is "now" in these tests.
    expect(breakfast?.isPast).toBe(true);
    expect(dentist?.isNext).toBe(true);
    expect(swimming?.isNext).toBe(false);
  });

  it('never treats an all-day event as the next thing due', () => {
    // It has no time to be next at, and highlighting it would push the actual
    // next thing down the page.
    const built = model([
      day('2026-07-15', [
        event({ title: 'Birthday', startsAt: Date.parse('2026-07-15T00:00:00Z'), allDay: true }),
        event({ title: 'Dentist', startsAt: Date.parse('2026-07-15T14:00:00Z') }),
      ]),
    ]);
    expect(built.today?.events[0]?.isNext).toBe(false);
    expect(built.today?.events[1]?.isNext).toBe(true);
  });

  it('includes a day that has only a shift', () => {
    // A shift is a fact about the day even with no appointments on it.
    const built = model([
      day('2026-07-15'),
      day('2026-07-16', [], [
        {
          key: 'night', label: 'Mids', shortCode: 'M', colorToken: '--s-night',
          isWorking: true, source: 'pattern',
          personId: 'p1', personName: 'Sam', personColor: '#C86',
        },
      ]),
    ]);
    expect(built.next[0]?.date).toBe('2026-07-16');
    expect(built.next[0]?.shifts[0]?.shortCode).toBe('M');
  });

  it('does not run past the end of the window', () => {
    // The window ends on the 16th, so exactly one row: asking for six days
    // must not invent days the server never sent.
    const built = model([day('2026-07-15')], { window: { from: '2026-07-14', to: '2026-07-16' } });
    expect(built.next.map((entry) => entry.date)).toEqual(['2026-07-16']);
  });
});

describe('the clock format (RFC 005)', () => {
  const dinner = () => day('2026-07-15', [event({ title: 'Dinner', startsAt: Date.parse('2026-07-15T18:30:00Z') })]);

  it('draws a 24-hour clock and event times by default', () => {
    const built = model([dinner()]);
    expect(built.clock).toMatch(/^\d{2}:\d{2}$/);
    expect(built.today?.events[0]?.time).toBe('19:30'); // 18:30 UTC is 19:30 in BST
  });

  it('draws a 12-hour clock and event times when the household turns it off', () => {
    const built = model([dinner()], {
      display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, clock24: false },
    });
    expect(built.clock).toMatch(/am|pm/i);
    expect(built.today?.events[0]?.time).toMatch(/7:30\s*pm/i);
  });
});

describe('the horizon', () => {
  it('is five rectangular weeks starting on a Sunday by default', () => {
    // A ragged first row reads as a rendering fault from across a room. Sunday
    // is the shipped default (a household can pick Monday on the Display screen).
    const built = model([day('2026-07-15')]);
    expect(built.horizon).toHaveLength(5);
    for (const week of built.horizon) expect(week).toHaveLength(7);
    // 2026-07-15 is a Wednesday, so a Sunday-start grid opens on the 12th.
    expect(built.horizon[0]?.[0]?.date).toBe('2026-07-12');
  });

  it('starts on Monday when the household picks it', () => {
    const built = model([day('2026-07-15')], {
      display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, weekStart: 'monday' },
    } as never);
    // The same Wednesday, but a Monday-start grid opens on the 13th.
    expect(built.horizon[0]?.[0]?.date).toBe('2026-07-13');
    expect(built.horizon[0]?.[0]?.weekday).toBe('Mon');
  });

  it('carries the working shift colour and code', () => {
    const built = model([
      day('2026-07-15', [], [
        {
          key: 'day', label: 'Days', shortCode: 'D', colorToken: '--s-day',
          isWorking: true, source: 'pattern',
          personId: 'p1', personName: 'Sam', personColor: '#C86',
        },
      ]),
    ]);
    const today = built.horizon.flat().find((cell) => cell.isToday);
    expect(today?.shiftToken).toBe('--s-day');
    expect(today?.shiftCode).toBe('D');
  });

  it('colours a rest day too, because it is part of the rotation shape', () => {
    // The design gives break its own hue. A rest day and a day with no rota at
    // all are different facts and have to look different.
    const built = model([
      day('2026-07-15', [], [
        {
          key: 'off', label: 'Break Day', shortCode: 'B', colorToken: '--s-break',
          isWorking: false, source: 'calendar',
          personId: 'p1', personName: 'Sam', personColor: '#C86',
        },
      ]),
    ]);
    const cells = built.horizon.flat();
    expect(cells.find((cell) => cell.isToday)?.shiftToken).toBe('--s-break');
    // A day the rota says nothing about stays uncoloured.
    expect(cells.find((cell) => cell.date === '2026-07-20')?.shiftToken).toBeUndefined();
  });

  it('says how far through a run of the same shift today is', () => {
    // The question a shift worker's household asks is "how many more of these".
    const nights = (date: string) =>
      day(date, [], [
        {
          key: 'night', label: 'Mids', shortCode: 'M', colorToken: '--s-night',
          isWorking: true, source: 'pattern',
          personId: 'p1', personName: 'Sam', personColor: '#C86',
        },
      ]);
    const built = model([
      nights('2026-07-14'), nights('2026-07-15'), nights('2026-07-16'), nights('2026-07-17'),
    ]);
    expect(built.todayShifts[0]?.run).toBe('Day 2 of 4 · 2 more');
    expect(built.todayShifts[0]?.shift.label).toBe('Mids');
  });

  it('says when today is the last of a run', () => {
    const nights = (date: string) =>
      day(date, [], [
        {
          key: 'night', label: 'Mids', shortCode: 'M', colorToken: '--s-night',
          isWorking: true, source: 'pattern',
          personId: 'p1', personName: 'Sam', personColor: '#C86',
        },
      ]);
    const built = model([nights('2026-07-14'), nights('2026-07-15'), day('2026-07-16')]);
    expect(built.todayShifts[0]?.run).toBe('Last of 2');
  });

  it('marks days outside the current month so the shape reads', () => {
    const built = model([day('2026-07-15')]);
    const cells = built.horizon.flat();
    expect(cells.find((cell) => cell.date === '2026-08-10')?.inMonth).toBe(false);
    expect(cells.find((cell) => cell.date === '2026-07-15')?.inMonth).toBe(true);
  });

  it('carries a few of the day events on the cell, for the pills and week modes', () => {
    // The month grid draws dots from `eventCount`, but the Skylight-style pills
    // and the week columns draw the events themselves — so the cell has to carry
    // them, with the colour and source the widget filters and paints by.
    const built = model([
      day('2026-07-15', [
        event({ title: 'Soccer', startsAt: Date.parse('2026-07-15T15:00:00Z'), color: '#E8A33D' }),
        event({ title: 'Dentist', startsAt: Date.parse('2026-07-15T09:00:00Z'), color: '#4C7FD1' }),
      ]),
    ]);
    const cell = built.horizon.flat().find((c) => c.date === '2026-07-15');
    expect(cell?.eventCount).toBe(2);
    expect(cell?.events.map((e) => e.title)).toEqual(['Soccer', 'Dentist']);
    expect(cell?.events[0]).toMatchObject({ color: '#E8A33D', sourceId: 'src-1', allDay: false });
  });

  it('carries a dozen cell events while eventCount stays the true total', () => {
    // Four until the dense styles arrived: an edge-to-edge week column is tall
    // enough for eight, so a cap of four here would have been a household
    // asking for a dense week and quietly getting the old one. The renderer
    // does the cutting; this only has to carry enough for the densest of them.
    const many = Array.from({ length: 6 }, (_, i) =>
      event({ title: `E${i}`, startsAt: Date.parse('2026-07-15T09:00:00Z') + i }),
    );
    const cell = model([day('2026-07-15', many)]).horizon.flat().find((c) => c.isToday);
    expect(cell?.eventCount).toBe(6); // the "+N" and the dots read from this
    expect(cell?.events).toHaveLength(6);
  });

  /**
   * A calendar kept off the grid.
   *
   * The reported fault: one weekday standup in a work feed drew 17 identical
   * cut-off pills across the visible month — the majority of every name on the
   * wall — because the grid treats a once-a-year birthday and a daily meeting
   * as equally worth a row. The switch is per calendar and the server stamps
   * each event; all the wall does is honour it, at the one seam where a cell is
   * built.
   */
  it('leaves a calendar the household kept off the grid out of every cell', () => {
    const built = model([
      day('2026-07-15', [
        event({ title: 'Dentist', startsAt: Date.parse('2026-07-15T09:00:00Z') }),
        event({ title: 'Standup', startsAt: Date.parse('2026-07-15T08:30:00Z'), showInGrid: false }),
      ]),
    ]);
    const cell = built.horizon.flat().find((c) => c.date === '2026-07-15');
    expect(cell?.events.map((e) => e.title)).toEqual(['Dentist']);
    /*
     * The count as well as the list, and this is the half that would have been
     * missed. `eventCount` is the true total a "+N" and the dots read from, so
     * a cell that drew one event and claimed two would say "+1" for a standup
     * the household has asked not to see — the "+6 and none of its six events"
     * fault, inverted.
     */
    expect(cell?.eventCount).toBe(1);
    /*
     * And the other half of the claim, which is what makes the switch usable:
     * the events are not gone, they are in the list. A control that reads
     * "hide this calendar" is one nobody turns on, so the hint says where they
     * still are and this asserts that it is true.
     */
    expect(built.today?.events.map((e) => e.title)).toEqual(['Dentist', 'Standup']);
  });

  it('still draws a calendar whose events say nothing about the grid', () => {
    // Absence is the default and has to stay it: a server older than the field
    // never sends it, and neither does a household that never touched the
    // switch. Reading `=== true` here would empty every wall already hanging.
    const built = model([
      day('2026-07-15', [event({ title: 'Dentist', startsAt: Date.parse('2026-07-15T09:00:00Z') })]),
    ]);
    const cell = built.horizon.flat().find((c) => c.date === '2026-07-15');
    expect(cell?.events.map((e) => e.title)).toEqual(['Dentist']);
    expect(cell?.eventCount).toBe(1);
  });

  it('gives each cell its weekday, for the week-columns header', () => {
    const built = model([day('2026-07-15')]);
    // 2026-07-12 is the Sunday the default grid starts on.
    expect(built.horizon[0]?.[0]?.weekday).toBe('Sun');
    expect(built.horizon.flat().find((c) => c.date === '2026-07-15')?.weekday).toBe('Wed');
  });
});

describe('saying when it last heard from the server', () => {
  it('stays quiet while everything is fine', () => {
    expect(model([day('2026-07-15')]).staleness.level).toBe('fresh');
  });

  it('admits to being stale rather than showing old data as current', () => {
    const built = buildModel({
      manifest: manifest([day('2026-07-15')]),
      now: NOON,
      lastConfirmedAt: NOON - 45 * 60_000,
      offline: false,
    });
    expect(built.staleness.level).toBe('stale');
    expect(built.staleness).toHaveProperty('message', 'Last updated 45 minutes ago.');
  });

  it('says so plainly when it cannot reach the server, and still draws', () => {
    // Rule nine. Yesterday's calendar with a note beats a blank rectangle.
    const built = buildModel({
      manifest: manifest([
        day('2026-07-15', [event({ title: 'Dentist', startsAt: Date.parse('2026-07-15T14:00:00Z') })]),
      ]),
      now: NOON,
      lastConfirmedAt: NOON - 3 * 3_600_000,
      offline: true,
    });
    expect(built.staleness.level).toBe('offline');
    expect(built.today?.events[0]?.title).toBe('Dentist');
  });
});

describe('describeAge', () => {
  it('reads the way somebody glancing at a wall would want', () => {
    expect(describeAge(30_000)).toBe('just now');
    expect(describeAge(60_000)).toBe('1 minute ago');
    expect(describeAge(45 * 60_000)).toBe('45 minutes ago');
    expect(describeAge(3 * 3_600_000)).toBe('3 hours ago');
    expect(describeAge(4 * 86_400_000)).toBe('4 days ago');
  });
});

describe('the household chooses how much is shown', () => {
  const withDisplay = (display: { todayEvents: number; nextDays: number; horizonWeeks: number }) =>
    model(
      [
        day('2026-07-15', Array.from({ length: 12 }, (_, index) =>
          event({ title: `Event ${index}`, startsAt: Date.parse('2026-07-15T09:00:00Z') }))),
      ],
      { display } as never,
    );

  it('honours the counts the manifest carries', () => {
    const built = withDisplay({ todayEvents: 3, nextDays: 2, horizonWeeks: 4 });
    expect(built.today?.events).toHaveLength(3);
    expect(built.today?.hiddenEventCount).toBe(9);
    expect(built.next).toHaveLength(2);
    expect(built.horizon).toHaveLength(4);
  });

  it('hides the week ahead entirely when the household asked for none', () => {
    expect(withDisplay({ todayEvents: 8, nextDays: 0, horizonWeeks: 5 }).next).toHaveLength(0);
  });

  it('falls back to its own numbers when the server does not say', () => {
    // An older server, or a manifest that predates the field, must still make
    // a sensible wall rather than an empty one.
    const built = model([day('2026-07-15')]);
    expect(built.next).toHaveLength(NEXT_DAY_COUNT);
    expect(built.horizon).toHaveLength(5);
  });

  it('refuses an amount that would draw nothing usable', () => {
    // The server clamps these too. A display that trusted them and was handed
    // two hundred weeks would render a grid nobody could read.
    const absurd = withDisplay({ todayEvents: 0, nextDays: 900, horizonWeeks: 400 });
    expect(absurd.today?.events.length).toBeGreaterThan(0);
    expect(absurd.horizon.length).toBeLessThanOrEqual(8);
    expect(absurd.next.length).toBeLessThanOrEqual(14);
  });
});

describe('which blocks are drawn, and in what order', () => {
  const withBlocks = (blocks: string[] | undefined) =>
    model([day('2026-07-15')], { display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks } } as never);

  it('follows the order the household chose', () => {
    expect(withBlocks(['horizon', 'now', 'next']).blocks).toEqual(['horizon', 'now', 'next']);
    expect(withBlocks(['next', 'now']).blocks).toEqual(['next', 'now']);
  });

  it('leaves out a block that is not in the list', () => {
    const built = withBlocks(['now', 'horizon']);
    expect(built.blocks).toEqual(['now', 'horizon']);
    expect(built.blocks).not.toContain('next');
  });

  it('does not build the days it is not going to draw', () => {
    // Cheap, but the point is that "no week ahead" and "zero days of week
    // ahead" arrive at the same place rather than one of them half-working.
    expect(withBlocks(['now', 'horizon']).next).toHaveLength(0);
  });

  it('drops a block name this bundle cannot render', () => {
    // A newer server naming a block this build has no renderer for would
    // otherwise be a gap on the wall. This used to use 'weather' as the
    // example, which stopped being unknown the moment weather shipped — the
    // name has to be one nothing will ever render.
    expect(withBlocks(['now', 'tides', 'horizon']).blocks).toEqual(['now', 'horizon']);
  });

  it('drops a repeat rather than drawing it twice', () => {
    expect(withBlocks(['now', 'now', 'next']).blocks).toEqual(['now', 'next']);
  });

  it('falls back to every block rather than drawing nothing', () => {
    // Rule nine. An empty list is far more likely to be a mistake than a
    // household asking for a blank wall.
    const all = ['now', 'weather', 'home', 'next', 'horizon'];
    expect(withBlocks([]).blocks).toEqual(all);
    expect(withBlocks(['nonsense']).blocks).toEqual(all);
    expect(withBlocks(undefined).blocks).toEqual(all);
  });
});

describe('text from somewhere else', () => {
  /**
   * The rule the brief states for CAP headlines, applied to Home Assistant
   * attributes too — which is where it was missed first time round.
   *
   * `textContent` in the renderer is what prevents injection, and there is no
   * `innerHTML` anywhere in this bundle. This is the other half: a reading has
   * to stay *legible*, and a friendly name carrying a bidi override can
   * reverse the reading order of the line it sits in.
   */
  it('strips the invisible characters out of a Home Assistant reading', () => {
    const { readings } = houseFrom({
      readings: [
        {
          label: 'Kitchen\u202Etemperature',
          value: '19.4\u200B',
          unit: '\u00B0C',
          icon: '\uD83C\uDF21',
          mode: 'label_value',
        },
      ],
    });
    expect(readings[0]?.label).toBe('Kitchentemperature');
    expect(readings[0]?.value).toBe('19.4°C');
  });

  it('caps a reading somebody made very long', () => {
    const { readings } = houseFrom({
      readings: [{ label: 'A'.repeat(400), value: 'B'.repeat(400), mode: 'value' }],
    });
    expect((readings[0]?.label ?? '').length).toBeLessThanOrEqual(60);
    expect((readings[0]?.value ?? '').length).toBeLessThanOrEqual(60);
  });

  it('drops a reading that is nothing but invisible characters', () => {
    // A label of zero-width marks is a label a household cannot see and cannot
    // tell apart from the one next to it.
    expect(houseFrom({ readings: [{ label: '\u200B\u200B', value: '1' }] }).readings).toEqual([]);
  });

  it('applies the same rule to an alert headline', () => {
    const [interrupt] = interruptsFrom([
      {
        ruleId: 'r', key: 'k', title: 'Tornado\u202EWarning',
        headline: 'TAKE COVER\u200B NOW', action: 'takeover', dismissible: true,
      },
    ]);
    expect(interrupt?.title).toBe('TornadoWarning');
    expect(interrupt?.headline).toBe('TAKE COVER NOW');
  });
});

describe('people, for the legend and the per-event owner cue', () => {
  const TODAY = '2026-07-15';

  it('carries the household through, in order, with initials for a photoless face', () => {
    const built = model([day(TODAY)], {
      people: [
        { id: 'p1', name: 'Mary Jane', color: '#22AA88', avatarUrl: null },
        { id: 'p2', name: 'Sam', color: '#C86', avatarUrl: '/d/media/sam.png' },
      ],
    });
    expect(built.people.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(built.people[0]!.initials).toBe('MJ');
    expect(built.people[1]!.initials).toBe('SA');
    expect(built.people[1]!.avatarUrl).toBe('/d/media/sam.png');
  });

  it('resolves an owned event to its person, and leaves an unowned one alone', () => {
    const built = model(
      [
        day(TODAY, [
          event({ title: 'Owned', startsAt: NOON + 3_600_000, color: '#22AA88', personId: 'p1' }),
          event({ title: 'Shared', startsAt: NOON + 7_200_000 }),
        ]),
      ],
      { people: [{ id: 'p1', name: 'Mary', color: '#22AA88', avatarUrl: null }] },
    );
    const events = built.today?.events ?? [];
    const owned = events.find((e) => e.title === 'Owned');
    const shared = events.find((e) => e.title === 'Shared');
    expect(owned?.owner?.name).toBe('Mary');
    expect(owned?.owner?.initials).toBe('MA');
    expect(shared?.owner).toBeUndefined();
  });

  it('empties the legend when nobody is defined, so the strip never draws', () => {
    expect(model([day(TODAY)]).people).toEqual([]);
  });
});

/*
 * The day group, redrawn (RFC 010 phase 1).
 *
 * Two of these are the ones that matter. `spanLabel` reads `endsAt` as
 * exclusive, which is the single most common ICS bug and the reason a
 * one-day birthday must never say "Day 1 of 2". And `progress` is absent
 * unless an event is actually running, because a bar is a claim about now.
 */
describe('how far through a running event we are', () => {
  const running = event({
    title: 'Dentist',
    startsAt: Date.parse('2026-07-15T10:00:00Z'),
  });

  it('is the fraction elapsed while the event is running', () => {
    // Starts 10:00, ends 11:00, and `now` is 10:30.
    const built = model([day('2026-07-15', [running])], {}, Date.parse('2026-07-15T10:30:00Z'));
    expect(built.today?.events[0]?.progress).toBeCloseTo(0.5, 5);
  });

  it('is absent before it starts and after it ends', () => {
    const before = model([day('2026-07-15', [running])], {}, Date.parse('2026-07-15T09:59:00Z'));
    expect(before.today?.events[0]?.progress).toBeUndefined();

    const after = model([day('2026-07-15', [running])], {}, Date.parse('2026-07-15T11:00:00Z'));
    expect(after.today?.events[0]?.progress).toBeUndefined();
  });

  it('is absent for an all-day event, which has no clock to be part-way through', () => {
    const allDay = event({
      title: 'Half term',
      startsAt: Date.parse('2026-07-14T23:00:00Z'),
      allDay: true,
    });
    const built = model([day('2026-07-15', [allDay])], {}, Date.parse('2026-07-15T12:00:00Z'));
    expect(built.today?.events[0]?.progress).toBeUndefined();
  });

  it('is absent for a zero-length event rather than dividing by zero', () => {
    const instant = event({
      title: 'Reminder',
      startsAt: Date.parse('2026-07-15T10:00:00Z'),
    });
    const built = model(
      [day('2026-07-15', [{ ...instant, endsAt: instant.startsAt }])],
      {},
      Date.parse('2026-07-15T10:00:00Z'),
    );
    expect(built.today?.events[0]?.progress).toBeUndefined();
  });
});

describe('an event that spans more than one day says how far in', () => {
  it('says nothing for a one-day all-day event, because DTEND is exclusive', () => {
    // The 15th, all day. DTEND is midnight on the 16th — and midnight is the
    // household's, not UTC's, which is what `expand.ts` resolves. Reading that
    // end date as a day the event occupies puts every birthday on two days.
    const birthday = event({
      title: 'Ada',
      startsAt: Date.parse('2026-07-14T23:00:00Z'),
      allDay: true,
    });
    const built = model([
      day('2026-07-15', [{ ...birthday, endsAt: Date.parse('2026-07-15T23:00:00Z') }]),
    ]);
    expect(built.today?.events[0]?.span).toBeUndefined();
  });

  it('counts the days an event actually occupies', () => {
    // The 15th to the 17th inclusive: DTEND is midnight on the 18th, London.
    const holiday = {
      ...event({ title: 'Cornwall', startsAt: Date.parse('2026-07-14T23:00:00Z'), allDay: true }),
      endsAt: Date.parse('2026-07-17T23:00:00Z'),
    };
    const built = model([day('2026-07-15', [holiday]), day('2026-07-16', [holiday])]);
    expect(built.today?.events[0]?.span).toBe('Day 1 of 3');
    expect(built.next[0]?.events[0]?.span).toBe('Day 2 of 3');
  });

  it('does not count a timed event that ends exactly at midnight into the next day', () => {
    // 22:00 to 00:00 is one evening, not two days.
    const shift = {
      ...event({ title: 'Late shift', startsAt: Date.parse('2026-07-15T21:00:00Z') }),
      endsAt: Date.parse('2026-07-15T23:00:00Z'),
    };
    const built = model([day('2026-07-15', [shift])]);
    expect(built.today?.events[0]?.span).toBeUndefined();
  });
});

/*
 * Weather in the agenda (RFC 010 phase 3).
 *
 * The join is by date and nothing else. A name cannot do it — "Tonight" names
 * no weekday and "Monday" names no year — and joining by position would put
 * tomorrow's rain on today's row, which is the kind of wrong a household
 * believes.
 */
describe('the forecast beside a day', () => {
  const panel = (days: unknown[]) => ({
    panels: { weather: { provider: 'nws', days, fetchedAt: NOON, note: null } },
  }) as Partial<Manifest>;

  const wx = (date: string | undefined, high: number, low: number) => ({
    name: 'Wednesday', icon: '☀', high, low, unit: 'F',
    ...(date !== undefined ? { date } : {}),
  });

  it('lands on the day with the same date', () => {
    const built = model(
      [day('2026-07-15'), day('2026-07-16', [event({ title: 'Bins', startsAt: NOON })])],
      panel([wx('2026-07-15', 80, 60), wx('2026-07-16', 70, 50)]),
    );
    expect(built.today?.weather).toMatchObject({ high: '80°', low: '60°F' });
    // One degree sign, not two. The display adds it and the provider must send
    // the letter alone — Open-Meteo sent "°F" and every wall read "69°°F".
    expect(built.today?.weather?.low).not.toContain('°°');
    expect(built.next[0]?.weather).toMatchObject({ high: '70°' });
  });

  it('leaves a day the forecast does not reach without one', () => {
    // Never the neighbour's: a seven-day agenda against a three-day forecast
    // must not decorate day five with day three's numbers.
    const built = model(
      [day('2026-07-15'), day('2026-07-16', [event({ title: 'Bins', startsAt: NOON })])],
      panel([wx('2026-07-15', 80, 60)]),
    );
    expect(built.today?.weather).toBeDefined();
    expect(built.next[0]?.weather).toBeUndefined();
  });

  it('joins nothing when the provider gave no dates', () => {
    // A forecast cached by a server older than this field. The strip still
    // draws from `name`; only the join goes quiet.
    const built = model([day('2026-07-15')], panel([wx(undefined, 80, 60)]));
    expect(built.today?.weather).toBeUndefined();
  });
});

/*
 * The dense styles need more per cell than the quiet ones ever did.
 *
 * The cap used to be four, chosen for a month cell that draws three. An
 * edge-to-edge week column is tall enough for eight, and a cap here would mean
 * a household asking for a dense week and silently getting four — the same
 * shape as the agenda that was pre-cut to six and could never honour twelve.
 */
describe('what a horizon cell carries', () => {
  it('keeps enough events for the densest style, and lets the renderer cut', () => {
    const many = Array.from({ length: 15 }, (_, index) =>
      event({ title: `Event ${index}`, startsAt: NOON + index * 60_000 }),
    );
    const built = model([day('2026-07-15', many)]);
    const cell = built.horizon.flat().find((c) => c.date === '2026-07-15');
    expect(cell?.events).toHaveLength(12);
    // The count is the truth about the day, not the length of the list above it.
    expect(cell?.eventCount).toBe(15);
  });

  it('formats each event time the way the rest of the wall does', () => {
    // A week column shows the time, so the household's 12/24-hour choice has to
    // reach it — reformatting in the renderer is how two clocks disagree.
    const built = model([day('2026-07-15', [event({ title: 'Swim', startsAt: NOON })])]);
    const cell = built.horizon.flat().find((c) => c.date === '2026-07-15');
    expect(cell?.events[0]?.time).toBe(built.today?.events[0]?.time);
  });

  it('says "All day" for an all-day event rather than a time it does not have', () => {
    const allDay = event({
      title: 'Half term',
      startsAt: Date.parse('2026-07-14T23:00:00Z'),
      allDay: true,
    });
    const built = model([day('2026-07-15', [allDay])]);
    const cell = built.horizon.flat().find((c) => c.date === '2026-07-15');
    expect(cell?.events[0]?.time).toBe('All day');
  });
});

/*
 * Turning the rota's colours off is a widget choice, so there is nothing to
 * assert here — the model always carries the shifts and the renderer decides.
 * What is worth pinning is the shape the renderer is handed, because a horizon
 * cell flattens a day's shifts to *one* and that is the whole of the two-person
 * limitation: `shifts[0]` wins and nothing downstream can see the rest.
 */
describe('a day with more than one person on a rota', () => {
  const two = {
    date: '2026-07-15',
    events: [],
    shifts: [
      {
        key: 'day', label: 'Day', shortCode: 'D', colorToken: '--s-day',
        isWorking: true, source: 'pattern',
        personId: 'amy', personName: 'Amy', personColor: '#4C7FD1', personAvatarUrl: null,
      },
      {
        key: 'night', label: 'Nights', shortCode: 'N', colorToken: '--s-night',
        isWorking: true, source: 'pattern',
        personId: 'ben', personName: 'Ben', personColor: '#C05C7E', personAvatarUrl: null,
      },
    ],
  } as unknown as ManifestDay;

  it('keeps both on the day model, in the order the server sorted them', () => {
    // The agenda could show both; only the month grid cannot. Asserting this
    // separately is what stops a future "simplification" dropping the second
    // person at the source, where nothing could get it back.
    const built = model([two]);
    expect(built.today?.shifts.map((s) => s.personName)).toEqual(['Amy', 'Ben']);
  });

  it('offers the badge both people, not whoever sorted first', () => {
    // The bug this shape exists to remove. `todayShift` was `shifts[0]`, so a
    // two-worker household could put Amy's day shift on the wall and had no way
    // to put Ben's nights anywhere — while the panel renderer drew them both.
    const built = model([two]);
    expect(built.todayShifts.map((entry) => entry.shift.personName)).toEqual(['Amy', 'Ben']);
  });

  it('counts each run against its own person, not against the day', () => {
    /*
     * Amy is on days for the whole stretch; Ben starts nights on the middle
     * day. Counted per *day* — the old `shifts[0]` walk — Ben's run would take
     * its length from whatever Amy is on, because the day matched on the first
     * entry's key. Each is now walked against their own entry.
     */
    const both = (date: string, ben: string | undefined) =>
      ({
        date, events: [],
        shifts: [
          {
            key: 'day', label: 'Day', shortCode: 'D', colorToken: '--s-day',
            isWorking: true, source: 'pattern',
            personId: 'amy', personName: 'Amy', personColor: '#4C7FD1', personAvatarUrl: null,
          },
          ...(ben === undefined
            ? []
            : [{
                key: ben, label: ben === 'night' ? 'Nights' : 'Day', shortCode: 'N',
                colorToken: '--s-night', isWorking: true, source: 'pattern',
                personId: 'ben', personName: 'Ben', personColor: '#C05C7E', personAvatarUrl: null,
              }]),
        ],
      }) as unknown as ManifestDay;

    const built = model([
      both('2026-07-14', undefined),
      both('2026-07-15', 'night'),
      both('2026-07-16', 'night'),
    ]);
    const [amy, ben] = built.todayShifts;
    expect(amy?.shift.personName).toBe('Amy');
    expect(amy?.run).toBe('Day 2 of 3 · 1 more');
    // Ben's nights start today: first of two, not second of three.
    expect(ben?.shift.personName).toBe('Ben');
    expect(ben?.run).toBe('Day 1 of 2 · 1 more');
  });
});

/*
 * The run the shift badge draws.
 *
 * The server resolves the rota and sends the answer; this only formats it. The
 * old local count is kept for a manifest from a server older than the field —
 * including one read out of IndexedDB, which a wall can draw for months — and
 * it is deliberately not trusted, because it counts the days *in the manifest*
 * and the manifest holds one day of history.
 */
describe('how far through a run today is', () => {
  const shiftOn = (date: string, run?: { position: number; total: number }) =>
    ({
      date, events: [],
      shifts: [{
        key: 'straights', label: 'Straights', shortCode: 'S', colorToken: '--s-straight',
        isWorking: true, source: 'pattern',
        personId: 'daddy', personName: 'Daddy', personColor: '#888', personAvatarUrl: null,
        ...(run !== undefined ? { run } : {}),
      }],
    }) as unknown as ManifestDay;

  it('draws the server\'s position, however little history the manifest holds', () => {
    // The reported bug: a 14-day run on day 13 read "Day 2 of 3 · 1 more",
    // because one day of history was all the wall could see.
    const built = model([shiftOn('2026-07-15', { position: 13, total: 14 })]);
    expect(built.todayShifts[0]?.run).toBe('Day 13 of 14 · 1 more');
  });

  it('says so on the last day rather than counting down to nothing', () => {
    const built = model([shiftOn('2026-07-15', { position: 14, total: 14 })]);
    expect(built.todayShifts[0]?.run).toBe('Last of 14');
  });

  it('falls back to counting the manifest when the server did not say', () => {
    // What every wall did before this: one day of history, so at most "Day 2".
    // Pinned as the floor it is, not as a correct answer.
    const built = model([shiftOn('2026-07-14'), shiftOn('2026-07-15'), shiftOn('2026-07-16')]);
    expect(built.todayShifts[0]?.run).toBe('Day 2 of 3 · 1 more');
  });
});
