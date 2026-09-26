/**
 * How the comfortable month grid looks, resolved once (plan item P5.4, part 4).
 *
 * Four stored keys, each a look a household can pick for the month and none of
 * them new *drawings* so much as the grid's existing marks made choosable:
 *
 *   todayStyle    `ring`, the ink outline every flat-text month has drawn
 *                 round today; `fill`, today's numeral knocked out of a filled
 *                 accent disc, the compact month's own mark; or `numeral`,
 *                 today's numeral in the accent, the Swiss month's.
 *   monthHeading  `large`, the Swiss month's oversized name in the corner;
 *                 `small`, the same name as a label; or `hidden`.
 *   eventMark     how a timed event says whose it is: a colour `dot` (today's),
 *                 a colour `bar` down the row's edge, or its words in the
 *                 calendar's own colour (`text`).
 *   gridLines     a rule above each `week`, or `none`.
 *
 * **Absence is each treatment's own look, and that is what keeps a hanging wall
 * where it is.** The flat-text month and the Swiss month were designed with
 * different answers to all four questions — a ring and an accent numeral, no
 * heading and an oversized one, no week rule and a hairline — so there is no
 * single default that leaves both alone. The editor shows the treatment's own
 * answer checked, and stores a choice only when it differs from it, so a canvas
 * saved before these keys existed sends a byte-identical config and draws
 * exactly what it drew. The two calendar looks (`variant`) move one default
 * each: a `planner` and a `bold` month are ruled by week, which is the look.
 *
 * Only the flat-text and Swiss treatments draw rows and a structure of rules,
 * so the mark and the rules are theirs; a `pills` or `dots` month keeps its own
 * and reads neither. Today and the heading are every treatment's. The compact
 * month has its own grammar (a filled disc for today, hairlines for structure)
 * and reads none of these, which is why the editor offers them only on the
 * comfortable one.
 *
 * **Nothing here costs an event its row.** Today's three marks are paint on the
 * cell or the numeral; a bar is narrower than the dot it replaces and coloured
 * text has no mark at all, so a row keeps every pixel it had or gains some; a
 * rule is an out-of-flow grid item or a colour on a border the cell already
 * carries. The heading is the one choice that spends height, and it spends it
 * on the widget's words rather than on a mark — the widget title's own trade —
 * which is why the editor says so beside it and why hiding the Swiss heading
 * is the one choice here that *gives* the cells room.
 *
 * Pure, with no DOM, for the reason every deciding module in this bundle is.
 * The e-paper panel reads none of the four and `PANEL_IGNORES` says why, so
 * there is no transcription to hold to this one.
 */

export const TODAY_STYLES = ['ring', 'fill', 'numeral'] as const;
export type TodayStyle = (typeof TODAY_STYLES)[number];

export const MONTH_HEADINGS = ['large', 'small', 'hidden'] as const;
export type MonthHeading = (typeof MONTH_HEADINGS)[number];

export const EVENT_MARKS = ['dot', 'bar', 'text'] as const;
export type EventMark = (typeof EVENT_MARKS)[number];

export const GRID_LINES = ['week', 'none'] as const;
export type GridLines = (typeof GRID_LINES)[number];

/** The comfortable month's four cell treatments (`CellStyle` in `render.ts`). */
export type MonthTreatment = 'text' | 'swiss' | 'pills' | 'dots';

/** Every look the month resolves to, one per key. */
export interface MonthLooks {
  readonly today: TodayStyle;
  readonly heading: MonthHeading;
  readonly mark: EventMark;
  readonly rules: GridLines;
}

/** Whether a treatment draws event rows and a structure of rules at all. */
export function drawsRows(treatment: MonthTreatment): boolean {
  return treatment === 'text' || treatment === 'swiss';
}

/**
 * What each treatment draws with nothing stored — the looks it was designed
 * with, and so the looks every hanging wall is already wearing.
 */
export function treatmentLooks(treatment: MonthTreatment): MonthLooks {
  return treatment === 'swiss'
    ? { today: 'numeral', heading: 'large', mark: 'dot', rules: 'week' }
    : { today: 'ring', heading: 'hidden', mark: 'dot', rules: 'none' };
}

function pick<T extends string>(values: readonly T[], raw: unknown): T | undefined {
  for (const value of values) if (value === raw) return value;
  return undefined;
}

/**
 * The defaults a calendar's look (`variant`) brings: a planner and a bold month
 * are ruled by week — "ruled week lines" and "high-contrast rules" are what
 * those looks *are* — unless the household has said otherwise.
 */
function variantLooks(variant: unknown): Partial<MonthLooks> {
  return variant === 'planner' || variant === 'bold' ? { rules: 'week' } : {};
}

/**
 * The looks a stored config asks for on this treatment.
 *
 * Total, because it runs inside a draw: an absent, unknown or foreign value is
 * the treatment's own (after the variant's), so a canvas from a server older or
 * newer than this bundle draws what it drew. A treatment with no rows reads
 * neither the mark nor the rules, whatever is stored — the options are not
 * offered there and must not start to mean something the day a household
 * switches cell treatments back.
 */
export function monthLooks(config: unknown, treatment: MonthTreatment): MonthLooks {
  const c: Record<string, unknown> =
    typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
  const own = treatmentLooks(treatment);
  const look = { ...own, ...variantLooks(c['variant']) };
  const rows = drawsRows(treatment);
  return {
    today: pick(TODAY_STYLES, c['todayStyle']) ?? look.today,
    heading: pick(MONTH_HEADINGS, c['monthHeading']) ?? look.heading,
    mark: rows ? (pick(EVENT_MARKS, c['eventMark']) ?? look.mark) : own.mark,
    rules: rows ? (pick(GRID_LINES, c['gridLines']) ?? look.rules) : own.rules,
  };
}

/**
 * The classes the grid carries for every look that is not its treatment's own.
 *
 * Only the differences, so a month on its own looks carries no new class and
 * its markup is what it always was; the stylesheet draws each difference from
 * the class. The heading is not a class — it is an element, drawn or not.
 */
export function monthLookClasses(looks: MonthLooks, treatment: MonthTreatment): readonly string[] {
  const own = treatmentLooks(treatment);
  const out: string[] = [];
  if (looks.today !== own.today) out.push(`today-${looks.today}`);
  if (looks.mark !== own.mark) out.push(`mark-${looks.mark}`);
  if (looks.rules !== own.rules) out.push(`rules-${looks.rules}`);
  return out;
}
