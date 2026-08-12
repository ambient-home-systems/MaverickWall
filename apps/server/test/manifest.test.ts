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
  layoutMode: 'auto',
  layoutAspect: 0.5625,
};

const SOURCES: SourceRow[] = [
  { id: 's1', name: 'Family', color: '#E8A33D', visible: 1, lastSuccessAt: NOW - 60_000, lastError: null, consecutiveFailures: 0, eventCount: 2 },
  { id: 's2', name: 'School', color: '#4C7FD1', visible: 1, lastSuccessAt: NOW - 60_000, lastError: null, consecutiveFailures: 0, eventCount: 1 },
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
