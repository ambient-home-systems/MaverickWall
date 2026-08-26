import { describe, expect, it } from 'vitest';
import type { ShiftPlan, ShiftType } from '@maverick-wall/core';
import {
  buildManifest,
  manifestEtag,
  type BuildManifestInput,
  type EventCacheRow,
  type HouseholdRow,
  type PersonRow,
  type SourceRow,
} from '../src/api/manifest.js';

const PEOPLE: PersonRow[] = [
  { id: 'p1', name: 'Josh', color: '#E8A33D', hasShiftRotation: 1, sortOrder: 0, avatarPath: null },
];

const NOW = Date.parse('2026-09-10T12:00:00Z');

const HOUSEHOLD: HouseholdRow = {
  timezone: 'America/New_York',
  theme: 'board',
  daytimeTheme: 'almanac',
  daytimeStartsAt: '07:00',
  daytimeEndsAt: '21:00',
  shiftEnabled: 1,
  displayTodayEvents: 8,
  displayNextDays: 6,
  displayHorizonWeeks: 5,
  displayBlocks: 'now,next,horizon',
  clock24: 1,
  weekStart: 'sunday',
  layoutMode: 'auto',
  layoutAspect: 0.5625,
  layoutLandscapeAspect: 1.7778,
  layoutBackground: null,
  layoutLandscapeBackground: null,
};

const SOURCES: SourceRow[] = [
  { id: 's1', name: 'Family', color: '#E8A33D', visible: 1, personId: null, lastSuccessAt: NOW - 60_000, lastError: null, consecutiveFailures: 0, eventCount: 2 },
  { id: 's2', name: 'School', color: '#4C7FD1', visible: 1, personId: null, lastSuccessAt: NOW - 60_000, lastError: null, consecutiveFailures: 0, eventCount: 1 },
];

const EVENTS: EventCacheRow[] = [
  { id: 'e1', sourceId: 's1', uid: 'u1', title: 'Dentist', location: null, startsAt: NOW, endsAt: NOW + 3_600_000, allDay: 0, startLocalDate: '2026-09-10', endLocalDate: '2026-09-10', status: 'CONFIRMED' },
  { id: 'e2', sourceId: 's1', uid: 'u2', title: 'Disney Trip', location: null, startsAt: NOW, endsAt: NOW + 3 * 86_400_000, allDay: 1, startLocalDate: '2026-09-10', endLocalDate: '2026-09-12', status: 'CONFIRMED' },
  { id: 'e3', sourceId: 's2', uid: 'u3', title: 'Half day', location: null, startsAt: NOW, endsAt: NOW + 86_400_000, allDay: 1, startLocalDate: '2026-09-11', endLocalDate: '2026-09-11', status: 'CONFIRMED' },
];

const SHIFT_TYPES: ShiftType[] = [
  { key: 'day', label: 'Days', shortCode: 'D', colorToken: '--s-day', isWorking: true },
  { key: 'night', label: 'Mids', shortCode: 'M', colorToken: '--s-night', isWorking: true },
];

// Anchored on 2026-09-06: three working days, then four off, repeating on the 13th.
const PLANS = [
  {
    kind: 'pattern',
    id: 'p',
    name: 'rota',
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
    priority: 0,
    anchorDate: '2026-09-06',
    cycle: ['day', 'day', 'day', null, null, null, null],
  },
] as unknown as ShiftPlan[];

const BASE: BuildManifestInput = {
  household: HOUSEHOLD,
  events: EVENTS,
  sources: SOURCES,
  people: PEOPLE,
  shiftTypes: SHIFT_TYPES,
  shiftPlans: PLANS,
  shiftOverrides: [],
  today: '2026-09-10',
  daysBefore: 1,
  daysAfter: 5,
  now: NOW,
  appVersion: '0.1.0',
};

const dayOf = (manifest: ReturnType<typeof buildManifest>, date: string) =>
  manifest.days.find((day) => day.date === date);

describe('shape', () => {
  it('covers the requested window with one entry per day', () => {
    const manifest = buildManifest(BASE);
    expect([manifest.window.from, manifest.window.to]).toEqual(['2026-09-09', '2026-09-15']);
    expect(manifest.days).toHaveLength(7);
  });

  it('carries authoritative server time', () => {
    // A wall tablet's clock drifts and some never get NTP. The display tracks
    // its offset from this and never trusts its own clock.
    expect(buildManifest(BASE).generatedAt).toBe(NOW);
  });

  it('carries the clock format, defaulting to 24-hour (RFC 005)', () => {
    expect(buildManifest(BASE).display.clock24).toBe(true);
    expect(buildManifest({ ...BASE, household: { ...HOUSEHOLD, clock24: 0 } }).display.clock24).toBe(false);
  });

  it('reserves the fields for features not yet built', () => {
    // So the display contract does not change when interrupts land. Weather
    // has arrived and is a panel now; with no modules registered here, the
    // collection is simply empty.
    const manifest = buildManifest(BASE);
    expect(manifest.panels).toEqual({});
    expect(manifest.interrupts).toEqual([]);
  });
});

describe('events', () => {
  it('lists a multi-day event on every day it touches', () => {
    // A trip that only appeared on its first day would look like a one-day
    // event to anyone glancing at the wall.
    const manifest = buildManifest(BASE);
    for (const date of ['2026-09-10', '2026-09-11', '2026-09-12']) {
      expect(dayOf(manifest, date)?.events.some((e) => e.title === 'Disney Trip')).toBe(true);
    }
    expect(dayOf(manifest, '2026-09-13')?.events).toHaveLength(0);
  });

  it('marks which events continue beyond their day', () => {
    const manifest = buildManifest(BASE);
    expect(dayOf(manifest, '2026-09-11')?.events.find((e) => e.title === 'Disney Trip')?.continues).toBe(true);
    expect(dayOf(manifest, '2026-09-10')?.events.find((e) => e.title === 'Dentist')?.continues).toBe(false);
  });

  it('paints an owned calendar in its owner’s colour, not its own', () => {
    // The whole point of assigning an owner: "Josh is amber everywhere". The
    // Family feed's own #E8A33D happens to match, so give the owner a distinct
    // colour and give the feed a different one, then prove the owner wins.
    const manifest = buildManifest({
      ...BASE,
      people: [{ ...PEOPLE[0]!, color: '#22AA88' }],
      sources: [{ ...SOURCES[0]!, color: '#111111', personId: 'p1' }, SOURCES[1]!],
    });
    const dentist = dayOf(manifest, '2026-09-10')?.events.find((e) => e.title === 'Dentist');
    expect(dentist?.color).toBe('#22AA88');
    expect(dentist?.personId).toBe('p1');
  });

  it('leaves an unowned calendar its own colour and no owner', () => {
    const manifest = buildManifest(BASE);
    const halfDay = dayOf(manifest, '2026-09-11')?.events.find((e) => e.title === 'Half day');
    expect(halfDay?.color).toBe('#4C7FD1');
    expect(halfDay?.personId).toBeUndefined();
  });

  it('falls back to the calendar’s colour when the owner id is dangling', () => {
    // A person removed after the calendar was assigned to them: better a real
    // colour than a grey nothing.
    const manifest = buildManifest({
      ...BASE,
      people: [],
      sources: [{ ...SOURCES[0]!, color: '#123456', personId: 'gone' }, SOURCES[1]!],
    });
    const dentist = dayOf(manifest, '2026-09-10')?.events.find((e) => e.title === 'Dentist');
    expect(dentist?.color).toBe('#123456');
  });

  it('sorts all-day above timed', () => {
    expect(dayOf(buildManifest(BASE), '2026-09-10')?.events.map((e) => e.title)).toEqual([
      'Disney Trip',
      'Dentist',
    ]);
  });

  it('omits hidden sources but still reports their health', () => {
    const manifest = buildManifest({
      ...BASE,
      sources: [{ ...SOURCES[0]!, visible: 0 }, SOURCES[1]!],
    });
    expect(manifest.days.flatMap((d) => d.events).some((e) => e.sourceId === 's1')).toBe(false);
    expect(manifest.sources).toHaveLength(2);
  });
});

describe('shifts', () => {
  it('resolves a working day, and marks a rest day as an explicit break', () => {
    const manifest = buildManifest(BASE);
    expect(dayOf(manifest, '2026-09-13')?.shifts[0]?.key).toBe('day');
    expect(dayOf(manifest, '2026-09-13')?.shifts[0]?.source).toBe('pattern');

    // A rest day the pattern named is a fact about the day, not an absence of
    // one. The display colours it, and it says so out of the same field.
    const rest = dayOf(manifest, '2026-09-10')?.shifts[0];
    expect(rest?.key).toBe('break');
    expect(rest?.isWorking).toBe(false);
    expect(rest?.colorToken).toBe('--s-break');
  });

  it('shows an override through to the display', () => {
    const manifest = buildManifest({
      ...BASE,
      shiftOverrides: [{ date: '2026-09-10', shiftTypeKey: 'night', note: 'covering' }],
    });
    expect(dayOf(manifest, '2026-09-10')?.shifts[0]?.key).toBe('night');
    expect(dayOf(manifest, '2026-09-10')?.shifts[0]?.source).toBe('override');
  });

  it('emits nothing at all when the feature is off', () => {
    // A household with no shift worker never sees any of it.
    const manifest = buildManifest({ ...BASE, household: { ...HOUSEHOLD, shiftEnabled: 0 } });
    expect(manifest.days.every((day) => day.shifts.length === 0)).toBe(true);
  });
});

describe('notices', () => {
  it('says nothing when everything is healthy', () => {
    expect(buildManifest(BASE).notices).toEqual([]);
  });

  it('ignores a single failure', () => {
    // Networks blip and the next sync is minutes away. Warning about it would
    // train people to ignore the banner.
    const manifest = buildManifest({
      ...BASE,
      sources: [{ ...SOURCES[0]!, consecutiveFailures: 1 }, SOURCES[1]!],
    });
    expect(manifest.notices).toEqual([]);
  });

  it('warns after three, naming the feed and how stale it is', () => {
    const manifest = buildManifest({
      ...BASE,
      sources: [
        { ...SOURCES[0]!, consecutiveFailures: 4, lastSuccessAt: NOW - 7_200_000 },
        SOURCES[1]!,
      ],
    });
    expect(manifest.notices.map((n) => n.code)).toEqual(['source-failing']);
    expect(manifest.notices[0]?.message).toContain('Family');
    expect(manifest.notices[0]?.message).toContain('2 hours');
  });

  it('treats a feed that has never synced as an error', () => {
    const manifest = buildManifest({
      ...BASE,
      sources: [{ ...SOURCES[0]!, consecutiveFailures: 4, lastSuccessAt: null }, SOURCES[1]!],
    });
    expect(manifest.notices[0]?.level).toBe('error');
  });

  it('surfaces a feed that is quietly stale without failing', () => {
    // A job that stopped being scheduled looks exactly like this and would
    // otherwise be invisible.
    const manifest = buildManifest({
      ...BASE,
      sources: [{ ...SOURCES[0]!, lastSuccessAt: NOW - 3 * 86_400_000 }, SOURCES[1]!],
    });
    expect(manifest.notices.map((n) => n.code)).toEqual(['source-stale']);
  });

  it('puts caller-supplied notices first', () => {
    const manifest = buildManifest({
      ...BASE,
      notices: [{ level: 'warn', code: 'migration', message: 'Database update incomplete.' }],
    });
    expect(manifest.notices[0]?.code).toBe('migration');
  });
});

describe('etag', () => {
  it('is stable for identical content', () => {
    expect(manifestEtag(buildManifest(BASE))).toBe(manifestEtag(buildManifest(BASE)));
  });

  it('ignores server time', () => {
    // Otherwise every poll would transfer the whole document even when nothing
    // had changed, which defeats the point of conditional requests.
    expect(manifestEtag(buildManifest({ ...BASE, now: NOW + 999_999 }))).toBe(
      manifestEtag(buildManifest(BASE)),
    );
  });

  it('changes when the content does', () => {
    const base = manifestEtag(buildManifest(BASE));
    expect(manifestEtag(buildManifest({ ...BASE, events: EVENTS.slice(0, 1) }))).not.toBe(base);
    expect(
      manifestEtag(
        buildManifest({ ...BASE, shiftOverrides: [{ date: '2026-09-10', shiftTypeKey: 'night' }] }),
      ),
    ).not.toBe(base);
  });

  it('is quoted, ready for the header', () => {
    expect(manifestEtag(buildManifest(BASE))).toMatch(/^"[0-9a-f]{32}"$/);
  });
});

describe('shifts derived from a calendar', () => {
  // The density problem this solves: a work calendar marks every single day
  // with "Working Day Shift" or "Break Day". Left in the agenda, those bury the
  // dentist appointment underneath the same fact the day's colour already says.
  const WORK_EVENTS: EventCacheRow[] = [
    { id: 'w1', sourceId: 's1', uid: 'w1', title: 'Daddy - Working Day Shift', location: null, startsAt: NOW, endsAt: NOW + 86_400_000, allDay: 1, startLocalDate: '2026-09-10', endLocalDate: '2026-09-10', status: 'CONFIRMED' },
    { id: 'w2', sourceId: 's1', uid: 'w2', title: 'Daddy - Break Day', location: null, startsAt: NOW + 86_400_000, endsAt: NOW + 2 * 86_400_000, allDay: 1, startLocalDate: '2026-09-11', endLocalDate: '2026-09-11', status: 'CONFIRMED' },
    { id: 'a1', sourceId: 's1', uid: 'a1', title: 'Mommy nail appt', location: null, startsAt: NOW, endsAt: NOW + 3_600_000, allDay: 0, startLocalDate: '2026-09-10', endLocalDate: '2026-09-10', status: 'CONFIRMED' },
  ];

  const CALENDAR_PLAN = [
    {
      kind: 'calendar',
      id: 'c1',
      name: 'from work',
      effectiveFrom: '2000-01-01',
      effectiveTo: null,
      priority: 10,
      calendarSourceId: 's1',
      consumesEvents: true,
      matchers: [
        { shiftTypeKey: null, pattern: 'break day', isRegex: false },
        { shiftTypeKey: 'day', pattern: 'day shift', isRegex: false },
      ],
    },
  ] as unknown as ShiftPlan[];

  const input: BuildManifestInput = { ...BASE, events: WORK_EVENTS, shiftPlans: CALENDAR_PLAN };

  it('reads the shift from the event title', () => {
    const manifest = buildManifest(input);
    expect(dayOf(manifest, '2026-09-10')?.shifts[0]?.key).toBe('day');
    expect(dayOf(manifest, '2026-09-10')?.shifts[0]?.source).toBe('calendar');
  });

  it('treats an explicit rest day as not working, not as unknown', () => {
    // The distinction this test is named for. It previously asserted an empty
    // list, which is what "unknown" looks like — so it was quietly checking
    // the opposite of its own title, and the display had no way to tell a
    // rest day from a day the rota says nothing about.
    const manifest = buildManifest(input);
    const shift = dayOf(manifest, '2026-09-11')?.shifts[0];
    expect(shift?.key).toBe('break');
    expect(shift?.isWorking).toBe(false);
    expect(shift?.source).not.toBe('none');
  });

  it('removes the shift events from the agenda but keeps the appointments', () => {
    const manifest = buildManifest(input);
    const titles = manifest.days.flatMap((day) => day.events.map((event) => event.title));
    expect(titles).toEqual(['Mommy nail appt']);
  });

  it('leaves them visible when the plan does not consume', () => {
    const manifest = buildManifest({
      ...input,
      shiftPlans: [{ ...(CALENDAR_PLAN[0] as object), consumesEvents: false }] as unknown as ShiftPlan[],
    });
    const titles = manifest.days.flatMap((day) => day.events.map((event) => event.title));
    expect(titles).toContain('Daddy - Working Day Shift');
  });

  it('only consumes events from the source the plan names', () => {
    // Another calendar happening to contain the words "day shift" must not have
    // its events silently swallowed.
    const manifest = buildManifest({
      ...input,
      events: [...WORK_EVENTS, { ...WORK_EVENTS[0]!, id: 'other', sourceId: 's2', title: 'School day shift photos' }],
    });
    const titles = manifest.days.flatMap((day) => day.events.map((event) => event.title));
    expect(titles).toContain('School day shift photos');
  });

  it('does nothing at all when the feature is off', () => {
    const manifest = buildManifest({
      ...input,
      household: { ...HOUSEHOLD, shiftEnabled: 0 },
    });
    const titles = manifest.days.flatMap((day) => day.events.map((event) => event.title));
    expect(titles).toContain('Daddy - Working Day Shift');
    expect(manifest.days.every((day) => day.shifts.length === 0)).toBe(true);
  });
});

describe('two people', () => {
  // Households have more than one shift worker. Resolving a single timeline —
  // which an earlier version did — cannot say whose shift it is, and a wall
  // showing one person's rota while the other's is invisible is worse than
  // showing neither.
  const TWO: PersonRow[] = [
    { id: 'p1', name: 'Josh', color: '#E8A33D', hasShiftRotation: 1, sortOrder: 0, avatarPath: null },
    { id: 'p2', name: 'Sam', color: '#4C7FD1', hasShiftRotation: 1, sortOrder: 1, avatarPath: null },
  ];

  const plans = [
    {
      kind: 'pattern', id: 'a', name: 'Josh', personId: 'p1',
      effectiveFrom: '2000-01-01', effectiveTo: null, priority: 0,
      anchorDate: '2026-09-06', cycle: ['day', 'day', 'day', null, null, null, null],
    },
    {
      kind: 'pattern', id: 'b', name: 'Sam', personId: 'p2',
      effectiveFrom: '2000-01-01', effectiveTo: null, priority: 0,
      anchorDate: '2026-09-06', cycle: [null, null, null, 'night', 'night', null, null],
    },
  ] as unknown as ShiftPlan[];

  const input: BuildManifestInput = { ...BASE, people: TWO, shiftPlans: plans };

  it('keeps each person on their own rota', () => {
    const manifest = buildManifest(input);
    // 2026-09-09 is cycle position 3: Josh is off, Sam is on nights. Both are
    // now stated, so a wall can say "Josh off, Sam nights" rather than leaving
    // half the household unaccounted for.
    const ninth = manifest.days.find((day) => day.date === '2026-09-09');
    expect(ninth?.shifts.map((shift) => shift.personName)).toEqual(['Josh', 'Sam']);

    const byPerson = new Map(ninth?.shifts.map((shift) => [shift.personName, shift]));
    expect(byPerson.get('Sam')?.key).toBe('night');
    expect(byPerson.get('Sam')?.isWorking).toBe(true);
    expect(byPerson.get('Josh')?.key).toBe('break');
    expect(byPerson.get('Josh')?.isWorking).toBe(false);
  });

  it('says nothing at all about a day no plan covers', () => {
    // The other half of the distinction: outside every plan's range there is
    // no rota to report, and that must not render as a rest day.
    const outside: BuildManifestInput = {
      ...input,
      shiftPlans: plans.map((plan) => ({ ...plan, effectiveTo: '2020-01-01' })) as ShiftPlan[],
    };
    const manifest = buildManifest(outside);
    expect(manifest.days.every((day) => day.shifts.length === 0)).toBe(true);
  });

  it('lists both when both are working', () => {
    const bothWorking = buildManifest({
      ...input,
      shiftPlans: plans.map((plan) => ({
        ...(plan as object),
        cycle: ['day', 'day', 'day', 'day', 'day', 'day', 'day'],
      })) as unknown as ShiftPlan[],
    });
    const day = bothWorking.days[0];
    expect(day?.shifts).toHaveLength(2);
    expect(day?.shifts.map((shift) => shift.personName)).toEqual(['Josh', 'Sam']);
  });

  it('carries each person’s colour, so the wall can tell them apart', () => {
    const manifest = buildManifest(input);
    const shifts = manifest.days.flatMap((day) => day.shifts);
    expect(new Set(shifts.map((shift) => shift.personColor))).toEqual(
      new Set(['#E8A33D', '#4C7FD1']),
    );
  });

  it('orders people consistently', () => {
    // Reversed input, same output: the wall must not reorder between polls.
    const reversed = buildManifest({ ...input, people: [...TWO].reverse() });
    const both = reversed.days.find((day) => day.shifts.length === 2);
    if (both) expect(both.shifts.map((shift) => shift.personName)).toEqual(['Josh', 'Sam']);
    expect(reversed.people.map((person) => person.name)).toEqual(['Josh', 'Sam']);
  });

  it('publishes the roster so a legend can be drawn', () => {
    expect(buildManifest(input).people).toEqual([
      { id: 'p1', name: 'Josh', color: '#E8A33D', hasShiftRotation: true, avatarUrl: null },
      { id: 'p2', name: 'Sam', color: '#4C7FD1', hasShiftRotation: true, avatarUrl: null },
    ]);
  });

  it('attributes an ownerless plan to the first person rather than dropping it', () => {
    // Plans created before people existed. Silently discarding them would make
    // an upgrade look like a broken rota.
    const legacy = buildManifest({
      ...input,
      shiftPlans: [{ ...(plans[0] as object), personId: null }] as unknown as ShiftPlan[],
    });
    expect(legacy.days.some((day) => day.shifts.some((shift) => shift.personName === 'Josh'))).toBe(true);
  });
});

describe('theme tokens in the manifest', () => {
  it('carries only the shape for a built-in — the display bundle owns its tokens', () => {
    const manifest = buildManifest({
      ...BASE,
      resolveTheme: (ref) => ({ shape: ref }),
    });
    expect(manifest.theme.active).toBe('board');
    expect(manifest.theme.activeShape).toBe('board');
    expect(manifest.theme.activeTokens).toBeUndefined();
  });

  it('carries the resolved token set for a custom active theme', () => {
    const manifest = buildManifest({
      ...BASE,
      household: { ...HOUSEHOLD, theme: 'custom:abc' },
      resolveTheme: (ref) =>
        ref === 'custom:abc' ? { tokens: { '--bg': '#123456' }, shape: 'board' } : { shape: ref },
    });
    expect(manifest.theme.active).toBe('custom:abc');
    expect(manifest.theme.activeShape).toBe('board');
    expect(manifest.theme.activeTokens).toEqual({ '--bg': '#123456' });
  });

  it('resolves the daytime theme too', () => {
    const manifest = buildManifest({
      ...BASE,
      household: { ...HOUSEHOLD, daytimeTheme: 'custom:day' },
      resolveTheme: (ref) =>
        ref === 'custom:day' ? { tokens: { '--bg': '#ffffff' }, shape: 'board' } : { shape: ref },
    });
    expect(manifest.theme.daytime).toBe('custom:day');
    expect(manifest.theme.daytimeTokens).toEqual({ '--bg': '#ffffff' });
  });
});

describe('per-type shift colour and times', () => {
  it("carries a type's explicit colour and window when set", () => {
    const types: ShiftType[] = SHIFT_TYPES.map((t) =>
      t.key === 'day' ? { ...t, color: '#ff8800', startTime: '07:00', endTime: '19:00' } : t,
    );
    const shift = dayOf(buildManifest({ ...BASE, shiftTypes: types }), '2026-09-13')?.shifts[0];
    expect(shift?.color).toBe('#ff8800');
    expect(shift?.startTime).toBe('07:00');
    expect(shift?.endTime).toBe('19:00');
  });

  it('omits colour and times, keeping the token, when the type sets none', () => {
    const shift = dayOf(buildManifest(BASE), '2026-09-13')?.shifts[0];
    expect(shift?.color).toBeUndefined();
    expect(shift?.startTime).toBeUndefined();
    expect(shift?.colorToken).toBe('--s-day');
  });
});

/*
 * Week numbers (RFC 010 phase 4).
 *
 * The expected values come from GNU coreutils (`date +%V` for ISO, `date +%U`
 * for the Sunday-start count, which numbers from the first Sunday and so runs
 * one behind a scheme that puts 1 January in week 1). Not from running the
 * implementation — that would only prove it is consistent with itself.
 *
 * The window here is 2026-09-09 to 2026-09-15, and 2026-09-13 is a Sunday,
 * where the two schemes genuinely disagree. That is the whole reason the scheme
 * follows the household's week start: an ISO number on a Sunday-start row
 * labels a row that spans two ISO weeks.
 */
describe('week numbers', () => {
  it('numbers a Sunday-start household from the week holding 1 January', () => {
    const manifest = buildManifest(BASE); // HOUSEHOLD.weekStart is 'sunday'
    expect(dayOf(manifest, '2026-09-09')?.weekNumber).toBe(37);
    // The Sunday starts a new row, so it starts a new number.
    expect(dayOf(manifest, '2026-09-13')?.weekNumber).toBe(38);
    expect(dayOf(manifest, '2026-09-15')?.weekNumber).toBe(38);
  });

  it('numbers a Monday-start household by ISO 8601', () => {
    const manifest = buildManifest({
      ...BASE,
      household: { ...HOUSEHOLD, weekStart: 'monday' },
    });
    expect(dayOf(manifest, '2026-09-09')?.weekNumber).toBe(37);
    // Under ISO the Sunday is the *end* of its week, not the start.
    expect(dayOf(manifest, '2026-09-13')?.weekNumber).toBe(37);
    expect(dayOf(manifest, '2026-09-15')?.weekNumber).toBe(38);
  });

  it('gives every day in the window one', () => {
    // The display only draws the column when every row has a number, so a
    // single gap would silently switch the feature off.
    for (const day of buildManifest(BASE).days) {
      expect(typeof day.weekNumber).toBe('number');
    }
  });
});

/*
 * How far through a run of shifts today is.
 *
 * This is computed here, on the server, because the display cannot do it: it
 * counted the days *in the manifest*, and the manifest carries one single day
 * of history, so it could not tell "the run started here" from "I ran out of
 * data". Every run longer than a day read "Day 2 of N" — a 14-day run of
 * straights on day 13 reported "Day 2 of 3 · 1 more". The "1 more" was right;
 * the position could never exceed 2.
 *
 * A 14-on / 14-off cycle is the case that was reported, so it is the case
 * asserted, and the position is checked on several days of the run rather than
 * one — a single day passes just as happily against an off-by-one.
 */
describe('the run a shift is part of', () => {
  const FOURTEEN = [
    {
      kind: 'pattern', id: 'straights', name: 'straights',
      effectiveFrom: '2020-01-01', effectiveTo: null, priority: 0,
      // 2026-08-31 is day 1 of the run, so 2026-09-12 is day 13.
      anchorDate: '2026-08-31',
      cycle: [...Array.from({ length: 14 }, () => 'day'), ...Array.from({ length: 14 }, () => null)],
    },
  ] as unknown as ShiftPlan[];

  const runOn = (today: string) =>
    buildManifest({ ...BASE, shiftPlans: FOURTEEN, today })
      .days.find((day) => day.date === today)?.shifts[0]?.run;

  it('reports the real position, not the manifest window', () => {
    expect(runOn('2026-09-12')).toEqual({ position: 13, total: 14 });
  });

  it('walks the whole run, not just its middle', () => {
    expect(runOn('2026-08-31')).toEqual({ position: 1, total: 14 });
    expect(runOn('2026-09-06')).toEqual({ position: 7, total: 14 });
    expect(runOn('2026-09-13')).toEqual({ position: 14, total: 14 });
  });

  it('counts a run of rest days too, because a rest day is a fact', () => {
    // The day after the working run ends. `shiftFor` emits a synthetic `break`
    // for a resolved not-working day precisely so the wall can draw it, so
    // "day 1 of 14 off" is a real answer and the right one — the first draft
    // of this test expected `undefined` and was asserting the wrong model.
    expect(runOn('2026-09-14')).toEqual({ position: 1, total: 14 });
    expect(runOn('2026-09-20')).toEqual({ position: 7, total: 14 });
  });

  it('is absent when there is no rota at all', () => {
    const manifest = buildManifest({ ...BASE, shiftPlans: [], today: '2026-09-12' });
    const day = manifest.days.find((entry) => entry.date === '2026-09-12');
    expect(day?.shifts).toHaveLength(0);
  });

  it('rides only on today, because that is the only day it answers for', () => {
    const manifest = buildManifest({ ...BASE, shiftPlans: FOURTEEN, today: '2026-09-12' });
    const others = manifest.days.filter((day) => day.date !== '2026-09-12');
    expect(others.every((day) => day.shifts.every((shift) => shift.run === undefined))).toBe(true);
  });
});

/*
 * The same run, from a calendar-derived rota.
 *
 * 0.40.0 moved this calculation to the server and *still* reported "Day 2 of
 * 3" on the wall that reported it. The resolution range was widened; the data
 * feeding it was not. A pattern plan resolves mathematically and needs no
 * events, so the pattern tests above passed — and a calendar plan matches on
 * event titles, so it went blind one day behind today and the walk stopped
 * there. The fixture that would have caught it is this one: the same fortnight,
 * read from titles instead of a cycle.
 */
describe('a run read from a calendar feed', () => {
  const FEED = [
    {
      kind: 'calendar', id: 'c', name: 'work feed',
      effectiveFrom: '2020-01-01', effectiveTo: null, priority: 0,
      calendarSourceId: SOURCES[0]!.id, consumesEvents: true,
      matchers: [{ shiftTypeKey: 'day', pattern: 'STRAIGHTS', mode: 'contains' }],
    },
  ] as unknown as ShiftPlan[];

  /** A "STRAIGHTS" event on each of `days`, as the feed would carry them. */
  const feedEvents = (days: readonly string[]) =>
    days.map((date, index) => ({
      ...EVENTS[0]!,
      id: `s${index}`, uid: `s${index}`, title: 'STRAIGHTS',
      startsAt: Date.parse(`${date}T06:00:00Z`), endsAt: Date.parse(`${date}T18:00:00Z`),
      startLocalDate: date, endLocalDate: date,
    }));

  // A fortnight of straights, 2026-08-31 to 2026-09-13.
  const RUN = Array.from({ length: 14 }, (_, index) =>
    new Date(Date.parse('2026-08-31T12:00:00Z') + index * 86_400_000).toISOString().slice(0, 10),
  );

  const runOn = (today: string) =>
    buildManifest({ ...BASE, today, shiftPlans: FEED, events: feedEvents(RUN) })
      .days.find((day) => day.date === today)?.shifts[0]?.run;

  it('follows the run back past the manifest window', () => {
    // The reported case. Before the fix this was { position: 2, total: 3 },
    // because the only history the resolver could see was yesterday.
    expect(runOn('2026-09-12')).toEqual({ position: 13, total: 14 });
  });

  it('agrees with the pattern rota on every day of the same fortnight', () => {
    expect(runOn('2026-08-31')).toEqual({ position: 1, total: 14 });
    expect(runOn('2026-09-06')).toEqual({ position: 7, total: 14 });
    expect(runOn('2026-09-13')).toEqual({ position: 14, total: 14 });
  });
});
