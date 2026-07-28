import { describe, expect, it } from 'vitest';
import { expandCalendar } from '../src/index.js';
import { listFixtures, loadFixture } from './support/helpers.js';
import type { NormalizedEvent } from '../src/types.js';

/**
 * Every fixture gets a committed snapshot. These are meant to be *read* during
 * review: a changed snapshot means either a bug was fixed or a bug was
 * introduced, and the diff is how you tell which. Do not update them reflexively.
 */

interface FixtureConfig {
  readonly targetTimezone: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly includeDescription?: boolean;
}

const DEFAULT_CONFIG: FixtureConfig = {
  targetTimezone: 'America/Chicago',
  windowStart: '2026-01-01T00:00:00Z',
  windowEnd: '2027-01-01T00:00:00Z',
};

/** Per-fixture overrides where the default window or zone would say nothing. */
const CONFIGS: Readonly<Record<string, Partial<FixtureConfig>>> = {
  'synthetic/rrule-comprehensive.ics': {
    targetTimezone: 'America/New_York',
    // Wide enough to catch the two 1997 WKST examples from the RFC.
    windowStart: '1997-01-01T00:00:00Z',
    windowEnd: '2027-01-01T00:00:00Z',
  },
  'synthetic/dst-us.ics': { targetTimezone: 'America/New_York' },
  'synthetic/dst-europe.ics': { targetTimezone: 'Europe/Berlin' },
  'synthetic/escaped-text.ics': { includeDescription: true },
  'synthetic/allday.ics': { windowEnd: '2028-01-01T00:00:00Z' },
  'synthetic/window-straddle.ics': {
    windowStart: '2026-06-15T00:00:00Z',
    windowEnd: '2026-06-16T00:00:00Z',
  },
  // A personal Google export, scrubbed. Deliberately a single month rather than
  // a year: this calendar expands to tens of thousands of instances, and a
  // snapshot nobody can read is a snapshot nobody reviews. Year-scale coverage
  // lives in google-feed.test.ts as invariants instead.
  'real/google-personal.ics': {
    targetTimezone: 'America/New_York',
    windowStart: '2026-09-01T00:00:00Z',
    windowEnd: '2026-10-01T00:00:00Z',
  },
  // Frederick County MD. Descriptions included so the snapshot records how this
  // producer's HTML-in-DESCRIPTION habit survives parsing.
  'real/fcps-school-district.ics': {
    targetTimezone: 'America/New_York',
    windowStart: '2026-01-01T00:00:00Z',
    windowEnd: '2028-01-01T00:00:00Z',
    includeDescription: true,
  },
};

function configFor(fixture: string): FixtureConfig {
  return { ...DEFAULT_CONFIG, ...CONFIGS[fixture] };
}

/**
 * Real fixtures must declare their household timezone explicitly.
 *
 * Synthetic fixtures are written against a known zone, so a default is fine.
 * A real feed inherits whatever zone the household lives in, and quietly
 * snapshotting it against the wrong one produces a plausible-looking record of
 * incorrect behaviour — the worst possible outcome for a file whose entire job
 * is to be read during review.
 */
function requiresExplicitConfig(fixture: string): boolean {
  return fixture.startsWith('real/');
}

/** One readable line per event. Diffs stay legible when something shifts. */
function describeEvent(event: NormalizedEvent): string {
  const parts = [
    event.startUtc.toISOString(),
    '->',
    event.endUtc.toISOString(),
    event.allDay ? '[all-day]' : '[timed]',
    `(${event.sourceTzid})`,
    event.status === 'CONFIRMED' ? '' : `<${event.status}>`,
    JSON.stringify(event.title),
    event.location ? `@ ${JSON.stringify(event.location)}` : '',
    event.recurrenceId ? `#${event.recurrenceId}` : '',
    event.description ? `desc=${JSON.stringify(event.description)}` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

describe('fixture snapshots', () => {
  const fixtures = listFixtures();

  it('the corpus is not empty', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures.filter(requiresExplicitConfig))(
    '%s declares its household timezone',
    (fixture) => {
      expect(
        CONFIGS[fixture]?.targetTimezone,
        `Add a config entry for '${fixture}' in CONFIGS with the household timezone.`,
      ).toBeTruthy();
    },
  );

  it.each(fixtures)('%s', (fixture) => {
    const config = configFor(fixture);
    const result = expandCalendar({
      icsText: loadFixture(fixture),
      targetTimezone: config.targetTimezone,
      windowStart: new Date(config.windowStart),
      windowEnd: new Date(config.windowEnd),
      maxEvents: 500,
      ...(config.includeDescription !== undefined
        ? { includeDescription: config.includeDescription }
        : {}),
    });

    const snapshot = {
      fixture,
      config,
      ...(result.ok
        ? {
            outcome: 'ok' as const,
            calendarName: result.meta.calendarName ?? null,
            truncated: result.meta.truncated,
            totalBeforeCap: result.meta.totalBeforeCap,
            warnings: result.meta.warnings.map((warning) =>
              [warning.code, warning.uid ?? '-', warning.message].join(' | '),
            ),
            events: result.value.map(describeEvent),
          }
        : {
            outcome: 'error' as const,
            code: result.error.code,
            message: result.error.message,
          }),
    };

    expect(snapshot).toMatchSnapshot();
  });
});
