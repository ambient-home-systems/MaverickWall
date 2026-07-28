import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandCalendar } from '../../src/index.js';
import type { ExpandCalendarInput, NormalizedEvent } from '../../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, '..', 'fixtures');

export function loadFixture(relativePath: string): string {
  return readFileSync(join(FIXTURE_DIR, relativePath), 'utf8');
}

export function listFixtures(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.ics')) {
        out.push(`${prefix}${entry.name}`);
      }
    }
  };
  walk(FIXTURE_DIR, '');
  return out.sort();
}

const DEFAULT_WINDOW_START = new Date('2026-01-01T00:00:00Z');
const DEFAULT_WINDOW_END = new Date('2027-01-01T00:00:00Z');

export type RunOverrides = Partial<Omit<ExpandCalendarInput, 'icsText'>>;

/** Expand a fixture and fail loudly if the result was an error. */
export function expandOk(fixture: string, overrides: RunOverrides = {}): NormalizedEvent[] {
  const result = expandCalendar({
    icsText: loadFixture(fixture),
    targetTimezone: overrides.targetTimezone ?? 'America/Chicago',
    windowStart: overrides.windowStart ?? DEFAULT_WINDOW_START,
    windowEnd: overrides.windowEnd ?? DEFAULT_WINDOW_END,
    ...(overrides.maxEvents !== undefined ? { maxEvents: overrides.maxEvents } : {}),
    ...(overrides.includeDescription !== undefined
      ? { includeDescription: overrides.includeDescription }
      : {}),
    ...(overrides.maxBytes !== undefined ? { maxBytes: overrides.maxBytes } : {}),
  });
  if (!result.ok) {
    throw new Error(`expected success but got ${result.error.code}: ${result.error.message}`);
  }
  return [...result.value];
}

/** Full result, for tests that care about warnings, truncation, or errors. */
export function expandRaw(fixture: string, overrides: RunOverrides = {}) {
  return expandCalendar({
    icsText: loadFixture(fixture),
    targetTimezone: overrides.targetTimezone ?? 'America/Chicago',
    windowStart: overrides.windowStart ?? DEFAULT_WINDOW_START,
    windowEnd: overrides.windowEnd ?? DEFAULT_WINDOW_END,
    ...(overrides.maxEvents !== undefined ? { maxEvents: overrides.maxEvents } : {}),
    ...(overrides.includeDescription !== undefined
      ? { includeDescription: overrides.includeDescription }
      : {}),
    ...(overrides.maxBytes !== undefined ? { maxBytes: overrides.maxBytes } : {}),
  });
}

export function byUid(events: readonly NormalizedEvent[], uid: string): NormalizedEvent[] {
  return events.filter((event) => event.uid === uid);
}

/** ISO instants, the terse form most assertions want. */
export function startsOf(events: readonly NormalizedEvent[]): string[] {
  return events.map((event) => event.startUtc.toISOString());
}

const localFormatters = new Map<string, Intl.DateTimeFormat>();

/** `2026-03-15 09:00` as read in the given zone. */
export function inZone(date: Date, timeZone: string): string {
  let formatter = localFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    localFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

/** `2026-03-15` as read in the given zone. */
export function dateInZone(date: Date, timeZone: string): string {
  return inZone(date, timeZone).slice(0, 10);
}

/**
 * Every local calendar date an event touches, from its start up to but not
 * including its exclusive end. This is what "appears on the grid" means.
 */
export function daysCovered(event: NormalizedEvent, timeZone: string): string[] {
  const days: string[] = [];
  const endExclusiveMs = Math.max(event.startUtc.getTime(), event.endUtc.getTime() - 1);
  let cursor = event.startUtc.getTime();
  let guard = 0;
  for (;;) {
    const day = dateInZone(new Date(cursor), timeZone);
    if (days[days.length - 1] !== day) days.push(day);
    if (cursor >= endExclusiveMs || guard++ > 1000) break;
    cursor = Math.min(cursor + 3_600_000, endExclusiveMs);
  }
  return days;
}
