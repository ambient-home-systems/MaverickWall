import { z } from '../../validation.js';
import { panelDataSchema } from './panel-data.js';
import { signalDataSchema } from './signal-data.js';
import { DEFAULT_TIMEZONE } from '../../timezone.js';
import { isXmlElement, type SourceFormat } from './source-formats.js';

/**
 * Recipe modules (docs/rfc-002-module-catalog-and-recipes.md, Phase B1).
 *
 * A recipe is a module that is *pure declarative data* — "fetch this URL, pull
 * these fields, draw this shape" — run by this first-party interpreter instead
 * of by a service the author hosts. It removes the one real friction of RFC
 * 001: that every module had to be its own running process. Same output as a
 * service module (validated Panel Data), same renderer, same trust boundary —
 * only the fetch-and-transform moves in here.
 *
 * The whole safety of it rests on the transform being **not a language**. It is
 * three fixed, first-party pieces:
 *
 *   - **selectors** — dotted / indexed paths into the fetched JSON. Traversal
 *     only: no arithmetic, no calls, no expressions.
 *   - **formatters** — a closed allowlist applied to a selected value (`upper`,
 *     `round:1`, `currency:GBP`, …). Adding one is a first-party code change,
 *     never something a recipe supplies.
 *   - **templates** — placeholder substitution into a string. Substitution
 *     only: no conditionals, no loops.
 *
 * A recipe cannot do I/O beyond its one declared `fetch`, cannot name anything
 * outside its `config` and the fetched body, and its output is validated against
 * the same `panelDataSchema` a service module's body is. So a recipe is as
 * bounded as a service module and needs no more trust — it just saves a
 * container.
 *
 * Not in B1, deliberately: `secrets` (encrypted credentials injected into the
 * fetch), recipe `signals` and their `when` predicate (B2), and sourceless
 * generators like a countdown (B2). This is the fetch-a-panel pipeline and no
 * more.
 */

// ---------------------------------------------------------------------------
// Formatters — the closed allowlist. A name not here is a rejected recipe.
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOL: Readonly<Record<string, string>> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
  JPY: '¥',
};

/**
 * What a formatter may know beyond the value: the time, the household's zone
 * (plan item M7.8, for `time`), and the recipe's own lookup tables (for `map`).
 * Never the network, never anything a recipe did not declare.
 */
interface FormatContext {
  readonly now: number;
  readonly timezone: string;
  readonly lookups: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** A formatter turns a selected value into a string. First-party, total, pure. */
type Formatter = (value: unknown, arg: string | undefined, context: FormatContext) => string;

function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

const FORMATTERS: Readonly<Record<string, Formatter>> = {
  upper: (v) => asString(v).toUpperCase(),
  lower: (v) => asString(v).toLowerCase(),
  trim: (v) => asString(v).trim(),
  round: (v, arg) => {
    const n = asNumber(v);
    if (n === undefined) return asString(v);
    const places = Math.max(0, Math.min(6, arg === undefined ? 0 : Number(arg) || 0));
    return n.toFixed(places);
  },
  int: (v) => {
    const n = asNumber(v);
    return n === undefined ? asString(v) : String(Math.round(n));
  },
  currency: (v, arg) => {
    const n = asNumber(v);
    if (n === undefined) return asString(v);
    const symbol = arg === undefined ? '' : CURRENCY_SYMBOL[arg.toUpperCase()] ?? '';
    return `${symbol}${n.toFixed(2)}`;
  },
  truncate: (v, arg) => {
    const s = asString(v);
    const max = Math.max(1, Math.min(280, arg === undefined ? 40 : Number(arg) || 40));
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  },
  date: (v, arg, context) => formatDate(v, arg, context.now, context.timezone),
  default: (v, arg) => {
    const s = asString(v);
    return s === '' ? arg ?? '' : s;
  },
  // Plan item M7.8's four.
  number: (v, arg) => formatNumber(v, arg),
  duration: (v, arg) => formatDuration(v, arg),
  time: (v, arg, context) => formatTime(v, arg, context.timezone),
  // Plan item M7.11: the instant a timeline's or a countdown's `at` must be.
  iso: (v) => formatIso(v),
  plural: (v, arg) => formatPlural(v, arg),
  map: (v, arg, context) => lookUp(v, arg, context.lookups),
};

/** How many decimal places an argument asks for: 0 to 6, and 0 when it says nothing. */
function places(arg: string | undefined): number {
  const n = arg === undefined ? 0 : Number(arg);
  return Number.isInteger(n) ? Math.max(0, Math.min(6, n)) : 0;
}

/** `number:2` — a number with its thousands grouped, "12,345.60", to as many places as asked. */
function formatNumber(value: unknown, arg: string | undefined): string {
  const n = asNumber(value);
  if (n === undefined) return asString(value);
  const p = places(arg);
  return n.toLocaleString('en-GB', { minimumFractionDigits: p, maximumFractionDigits: p });
}

const DURATION_UNITS: Readonly<Record<string, number>> = { ms: 1, s: 1000, min: 60_000, h: 3_600_000 };

/**
 * `duration:s` — a length of time in the words the wall's own countdowns use:
 * "45 s", "12 min", "1 h 20 min", "3 days". The argument is the unit the feed
 * counts in (`ms`, `s`, `min` or `h`; seconds when it says nothing, or names a
 * unit not on the list). A length has no direction, so a negative one is said
 * as its size; whether it is to come or past is the recipe's own words.
 */
function formatDuration(value: unknown, arg: string | undefined): string {
  const n = asNumber(value);
  if (n === undefined) return asString(value);
  const unit = DURATION_UNITS[arg ?? 's'] ?? 1000;
  const ms = Math.abs(n) * unit;
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`;
  if (ms < 2 * 86_400_000) {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms - hours * 3_600_000) / 60_000);
    return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
  }
  return `${Math.floor(ms / 86_400_000)} days`;
}

/**
 * `time:24` or `time:12` — the clock time of an instant in the household's own
 * zone, "14:05" or "2:05 pm", so a feed that speaks UTC reads like the kitchen
 * clock. Twenty-four hours when the argument says nothing else.
 */
function formatTime(value: unknown, arg: string | undefined, timezone: string): string {
  const ms = toEpochMs(value);
  if (ms === undefined) return asString(value);
  const twelve = arg === '12';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: twelve ? 'numeric' : '2-digit',
      minute: '2-digit',
      hour12: twelve,
    }).format(new Date(ms));
  } catch {
    // A zone this runtime does not know is the household's to fix; the clock
    // in UTC is still a clock.
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(
      new Date(ms),
    );
  }
}

/**
 * `plural:train` — a count and its noun, "1 train", "3 trains"; or
 * `plural:child,children` for a noun that does not take an s. One (and minus
 * one) is singular, and every other count plural, nought included.
 */
function formatPlural(value: unknown, arg: string | undefined): string {
  const n = asNumber(value);
  if (n === undefined) return asString(value);
  const [one = '', many] = (arg ?? '').split(',').map((word) => word.trim());
  if (one === '') return String(n);
  const word = Math.abs(n) === 1 ? one : many ?? `${one}s`;
  return `${n} ${word}`;
}

/**
 * `map:status` — a value turned into the recipe's own words by one of its
 * lookup tables: `on` into "Running". A value the table does not name takes
 * its `*` entry where it has one, and is said as itself where it has not.
 */
function lookUp(
  value: unknown,
  arg: string | undefined,
  lookups: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string {
  const key = asString(value);
  const table = arg === undefined || !Object.prototype.hasOwnProperty.call(lookups, arg) ? undefined : lookups[arg];
  if (table === undefined) return key;
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key] as string;
  return Object.prototype.hasOwnProperty.call(table, '*') ? (table['*'] as string) : key;
}

/**
 * `date:short` and `date:relative`, in the household's own zone, as `time` is.
 * Plan item M7.11 found both reading the *server's* zone: an event that began
 * at 14:58 UTC on the 10th said "10 Oct" on a server in UTC and "11 Oct" on
 * one in New Zealand. And `relative` counted elapsed hours rather than days,
 * so something at 23:00 tonight read "tomorrow" at one in the morning. It
 * compares the two calendar dates in the household's zone now.
 */
function formatDate(value: unknown, arg: string | undefined, now: number, timezone: string): string {
  const ms = toEpochMs(value);
  if (ms === undefined) return asString(value);
  const zone = knownZone(timezone);
  if (arg === 'relative') {
    const days = Math.round((civilDay(ms, zone) - civilDay(now, zone)) / 86_400_000);
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    return days > 0 ? `in ${days} days` : `${-days} days ago`;
  }
  // `short` (and the default): a plain calendar date.
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: zone });
}

/** A zone this runtime knows, or UTC: a zone it does not is the household's to fix, and UTC is still a date. */
function knownZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return timezone;
  } catch {
    return 'UTC';
  }
}

/** The calendar date an instant falls on in a zone, as midnight UTC of that date. */
function civilDay(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms));
  return Date.parse(`${parts}T00:00:00Z`);
}

/**
 * A date and time that names no zone, as a feed writes it: `2026-10-14 02:56`
 * or `2026-10-15T03:00:00`. Plan item M7.11 found three public feeds in the
 * store's first ten writing their times this way, and every one of them meant
 * UTC (NOAA's tides asked for in `gmt`, NOAA's space weather, USGS's
 * `sent_utc`). JavaScript reads such a string in the *server's* zone, so the
 * same answer said one time on a container in UTC and another on one set to
 * New York. It is read as UTC here, so a recipe means one thing on every box.
 */
const ZONELESS = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/;

function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: ten-digit values are seconds, not milliseconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const zoneless = ZONELESS.exec(value.trim());
    const t = Date.parse(zoneless === null ? value : `${zoneless[1]}T${zoneless[2]}Z`);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/**
 * `iso` — any time a recipe can read, written as the instant a timeline's or
 * a countdown's `at` must be: `2026-10-14T02:56:00Z`. A feed's own way of
 * writing a time (seconds since 1970, a zone-less date and time) is otherwise
 * refused there, because the panel will not guess a zone.
 */
function formatIso(value: unknown): string {
  const ms = toEpochMs(value);
  return ms === undefined ? asString(value) : new Date(ms).toISOString().replace('.000Z', 'Z');
}

// ---------------------------------------------------------------------------
// Selectors — dotted / indexed path resolution. Traversal only.
// ---------------------------------------------------------------------------

/*
 * A selector: a dotted / indexed path into the primary fetch's body, or, with
 * `@name` in front, into one of the recipe's named `sources` (plan item M7.7)
 * — `@name` alone is that source's whole body. Traversal only: a path can say
 * where a value is and nothing about what to do with it.
 *
 * `.` alone is the main answer's whole body, and a path may start with an
 * index, `[0].kp` (plan item M7.11): a feed whose answer is a list at the top,
 * as NOAA's space weather, USGS's volcanoes and the EPA's UV index all are,
 * had no path to it at all.
 */
const PATH =
  /^(?:\.|@[a-z][a-z0-9_]{0,19}(?:\.[A-Za-z0-9_]+|\[\d+\])*|(?:[A-Za-z0-9_]+|\[\d+\])(?:\.[A-Za-z0-9_]+|\[\d+\])*)$/;
const SOURCE_REF = /^@([a-z][a-z0-9_]{0,19})(.*)$/;

/** The bodies of a recipe's named sources, by name, for `@name` selectors. */
export type RecipeSources = Readonly<Record<string, unknown>>;

function parsePath(path: string): (string | number)[] {
  const segments: (string | number)[] = [];
  const re = /([A-Za-z0-9_]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    segments.push(m[2] !== undefined ? Number(m[2]) : (m[1] as string));
  }
  return segments;
}

function resolvePath(root: unknown, path: string, sources: RecipeSources = {}): unknown {
  let current = root;
  let rest = path;
  const source = SOURCE_REF.exec(path);
  if (source !== null) {
    const name = source[1] as string;
    current = Object.prototype.hasOwnProperty.call(sources, name) ? sources[name] : undefined;
    rest = (source[2] ?? '').replace(/^\./, '');
  }
  for (const segment of parsePath(rest)) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (typeof current !== 'object' || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Templates — `{ selector }` or `{ selector | formatter:arg }`. Substitution only.
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{([^}]*)\}/g;

interface Placeholder {
  readonly path: string;
  readonly formatter?: string;
  readonly arg?: string;
}

/** Parse one placeholder body (`selector | fmt:arg`), or null if malformed. */
function parsePlaceholder(body: string): Placeholder | null {
  const parts = body.split('|');
  const path = (parts[0] ?? '').trim();
  if (!PATH.test(path)) return null;
  if (parts.length === 1) return { path };
  if (parts.length > 2) return null; // one formatter, not a chain — keep it blunt
  const fmt = (parts[1] ?? '').trim();
  const colon = fmt.indexOf(':');
  const name = colon === -1 ? fmt : fmt.slice(0, colon);
  const arg = colon === -1 ? undefined : fmt.slice(colon + 1);
  if (!(name in FORMATTERS)) return null;
  return { path: path, formatter: name, ...(arg !== undefined ? { arg } : {}) };
}

/** Every placeholder in a template is well-formed and names a known formatter. */
function templateIsValid(template: string): boolean {
  const matches = template.matchAll(PLACEHOLDER);
  for (const match of matches) {
    if (parsePlaceholder(match[1] ?? '') === null) return false;
  }
  return true;
}

function renderTemplate(template: string, scope: unknown, context: FormatContext, sources: RecipeSources = {}): string {
  return template.replace(PLACEHOLDER, (_whole, body: string) => {
    const parsed = parsePlaceholder(body);
    if (parsed === null) return '';
    const value = resolvePath(scope, parsed.path, sources);
    if (parsed.formatter === undefined) return asString(value);
    return FORMATTERS[parsed.formatter]!(value, parsed.arg, context);
  });
}

// ---------------------------------------------------------------------------
// The recipe schema
// ---------------------------------------------------------------------------

/** A template string: capped, and every formatter it names must exist. */
const tpl = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(templateIsValid, 'a template names an unknown formatter or a bad selector');

/*
 * A setting the household fills in (plan item M7.6): text, a number, a switch,
 * one of a list, or one of their Home Assistant readings. Each is drawn as its
 * own control on the install page and in a Module widget's settings, and each
 * value is kept as the string it substitutes into the address, so a recipe
 * written before the types existed reads exactly as it did.
 *
 * A Home Assistant reading substitutes the reading's *value* at fetch time and
 * never its entity id, so what leaves the house is the number the household
 * chose to send, and the address of nothing.
 */
const fieldBase = {
  key: z.string().min(1).max(40).regex(/^[a-z0-9_]+$/, 'lower-case, digits and underscore only'),
  label: z.string().min(1).max(60),
  /** A line under the control, for what the value means. */
  hint: z.string().min(1).max(160).optional(),
};
/** A number as a recipe writes it: plain decimal, no exponent, no spaces. */
const NUMBER_TEXT = /^-?\d+(\.\d+)?$/;
const OPTION_VALUE = /^[^{}]{1,80}$/;

const configField = z.preprocess(
  // `type` was optional when every field was text, and a recipe that leaves it
  // out still means text.
  (raw) =>
    raw !== null && typeof raw === 'object' && !('type' in raw) ? { ...(raw as object), type: 'string' } : raw,
  z
    .discriminatedUnion('type', [
      z.object({ ...fieldBase, type: z.literal('string'), default: z.string().max(280).optional() }).strict(),
      z
        .object({
          ...fieldBase,
          type: z.literal('number'),
          min: z.number().finite().optional(),
          max: z.number().finite().optional(),
          step: z.number().finite().positive().optional(),
          default: z.string().regex(NUMBER_TEXT, 'a number written plainly').optional(),
        })
        .strict(),
      z
        .object({ ...fieldBase, type: z.literal('boolean'), default: z.enum(['true', 'false']).optional() })
        .strict(),
      z
        .object({
          ...fieldBase,
          type: z.literal('select'),
          options: z
            .array(z.object({ value: z.string().regex(OPTION_VALUE, 'a value'), label: z.string().min(1).max(60) }).strict())
            .min(1)
            .max(20),
          default: z.string().max(80).optional(),
        })
        .strict(),
      z.object({ ...fieldBase, type: z.literal('ha_reading') }).strict(),
    ])
    .superRefine((field, ctx) => {
      if (field.type === 'number') {
        if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['max'], message: 'max is below min' });
        }
        if (field.default !== undefined && fieldValue(field, field.default) === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['default'], message: 'the default is outside min and max' });
        }
      }
      if (field.type === 'select') {
        const values = field.options.map((o) => o.value);
        if (new Set(values).size !== values.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'two options share a value' });
        }
        if (field.default !== undefined && !values.includes(field.default)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['default'], message: 'the default is not one of the options' });
        }
      }
    }),
);

export type ConfigField = z.infer<typeof configField>;

/** An entity id, as Home Assistant writes one. */
const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;

/**
 * A value for a setting, as the string it substitutes, or `undefined` when it
 * is not one this field takes. Refused rather than coerced (rule five): "12.0"
 * stays "12.0", a number out of its range is no value, and a choice not on the
 * list is no choice. Text is the one type that takes anything under its cap,
 * which is what a text field always took.
 */
export function fieldValue(field: ConfigField, raw: string): string | undefined {
  switch (field.type) {
    case 'string':
      return raw.length <= 280 ? raw : undefined;
    case 'number': {
      if (!NUMBER_TEXT.test(raw)) return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) return undefined;
      if (field.min !== undefined && n < field.min) return undefined;
      if (field.max !== undefined && n > field.max) return undefined;
      return raw;
    }
    case 'boolean':
      return raw === 'true' || raw === 'false' ? raw : undefined;
    case 'select':
      return field.options.some((o) => o.value === raw) ? raw : undefined;
    case 'ha_reading':
      return ENTITY_ID.test(raw) ? raw : undefined;
  }
}

/** The fields whose value is a Home Assistant reading's, read at fetch time. */
export function readingFields(recipe: Recipe): string[] {
  return recipe.config.filter((f) => f.type === 'ha_reading').map((f) => f.key);
}

/*
 * Choosing which rows of an array a panel draws (plan item M7.7): keep the
 * rows every condition holds for, put them in an order, and take the first so
 * many. Each condition is a path and at most one comparison against a literal,
 * and the conditions are all required — there is no "or", no arithmetic and
 * nothing nested, because the moment a filter can say `a > b + 1` a recipe is
 * code again. A path is the same selector a template uses, so `price > 3` or
 * `a + b` is refused by the selector's own pattern at parse, not at fetch.
 */
const selector = z.string().regex(PATH, 'a selector path');
const literal = z.union([z.string().max(200), z.number().finite(), z.boolean()]);
const condition = z.union([
  selector,
  z.object({ path: selector, equals: literal }).strict(),
  z.object({ path: selector, notEquals: literal }).strict(),
  z.object({ path: selector, above: z.number().finite() }).strict(),
  z.object({ path: selector, below: z.number().finite() }).strict(),
]);
const whereSpec = z.array(condition).min(1).max(4);
const sortSpec = z
  .object({
    by: selector,
    order: z.enum(['asc', 'desc']).default('asc'),
    /** How the values compare; absent, numbers when every value is one and text otherwise. */
    as: z.enum(['number', 'text', 'time']).optional(),
  })
  .strict();
const limitSpec = z.number().int().min(1).max(12);

/*
 * What a row is doing, from what its feed says (plan item M7.8): the value at
 * `from`, looked up in `map`, is one of the three tones a row may carry, and
 * `default` is the tone of a value the map does not name. A value neither
 * names is a row with no tone, which is the plain row. A lookup and not a
 * comparison, for the reason a condition is one: `on → active` is a table, and
 * a table cannot become code.
 */
const toneWord = z.enum(['active', 'alert', 'idle']);
const LOOKUP_KEY = z.string().max(80);
const toneSpec = z
  .object({
    from: selector,
    map: z
      .record(LOOKUP_KEY, toneWord)
      .refine((map) => Object.keys(map).length >= 1 && Object.keys(map).length <= 30, {
        message: 'a tone map names from 1 to 30 values',
      }),
    default: toneWord.optional(),
  })
  .strict();

const itemsSpec = z
  .object({
    for: selector,
    label: tpl(120),
    value: tpl(120),
    icon: tpl(8).optional(),
    tone: toneSpec.optional(),
    where: whereSpec.optional(),
    sort: sortSpec.optional(),
    limit: limitSpec.optional(),
    empty: tpl(120).optional(),
  })
  .strict();

/* A timeline is always in time order, so it takes no `sort` of its own. */
const timelineSpec = z
  .object({
    for: selector,
    at: tpl(120),
    label: tpl(120),
    detail: tpl(120).optional(),
    tone: toneSpec.optional(),
    where: whereSpec.optional(),
    limit: limitSpec.optional(),
    empty: tpl(120).optional(),
  })
  .strict();

const panelSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stat'), title: tpl(120).optional(), value: tpl(120), caption: tpl(120).optional() }).strict(),
  z.object({ kind: z.literal('text'), title: tpl(120).optional(), text: tpl(320) }).strict(),
  z.object({ kind: z.literal('readings'), title: tpl(120).optional(), items: itemsSpec }).strict(),
  z.object({ kind: z.literal('tiles'), title: tpl(120).optional(), items: itemsSpec }).strict(),
  // Contract 2's QR code, countdown, timeline and picture (plan item M7.5).
  z.object({ kind: z.literal('qr'), title: tpl(120).optional(), text: tpl(320), label: tpl(120).optional() }).strict(),
  z.object({ kind: z.literal('countdown'), title: tpl(120).optional(), label: tpl(120), at: tpl(120) }).strict(),
  z.object({ kind: z.literal('timeline'), title: tpl(120).optional(), items: timelineSpec }).strict(),
  z.object({ kind: z.literal('image'), title: tpl(120).optional(), url: tpl(400), caption: tpl(120).optional() }).strict(),
]);

/**
 * `when` — the one predicate a recipe signal is allowed, kept deliberately
 * blunt. Two forms, and no more:
 *   - a selector path, which fires when the value there is *truthy*;
 *   - `{ path, equals }`, which fires when the value there equals a literal.
 * The moment this grows `and`/`or` and parentheses, a recipe is code again — so
 * it does not. "Compare to a config value" and the like are for later, if ever.
 */
const whenSpec = z.union([
  selector,
  z.object({ path: selector, equals: z.string().max(200) }).strict(),
]);

/**
 * A signal a recipe can raise. It reads the *same* fetched body the panel does,
 * and what it produces is validated against the very `signalDataSchema` a
 * service module's `/signals` answers with — so everything downstream is the
 * Phase 2b machinery, unchanged: the signal is stamped `source: ext:<id>`, does
 * nothing until the household arms the module's Alerts control, and is
 * dismissible and source-scoped like any other.
 *
 * `severity` is a literal the author declares, not a value pulled from the feed:
 * mapping a stranger's severity words onto CAP levels is fuzzy, and the author
 * knows what their own signal means. `key` and `title` are templates.
 */
const signalSpec = z
  .object({
    when: whenSpec,
    key: tpl(120),
    title: tpl(80),
    severity: z.enum(['Minor', 'Moderate', 'Severe', 'Extreme']).optional(),
  })
  .strict();

/** A credential the household supplies at install: never defaulted, never shown. */
const secretField = z
  .object({
    key: z.string().min(1).max(40).regex(/^[a-z0-9_]+$/, 'lower-case, digits and underscore only'),
    label: z.string().min(1).max(60),
  })
  .strict();

/** A request header name — a plain HTTP token, no separators. */
const headerName = z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/, 'a header name');
/** A header value template: `{config}` and `{secret:key}` substitution, no formatters. */
const headerValue = z.string().min(1).max(512);

/** A placeholder in a header: `secret:key` names a secret, anything else a config key. */
const SECRET_REF = /^secret:([a-z0-9_]+)$/;

/** What a request answers with (plan item M7.9). */
const sourceFormat = z.enum(['json', 'feed', 'xml']);

const fetchSpec = z
  .object({
    // May carry {config_key} placeholders, substituted before the request.
    // Secrets are NOT allowed here — a URL is logged and stored; a credential in
    // a query string is a credential leaked. Secrets go in headers only.
    url: z.string().min(1).max(2048),
    intervalSeconds: z.number().int().min(60).max(86_400).default(900),
    /**
     * Off by default: a recipe reaches the public internet over https only.
     * Turning it on lets the fetch reach the LAN, loopback and plain http — for
     * a recipe pointed at a service the household runs. In B1 the household adds
     * a recipe by pasting its manifest, so setting this is itself their explicit
     * act; the catalogue-install grant tick is Phase A2.
     */
    allowLan: z.boolean().default(false),
    /**
     * Request headers, each a template of `{config}` and `{secret:key}`. This is
     * where a credential goes — injected server-side at fetch time, never in the
     * manifest or the stored URL.
     */
    headers: z.record(headerName, headerValue).optional(),
    /** What the address answers with (plan item M7.9): JSON, a news feed, or any XML. */
    format: sourceFormat.default('json'),
  })
  .strict();

/*
 * A further request a recipe makes (plan item M7.7), named so its body can be
 * reached as `@name`. Its own address and headers, built from the same
 * settings and secrets the main fetch's are; the interval and the network
 * switch are the main fetch's, so a recipe asks for the LAN once and is polled
 * as one thing. At most three, so one recipe is at most four requests.
 */
const sourceName = z.string().regex(/^[a-z][a-z0-9_]{0,19}$/, 'a lower-case name');
const networkSource = z
  .object({
    url: z.string().min(1).max(2048),
    headers: z.record(headerName, headerValue).optional(),
    format: sourceFormat.default('json'),
  })
  .strict();
/*
 * A source that is the house rather than an address (plan item M7.9): the Home
 * Assistant readings the household picked in the recipe's `ha_reading`
 * settings, read from what the house last told us. A recipe names settings,
 * never entities — which reading is the household's choice — and the body it
 * reaches is values only: no entity id is ever in it.
 */
const MAX_HOUSE_READINGS = 8;
const houseSource = z
  .object({
    ha: z.array(z.string().min(1).max(40)).min(1).max(MAX_HOUSE_READINGS),
  })
  .strict();
const sourceSpec = z.union([networkSource, houseSource]);
const MAX_SOURCES = 3;

type NetworkSource = z.infer<typeof networkSource>;
type HouseSource = z.infer<typeof houseSource>;
export function isHouseSource(source: NetworkSource | HouseSource): source is HouseSource {
  return 'ha' in source;
}

/*
 * A recipe's lookup tables (plan item M7.8), each a value's words: `map:name`
 * in a template turns `on` into "Running". Up to eight tables of up to fifty
 * entries; `*` is the entry for a value the table does not name. Words, never
 * templates — a table cannot reach into the feed.
 */
const lookupName = z.string().regex(/^[a-z][a-z0-9_]{0,19}$/, 'a lower-case name');
const lookupTable = z
  .record(LOOKUP_KEY, z.string().max(120))
  .refine((table) => Object.keys(table).length >= 1 && Object.keys(table).length <= 50, {
    message: 'a lookup table names from 1 to 50 values',
  });
const MAX_LOOKUPS = 8;

/** Every placeholder's formatter and argument in a recipe's panel and signals. */
function placeholderFormats(value: unknown): Placeholder[] {
  if (typeof value === 'string') {
    const out: Placeholder[] = [];
    for (const match of value.matchAll(PLACEHOLDER)) {
      const parsed = parsePlaceholder(match[1] ?? '');
      if (parsed !== null && parsed.formatter !== undefined) out.push(parsed);
    }
    return out;
  }
  if (Array.isArray(value)) return value.flatMap(placeholderFormats);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(placeholderFormats);
  return [];
}

/** Every selector path a recipe's panel and signals use: the `for`s, the conditions, the sort keys and every placeholder. */
function selectorPaths(value: unknown, key = ''): string[] {
  if (typeof value === 'string') {
    if (key === 'for' || key === 'path' || key === 'by') return [value];
    if (key === 'when' || key === 'where') return [value];
    const out: string[] = [];
    for (const match of value.matchAll(PLACEHOLDER)) {
      const parsed = parsePlaceholder(match[1] ?? '');
      if (parsed !== null) out.push(parsed.path);
    }
    return out;
  }
  if (Array.isArray(value)) return value.flatMap((entry) => selectorPaths(entry, key));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => selectorPaths(v, k));
  }
  return [];
}

export const recipeSchema = z
  .object({
    name: z.string().min(1).max(60),
    contract: z.literal(1),
    config: z.array(configField).max(8).default([]),
    secrets: z.array(secretField).max(8).default([]),
    fetch: fetchSpec,
    sources: z
      .record(sourceName, sourceSpec)
      .refine((sources) => Object.keys(sources).length <= MAX_SOURCES, {
        message: `a recipe has at most ${MAX_SOURCES} more sources`,
      })
      .optional(),
    lookups: z
      .record(lookupName, lookupTable)
      .refine((lookups) => Object.keys(lookups).length <= MAX_LOOKUPS, {
        message: `a recipe has at most ${MAX_LOOKUPS} lookup tables`,
      })
      .optional(),
    panel: panelSpec,
    // Optional. A panel-only recipe omits it; the cap matches signalDataSchema.
    signals: z.array(signalSpec).max(12).default([]),
  })
  .strict()
  .superRefine((recipe, ctx) => {
    const config = new Set(recipe.config.map((f) => f.key));
    const secrets = new Set(recipe.secrets.map((f) => f.key));

    // Every request — the main fetch and each named source — is checked the
    // same way.
    const requests: [readonly (string | number)[], { url: string; headers?: Record<string, string> | undefined }][] = [
      [['fetch'], recipe.fetch],
      ...Object.entries(recipe.sources ?? {}).flatMap(([name, source]) =>
        isHouseSource(source) ? [] : [[['sources', name], source] as [readonly (string | number)[], NetworkSource]],
      ),
    ];
    for (const [at, request] of requests) {
      // Every `{placeholder}` in an address must name a declared config key —
      // the address is built before there is any fetched data to reference,
      // and a secret may never appear in it.
      for (const match of request.url.matchAll(PLACEHOLDER)) {
        const key = (match[1] ?? '').trim();
        if (SECRET_REF.test(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...at, 'url'],
            message: 'a secret may not appear in the address — put it in a header',
          });
        } else if (!config.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...at, 'url'],
            message: `the URL references {${key}}, which is not a config field`,
          });
        }
      }

      // Every `{placeholder}` in a header must name a declared secret or config key.
      for (const [name, template] of Object.entries(request.headers ?? {})) {
        for (const match of template.matchAll(PLACEHOLDER)) {
          const body = (match[1] ?? '').trim();
          const secret = SECRET_REF.exec(body);
          if (secret !== null) {
            if (!secrets.has(secret[1] as string)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...at, 'headers', name],
                message: `references {secret:${secret[1]}}, which is not a declared secret`,
              });
            }
          } else if (!config.has(body)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...at, 'headers', name],
              message: `references {${body}}, which is not a config field`,
            });
          }
        }
      }
    }

    // A house source names the recipe's own `ha_reading` settings, and nothing
    // else: an entity id typed into a recipe is a stranger choosing which of
    // the household's things to read.
    const readings = new Set(recipe.config.filter((f) => f.type === 'ha_reading').map((f) => f.key));
    for (const [name, source] of Object.entries(recipe.sources ?? {})) {
      if (!isHouseSource(source)) continue;
      for (const key of source.ha) {
        if (!readings.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['sources', name, 'ha'],
            message: `names “${key}”, which is not a Home Assistant reading setting`,
          });
        }
      }
    }

    // Every `@name` a selector reaches for is a source the recipe declares: a
    // panel that would draw from nothing is a rejected recipe, not an empty one.
    const declared = new Set(Object.keys(recipe.sources ?? {}));
    for (const path of selectorPaths({ panel: recipe.panel, signals: recipe.signals })) {
      const source = SOURCE_REF.exec(path);
      if (source !== null && !declared.has(source[1] as string)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources'],
          message: `a selector reaches for @${source[1]}, which is not a declared source`,
        });
      }
    }

    // Every `map:` names a table the recipe declares (plan item M7.8): a lookup
    // into nothing is a rejected recipe, not a value said as itself for ever.
    const tables = new Set(Object.keys(recipe.lookups ?? {}));
    for (const placeholder of placeholderFormats({ panel: recipe.panel, signals: recipe.signals })) {
      if (placeholder.formatter === 'map' && (placeholder.arg === undefined || !tables.has(placeholder.arg))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lookups'],
          message: `a template looks up “${placeholder.arg ?? ''}”, which is not a declared lookup table`,
        });
      }
    }
  });

export type Recipe = z.infer<typeof recipeSchema>;
export type RecipeConfig = Record<string, string>;
export type RecipeSecrets = Record<string, string>;

// ---------------------------------------------------------------------------
// Running a recipe
// ---------------------------------------------------------------------------

/** Substitute `{config_key}` in the fetch URL. Config only — there is no data yet. */
export function resolveFetchUrl(recipe: Recipe, config: RecipeConfig): string {
  return resolveUrl(recipe.fetch.url, config);
}

function resolveUrl(template: string, config: RecipeConfig): string {
  return template.replace(PLACEHOLDER, (_whole, key: string) => encodeURIComponent(config[key.trim()] ?? ''));
}

/** A named source's request (plan item M7.7): its address and headers, built as the main fetch's are. */
export interface SourceRequest {
  readonly name: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly format: SourceFormat;
}

/** Every named source that is an address, its request in the recipe's own order. */
export function resolveSources(recipe: Recipe, config: RecipeConfig, secrets: RecipeSecrets): SourceRequest[] {
  return Object.entries(recipe.sources ?? {}).flatMap(([name, source]) =>
    isHouseSource(source)
      ? []
      : [
          {
            name,
            url: resolveUrl(source.url, config),
            headers: headersFrom(source.headers, config, secrets),
            format: source.format,
          },
        ],
  );
}

/** A house source's readings (plan item M7.9): the entity each named setting picked, in the recipe's order. */
export interface HouseRequest {
  readonly name: string;
  readonly readings: readonly { readonly key: string; readonly entityId: string }[];
}

/**
 * Every house source and the entities its settings name. Read from the
 * settings as stored — entity ids — and never from settings whose readings
 * have already been turned into values for an address.
 */
export function houseRequests(recipe: Recipe, config: RecipeConfig): HouseRequest[] {
  return Object.entries(recipe.sources ?? {}).flatMap(([name, source]) =>
    isHouseSource(source)
      ? [{ name, readings: source.ha.map((key) => ({ key, entityId: config[key] ?? '' })) }]
      : [],
  );
}

/** What the house says about one reading, as a house source's body carries it: values, never its id. */
export interface HouseValue {
  readonly name?: string;
  readonly state?: string;
  readonly unit?: string;
  readonly changed?: string;
}

/**
 * A house source's body: one row per setting, in the recipe's order, so
 * `@house[0].state` is the first and `for: "@house"` draws them all. A setting
 * left empty, or naming a reading the household no longer watches, is a row
 * with its key and nothing else, so a `where` can leave it out.
 */
export function houseBody(request: HouseRequest, valueOf: (entityId: string) => HouseValue | undefined): unknown[] {
  return request.readings.map(({ key, entityId }) => ({
    key,
    ...(entityId === '' ? {} : (valueOf(entityId) ?? {})),
  }));
}

/**
 * Build the request headers, injecting config and decrypted secrets.
 *
 * The one place a credential enters a request, and it happens here, server-side,
 * at fetch time — never in the manifest, never in the stored URL, never on the
 * wall. A missing secret resolves to empty rather than leaking the placeholder.
 */
export function resolveHeaders(
  recipe: Recipe,
  config: RecipeConfig,
  secrets: RecipeSecrets,
): Record<string, string> {
  return headersFrom(recipe.fetch.headers, config, secrets);
}

function headersFrom(
  templates: Record<string, string> | undefined,
  config: RecipeConfig,
  secrets: RecipeSecrets,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(templates ?? {})) {
    out[name] = template.replace(PLACEHOLDER, (_whole, body: string) => {
      const trimmed = body.trim();
      const secret = SECRET_REF.exec(trimmed);
      if (secret !== null) return secrets[secret[1] as string] ?? '';
      return config[trimmed] ?? '';
    });
  }
  return out;
}

/** The host a recipe's fetch (and any secret in a header) is sent to, for the install page. */
export function recipeFetchHost(recipe: Recipe): string {
  // Every host a recipe asks, its sources' too (plan item M7.7): the install
  // page names where a setting or a secret goes, and that is all of them.
  const hosts: string[] = [];
  const addresses = Object.values(recipe.sources ?? {}).flatMap((source) => (isHouseSource(source) ? [] : [source.url]));
  for (const url of [recipe.fetch.url, ...addresses]) {
    let host: string;
    try {
      // Placeholders stand in as a dummy so the URL parses; only the host matters.
      host = new URL(url.replace(PLACEHOLDER, 'x')).host;
    } catch {
      host = 'the recipe’s address';
    }
    if (!hosts.includes(host)) hosts.push(host);
  }
  if (hosts.length === 1) return hosts[0] as string;
  return `${hosts.slice(0, -1).join(', ')} and ${hosts[hosts.length - 1] as string}`;
}

/** The SSRF policy for a recipe: public https only, unless it opts into the LAN. */
export function recipePolicy(recipe: Recipe): {
  allowHttp: boolean;
  allowPrivateNetwork: boolean;
  allowLoopback: boolean;
} {
  const lan = recipe.fetch.allowLan;
  return { allowHttp: lan, allowPrivateNetwork: lan, allowLoopback: lan };
}

/** Build the Panel Data a recipe describes from the fetched JSON. */
/** The most rows of a source's array a recipe looks at: enough for any real list, and a bound on the work. */
const MAX_ROWS_READ = 500;

/** Does one `where` condition hold for a row? A value that is missing fails every comparison. */
type Condition = z.infer<typeof condition>;
function conditionHolds(
  condition: Condition,
  row: unknown,
  sources: RecipeSources,
): boolean {
  if (typeof condition === 'string') return truthy(resolvePath(row, condition, sources));
  const value = resolvePath(row, condition.path, sources);
  if ('equals' in condition) return value !== undefined && asString(value) === String(condition.equals);
  if ('notEquals' in condition) return asString(value) !== String(condition.notEquals);
  const n = asNumber(value);
  if (n === undefined) return false;
  return 'above' in condition ? n > condition.above : n < condition.below;
}

/**
 * The rows of an array a panel draws (plan item M7.7): those every `where`
 * condition holds for, in `sort`'s order, the first `limit` of them. Sorting
 * keeps rows with no value for the key at the end whichever way it runs, and
 * is stable, so rows the key cannot tell apart keep the source's own order.
 */
function selectRows(
  spec: { for: string; where?: z.infer<typeof whereSpec> | undefined; sort?: z.infer<typeof sortSpec> | undefined },
  root: unknown,
  sources: RecipeSources,
): unknown[] | undefined {
  const selected = resolvePath(root, spec.for, sources);
  // Not an array at all is a feed that has changed shape, not one that has
  // nothing to say: the read fails, and the wall keeps its last good panel.
  // One element of an XML document is a list of one (plan item M7.9): a feed
  // with one item has not changed shape.
  const list = isXmlElement(selected) ? [selected] : selected;
  if (!Array.isArray(list)) return undefined;
  let rows = list.slice(0, MAX_ROWS_READ);
  const where = spec.where;
  if (where !== undefined) rows = rows.filter((row) => where.every((one) => conditionHolds(one, row, sources)));
  const sort = spec.sort;
  if (sort !== undefined) {
    const raw = rows.map((row) => resolvePath(row, sort.by, sources));
    const as = sort.as ?? (raw.every((v) => v === undefined || v === null || asNumber(v) !== undefined) ? 'number' : 'text');
    const key = (v: unknown): number | string | undefined =>
      v === undefined || v === null
        ? undefined
        : as === 'number'
          ? asNumber(v)
          : as === 'time'
            ? toEpochMs(v)
            : asString(v).toLowerCase();
    const keyed = rows.map((row, i) => ({ row, key: key(raw[i]) }));
    const sign = sort.order === 'desc' ? -1 : 1;
    keyed.sort((a, b) => {
      if (a.key === undefined || b.key === undefined) return a.key === b.key ? 0 : a.key === undefined ? 1 : -1;
      if (typeof a.key === 'number' && typeof b.key === 'number') return sign * (a.key - b.key);
      return sign * String(a.key).localeCompare(String(b.key));
    });
    rows = keyed.map((entry) => entry.row);
  }
  return rows;
}

/** What a list says when its conditions leave no rows, unless the recipe says otherwise. */
const NOTHING_TO_SHOW = 'Nothing to show.';

/** The context a recipe's formatters run in: its own tables, and the household's clock and zone. */
function formatContext(recipe: Recipe, now: number, timezone: string): FormatContext {
  return { now, timezone, lookups: recipe.lookups ?? {} };
}

/** A row's tone from its feed (plan item M7.8), or none. */
function toneOf(spec: z.infer<typeof toneSpec> | undefined, row: unknown, sources: RecipeSources): { tone?: string } {
  if (spec === undefined) return {};
  const key = asString(resolvePath(row, spec.from, sources));
  const tone = Object.prototype.hasOwnProperty.call(spec.map, key) ? spec.map[key] : spec.default;
  return tone === undefined ? {} : { tone };
}

function buildPanel(recipe: Recipe, root: unknown, context: FormatContext, sources: RecipeSources): unknown {
  const r = (template: string, scope: unknown = root): string => renderTemplate(template, scope, context, sources);
  const spec = recipe.panel;
  const title = 'title' in spec && spec.title !== undefined ? { title: r(spec.title) } : {};
  /*
   * A list that is empty, or that its conditions leave empty, is a true
   * answer — no disruptions, no trains — and says so in words (plan item
   * M7.7). One whose selector finds no array at all is not: that is refused. Built as a list of nothing
   * it would be refused, and the wall would go on drawing the last rows it had
   * as though they were still so.
   */
  const nothing = (empty: string | undefined): unknown => {
    const words = empty === undefined ? '' : r(empty);
    return { kind: 'text', ...title, text: words === '' ? NOTHING_TO_SHOW : words };
  };

  if (spec.kind === 'stat') {
    return {
      kind: 'stat',
      ...title,
      value: r(spec.value),
      ...(spec.caption !== undefined ? { caption: r(spec.caption) } : {}),
    };
  }
  if (spec.kind === 'text') {
    return { kind: 'text', ...title, text: r(spec.text) };
  }
  if (spec.kind === 'qr') {
    return { kind: 'qr', ...title, text: r(spec.text), ...(spec.label !== undefined ? { label: r(spec.label) } : {}) };
  }
  if (spec.kind === 'countdown') {
    return { kind: 'countdown', ...title, label: r(spec.label), at: r(spec.at) };
  }
  if (spec.kind === 'image') {
    return { kind: 'image', ...title, url: r(spec.url), ...(spec.caption !== undefined ? { caption: r(spec.caption) } : {}) };
  }
  if (spec.kind === 'timeline') {
    const chosen = selectRows(spec.items, root, sources);
    if (chosen === undefined) return { kind: 'timeline', ...title, items: [] };
    if (chosen.length === 0) return nothing(spec.items.empty);
    const items = chosen.map((element) => {
      const detail = spec.items.detail === undefined ? '' : r(spec.items.detail, element);
      return {
        at: r(spec.items.at, element),
        label: r(spec.items.label, element),
        ...(detail !== '' ? { detail } : {}),
        ...toneOf(spec.items.tone, element, sources),
      };
    });
    // A source's list is in whatever order it keeps; the panel a timeline is
    // validated as wants time order, so the recipe — our code, not the
    // module's — puts it there. A time that does not parse sorts last and is
    // refused by the schema with the recipe's error.
    const time = (at: string): number => {
      const ms = Date.parse(at);
      return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
    };
    items.sort((a, b) => time(a.at) - time(b.at));
    // The limit after the order, so "the next five" is the next five.
    return { kind: 'timeline', ...title, items: items.slice(0, Math.min(12, spec.items.limit ?? 12)) };
  }
  // readings | tiles: map the selected array to rows.
  const chosen = selectRows(spec.items, root, sources);
  if (chosen === undefined) return { kind: spec.kind, ...title, items: [] };
  const rows = chosen.slice(0, Math.min(12, spec.items.limit ?? 12));
  if (rows.length === 0) return nothing(spec.items.empty);
  const items = rows.map((element) => ({
    label: r(spec.items.label, element),
    value: r(spec.items.value, element),
    ...(spec.items.icon !== undefined ? { icon: r(spec.items.icon, element) } : {}),
    ...toneOf(spec.items.tone, element, sources),
  }));
  return { kind: spec.kind, ...title, items };
}

/**
 * Up to three of a schema's complaints as `where: why` lines, for a recipe's
 * author (plan item M7.10). Paths and the schema's own messages only: the
 * values that failed are the feed's, and a feed's words are not a tool's to
 * repeat.
 */
export function describeIssues(issues: readonly z.ZodIssue[], prefix: string): string {
  const lines = issues.slice(0, 3).map((issue) => {
    const where = [prefix, ...issue.path.map(String)].filter((part) => part !== '').join('.');
    return `${where === '' ? '(top)' : where}: ${issue.message}`;
  });
  if (issues.length > 3) lines.push(`…and ${issues.length - 3} more`);
  return lines.join('\n');
}

/**
 * Run a recipe against a fetched body, and hand back Panel Data or a reason.
 *
 * The built panel is validated against the *same* `panelDataSchema` a service
 * module's body is — so a recipe that computes nonsense fails the identical
 * boundary, with a visible error, rather than drawing half a panel.
 */
export function runRecipePanel(
  recipe: Recipe,
  body: unknown,
  now: number,
  sources: RecipeSources = {},
  timezone: string = DEFAULT_TIMEZONE,
): { ok: true; panel: unknown } | { ok: false; error: string; detail: string } {
  const built = buildPanel(recipe, body, formatContext(recipe, now, timezone), sources);
  const parsed = panelDataSchema.safeParse(built);
  if (!parsed.success) {
    // `error` is what the module's card says, for a household; `detail` is
    // what the tooling says, for whoever wrote the recipe (plan item M7.10):
    // where in the built panel it went wrong and why, never a value.
    return {
      ok: false,
      error: 'The recipe produced something the wall cannot draw.',
      detail: describeIssues(parsed.error.issues, 'panel'),
    };
  }
  return { ok: true, panel: parsed.data };
}

/** JS-ish truthiness on a selected value: null/undefined/false/0/'' are false. */
function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false && value !== 0 && value !== '';
}

/** Does a recipe signal's `when` predicate hold against the fetched body? */
function whenHolds(when: Recipe['signals'][number]['when'], body: unknown, sources: RecipeSources): boolean {
  if (typeof when === 'string') return truthy(resolvePath(body, when, sources));
  return asString(resolvePath(body, when.path, sources)) === when.equals;
}

/**
 * Evaluate a recipe's signals against the fetched body.
 *
 * Only the ones whose `when` holds are produced, and the result is validated
 * against the same `signalDataSchema` a service module answers with — so a
 * recipe cannot smuggle a malformed signal past the boundary any more than a
 * service can. From here it is entirely the Phase 2b path: source-scoped,
 * inert until armed, dismissible.
 */
export function runRecipeSignals(
  recipe: Recipe,
  body: unknown,
  now: number,
  sources: RecipeSources = {},
  timezone: string = DEFAULT_TIMEZONE,
): { ok: true; signals: unknown } | { ok: false; error: string; detail: string } {
  const context = formatContext(recipe, now, timezone);
  const built = recipe.signals
    .filter((spec) => whenHolds(spec.when, body, sources))
    .map((spec) => ({
      key: renderTemplate(spec.key, body, context, sources),
      title: renderTemplate(spec.title, body, context, sources),
      ...(spec.severity !== undefined ? { severity: spec.severity } : {}),
    }));
  const parsed = signalDataSchema.safeParse({ signals: built });
  if (!parsed.success) {
    return {
      ok: false,
      error: 'The recipe produced a signal the wall cannot use.',
      detail: describeIssues(parsed.error.issues, ''),
    };
  }
  return { ok: true, signals: parsed.data };
}

/**
 * Fill in any config defaults the household did not supply, and drop unknown
 * keys. A stored value this field does not take — a choice a newer recipe took
 * off its list, a number now out of range — is no value, and the default
 * stands in: what reaches the address is always one the recipe declared.
 */
export function normaliseConfig(recipe: Recipe, supplied: RecipeConfig): RecipeConfig {
  const config: RecipeConfig = {};
  for (const field of recipe.config) {
    const raw = supplied[field.key];
    const value = typeof raw === 'string' && raw !== '' ? fieldValue(field, raw) : undefined;
    config[field.key] = value ?? (field.type === 'ha_reading' ? '' : (field.default ?? ''));
  }
  return config;
}

/**
 * The install's settings with one widget's on top (plan item M7.6): what that
 * widget's fetch is built from. A widget's value that this field does not take
 * falls back to the install's, never to a stranger's default.
 */
export function widgetConfig(recipe: Recipe, install: RecipeConfig, settings: RecipeConfig): RecipeConfig {
  const base = normaliseConfig(recipe, install);
  const out: RecipeConfig = { ...base };
  for (const field of recipe.config) {
    const raw = settings[field.key];
    const value = typeof raw === 'string' && raw !== '' ? fieldValue(field, raw) : undefined;
    if (value !== undefined) out[field.key] = value;
  }
  return out;
}

/**
 * What a fetch is, for telling two of them apart (plan item M7.6): the
 * address and the headers, built from the settings, with every secret left as
 * its placeholder. Two widgets whose settings build the same request share one
 * fetch, whatever they called their settings; a secret is the install's own and
 * the same for both, so leaving it unresolved costs nothing and keeps it out of
 * a key that is held in memory beside the others.
 */
export function requestKey(recipe: Recipe, config: RecipeConfig): string {
  const placeholders: RecipeSecrets = {};
  for (const secret of recipe.secrets) placeholders[secret.key] = `{secret:${secret.key}}`;
  const headers = Object.entries(resolveHeaders(recipe, config, placeholders)).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const sorted = (h: Record<string, string>): [string, string][] =>
    Object.entries(h).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // A recipe's sources are part of what it asks (plan item M7.7): two widgets
  // share a fetch only when every one of its requests is the same.
  const sources = resolveSources(recipe, config, placeholders).map((source) => [source.name, source.url, sorted(source.headers)]);
  return JSON.stringify(sources.length === 0 ? [resolveFetchUrl(recipe, config), headers] : [resolveFetchUrl(recipe, config), headers, sources]);
}

/**
 * The settings with each Home Assistant reading's value in place of its entity
 * id, read from what the house last told us. A reading the cache does not have
 * is empty, which is what an unfilled text field has always sent.
 */
export function withReadingValues(
  recipe: Recipe,
  config: RecipeConfig,
  valueOf: (entityId: string) => string | undefined,
): RecipeConfig {
  const keys = readingFields(recipe);
  if (keys.length === 0) return config;
  const out: RecipeConfig = { ...config };
  for (const key of keys) {
    const entity = out[key] ?? '';
    out[key] = entity === '' ? '' : (valueOf(entity) ?? '');
  }
  return out;
}
