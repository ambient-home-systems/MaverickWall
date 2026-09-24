import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifestEtag, todoListHandle, type Manifest, type ManifestDay } from '../src/api/manifest.js';
import { renderScreenFrame, type FrameScreen } from '../src/epaper/frame.js';
import type { PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { parseForecast, parseHourly } from '../src/modules/weather/nws.js';
import { parseObservation } from '../src/modules/weather/nws-observations.js';
import { parseAirQuality } from '../src/modules/weather/open-meteo.js';
import { presentCurrent, presentHourly } from '../src/modules/weather/readings.js';

/**
 * A panel's frame ETag moves when its picture can have, and not otherwise (P3.5).
 *
 * The ETag used to hash the whole manifest, so anything any module wrote moved
 * every paired panel — and once the weather carried current conditions,
 * refreshed every fifteen minutes, every panel would have downloaded a new
 * frame every fifteen minutes whether it had weather on it or not. A battery
 * panel does a full refresh to show a new frame, so that is a flash on the wall
 * and a battery spent, four times an hour, on a picture that had not changed.
 *
 * Two directions, and they fail differently:
 *
 * - **No churn.** A panel's ETag does not move for a slice of `panels` none of
 *   its widgets draws — the brief's first test, and the one the preimage change
 *   exists for.
 * - **No hidden change.** A frame whose pixels moved always gets a new ETag.
 *   Narrowing a hash is a way to make a panel keep an old picture for ever, and
 *   that is worse than the churn it cures. This half is *derived by rendering*
 *   — every widget type against every mutation, the frames compared bit for
 *   bit — rather than read off a table, for the reason `epaper-ink.test.ts`
 *   gives: a table of what a draw reads is an opinion about the renderer, and
 *   the frame is the fact.
 *
 * The weather panel is assembled by the real parsers from the owner's captured
 * NWS documents and a captured Open-Meteo air-quality answer, so its fields are
 * the fields the job writes.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const NWS = join(HERE, 'fixtures', 'nws', 'real');
const OPEN_METEO = join(HERE, 'fixtures', 'open-meteo', 'real');
const bytes = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8');

const NOW = Date.parse('2026-09-24T12:40:00Z');
const MINUTE = 60_000;
const SCREEN: FrameScreen = { panelWidth: 800, panelHeight: 480, panelColour: null, rotation: 0 };

/** The weather panel as the job assembles it from the captured documents. */
function weatherPanel(): Record<string, unknown> {
  const hours = parseHourly(bytes(NWS, 'forecast-hourly.json'), NOW, () => true) ?? [];
  const forecast = parseForecast(bytes(NWS, 'forecast.json'), NOW, 5);
  const current = presentCurrent({
    provider: 'nws',
    reading: parseObservation(bytes(NWS, 'observation-latest.json'), () => true),
    hours,
    now: NOW,
  });
  const air = parseAirQuality(bytes(OPEN_METEO, 'air-quality-dc.json'), 'us');
  // The fixture is the premise: without all three, "differs only in `current`"
  // would be a claim about a panel that had nothing in it to differ.
  if (forecast === undefined || current === undefined || air === undefined || hours.length === 0) {
    throw new Error('the captured documents no longer parse into a full panel');
  }
  return {
    provider: 'nws',
    days: forecast.days,
    fetchedAt: forecast.fetchedAt,
    note: null,
    current,
    hourly: presentHourly(hours, NOW),
    units: { temp: 'F', wind: 'mph', precip: 'in' },
    air,
  };
}

function baseManifest(): Manifest {
  const days: ManifestDay[] = [];
  for (let d = 24; d <= 29; d++) {
    days.push({
      date: `2026-09-${d}`,
      shifts: [
        {
          personId: 'p1', personName: 'Amy', label: 'Days', shortCode: 'D',
          startTime: '07:00', endTime: '19:00', isWorking: true, color: '#f00',
        },
      ],
      events: [
        {
          id: `e${d}`, uid: `e${d}`, title: `Dentist ${d}`, startsAt: Date.UTC(2026, 8, d, 13),
          endsAt: Date.UTC(2026, 8, d, 14), allDay: false, sourceId: 's1', color: '#000',
          status: 'confirmed', continues: false,
        },
      ],
    } as unknown as ManifestDay);
  }
  return {
    manifestVersion: 1,
    appVersion: '0.0.0-test',
    timezone: 'America/New_York',
    generatedAt: NOW,
    theme: { active: 'panels' },
    window: { from: '2026-09-01', to: '2026-10-31' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    layout: { mode: 'freeform', portrait: { widgets: [] }, landscape: { widgets: [] } },
    screen: { orientation: 'auto', rotation: 0, allowDismiss: false, allowChores: false },
    days,
    people: [],
    sources: [{ id: 's1', name: 'Family', color: '#000', lastSuccessAt: NOW - 5 * MINUTE }],
    notices: [],
    interrupts: [],
    panels: {
      weather: weatherPanel(),
      home: {
        readings: [
          { key: 'ha:front', label: 'Front door', value: 'Locked', glyph: 'lock', mode: 'label_value' },
          { key: 'ha:kitchen', label: 'Kitchen', value: '19.4 C', glyph: 'temperature', mode: 'label_value' },
        ],
        fetchedAt: NOW,
      },
      todo: {
        lists: [
          {
            key: todoListHandle('todo.shopping'), name: 'Shopping', canTick: true, open: 2,
            items: [
              { id: 'h1', summary: 'Milk', done: false },
              { id: 'h2', summary: 'Eggs', done: false },
            ],
          },
          {
            key: todoListHandle('todo.garden'), name: 'Garden', canTick: true, open: 1,
            items: [{ id: 'g1', summary: 'Mow', done: false }],
          },
        ],
      },
      chores: {
        today: '2026-09-24',
        days: [{ date: '2026-09-24', items: [{ name: 'Bins', person: 'Amy', personId: 'p1', done: false }] }],
      },
      mymod: { items: [{ label: 'Tide', value: 'High' }, { label: 'Bins', value: 'Tuesday' }] },
    },
  } as unknown as Manifest;
}

const BASE = baseManifest();

/** A copy of the manifest with one change made to its panels. */
function edit(manifest: Manifest, change: (panels: Record<string, Record<string, unknown>>) => void): Manifest {
  const copy = structuredClone(manifest) as Manifest & { panels: Record<string, Record<string, unknown>> };
  change(copy.panels);
  return copy;
}

const weather = (panels: Record<string, Record<string, unknown>>): Record<string, unknown> => panels['weather']!;
const firstDay = (panels: Record<string, Record<string, unknown>>): Record<string, unknown> =>
  (weather(panels)['days'] as Record<string, unknown>[])[0]!;

/** Fifteen minutes on: a new reading, which is exactly what the job writes every run. */
const NEXT_READING = edit(BASE, (panels) => {
  const current = weather(panels)['current'] as Record<string, unknown>;
  current['temp'] = 57.2;
  current['observedAt'] = (current['observedAt'] as number) + 15 * MINUTE;
  current['condition'] = 'Sunny';
});

function draw(manifest: Manifest, widgets?: readonly PlacedEpaperWidget[]): { etag: string; bits: string } {
  const frame = renderScreenFrame(manifest, SCREEN, widgets);
  return { etag: frame.etag, bits: Buffer.from(frame.fb.toPacked()).toString('base64') };
}

const at = (
  type: string,
  config: Record<string, unknown> = {},
  box: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 1, h: 1 },
  link: { id?: string; parentId?: string } = {},
): PlacedEpaperWidget => ({ type, ...box, z: 0, config, ...link });

/** A kitchen panel with a clock, a note and the month, and no weather anywhere. */
const NO_WEATHER: readonly PlacedEpaperWidget[] = [
  at('clock', {}, { x: 0, y: 0, w: 0.5, h: 0.3 }),
  at('notes', { text: 'Swim kit' }, { x: 0.5, y: 0, w: 0.5, h: 0.3 }),
  at('calendar', { mode: 'month' }, { x: 0, y: 0.3, w: 1, h: 0.7 }),
];

/** The forecast strip, which is the only weather a panel draws today. */
const STRIP: readonly PlacedEpaperWidget[] = [at('weather')];

describe('a panel with no weather on it', () => {
  it('keeps its ETag across two manifests that differ only in `current`', () => {
    // The control: the two documents really do differ, and a browser wall,
    // which hashes the whole manifest, is right to be told so.
    expect(manifestEtag(NEXT_READING)).not.toBe(manifestEtag(BASE));

    expect(draw(NEXT_READING, NO_WEATHER).etag).toBe(draw(BASE, NO_WEATHER).etag);
    // The built-in layout reads no module's panel at all.
    expect(draw(NEXT_READING).etag).toBe(draw(BASE).etag);
  });

  it('keeps it across the next hours and the air quality too, which it does not draw either', () => {
    const later = edit(BASE, (panels) => {
      const hourly = weather(panels)['hourly'] as unknown[];
      weather(panels)['hourly'] = hourly.slice(1);
      weather(panels)['air'] = { aqi: 61, scale: 'us', label: 'Moderate', observedAt: NOW + 60 * MINUTE };
    });
    expect(draw(later, NO_WEATHER).etag).toBe(draw(BASE, NO_WEATHER).etag);
    expect(draw(later).etag).toBe(draw(BASE).etag);
  });

  it('still moves for what the panel draws outside the modules — an event renamed', () => {
    // The manifest minus `panels` is still hashed whole: this is the guard on
    // somebody "narrowing" the rest of it by accident.
    const renamed = structuredClone(BASE) as Manifest & { days: { events: { title: string }[] }[] };
    renamed.days[0]!.events[0]!.title = 'Orthodontist';
    expect(draw(renamed, NO_WEATHER).etag).not.toBe(draw(BASE, NO_WEATHER).etag);
    expect(draw(renamed).etag).not.toBe(draw(BASE).etag);
  });
});

describe('a panel with the forecast strip', () => {
  it('keeps its ETag, and its frame, when only what the strip does not draw changes', () => {
    const changes: Readonly<Record<string, Manifest>> = {
      current: NEXT_READING,
      hourly: edit(BASE, (panels) => {
        weather(panels)['hourly'] = (weather(panels)['hourly'] as unknown[]).slice(2);
      }),
      air: edit(BASE, (panels) => {
        weather(panels)['air'] = { aqi: 61, scale: 'us', label: 'Moderate', observedAt: NOW };
      }),
      'the hourly refresh': edit(BASE, (panels) => {
        weather(panels)['fetchedAt'] = (weather(panels)['fetchedAt'] as number) + 60 * MINUTE;
      }),
      'a day’s words and rain chance': edit(BASE, (panels) => {
        firstDay(panels)['detail'] = 'A chance of showers after 2pm.';
        firstDay(panels)['precipChance'] = 40;
      }),
    };
    const base = draw(BASE, STRIP);
    for (const [name, changed] of Object.entries(changes)) {
      const after = draw(changed, STRIP);
      expect(after.bits, `${name}: the strip draws none of it`).toBe(base.bits);
      expect(after.etag, `${name}: so the panel is not sent it`).toBe(base.etag);
    }
  });

  it('moves its ETag, and its frame, when a day it draws changes', () => {
    const warmer = edit(BASE, (panels) => {
      firstDay(panels)['high'] = (firstDay(panels)['high'] as number) + 4;
    });
    const before = draw(BASE, STRIP);
    const after = draw(warmer, STRIP);
    expect(after.bits).not.toBe(before.bits);
    expect(after.etag).not.toBe(before.etag);
  });

  it('reads the same from inside a group', () => {
    const grouped: readonly PlacedEpaperWidget[] = [
      at('group', { layout: 'row' }, { x: 0, y: 0, w: 1, h: 0.5 }, { id: 'g' }),
      at('clock', {}, { x: 0, y: 0, w: 0.5, h: 1 }, { parentId: 'g' }),
      at('weather', {}, { x: 0.5, y: 0, w: 0.5, h: 1 }, { parentId: 'g' }),
    ];
    const warmer = edit(BASE, (panels) => {
      firstDay(panels)['high'] = (firstDay(panels)['high'] as number) + 4;
    });
    expect(draw(NEXT_READING, grouped).etag).toBe(draw(BASE, grouped).etag);
    expect(draw(warmer, grouped).etag).not.toBe(draw(BASE, grouped).etag);
  });
});

describe('a panel whose canvas draws current conditions', () => {
  /*
   * Nothing on a panel draws current conditions yet: P5.1's `today` style is
   * the first, and it is S14's. This is written now, against that style's
   * name, so the session that builds it cannot land the draw without the ETag
   * following it — and `panelInput` is the only way a draw reaches a module's
   * panel, so the draw cannot read `current` without adding it there, which is
   * what makes the body below pass. When it does, `it.fails` goes red and the
   * fix is to drop `.fails`: the same device P2.1 used for S06's screens.
   * TODO(S14)
   */
  it.fails('moves its ETag when the reading changes — TODO(S14): nothing draws `today` yet', () => {
    const today: readonly PlacedEpaperWidget[] = [at('weather', { variant: 'today' })];
    expect(draw(NEXT_READING, today).etag).not.toBe(draw(BASE, today).etag);
  });
});

/**
 * Every widget a panel can hold, and the slices of `panels` each one reads.
 *
 * `reads` is used only for the *no churn* half. The *no hidden change* half
 * asks the frames, so a wrong entry here can make that half stricter than it
 * needs to be and never looser.
 */
const PROBES: readonly {
  name: string;
  /** `undefined` is the built-in layout: no canvas at all. */
  widgets: readonly PlacedEpaperWidget[] | undefined;
  reads: readonly string[];
}[] = [
  { name: 'the built-in layout', widgets: undefined, reads: [] },
  { name: 'clock', widgets: [at('clock')], reads: [] },
  { name: 'calendar, month', widgets: [at('calendar', { mode: 'month' })], reads: [] },
  { name: 'calendar, list', widgets: [at('calendar', { mode: 'list' })], reads: [] },
  { name: 'shift', widgets: [at('shift')], reads: [] },
  { name: 'countdown', widgets: [at('countdown', { target: '2026-12-25', label: 'Christmas' })], reads: [] },
  { name: 'notes', widgets: [at('notes', { text: 'Swim kit' })], reads: [] },
  { name: 'image', widgets: [at('image', { image: 'beach.jpg' })], reads: [] },
  { name: 'to-do, typed', widgets: [at('todo', { items: ['Milk', 'Bread'] })], reads: [] },
  { name: 'to-do, a list', widgets: [at('todo', { list: 'todo.shopping' })], reads: ['todo:shopping'] },
  { name: 'chores', widgets: [at('chores')], reads: ['chores'] },
  { name: 'weather', widgets: STRIP, reads: ['weather:days'] },
  { name: 'house', widgets: [at('homeassistant')], reads: ['home'] },
  { name: 'a module', widgets: [at('external', { module: 'mymod' })], reads: ['mymod'] },
];

/** What changes, and which read it touches — `weather:other` is a field no draw reads. */
const MUTATIONS: readonly { name: string; touches: string; manifest: Manifest }[] = [
  { name: 'current conditions', touches: 'weather:other', manifest: NEXT_READING },
  {
    name: 'the next hours',
    touches: 'weather:other',
    manifest: edit(BASE, (panels) => {
      weather(panels)['hourly'] = (weather(panels)['hourly'] as unknown[]).slice(3);
    }),
  },
  {
    name: 'air quality',
    touches: 'weather:other',
    manifest: edit(BASE, (panels) => {
      delete weather(panels)['air'];
    }),
  },
  {
    name: 'a warmer day',
    touches: 'weather:days',
    manifest: edit(BASE, (panels) => {
      firstDay(panels)['high'] = (firstDay(panels)['high'] as number) + 4;
    }),
  },
  {
    name: 'a wetter day',
    touches: 'weather:days',
    manifest: edit(BASE, (panels) => {
      firstDay(panels)['glyph'] = 'rain';
    }),
  },
  {
    name: 'no weather at all',
    touches: 'weather:days',
    manifest: edit(BASE, (panels) => {
      delete panels['weather'];
    }),
  },
  {
    name: 'the front door opened',
    touches: 'home',
    manifest: edit(BASE, (panels) => {
      (panels['home']!['readings'] as Record<string, unknown>[])[0]!['value'] = 'Unlocked';
    }),
  },
  {
    name: 'milk ticked off',
    touches: 'todo:shopping',
    manifest: edit(BASE, (panels) => {
      const lists = panels['todo']!['lists'] as { items: Record<string, unknown>[] }[];
      lists[0]!.items[0]!['done'] = true;
    }),
  },
  {
    name: 'the garden list changed',
    touches: 'todo:garden',
    manifest: edit(BASE, (panels) => {
      const lists = panels['todo']!['lists'] as { items: Record<string, unknown>[] }[];
      lists[1]!.items[0]!['summary'] = 'Rake';
    }),
  },
  {
    name: 'the bins done',
    touches: 'chores',
    manifest: edit(BASE, (panels) => {
      const days = panels['chores']!['days'] as { items: Record<string, unknown>[] }[];
      days[0]!.items[0]!['done'] = true;
    }),
  },
  {
    name: 'the tide turned',
    touches: 'mymod',
    manifest: edit(BASE, (panels) => {
      (panels['mymod']!['items'] as Record<string, unknown>[])[0]!['value'] = 'Low';
    }),
  },
];

describe('what a panel draws is what its ETag hashes', () => {
  it('never keeps an ETag over a frame that changed, for any widget and any module', () => {
    let inkMoved = 0;
    for (const probe of PROBES) {
      const before = draw(BASE, probe.widgets);
      for (const mutation of MUTATIONS) {
        const after = draw(mutation.manifest, probe.widgets);
        if (after.bits === before.bits) continue;
        inkMoved++;
        expect(after.etag, `${probe.name}: "${mutation.name}" moved the ink`).not.toBe(before.etag);
      }
    }
    // Not vacuous: every widget that reads a panel had its own panel's change
    // reach the glass, one each at least, and none of the others did.
    expect(inkMoved).toBeGreaterThanOrEqual(PROBES.filter((probe) => probe.reads.length > 0).length);
  });

  it('moves a panel’s ETag only for something one of its widgets reads', () => {
    for (const probe of PROBES) {
      const before = draw(BASE, probe.widgets);
      for (const mutation of MUTATIONS) {
        if (probe.reads.includes(mutation.touches)) continue;
        expect(draw(mutation.manifest, probe.widgets).etag, `${probe.name}: "${mutation.name}"`).toBe(before.etag);
      }
    }
  });

  it('does move it for each thing a widget reads, so the probes above are probing', () => {
    for (const probe of PROBES) {
      for (const read of probe.reads) {
        const reaching = MUTATIONS.filter((mutation) => mutation.touches === read);
        expect(reaching.length, `${probe.name} has a mutation for ${read}`).toBeGreaterThan(0);
        for (const mutation of reaching) {
          const before = draw(BASE, probe.widgets);
          const after = draw(mutation.manifest, probe.widgets);
          expect(after.bits, `${probe.name}: "${mutation.name}" is drawn`).not.toBe(before.bits);
          expect(after.etag).not.toBe(before.etag);
        }
      }
    }
  });
});
