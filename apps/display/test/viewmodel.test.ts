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
    expect(built.shiftRun).toBe('Day 2 of 4 · 2 more');
    expect(built.todayShift?.label).toBe('Mids');
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
    expect(built.shiftRun).toBe('Last of 2');
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

  it('caps the cell events at four while eventCount stays the true total', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      event({ title: `E${i}`, startsAt: Date.parse('2026-07-15T09:00:00Z') + i }),
    );
    const cell = model([day('2026-07-15', many)]).horizon.flat().find((c) => c.isToday);
    expect(cell?.eventCount).toBe(6); // the "+N" and the dots read from this
    expect(cell?.events).toHaveLength(4); // a column has room for a handful
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
 * The day group, redrawn (RFC 007 phase 1).
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
 * Weather in the agenda (RFC 007 phase 3).
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
