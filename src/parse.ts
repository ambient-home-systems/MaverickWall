import { Component, Property, Time, parse as icalParse } from 'ical.js';
import { resolveTzid } from './zoneAliases.js';
import { addDaysToWallClock } from './timezone.js';
import type {
  CalendarError,
  CalendarWarning,
  CalendarWarningCode,
  EventStatus,
  LocalDateTime,
  NormalizedVevent,
  ParseResult,
  ParsedEvent,
  WallClock,
  ZoneRef,
} from './types.js';

/**
 * ical.js is used strictly as a *parser and rule iterator*. We never ask it for
 * an instant and we never use its VTIMEZONE registry, because a feed's embedded
 * VTIMEZONE is whatever the producer shipped — often stale, often absent.
 * Instants come from `timezone.ts`, which reads the platform's live IANA data.
 *
 * VTIMEZONE components are still honoured in the sense that matters: the TZID
 * they define is matched against IANA, so `TZID:America/Chicago` works whether
 * or not a VTIMEZONE block accompanies it.
 */

const MAX_WARNINGS = 200;

/** Upper bound on VEVENT blocks re-parsed individually during salvage. */
const MAX_SALVAGE_BLOCKS = 10_000;

class WarningLog {
  private readonly items: CalendarWarning[] = [];

  add(code: CalendarWarningCode, message: string, uid?: string): void {
    // Bounded so one catastrophic feed cannot exhaust memory or flood logs.
    if (this.items.length >= MAX_WARNINGS) return;
    this.items.push(uid === undefined ? { code, message } : { code, message, uid });
  }

  all(): CalendarWarning[] {
    return this.items;
  }
}

function wallClockOf(time: Time): WallClock {
  return {
    year: time.year,
    month: time.month,
    day: time.day,
    hour: time.isDate ? 0 : time.hour,
    minute: time.isDate ? 0 : time.minute,
    second: time.isDate ? 0 : time.second,
  };
}

function zoneRefOf(prop: Property, time: Time, warnings: WarningLog, uid: string): ZoneRef {
  if (time.isDate) return { kind: 'floating' };

  const tzidParam = prop.getParameter('tzid');
  const rawTzid = typeof tzidParam === 'string' ? tzidParam : undefined;

  if (rawTzid) {
    const resolved = resolveTzid(rawTzid);
    if (resolved.kind === 'iana') return { kind: 'iana', tzid: resolved.tzid };
    if (resolved.kind === 'aliased') {
      warnings.add(
        'WINDOWS_TIMEZONE_MAPPED',
        `Timezone "${resolved.from}" is not an IANA name; treating it as ${resolved.tzid}.`,
        uid,
      );
      return { kind: 'iana', tzid: resolved.tzid };
    }
    warnings.add(
      'UNRESOLVED_TIMEZONE',
      `Timezone "${resolved.from}" is unknown; falling back to the target timezone.`,
      uid,
    );
    return { kind: 'unknown', tzid: resolved.from };
  }

  const zoneId = time.zone?.tzid ?? '';
  if (zoneId === 'UTC' || zoneId === 'Z') return { kind: 'utc' };
  return { kind: 'floating' };
}

function toLocalDateTime(
  prop: Property,
  time: Time,
  warnings: WarningLog,
  uid: string,
): LocalDateTime {
  return {
    wall: wallClockOf(time),
    zone: zoneRefOf(prop, time, warnings, uid),
    isDate: Boolean(time.isDate),
  };
}

function readDateList(
  vevent: Component,
  name: 'exdate' | 'rdate',
  warnings: WarningLog,
  uid: string,
): LocalDateTime[] {
  const out: LocalDateTime[] = [];
  for (const prop of vevent.getAllProperties(name)) {
    let values: unknown[];
    try {
      values = prop.getValues();
    } catch {
      continue;
    }
    for (const value of values) {
      // RDATE may carry a PERIOD value. We take its start and ignore the
      // duration, which is what every mainstream client does.
      const time = value instanceof Time ? value : (value as { start?: Time } | null)?.start;
      if (time instanceof Time) out.push(toLocalDateTime(prop, time, warnings, uid));
    }
  }
  return out;
}

function readStatus(vevent: Component): EventStatus {
  const raw = vevent.getFirstPropertyValue('status');
  if (typeof raw !== 'string') return 'CONFIRMED';
  const upper = raw.toUpperCase();
  return upper === 'TENTATIVE' || upper === 'CANCELLED' || upper === 'CONFIRMED'
    ? upper
    : 'CONFIRMED';
}

/**
 * Zero-width and word-joining characters at the edges of a value.
 *
 * Web-based calendar editors paste these in constantly and they are invisible
 * to whoever typed them. `String.trim()` does not remove them, because they are
 * not Unicode White_Space, so without this a title silently sorts under the
 * wrong letter and compares unequal to the identical-looking string next to it.
 * Interior occurrences are left alone; only the edges are cleaned.
 */
const EDGE_NOISE = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

function readString(vevent: Component, name: string): string | undefined {
  const raw = vevent.getFirstPropertyValue(name);
  if (typeof raw !== 'string') return undefined;
  // ical.js already unescapes \, \; \n and unfolds continuation lines.
  const cleaned = raw.replace(EDGE_NOISE, '');
  return cleaned.length > 0 ? cleaned : undefined;
}

function wallClockFromUtcMs(ms: number): WallClock {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

function utcMsFromWall(wall: WallClock): number {
  const d = new Date(0);
  d.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  d.setUTCHours(wall.hour, wall.minute, wall.second, 0);
  return d.getTime();
}

/** Derive DTEND when the producer omitted it, per RFC 5545 section 3.6.1. */
function deriveEnd(
  vevent: Component,
  start: LocalDateTime,
  warnings: WarningLog,
  uid: string,
): LocalDateTime {
  const dtendProp = vevent.getFirstProperty('dtend');
  if (dtendProp) {
    const value = dtendProp.getFirstValue();
    if (value instanceof Time) return toLocalDateTime(dtendProp, value, warnings, uid);
  }

  const duration = vevent.getFirstPropertyValue('duration');
  if (duration && typeof (duration as { toSeconds?: () => number }).toSeconds === 'function') {
    const seconds = (duration as { toSeconds: () => number }).toSeconds();
    if (seconds < 0) {
      warnings.add('NEGATIVE_DURATION', 'Event has a negative DURATION; treating it as zero.', uid);
      return start;
    }
    if (start.isDate) {
      const days = Math.max(1, Math.round(seconds / 86_400));
      return { ...start, wall: addDaysToWallClock(start.wall, days) };
    }
    return { ...start, wall: wallClockFromUtcMs(utcMsFromWall(start.wall) + seconds * 1000) };
  }

  // No DTEND and no DURATION. A DATE start implies one whole day; a timed start
  // implies a zero-length event.
  return start.isDate ? { ...start, wall: addDaysToWallClock(start.wall, 1) } : start;
}

function normalizeVevent(vevent: Component, warnings: WarningLog): NormalizedVevent | undefined {
  const uidRaw = vevent.getFirstPropertyValue('uid');
  const uid = typeof uidRaw === 'string' && uidRaw.trim() ? uidRaw.trim() : '';
  if (!uid) {
    warnings.add('MISSING_UID', 'An event has no UID and was skipped.');
    return undefined;
  }

  const dtstartProp = vevent.getFirstProperty('dtstart');
  const dtstartValue = dtstartProp?.getFirstValue();
  if (!dtstartProp || !(dtstartValue instanceof Time)) {
    warnings.add('MISSING_DTSTART', 'An event has no usable DTSTART and was skipped.', uid);
    return undefined;
  }

  const start = toLocalDateTime(dtstartProp, dtstartValue, warnings, uid);
  const end = deriveEnd(vevent, start, warnings, uid);

  const rruleRaw = vevent.getFirstPropertyValue('rrule');
  let rrule: string | undefined;
  if (rruleRaw) {
    const asString =
      typeof rruleRaw === 'string'
        ? rruleRaw
        : typeof (rruleRaw as { toString?: () => string }).toString === 'function'
          ? (rruleRaw as { toString: () => string }).toString()
          : undefined;
    if (asString && asString.trim()) rrule = asString.trim();
    else warnings.add('INVALID_RRULE', 'RRULE could not be read; treating as a single event.', uid);
  }

  const recurrenceIdProp = vevent.getFirstProperty('recurrence-id');
  const recurrenceIdValue = recurrenceIdProp?.getFirstValue();
  const recurrenceId =
    recurrenceIdProp && recurrenceIdValue instanceof Time
      ? toLocalDateTime(recurrenceIdProp, recurrenceIdValue, warnings, uid)
      : undefined;

  const sequenceRaw = vevent.getFirstPropertyValue('sequence');
  const sequence = typeof sequenceRaw === 'number' && Number.isFinite(sequenceRaw) ? sequenceRaw : 0;

  return {
    uid,
    sequence,
    title: readString(vevent, 'summary') ?? '(no title)',
    description: readString(vevent, 'description'),
    location: readString(vevent, 'location'),
    status: readStatus(vevent),
    start,
    end,
    allDay: start.isDate,
    rrule,
    rdates: readDateList(vevent, 'rdate', warnings, uid),
    exdates: readDateList(vevent, 'exdate', warnings, uid),
    recurrenceId,
  };
}

function rootComponents(jcal: unknown): Component[] {
  // ICAL.parse yields one jCal component, or an array of them when the input
  // concatenates several VCALENDARs.
  if (Array.isArray(jcal) && Array.isArray(jcal[0])) {
    return (jcal as unknown[]).map((entry) => new Component(entry as never));
  }
  return [new Component(jcal as never)];
}

function collectVevents(roots: readonly Component[]): Component[] {
  const vevents: Component[] = [];
  for (const root of roots) {
    if (root.name === 'vevent') {
      vevents.push(root);
      continue;
    }
    vevents.push(...root.getAllSubcomponents('vevent'));
    // Some producers nest VCALENDARs one level deep.
    for (const nested of root.getAllSubcomponents('vcalendar')) {
      vevents.push(...nested.getAllSubcomponents('vevent'));
    }
  }
  return vevents;
}

/**
 * Split a document into its VEVENT blocks textually.
 *
 * Line-based rather than regex-based so that folded continuation lines, which
 * belong to the property above them, travel with their block untouched.
 */
function extractVeventBlocks(icsText: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;

  for (const line of icsText.split(/\r?\n/)) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:VEVENT')) {
      current = [line];
      continue;
    }
    if (!current) continue;
    current.push(line);
    if (upper.startsWith('END:VEVENT')) {
      blocks.push(current.join('\r\n'));
      current = null;
      if (blocks.length >= MAX_SALVAGE_BLOCKS) break;
    }
  }
  // A block left open means the file was truncated mid-event; drop it.
  return blocks;
}

/**
 * Recover what we can from a document ical.js refused outright.
 *
 * ical.js validates property *values* while parsing, so a single malformed
 * RRULE anywhere rejects the whole file. A household feed is not allowed to
 * vanish because one event out of four hundred is broken, so we re-parse each
 * VEVENT on its own and lose only the ones that are genuinely bad.
 *
 * This runs only on the error path, so the healthy case pays nothing for it.
 */
function salvageVevents(icsText: string, warnings: WarningLog): Component[] {
  const recovered: Component[] = [];
  let skipped = 0;

  for (const block of extractVeventBlocks(icsText)) {
    const wrapped = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Maverick Wall//Salvage//EN',
      block,
      'END:VCALENDAR',
      '',
    ].join('\r\n');

    try {
      recovered.push(...collectVevents(rootComponents(icalParse(wrapped))));
    } catch {
      skipped++;
    }
  }

  if (skipped > 0) {
    warnings.add(
      'EVENT_SKIPPED',
      `${skipped} event${skipped === 1 ? '' : 's'} could not be read and ${
        skipped === 1 ? 'was' : 'were'
      } skipped; the rest of the calendar is unaffected.`,
    );
  }

  return recovered;
}

/** X-WR-CALNAME read textually, for when the structured parse is unavailable. */
function salvageCalendarName(icsText: string): string | undefined {
  for (const line of icsText.split(/\r?\n/)) {
    if (line.toUpperCase().startsWith('X-WR-CALNAME:')) {
      const value = line.slice(line.indexOf(':') + 1).trim();
      if (value) return value;
    }
    if (line.toUpperCase().startsWith('BEGIN:VEVENT')) break;
  }
  return undefined;
}

function failure(code: CalendarError['code'], message: string, detail?: string): ParseResult {
  return {
    events: [],
    warnings: [],
    calendarName: undefined,
    error: detail === undefined ? { code, message } : { code, message, detail },
  };
}

/**
 * Parse an ICS document into normalised VEVENTs. Never throws.
 *
 * A feed that is malformed in part yields whatever could be salvaged plus
 * warnings explaining the rest, because a kitchen display showing four of five
 * events is enormously better than one showing an error page. Only a document
 * that cannot be parsed at all produces an error.
 */
export function parseIcs(icsText: string, maxBytes: number): ParseResult {
  const warnings = new WarningLog();

  if (typeof icsText !== 'string' || icsText.trim().length === 0) {
    return failure('EMPTY_INPUT', 'The calendar feed was empty.');
  }
  if (icsText.length > maxBytes) {
    return failure(
      'TOO_LARGE',
      `The calendar feed is larger than the ${Math.round(maxBytes / 1024 / 1024)} MiB limit.`,
    );
  }

  let roots: Component[] = [];
  let vevents: Component[];
  let salvaged = false;

  try {
    roots = rootComponents(icalParse(icsText));
    vevents = collectVevents(roots);
  } catch (error) {
    // ical.js rejects a whole document over one bad property value. Fall back
    // to per-event parsing so a single broken entry costs only itself.
    const detail = error instanceof Error ? error.message : 'unknown parser error';
    salvaged = true;
    vevents = salvageVevents(icsText, warnings);
    if (vevents.length === 0) {
      return failure('PARSE_FAILED', 'The calendar feed could not be parsed.', detail);
    }
  }

  const masters = new Map<string, NormalizedVevent>();
  const overrides = new Map<string, NormalizedVevent[]>();

  for (const vevent of vevents) {
    let normalized: NormalizedVevent | undefined;
    try {
      normalized = normalizeVevent(vevent, warnings);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      warnings.add('EVENT_SKIPPED', `An event could not be read and was skipped: ${detail}`);
      continue;
    }
    if (!normalized) continue;

    if (normalized.recurrenceId) {
      const list = overrides.get(normalized.uid) ?? [];
      list.push(normalized);
      overrides.set(normalized.uid, list);
      continue;
    }

    const existing = masters.get(normalized.uid);
    // Duplicate UIDs happen. Highest SEQUENCE wins, matching RFC 5546 ordering.
    if (!existing || normalized.sequence >= existing.sequence) {
      masters.set(normalized.uid, normalized);
    }
  }

  const events: ParsedEvent[] = [];
  for (const [uid, master] of masters) {
    events.push({ master, overrides: overrides.get(uid) ?? [] });
    overrides.delete(uid);
  }

  // An override whose master never arrived. Common when a server windows a
  // feed. Promote it so the instance still shows up.
  for (const [uid, orphans] of overrides) {
    warnings.add(
      'ORPHAN_OVERRIDE',
      'A modified occurrence arrived without its parent event; showing it on its own.',
      uid,
    );
    for (const orphan of orphans) {
      events.push({
        master: { ...orphan, recurrenceId: undefined, rrule: undefined },
        overrides: [],
      });
    }
  }

  let calendarName: string | undefined;
  if (salvaged) {
    calendarName = salvageCalendarName(icsText);
  } else {
    try {
      const raw = roots[0]?.getFirstPropertyValue('x-wr-calname');
      if (typeof raw === 'string' && raw.trim()) calendarName = raw.trim();
    } catch {
      calendarName = undefined;
    }
  }

  return { events, warnings: warnings.all(), calendarName, error: undefined };
}
