/**
 * The hours a wall's timed layouts show, as the layout editor edits them
 * (RFC 014 §5.2).
 *
 * The editor's Layouts menu lists every layout with when it shows, lets the
 * household set a timed layout's hours beside the arrangement they decide,
 * and saves them with the wall. What it has to answer — is this unsaved, what
 * does this layout's line say, is there anything the server would refuse, do
 * two windows fight over the same minute — is arithmetic, so it lives here,
 * pure and DOM-free, for the reason `canvas-state.ts` and `placement.ts` do:
 * a rule that lives in a click handler is a rule nothing can check.
 *
 * A rule in the editor may be half-typed. A row with neither time is not a
 * rule at all — the menu shows one so a layout with no hours has somewhere to
 * type them — and it never counts as unsaved work. A row with one time is
 * unsaved work the save refuses by name, rather than a window nobody can see.
 */

import { windowContains } from './canvas-schedule.js';

export interface EditedRule {
  readonly slot: string;
  readonly from: string;
  readonly to: string;
}

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** A row nobody has typed a time into — not a rule, and not unsaved work. */
export function isBlankRule(rule: EditedRule): boolean {
  return rule.from === '' && rule.to === '';
}

/** A row that is a window the wall can draw: two real times, and different. */
export function isWindow(rule: EditedRule): boolean {
  return HHMM.test(rule.from) && HHMM.test(rule.to) && rule.from !== rule.to;
}

/**
 * The schedule as one comparable string — every row that is not blank, in
 * order, because order is meaning here: where two windows overlap, the first
 * one written wins.
 */
export function scheduleSnapshot(rules: readonly EditedRule[]): string {
  return JSON.stringify(rules.filter((rule) => !isBlankRule(rule)).map((rule) => [rule.slot, rule.from, rule.to]));
}

/** What is posted: the windows, in order, and nothing half-typed. */
export function scheduleForSave(rules: readonly EditedRule[]): EditedRule[] {
  return rules.filter(isWindow).map((rule) => ({ slot: rule.slot, from: rule.from, to: rule.to }));
}

/** A layout's windows as the menu writes them: "06:30–08:30". */
export function hoursOf(rules: readonly EditedRule[], slot: string): string[] {
  return rules.filter((rule) => rule.slot === slot && isWindow(rule)).map((rule) => `${rule.from}–${rule.to}`);
}

/**
 * The line under a layout's name in the menu.
 *
 * The everyday layout says "all day" until a timed layout has hours, and "the
 * rest of the time" after — which is the whole of how a schedule works, said
 * where somebody is choosing between them. A timed layout with no window is
 * **never drawn**, and that is the case this line exists for: a layout made,
 * arranged and saved with no hours used to look exactly like one that works.
 */
export function whenLine(rules: readonly EditedRule[], slot: string | null): string {
  if (slot === null) {
    return rules.some(isWindow) ? 'Shown the rest of the time' : 'Shown all day';
  }
  const hours = hoursOf(rules, slot);
  return hours.length === 0 ? 'No hours yet, so never shown' : `Shown ${hours.join(' and ')}`;
}

/**
 * The first thing the save would be refused for, as a sentence and the layout
 * it is about — or undefined when every row is a window or blank.
 *
 * Checked before anything is posted, so a half-typed row costs a sentence in
 * the save bar and the menu opened on it, never a canvas saved without the
 * hours it was made for. The server refuses the same rows again, because a
 * form is a convenience and the POST is the boundary.
 */
export function scheduleProblem(
  rules: readonly EditedRule[],
): { readonly slot: string; readonly message: string } | undefined {
  for (const rule of rules) {
    if (isBlankRule(rule)) continue;
    if (rule.from === '' || rule.to === '') {
      return {
        slot: rule.slot,
        message: `Give ${rule.slot} both times, or clear them. From 06:30 until 08:30 shows it every morning.`,
      };
    }
    if (!HHMM.test(rule.from) || !HHMM.test(rule.to)) {
      return { slot: rule.slot, message: `${rule.slot}: those times are not times. Use HH:MM.` };
    }
    if (rule.from === rule.to) {
      return {
        slot: rule.slot,
        message: `${rule.slot} starts and ends at ${rule.from}, so it would never show. Make the two times different.`,
      };
    }
  }
  return undefined;
}

const hhmmOf = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/**
 * Where two different layouts' windows first overlap, and which one the wall
 * draws there — or undefined when none do.
 *
 * Overlap is let through, deliberately (`layout-slots.ts` says why): the wall
 * resolves it by drawing the first rule written, and a refusal would cost a
 * save for a case with a perfectly good answer. What was missing is the
 * household knowing the answer, so the menu says it. Read minute by minute,
 * because a window can wrap past midnight and a comparison of endpoints is
 * where that goes wrong; `from` is where the overlap *starts*, walked back
 * from the first shared minute so a night window reports 22:00 and not 00:00.
 */
export function firstOverlap(
  rules: readonly EditedRule[],
): { readonly from: string; readonly slots: readonly [string, string]; readonly shows: string } | undefined {
  const windows = rules.filter(isWindow);
  const at = (minute: number): EditedRule[] => windows.filter((rule) => windowContains(rule.from, rule.to, hhmmOf(minute)));
  for (let minute = 0; minute < 1440; minute += 1) {
    const here = at(minute);
    const first = here[0];
    const other = here.find((rule) => first !== undefined && rule.slot !== first.slot);
    if (first === undefined || other === undefined) continue;
    const both = (m: number): boolean => {
      const slots = at(((m % 1440) + 1440) % 1440).map((rule) => rule.slot);
      return slots.includes(first.slot) && slots.includes(other.slot);
    };
    let start = minute;
    for (let step = 0; step < 1440 && both(start - 1); step += 1) start -= 1;
    return {
      from: hhmmOf(((start % 1440) + 1440) % 1440),
      slots: [first.slot, other.slot],
      shows: first.slot,
    };
  }
  return undefined;
}
