import {
  analyseTitles,
  resolveShifts,
  type ResolvedShift,
  type ShiftPlan,
  type ShiftType,
  type TitleObservation,
} from '@maverick-wall/core';
import { escapeHtml } from './html.js';

/**
 * The shift rotation screen, minus the routing.
 *
 * Everything here is a pure function of a draft and the data behind it, so the
 * four-week preview can be tested against a document rather than a screenshot —
 * and the preview is the whole point of the screen. Nobody can verify a rota by
 * reading back a cycle string; they verify it by looking at four weeks of days
 * and recognising their own life.
 *
 * A draft lives in the form's own fields rather than on the server. There is no
 * half-saved rotation to clean up, no session state to expire, and the back
 * button does what it looks like it does.
 */

export type PlanKind = 'pattern' | 'calendar';

/** How long a cycle may be. Two weeks covers every rota anybody has described. */
export const MAX_CYCLE = 14;
export const PREVIEW_DAYS = 28;

/** The sentinel for "this slot is not part of the cycle". */
export const SLOT_UNUSED = '';
/** The sentinel for "explicitly not working", which is not the same as unused. */
export const SLOT_OFF = 'off';

export interface Draft {
  readonly personId: string;
  readonly kind: PlanKind;
  readonly sourceId: string;
  readonly anchorDate: string;
  /** One entry per slot, `''` for unused and `'off'` for a rest day. */
  readonly slots: readonly string[];
  /** Title to shift key, `'off'` for a rest day, `''` for ignore. */
  readonly titleMap: readonly { readonly title: string; readonly key: string }[];
}

export type DraftProblem = { readonly message: string; readonly suggestion?: string };

/**
 * A cycle from the slot dropdowns.
 *
 * Trailing unused slots end the cycle; an unused slot with something after it
 * is a hole, and a hole is a mistake rather than a shorter cycle — somebody
 * cleared the wrong row and the rota would silently shift by a day.
 */
export function cycleFrom(slots: readonly string[]): (string | null)[] | DraftProblem {
  const lastUsed = slots.reduce(
    (last, slot, index) => (slot === SLOT_UNUSED ? last : index),
    -1,
  );
  if (lastUsed < 0) return { message: 'Set at least one day of the cycle.' };

  const used = slots.slice(0, lastUsed + 1);
  if (used.some((slot) => slot === SLOT_UNUSED)) {
    return {
      message: 'The cycle has a gap in it.',
      suggestion:
        'Every day up to the last one has to say something. Use "Off" for a rest day — ' +
        'leaving a day blank ends the cycle rather than skipping it.',
    };
  }
  return used.map((slot) => (slot === SLOT_OFF ? null : slot));
}

/** The plan a draft describes, or why it does not describe one yet. */
export function planFrom(draft: Draft, id: string): ShiftPlan | DraftProblem {
  const base = {
    id,
    name: 'Rotation',
    personId: draft.personId,
    effectiveFrom: '2000-01-01',
    effectiveTo: null,
    priority: 0,
  };

  if (draft.kind === 'pattern') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.anchorDate)) {
      return {
        message: 'Pick the date the cycle starts on.',
        suggestion: 'A day you know what you were doing — the resolver counts from there.',
      };
    }
    const cycle = cycleFrom(draft.slots);
    if (!Array.isArray(cycle)) return cycle;
    return { ...base, kind: 'pattern', anchorDate: draft.anchorDate, cycle } as ShiftPlan;
  }

  if (draft.sourceId === '') return { message: 'Choose which calendar the shifts are in.' };
  const matchers = draft.titleMap
    .filter((entry) => entry.key !== '')
    .map((entry) => ({
      shiftTypeKey: entry.key === SLOT_OFF ? null : entry.key,
      pattern: entry.title,
      /*
       * Exact, because these titles were picked from a list of what is
       * genuinely in the feed. A substring test could quietly also match
       * something the household never looked at.
       */
      matchMode: 'exact' as const,
    }));
  if (matchers.length === 0) {
    return {
      message: 'Tag at least one title as a shift.',
      suggestion: 'Pick the entries that mean work or a rest day. Leave the rest as "Not a shift".',
    };
  }
  return {
    ...base,
    kind: 'calendar',
    calendarSourceId: draft.sourceId,
    matchers,
    consumesEvents: true,
  } as ShiftPlan;
}

export interface PreviewDay {
  readonly date: string;
  readonly dayNumber: string;
  readonly weekday: string;
  readonly key: string | null;
  readonly label: string;
  readonly shortCode: string;
  readonly isWorking: boolean;
  /** Nothing resolved. Different from a rest day, and shown differently. */
  readonly unknown: boolean;
}

/**
 * Four weeks of the rotation this draft would produce.
 *
 * Run through the same resolver the wall uses, against the same cached titles,
 * so what somebody approves here is what they will see. A preview computed by
 * a second implementation would be a second thing to keep correct, and the one
 * that disagreed would be the one nobody noticed.
 */
export function previewFor(
  plan: ShiftPlan,
  from: string,
  shiftTypes: readonly ShiftType[],
  titlesByDate: ReadonlyMap<string, readonly string[]>,
  timezone: string,
): PreviewDay[] {
  const to = addDays(from, PREVIEW_DAYS - 1);
  const resolved = new Map<string, ResolvedShift>();
  for (const day of resolveShifts({ from, to, plans: [plan], overrides: [], titlesByDate, shiftTypes })) {
    resolved.set(day.date, day);
  }

  const days: PreviewDay[] = [];
  for (let offset = 0; offset < PREVIEW_DAYS; offset++) {
    const date = addDays(from, offset);
    const entry = resolved.get(date);
    const type =
      entry?.shiftTypeKey == null
        ? undefined
        : shiftTypes.find((candidate) => candidate.key === entry.shiftTypeKey);
    const off = entry !== undefined && entry.shiftTypeKey === null && entry.source !== 'none';

    days.push({
      date,
      dayNumber: String(Number(date.slice(8, 10))),
      weekday: weekdayName(date, timezone),
      key: entry?.shiftTypeKey ?? null,
      label: type?.label ?? (off ? 'Off' : '—'),
      shortCode: type?.shortCode ?? (off ? 'B' : ''),
      isWorking: type?.isWorking ?? false,
      unknown: entry === undefined || (entry.shiftTypeKey === null && entry.source === 'none'),
    });
  }
  return days;
}

/** How much of the preview the rotation actually accounts for. */
export function previewSummary(days: readonly PreviewDay[]): string {
  const working = days.filter((day) => day.isWorking).length;
  const unknown = days.filter((day) => day.unknown).length;
  if (unknown === days.length) {
    return 'Nothing resolved for these four weeks. Check the tags or the start date.';
  }
  const parts = [`${working} working day${working === 1 ? '' : 's'} in four weeks`];
  if (unknown > 0) parts.push(`${unknown} day${unknown === 1 ? '' : 's'} the rota says nothing about`);
  return `${parts.join(' · ')}.`;
}

export function renderPreview(days: readonly PreviewDay[]): string {
  const cells = days
    .map((day) => {
      const classes = ['pv-cell'];
      if (day.unknown) classes.push('pv-unknown');
      else if (!day.isWorking) classes.push('pv-off');
      return (
        `<div class="${classes.join(' ')}">` +
        `<span class="pv-dow">${escapeHtml(day.weekday)}</span>` +
        `<span class="pv-num">${escapeHtml(day.dayNumber)}</span>` +
        `<span class="pv-code">${escapeHtml(day.shortCode || '·')}</span>` +
        `</div>`
      );
    })
    .join('');

  return (
    `<div class="preview">` +
    `<h2>The next four weeks</h2>` +
    `<p class="hint">${escapeHtml(previewSummary(days))}</p>` +
    `<div class="pv-grid">${cells}</div>` +
    `<p class="hint">Nothing has been saved yet. If this matches your rota, save it.</p>` +
    `</div>`
  );
}

/** Titles worth offering, most shift-like first. */
export function candidatesFor(
  rows: readonly { title: string; startDate: string; endDate: string; allDay: number; startsAt: number }[],
  timezone: string,
): ReturnType<typeof analyseTitles> {
  const observations: TitleObservation[] = rows.map((row) => {
    const dates: string[] = [];
    let cursor = row.startDate;
    for (let guard = 0; cursor <= row.endDate && guard < 400; guard++) {
      dates.push(cursor);
      cursor = addDays(cursor, 1);
    }
    return row.allDay === 1
      ? { title: row.title, dates, allDay: true }
      : {
          title: row.title,
          dates,
          allDay: false,
          startTime: new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }).format(new Date(row.startsAt)),
        };
  });

  const days = new Set(observations.flatMap((observation) => observation.dates));
  return analyseTitles({ observations, windowDays: Math.max(1, days.size) })
    .filter((candidate) => candidate.confidence !== 'unlikely')
    .slice(0, 20);
}

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function weekdayName(date: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short' }).format(
    new Date(`${date}T12:00:00Z`),
  );
}
