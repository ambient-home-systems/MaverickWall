import type { SqliteDatabase } from '../../db/open.js';
import { parseJsonOr, z } from '../../validation.js';
import { domainOf } from './entities.js';

/**
 * A reading's last day, for a sparkline (plan item M6.10).
 *
 * **A read, never a service call.** Home Assistant keeps every state an entity
 * has had in its recorder, and `GET /api/history/period/<start>` answers with
 * the changes in a window — the same kind of request as `/api/states`, with the
 * same token, and nothing in it can change the house. Rule 12 is about writes;
 * this is not one, and `ha-write-boundary.test.ts` holds that it stays a GET.
 *
 * **One fixed shape: the last 24 hours as 48 half-hour means**, oldest first,
 * with `null` for a half hour that held no number (the sensor was
 * `unavailable`, or Home Assistant had not heard of it yet). Fixed so that the
 * wall can draw it in a box of a fixed size — a sparkline that grew a point
 * when the history arrived would be a box that moved — and half-hourly so the
 * window ends on a half-hour boundary: the series changes at most twice an
 * hour, the poll asks Home Assistant at most twice an hour, and the manifest
 * moves for it at most twice an hour. The latest number is the reading's own
 * state, which is what the words beside the line say.
 *
 * **Time-weighted, not sampled.** A heater that came on for ten minutes of a
 * half hour moves that half hour's mean by a third; sampling the state at the
 * boundary would draw it as nothing or as the whole half hour, depending on
 * which side of the boundary it fell.
 */

export const HISTORY_HOURS = 24;
export const HISTORY_POINTS = 48;
export const HISTORY_BUCKET_MS = (HISTORY_HOURS * 3_600_000) / HISTORY_POINTS;

/**
 * The most readings one house reads a day of. A sparkline is a few lines on a
 * wall; a household asking for forty is a household that will wait forty
 * requests for them, every half hour, on a box that may be a Raspberry Pi.
 */
export const HISTORY_MAX_ENTITIES = 16;

/** The end of the window the series covers at `now`: the last half-hour boundary. */
export function historyWindowEnd(now: number): number {
  return Math.floor(now / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
}

/** Home Assistant's history request for one entity over the window ending at `end`. */
export function historyPath(entityId: string, end: number): string {
  const start = new Date(end - HISTORY_HOURS * 3_600_000).toISOString();
  const stop = new Date(end).toISOString();
  return (
    `/history/period/${encodeURIComponent(start)}` +
    `?filter_entity_id=${encodeURIComponent(entityId)}` +
    `&end_time=${encodeURIComponent(stop)}` +
    // The first and last states in full, the rest as a state and an instant;
    // and no attributes, which a line has no use for and an integration may
    // have put something in.
    '&minimal_response&no_attributes'
  );
}

/** One change: when, and the number it changed to — `null` for a state that is no number. */
export interface HistoryChange {
  readonly at: number;
  readonly value: number | null;
}

const changeRow = z.object({
  state: z.string().max(255),
  last_changed: z.string().max(64).optional(),
  last_updated: z.string().max(64).optional(),
});

/**
 * The changes in a history answer for one entity, in order. Home Assistant
 * answers with a list per entity asked for; one was asked for, so the first
 * list is read and anything else is ignored. A row of the wrong shape is
 * skipped rather than costing the day.
 */
export function parseHistory(body: string): HistoryChange[] {
  const raw = parseJsonOr(z.array(z.unknown()), body, []);
  const first = raw[0];
  if (!Array.isArray(first)) return [];
  const out: HistoryChange[] = [];
  for (const item of first) {
    const row = changeRow.safeParse(item);
    if (!row.success) continue;
    const at = Date.parse(row.data.last_changed ?? row.data.last_updated ?? '');
    if (!Number.isFinite(at)) continue;
    const text = row.data.state.trim();
    const number = text === '' ? NaN : Number(text);
    out.push({ at, value: Number.isFinite(number) ? number : null });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Four significant figures: enough for a line, and a series that does not move in its fifteenth. */
function rounded(value: number): number {
  return Number(value.toPrecision(4));
}

/**
 * The window's half-hour means. Each change holds until the next, and the
 * last until the window's end; a half hour is the mean of the numbers over the
 * part of it that had one, weighted by how long each held, or `null` when no
 * part of it did. Before the first change nothing is known.
 */
export function seriesFrom(
  changes: readonly HistoryChange[],
  end: number,
  points = HISTORY_POINTS,
  bucketMs = HISTORY_BUCKET_MS,
): (number | null)[] {
  const start = end - points * bucketMs;
  const sums = new Array<number>(points).fill(0);
  const spans = new Array<number>(points).fill(0);
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i] as HistoryChange;
    if (change.value === null) continue;
    const from = Math.max(start, change.at);
    const until = Math.min(end, (changes[i + 1] as HistoryChange | undefined)?.at ?? end);
    if (until <= from) continue;
    const first = Math.floor((from - start) / bucketMs);
    const last = Math.min(points - 1, Math.floor((until - 1 - start) / bucketMs));
    for (let b = first; b <= last; b++) {
      const lo = Math.max(from, start + b * bucketMs);
      const hi = Math.min(until, start + (b + 1) * bucketMs);
      if (hi <= lo) continue;
      sums[b] = (sums[b] as number) + change.value * (hi - lo);
      spans[b] = (spans[b] as number) + (hi - lo);
    }
  }
  return sums.map((sum, b) => ((spans[b] as number) > 0 ? rounded(sum / (spans[b] as number)) : null));
}

/** A stored series, read defensively: anything but the fixed shape is no series. */
export function storedSeries(raw: string | null): (number | null)[] | undefined {
  if (raw === null) return undefined;
  const parsed = parseJsonOr(z.array(z.number().finite().nullable()).length(HISTORY_POINTS), raw, undefined);
  if (parsed === undefined || parsed.every((value) => value === null)) return undefined;
  return parsed;
}

interface WatchedName {
  readonly entityId: string;
  readonly label: string | null;
  readonly friendlyName: string | null;
}

/** Every Home Assistant widget's stored config, on every wall, canvas and layout. */
function haWidgetConfigs(db: SqliteDatabase): Record<string, unknown>[] {
  const rows = db
    .prepare(`SELECT config FROM layout_widgets WHERE type = 'homeassistant' AND json_valid(config)`)
    .all() as { config: string }[];
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const config = parseJsonOr(z.record(z.string(), z.unknown()), row.config, undefined);
    if (config !== undefined) out.push(config);
  }
  return out;
}

/**
 * The watched entities a widget's `readings` names, in the household's order —
 * by entity id, or by the label a widget saved before P1.3 stored ids, exactly
 * as `readingHandlesFor` resolves them for the wall. None named is all of them.
 */
function readingsOf(config: Record<string, unknown>, watched: readonly WatchedName[]): string[] {
  const entries = Array.isArray(config['readings'])
    ? (config['readings'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (entries.length === 0) return watched.map((row) => row.entityId);
  return watched
    .filter((row) =>
      entries.some((entry) => entry === row.entityId || entry === (row.label ?? row.friendlyName ?? row.entityId)),
    )
    .map((row) => row.entityId);
}

function watchedNames(db: SqliteDatabase): WatchedName[] {
  return db
    .prepare(
      `SELECT entity_id AS entityId, label, friendly_name AS friendlyName FROM ha_entity_cache
        WHERE watched = 1 ORDER BY sort_order, entity_id`,
    )
    .all() as WatchedName[];
}

/**
 * The subject of a status card (M6.8): the reading it names, when that
 * reading is watched, and otherwise the first reading the widget shows.
 */
export function statusSubjectOf(config: Record<string, unknown>, watched: readonly WatchedName[]): string | undefined {
  const named = config['subject'];
  if (typeof named === 'string' && watched.some((row) => row.entityId === named)) return named;
  return readingsOf(config, watched)[0];
}

/**
 * The readings whose history a widget asks for (M6.10): those a widget with
 * `sparkline` on shows, its status card's subject and progress among them —
 * and only sensors, whose state is a number. A light's "on" has no line.
 * Capped at `HISTORY_MAX_ENTITIES`, in the household's order.
 */
export function sparklineEntities(db: SqliteDatabase): string[] {
  const configs = haWidgetConfigs(db).filter((config) => config['sparkline'] === true);
  if (configs.length === 0) return [];
  const watched = watchedNames(db);
  const wanted = new Set<string>();
  for (const config of configs) {
    for (const id of readingsOf(config, watched)) wanted.add(id);
    if (config['variant'] === 'status') {
      const subject = statusSubjectOf(config, watched);
      if (subject !== undefined) wanted.add(subject);
    }
  }
  return watched
    .map((row) => row.entityId)
    .filter((id) => wanted.has(id) && domainOf(id) === 'sensor')
    .slice(0, HISTORY_MAX_ENTITIES);
}

/**
 * The readings whose own picture a status card draws (M6.8): the subject of
 * every card with `subjectPicture` on. Only those carry a picture handle to
 * the wall, so a household that never asked sends what it sent before.
 */
export function pictureEntities(db: SqliteDatabase): Set<string> {
  const configs = haWidgetConfigs(db).filter(
    (config) => config['variant'] === 'status' && config['subjectPicture'] === true,
  );
  if (configs.length === 0) return new Set();
  const watched = watchedNames(db);
  const out = new Set<string>();
  for (const config of configs) {
    const subject = statusSubjectOf(config, watched);
    if (subject !== undefined) out.add(subject);
  }
  return out;
}
