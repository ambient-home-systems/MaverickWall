import { z } from 'zod';

/**
 * Rule five, made real: Zod at every boundary. Reject, do not coerce.
 *
 * A boundary is anywhere a value arrives from outside this process — a form
 * somebody filled in, a JSON document from somebody else's server, a column
 * that has been sitting in SQLite since a version of this code nobody has any
 * more. Everything past a boundary is typed and trusted; everything at one is
 * neither.
 *
 * ## Why this file exists rather than `z.parse` at each call site
 *
 * **Nothing here ever throws.** `safeParse`, always. A validation failure at a
 * boundary is an ordinary outcome — a household mistyping a latitude, a
 * provider renaming a field — and the wall has to keep drawing through all of
 * them. `parse()` would turn a bad forecast into an exception inside manifest
 * assembly, which is the one path rule nine forbids from failing.
 *
 * **The messages are written for a kitchen.** Zod's own are for developers:
 * "Invalid input: expected string, received undefined" tells a person nothing
 * about what to type. Every schema below carries its own wording, and
 * `firstProblem` picks the one message worth showing rather than a list.
 *
 * ## Where it deliberately is not
 *
 * `packages/core` and `packages/calendar` — rule one. They import no vendor
 * library at all, so their boundaries stay hand-written and their inputs are
 * validated here, on the way in. That is not an exception to rule five; it is
 * where rule one wins, and the validation still happens, one layer out.
 */

export type { ZodType } from 'zod';

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  /** Never an exception, and never a developer's sentence. */
  | { readonly ok: false; readonly message: string; readonly suggestion?: string };

/**
 * The one message worth showing.
 *
 * A form with four problems is still a person who will fix one thing and press
 * the button again, so a list is noise. The first issue in field order is the
 * one nearest the top of the page, which is where they are looking.
 */
function firstProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'That did not look right.';
  return issue.message;
}

/** Validate, and never throw. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): Parsed<T> {
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, message: firstProblem(result.error) };
}

/**
 * Validate, and fall back rather than fail.
 *
 * For the boundaries where there is a sane empty answer and no-one to tell: a
 * forecast that will not parse is a missing panel, not an error page. The
 * caller says what "nothing" means for it.
 */
export function parseOr<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : fallback;
}

/** Parse a JSON string at a boundary. Bad JSON is a validation failure. */
export function parseJson<T>(schema: z.ZodType<T>, text: string): Parsed<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'That was not readable as JSON.' };
  }
  return parse(schema, raw);
}

export function parseJsonOr<T>(schema: z.ZodType<T>, text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return parseOr(schema, JSON.parse(text), fallback);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------
//
// `parseBody()` hands back `Record<string, string | File>`. Every one of these
// starts from `unknown` and states its own wording, because the person reading
// the failure is standing at a screen rather than at a terminal.

/** A required text field, trimmed. */
export const text = (label: string, max = 200): z.ZodType<string> =>
  z
    .string({ error: () => `${label} is required.` })
    .transform((value) => value.trim())
    .refine((value) => value !== '', { error: () => `${label} is required.` })
    .refine((value) => value.length <= max, {
      error: () => `${label} is longer than ${max} characters.`,
    });

/** An optional text field. Empty and absent both mean absent. */
export const optionalText = (max = 200) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined),
    z
      .string()
      .max(max, { error: () => `That is longer than ${max} characters.` })
      .optional(),
  );

/**
 * An HTML checkbox.
 *
 * Present means ticked, absent means not — a browser sends nothing at all for
 * an unticked box, so `undefined` is a real answer rather than a missing one.
 */
export const checkbox = () =>
  /*
   * `preprocess`, for the same reason `blankIsAbsent` uses it, and here the
   * consequence is worse: a `.transform()` on `z.unknown()` makes the key
   * *required* in Zod 4, and an unticked checkbox is not sent at all. Every
   * form with a box left unticked would have been refused — which is most
   * submissions of most forms in this application.
   */
  z.preprocess((value) => typeof value === 'string' && value !== '', z.boolean());

/** A whole number inside a range, stated in the words of the thing it counts. */
export const bounded = (label: string, low: number, high: number): z.ZodType<number> =>
  z
    .unknown()
    .refine((value) => typeof value === 'string' && /^[0-9]+$/.test(value), {
      error: () => `${label} has to be a whole number.`,
    })
    .transform((value) => Number(value))
    .refine((value) => value >= low && value <= high, {
      error: () => `${label} has to be between ${low} and ${high}.`,
    });

/** `HH:MM`, 24 hour. */
export const hhmm = (label: string): z.ZodType<string> =>
  z
    .unknown()
    .refine((value) => typeof value === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value), {
      error: () => `${label} has to be a time like 07:00.`,
    })
    .transform((value) => value as string);

/** What `<input type="color">` submits. */
export const colour = (): z.ZodType<string> =>
  z
    .unknown()
    .refine((value) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value), {
      error: () => 'Pick a colour from the swatch.',
    })
    .transform((value) => value as string);

/**
 * A latitude or longitude.
 *
 * Bounded rather than merely numeric: a longitude of 400 is not a place, and a
 * forecast provider given one answers something unhelpful rather than nothing.
 */
export const coordinate = (label: string, limit: number): z.ZodType<number> =>
  z
    .unknown()
    .refine((value) => typeof value === 'string' && /^-?\d{1,3}(\.\d+)?$/.test(value), {
      error: () => `${label} has to be a number.`,
    })
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && Math.abs(value) <= limit, {
      error: () => `${label} has to be between -${limit} and ${limit}.`,
    });

/**
 * A string that may be there, may be absent, and may be `""` — which means
 * absent.
 *
 * `z.string().min(1).optional()` looks like this and is not: an empty string
 * is present and fails the minimum, so the *whole surrounding object* fails to
 * parse. Home Assistant sends `"location": ""` on most calendar events, and
 * that one difference silently dropped every event it appeared on. Anything
 * reading a field somebody else populates wants this rather than `.optional()`.
 */
export const blankIsAbsent = () =>
  /*
   * `preprocess` rather than `.transform()`, and that is not style.
   *
   * A `.transform()` makes the key *required* in Zod 4 — so an object simply
   * missing the field fails to parse, which is the opposite of what this is
   * for. Preprocessing to `undefined` and validating an optional string keeps
   * "absent", "empty" and "whitespace" as the same answer, which is what
   * anybody reading a field somebody else populates actually means.
   */
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined),
    z.string().optional(),
  );

/** One of a fixed set, named in the failure so the list is discoverable. */
export const oneOf = <T extends string>(
  label: string,
  values: readonly [T, ...T[]],
): z.ZodType<T> =>
  z
    .unknown()
    .refine((value) => typeof value === 'string' && (values as readonly string[]).includes(value), {
      error: () => `Choose ${label} from the list.`,
    })
    .transform((value) => value as T);

/**
 * A base URL the household typed, made safe to boot with.
 *
 * `BASE_URL` — or the add-on's `base_url` option — is a boundary: somebody
 * types it, and a bare `192.168.1.33`, the obvious thing to type, is not a URL.
 * Better Auth rejects it and the process exits on its first line, which is
 * exactly the refusal-to-start rule nine forbids. So a value with no scheme
 * gets `http://`, and anything still unparseable falls back to the default
 * rather than crashing. The port stays the household's to get right: a missing
 * one is warned about, never invented, because only they know which host port
 * the add-on was mapped to.
 */
export function normalizeBaseUrl(
  raw: string | undefined,
  fallback: string,
): { readonly url: string; readonly warning?: string } {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { url: fallback };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { url: fallback, warning: `BASE_URL "${raw}" is not a valid address; using ${fallback}.` };
  }

  // Scheme and host only — a path or trailing slash would double up when the
  // setup and pairing links append their own.
  const url = `${parsed.protocol}//${parsed.host}`;
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  // Only `http` with no port is worth a word — that is the add-on case, where
  // the wall lives on a mapped host port and port 80 is almost never it. An
  // `https` host with no port means 443 behind a reverse proxy, which is a
  // deliberate setup, not a mistake.
  if (parsed.port === '' && parsed.protocol === 'http:' && !local) {
    return {
      url,
      warning:
        `BASE_URL "${url}" has no port. Wall displays reach the add-on on its ` +
        `mapped port — include it, e.g. http://${parsed.hostname}:8080.`,
    };
  }
  return { url };
}

export { z };
