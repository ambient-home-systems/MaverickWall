import { createHash } from 'node:crypto';
import {
  addDays,
  eachDate,
  matchShiftTitle,
  resolveShifts,
  type CivilDate,
  type ResolvedShift,
  type ShiftOverride,
  type ShiftPlan,
  type ShiftType,
} from '@maverick-wall/core';

/**
 * The manifest: everything a display needs, in one document.
 *
 * One round trip rather than several, because a display assembling its own view
 * from four endpoints can render half-updated state — today's events beside
 * yesterday's shift. Making the document the unit of consistency removes that
 * whole category of bug from the client, which is the component least able to
 * report what went wrong.
 *
 * Assembly is pure: it takes plain rows and returns a document. The database
 * queries live next door, so everything below can be tested without one.
 */

export const MANIFEST_VERSION = 1;

export interface ManifestEvent {
  readonly id: string;
  readonly uid: string;
  readonly title: string;
  readonly location?: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly allDay: boolean;
  readonly sourceId: string;
  readonly color: string;
  readonly status: string;
  /** True when the event covers more than the day it is listed under. */
  readonly continues: boolean;
}

export interface ManifestShift {
  readonly key: string;
  readonly label: string;
  readonly shortCode: string;
  readonly colorToken: string;
  readonly isWorking: boolean;
  /** Where the answer came from, for the diagnostics overlay. */
  readonly source: string;
}

/**
 * A shift belonging to somebody.
 *
 * Households have more than one shift worker. Resolving a single timeline —
 * which an earlier version did — cannot say whose shift it is, and a wall
 * showing one person's rota while the other's is invisible is worse than showing
 * neither.
 */
export interface ManifestPersonShift extends ManifestShift {
  readonly personId: string;
  readonly personName: string;
  readonly personColor: string;
}

export interface ManifestPerson {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly hasShiftRotation: boolean;
}

export interface ManifestDay {
  readonly date: CivilDate;
  /**
   * One entry per person who has a shift that day, in the order people are
   * sorted. Empty when nobody does — which is different from the feature being
   * off, and the display should render those differently.
   */
  readonly shifts: readonly ManifestPersonShift[];
  readonly events: readonly ManifestEvent[];
}

export interface ManifestSourceHealth {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly lastSuccessAt: number | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly eventCount: number;
}

export interface ManifestNotice {
  readonly level: 'info' | 'warn' | 'error';
  readonly code: string;
  /** Written for someone standing in a kitchen, not for a log reader. */
  readonly message: string;
}

export interface Manifest {
  readonly manifestVersion: number;
  readonly appVersion: string;
  /**
   * Authoritative server time.
   *
   * A wall tablet's clock drifts, and some never get NTP at all. The display
   * tracks the offset from this and never trusts its own clock for anything
   * that decides what to show.
   */
  readonly generatedAt: number;
  readonly timezone: string;
  readonly theme: {
    readonly active: string;
    readonly daytime?: string;
    readonly daytimeStartsAt?: string;
    readonly daytimeEndsAt?: string;
  };
  readonly window: { readonly from: CivilDate; readonly to: CivilDate };
  readonly days: readonly ManifestDay[];
  /** Everyone the wall knows about, so a legend can be drawn. */
  readonly people: readonly ManifestPerson[];
  readonly sources: readonly ManifestSourceHealth[];
  /** Empty in the healthy case. Anything here gets a banner on screen. */
  readonly notices: readonly ManifestNotice[];
  /** Weather and interrupts are not built yet; the fields exist so the
   *  display contract does not change when they arrive. */
  readonly weather: null;
  readonly interrupts: readonly never[];
}

/** Row shapes as they come out of the database, before assembly. */
export interface EventCacheRow {
  readonly id: string;
  readonly sourceId: string;
  readonly uid: string;
  readonly title: string;
  readonly location: string | null;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly allDay: number;
  readonly startLocalDate: string;
  readonly endLocalDate: string;
  readonly status: string;
}

export interface SourceRow {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly visible: number;
  readonly lastSuccessAt: number | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly eventCount: number;
}

export interface HouseholdRow {
  readonly timezone: string;
  readonly theme: string;
  readonly daytimeTheme: string | null;
  readonly daytimeStartsAt: string | null;
  readonly daytimeEndsAt: string | null;
  readonly shiftEnabled: number;
}

export interface PersonRow {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly hasShiftRotation: number;
  readonly sortOrder: number;
}

export interface BuildManifestInput {
  readonly household: HouseholdRow;
  readonly events: readonly EventCacheRow[];
  readonly sources: readonly SourceRow[];
  readonly people: readonly PersonRow[];
  readonly shiftTypes: readonly ShiftType[];
  readonly shiftPlans: readonly ShiftPlan[];
  readonly shiftOverrides: readonly ShiftOverride[];
  readonly today: CivilDate;
  readonly daysBefore: number;
  readonly daysAfter: number;
  readonly now: number;
  readonly appVersion: string;
  /** Anything the caller already knows is wrong: a failed migration, say. */
  readonly notices?: readonly ManifestNotice[];
}

function shiftFor(
  resolved: ResolvedShift | undefined,
  types: readonly ShiftType[],
): ManifestShift | undefined {
  if (!resolved || resolved.shiftTypeKey === null) return undefined;
  const type = types.find((candidate) => candidate.key === resolved.shiftTypeKey);
  if (!type) return undefined;
  return {
    key: type.key,
    label: type.label,
    shortCode: type.shortCode,
    colorToken: type.colorToken,
    isWorking: type.isWorking,
    source: resolved.source,
  };
}

/**
 * Notices describing anything a household should be told about.
 *
 * A feed that has failed once is not worth mentioning — networks blip, and the
 * next sync is minutes away. Three consecutive failures means something is
 * actually wrong, and by then the events on screen are getting stale.
 */
function healthNotices(sources: readonly SourceRow[], now: number): ManifestNotice[] {
  const notices: ManifestNotice[] = [];
  const dayMs = 86_400_000;

  for (const source of sources) {
    if (source.consecutiveFailures >= 3) {
      const staleFor = source.lastSuccessAt === null ? null : now - source.lastSuccessAt;
      const age =
        staleFor === null
          ? 'has never synced'
          : `last updated ${Math.floor(staleFor / 3_600_000)} hours ago`;
      notices.push({
        level: source.lastSuccessAt === null ? 'error' : 'warn',
        code: 'source-failing',
        message: `"${source.name}" ${age}.`,
      });
    } else if (source.lastSuccessAt !== null && now - source.lastSuccessAt > 2 * dayMs) {
      // Not failing, but not succeeding either — a job that stopped being
      // scheduled looks exactly like this and would otherwise be invisible.
      notices.push({
        level: 'warn',
        code: 'source-stale',
        message: `"${source.name}" has not updated in over two days.`,
      });
    }
  }

  return notices;
}

export function buildManifest(input: BuildManifestInput): Manifest {
  const from = addDays(input.today, -input.daysBefore);
  const to = addDays(input.today, input.daysAfter);
  const dates = eachDate(from, to);

  const visible = new Set(
    input.sources.filter((source) => source.visible === 1).map((source) => source.id),
  );
  const colours = new Map(input.sources.map((source) => [source.id, source.color]));

  const shiftEnabled = input.household.shiftEnabled === 1;

  /**
   * Event titles per date, so calendar-derived shift plans can see them.
   *
   * Without this a `calendar` plan can never fire: it matches on titles, and
   * the resolver has no other way to learn them.
   */
  const titlesByDate = new Map<string, string[]>();
  if (shiftEnabled) {
    for (const row of input.events) {
      for (const date of eachDate(row.startLocalDate, row.endLocalDate)) {
        const bucket = titlesByDate.get(date) ?? [];
        bucket.push(row.title);
        titlesByDate.set(date, bucket);
      }
    }
  }

  /**
   * Resolved per person, by filtering the plans and overrides that name them.
   *
   * Reusing the single-timeline resolver rather than teaching it about people
   * keeps all the layering logic — override beats calendar beats pattern — in
   * one tested place, and means a household with one shift worker costs exactly
   * what it did before.
   */
  const people = [...input.people].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const shiftsByDate = new Map<string, ManifestPersonShift[]>();

  if (shiftEnabled) {
    for (const person of people) {
      const plans = input.shiftPlans.filter((plan) => {
        const owner = (plan as unknown as { personId?: string | null }).personId;
        // A plan with no owner predates people existing. Attribute it to the
        // first person rather than dropping it silently.
        return owner === person.id || (owner == null && person.id === people[0]?.id);
      });
      if (plans.length === 0) continue;

      const overrides = input.shiftOverrides.filter((override) => {
        const owner = (override as unknown as { personId?: string | null }).personId;
        return owner === person.id || (owner == null && person.id === people[0]?.id);
      });

      for (const resolved of resolveShifts({
        from,
        to,
        plans,
        overrides,
        shiftTypes: input.shiftTypes,
        titlesByDate,
      })) {
        const shift = shiftFor(resolved, input.shiftTypes);
        if (!shift) continue;
        const bucket = shiftsByDate.get(resolved.date) ?? [];
        bucket.push({
          ...shift,
          personId: person.id,
          personName: person.name,
          personColor: person.color,
        });
        shiftsByDate.set(resolved.date, bucket);
      }
    }
  }

  /**
   * Plans that absorb the events they read.
   *
   * A feed marking every single day with "Working Day Shift" or "Break Day"
   * would otherwise fill the agenda with the same fact the day's colour already
   * carries, and bury the dentist appointment underneath it.
   */
  const consuming = shiftEnabled
    ? input.shiftPlans.filter((plan): plan is Extract<typeof plan, { kind: 'calendar' }> => {
        const record = plan as unknown as { kind: string; consumesEvents?: boolean };
        return record.kind === 'calendar' && record.consumesEvents !== false;
      })
    : [];

  const isConsumed = (sourceId: string, title: string): boolean =>
    consuming.some((plan) => {
      const record = plan as unknown as {
        calendarSourceId?: string;
        matchers?: readonly { shiftTypeKey: string | null; pattern: string; isRegex: boolean }[];
      };
      if (record.calendarSourceId !== undefined && record.calendarSourceId !== sourceId) {
        return false;
      }
      return matchShiftTitle(record.matchers ?? [], title) !== undefined;
    });

  // Events are bucketed by every local date they touch, so a multi-day trip
  // appears on each of its days rather than only the first. `continues` lets
  // the display draw it as a bar rather than repeating the title.
  const byDate = new Map<string, ManifestEvent[]>();
  for (const row of input.events) {
    if (!visible.has(row.sourceId)) continue;
    // Read as a shift, so it is not also listed as an appointment.
    if (isConsumed(row.sourceId, row.title)) continue;
    const span = eachDate(row.startLocalDate, row.endLocalDate);
    const multiDay = span.length > 1;
    for (const date of span) {
      const bucket = byDate.get(date) ?? [];
      bucket.push({
        id: row.id,
        uid: row.uid,
        title: row.title,
        ...(row.location !== null ? { location: row.location } : {}),
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        allDay: row.allDay === 1,
        sourceId: row.sourceId,
        color: colours.get(row.sourceId) ?? '#888888',
        status: row.status,
        continues: multiDay,
      });
      byDate.set(date, bucket);
    }
  }

  const days: ManifestDay[] = dates.map((date) => {
    const events = (byDate.get(date) ?? []).sort((a, b) => {
      // All-day first, then by start. A day's banner belongs above its agenda.
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      if (a.startsAt !== b.startsAt) return a.startsAt - b.startsAt;
      return a.title.localeCompare(b.title);
    });
    return { date, shifts: shiftsByDate.get(date) ?? [], events };
  });

  const theme = {
    active: input.household.theme,
    ...(input.household.daytimeTheme !== null ? { daytime: input.household.daytimeTheme } : {}),
    ...(input.household.daytimeStartsAt !== null
      ? { daytimeStartsAt: input.household.daytimeStartsAt }
      : {}),
    ...(input.household.daytimeEndsAt !== null
      ? { daytimeEndsAt: input.household.daytimeEndsAt }
      : {}),
  };

  return {
    manifestVersion: MANIFEST_VERSION,
    appVersion: input.appVersion,
    generatedAt: input.now,
    timezone: input.household.timezone,
    theme,
    window: { from, to },
    days,
    people: people.map((person) => ({
      id: person.id,
      name: person.name,
      color: person.color,
      hasShiftRotation: person.hasShiftRotation === 1,
    })),
    sources: input.sources.map((source) => ({
      id: source.id,
      name: source.name,
      color: source.color,
      lastSuccessAt: source.lastSuccessAt,
      lastError: source.lastError,
      consecutiveFailures: source.consecutiveFailures,
      eventCount: source.eventCount,
    })),
    notices: [...(input.notices ?? []), ...healthNotices(input.sources, input.now)],
    weather: null,
    interrupts: [],
  };
}

/**
 * An ETag over the parts of the manifest that affect what is drawn.
 *
 * `generatedAt` is deliberately excluded: it changes every poll, and including
 * it would mean every request transferred the whole document even when nothing
 * had changed. The display gets fresh server time from the response headers
 * regardless, so clock sync does not depend on the body being sent.
 */
export function manifestEtag(manifest: Manifest): string {
  const { generatedAt: _ignored, ...stable } = manifest;
  return `"${createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex').slice(0, 32)}"`;
}
