import { z } from '../../validation.js';
import { panelDataSchema } from './panel-data.js';
import { signalDataSchema } from './signal-data.js';

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

/** A formatter turns a selected value into a string. First-party, total, pure. */
type Formatter = (value: unknown, arg: string | undefined, now: number) => string;

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
  date: (v, arg, now) => formatDate(v, arg, now),
  default: (v, arg) => {
    const s = asString(v);
    return s === '' ? arg ?? '' : s;
  },
};

/** `date:short` and `date:relative`. Server-side, so `Intl` is fine (rule one is core-only). */
function formatDate(value: unknown, arg: string | undefined, now: number): string {
  const ms = toEpochMs(value);
  if (ms === undefined) return asString(value);
  if (arg === 'relative') {
    const days = Math.round((ms - now) / 86_400_000);
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    return days > 0 ? `in ${days} days` : `${-days} days ago`;
  }
  // `short` (and the default): a plain calendar date.
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: ten-digit values are seconds, not milliseconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Selectors — dotted / indexed path resolution. Traversal only.
// ---------------------------------------------------------------------------

const PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+|\[\d+\])*$/;

function parsePath(path: string): (string | number)[] {
  const segments: (string | number)[] = [];
  const re = /([A-Za-z0-9_]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    segments.push(m[2] !== undefined ? Number(m[2]) : (m[1] as string));
  }
  return segments;
}

function resolvePath(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of parsePath(path)) {
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

function renderTemplate(template: string, scope: unknown, now: number): string {
  return template.replace(PLACEHOLDER, (_whole, body: string) => {
    const parsed = parsePlaceholder(body);
    if (parsed === null) return '';
    const value = resolvePath(scope, parsed.path);
    if (parsed.formatter === undefined) return asString(value);
    return FORMATTERS[parsed.formatter]!(value, parsed.arg, now);
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

const configField = z
  .object({
    key: z.string().min(1).max(40).regex(/^[a-z0-9_]+$/, 'lower-case, digits and underscore only'),
    label: z.string().min(1).max(60),
    type: z.literal('string').default('string'), // B1 config is text only
    default: z.string().max(280).optional(),
  })
  .strict();

const itemsSpec = z
  .object({
    for: z.string().regex(PATH, 'a selector path'),
    label: tpl(120),
    value: tpl(120),
    icon: tpl(8).optional(),
  })
  .strict();

const panelSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stat'), title: tpl(120).optional(), value: tpl(120), caption: tpl(120).optional() }).strict(),
  z.object({ kind: z.literal('text'), title: tpl(120).optional(), text: tpl(320) }).strict(),
  z.object({ kind: z.literal('readings'), title: tpl(120).optional(), items: itemsSpec }).strict(),
  z.object({ kind: z.literal('tiles'), title: tpl(120).optional(), items: itemsSpec }).strict(),
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
  z.string().regex(PATH, 'a selector path'),
  z.object({ path: z.string().regex(PATH, 'a selector path'), equals: z.string().max(200) }).strict(),
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

const fetchSpec = z
  .object({
    // May carry {config_key} placeholders, substituted before the request.
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
  })
  .strict();

export const recipeSchema = z
  .object({
    name: z.string().min(1).max(60),
    contract: z.literal(1),
    config: z.array(configField).max(8).default([]),
    fetch: fetchSpec,
    panel: panelSpec,
    // Optional. A panel-only recipe omits it; the cap matches signalDataSchema.
    signals: z.array(signalSpec).max(12).default([]),
  })
  .strict()
  .superRefine((recipe, ctx) => {
    // Every `{placeholder}` in the fetch URL must name a declared config key —
    // the URL is built before there is any fetched data to reference.
    const declared = new Set(recipe.config.map((f) => f.key));
    for (const match of recipe.fetch.url.matchAll(PLACEHOLDER)) {
      const key = (match[1] ?? '').trim();
      if (!declared.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fetch', 'url'],
          message: `the URL references {${key}}, which is not a config field`,
        });
      }
    }
  });

export type Recipe = z.infer<typeof recipeSchema>;
export type RecipeConfig = Record<string, string>;

// ---------------------------------------------------------------------------
// Running a recipe
// ---------------------------------------------------------------------------

/** Substitute `{config_key}` in the fetch URL. Config only — there is no data yet. */
export function resolveFetchUrl(recipe: Recipe, config: RecipeConfig): string {
  return recipe.fetch.url.replace(PLACEHOLDER, (_whole, key: string) =>
    encodeURIComponent(config[key.trim()] ?? ''),
  );
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
function buildPanel(recipe: Recipe, root: unknown, now: number): unknown {
  const r = (template: string, scope: unknown = root): string => renderTemplate(template, scope, now);
  const spec = recipe.panel;
  const title = 'title' in spec && spec.title !== undefined ? { title: r(spec.title) } : {};

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
  // readings | tiles: map the selected array to rows.
  const selected = resolvePath(root, spec.items.for);
  const array = Array.isArray(selected) ? selected : [];
  const items = array.slice(0, 12).map((element) => ({
    label: r(spec.items.label, element),
    value: r(spec.items.value, element),
    ...(spec.items.icon !== undefined ? { icon: r(spec.items.icon, element) } : {}),
  }));
  return { kind: spec.kind, ...title, items };
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
): { ok: true; panel: unknown } | { ok: false; error: string } {
  const built = buildPanel(recipe, body, now);
  const parsed = panelDataSchema.safeParse(built);
  if (!parsed.success) {
    return { ok: false, error: 'The recipe produced something the wall cannot draw.' };
  }
  return { ok: true, panel: parsed.data };
}

/** JS-ish truthiness on a selected value: null/undefined/false/0/'' are false. */
function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false && value !== 0 && value !== '';
}

/** Does a recipe signal's `when` predicate hold against the fetched body? */
function whenHolds(when: Recipe['signals'][number]['when'], body: unknown): boolean {
  if (typeof when === 'string') return truthy(resolvePath(body, when));
  return asString(resolvePath(body, when.path)) === when.equals;
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
): { ok: true; signals: unknown } | { ok: false; error: string } {
  const built = recipe.signals
    .filter((spec) => whenHolds(spec.when, body))
    .map((spec) => ({
      key: renderTemplate(spec.key, body, now),
      title: renderTemplate(spec.title, body, now),
      ...(spec.severity !== undefined ? { severity: spec.severity } : {}),
    }));
  const parsed = signalDataSchema.safeParse({ signals: built });
  if (!parsed.success) {
    return { ok: false, error: 'The recipe produced a signal the wall cannot use.' };
  }
  return { ok: true, signals: parsed.data };
}

/** Fill in any config defaults the household did not supply, and drop unknown keys. */
export function normaliseConfig(recipe: Recipe, supplied: RecipeConfig): RecipeConfig {
  const config: RecipeConfig = {};
  for (const field of recipe.config) {
    const value = supplied[field.key];
    config[field.key] = value !== undefined && value !== '' ? value : field.default ?? '';
  }
  return config;
}
