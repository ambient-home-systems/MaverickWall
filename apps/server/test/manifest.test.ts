import { describe, expect, it } from 'vitest';
import type { ShiftPlan, ShiftType } from '@maverick-wall/core';
import {
  buildManifest,
  manifestEtag,
  type BuildManifestInput,
  type EventCacheRow,
  type HouseholdRow,
  type SourceRow,
} from '../src/api/manifest.js';

const NOW = Date.parse('2026-09-10T12:00:00Z');

const HOUSEHOLD: HouseholdRow = {
  timezone: 'America/New_York',
  theme: 'board',
  daytimeTheme: 'almanac',
  daytimeStartsAt: '07:00',
  daytimeEndsAt: '21:00',
  shiftEnabled: 1,
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
    // So the display contract does not change when weather and interrupts land.
    const manifest = buildManifest(BASE);
    expect(manifest.weather).toBe(null);
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
  it('resolves a working day and leaves rest days empty', () => {
    const manifest = buildManifest(BASE);
    expect(dayOf(manifest, '2026-09-13')?.shift?.key).toBe('day');
    expect(dayOf(manifest, '2026-09-13')?.shift?.source).toBe('pattern');
    expect(dayOf(manifest, '2026-09-10')?.shift).toBeUndefined();
  });

  it('shows an override through to the display', () => {
    const manifest = buildManifest({
      ...BASE,
      shiftOverrides: [{ date: '2026-09-10', shiftTypeKey: 'night', note: 'covering' }],
    });
    expect(dayOf(manifest, '2026-09-10')?.shift?.key).toBe('night');
    expect(dayOf(manifest, '2026-09-10')?.shift?.source).toBe('override');
  });

  it('emits nothing at all when the feature is off', () => {
    // A household with no shift worker never sees any of it.
    const manifest = buildManifest({ ...BASE, household: { ...HOUSEHOLD, shiftEnabled: 0 } });
    expect(manifest.days.every((day) => day.shift === undefined)).toBe(true);
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
