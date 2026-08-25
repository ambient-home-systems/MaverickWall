/**
 * The confirmation strip (RFC 009 Phase 3.1).
 *
 * There are seventy-nine `c.redirect(...)` calls across the admin and, until
 * this file, no flash mechanism anywhere. Every successful POST redirected and
 * said nothing, so the only evidence a save worked was that the fields happened
 * to show the new value — which is also exactly what a *discarded* save looks
 * like. The Weather screen proved it: two forms, two buttons both labelled
 * "Save", and pressing the wrong one lost a typed location in silence.
 *
 * So a handler that changed something says which thing, in one token:
 *
 * ```ts
 * return savedRedirect(c, '/admin/calendars', 'calendar-added');
 * ```
 *
 * and the page it lands on renders the sentence. Three properties are the
 * whole design:
 *
 *   - **The token is a key, never a message.** Nothing a caller passes is
 *     echoed; the strip draws a literal from the table below. A crafted
 *     `?saved=` in somebody's address bar can therefore say one of these
 *     sentences and nothing else — no escaping question to get wrong, and rule
 *     five is satisfied by the shape rather than by a validator.
 *   - **The key is a TypeScript union.** A typo at a call site is a compile
 *     error rather than a silent 302 that confirms nothing, which is the
 *     failure mode this exists to end.
 *   - **No script.** Dismissing is a link back to the same URL without the
 *     parameter, which also stops a refresh re-announcing a save from ten
 *     minutes ago.
 *
 * This file holds no markup on purpose: `page()` in `html.ts` draws the strip,
 * because that is the one place the shell's DOM order is decided. It imports
 * the table from here, so the dependency runs one way.
 */
import type { Context } from 'hono';

/**
 * What each token says, in the household's words.
 *
 * Named after the *thing* that changed rather than after the handler that
 * changed it — "Calendar added", not "POST /admin/calendars succeeded" — for
 * the same reason `testFeed` returns a suggestion: the sentence is read by
 * somebody standing in a kitchen, and it is the only evidence they get.
 *
 * A screen adopting the strip adds its tokens here. Three do so far (RFC 009
 * Phase 3a); the remaining redirects are Phase 3b's mechanical work.
 */
export const SAVED_MESSAGES = {
  // Calendars
  'calendar-added': 'Calendar added.',
  'calendar-settings': 'Calendar settings saved.',
  'calendar-sync': 'Syncing now — it will show as synced within a minute.',
  'calendar-removed': 'Calendar removed.',
  // System
  'timezone': 'Timezone saved.',
  'update-check': 'Update check setting saved.',
  'update-checked': 'Checked for a newer version.',
  // Weather
  'weather': 'Weather settings saved.',
  'weather-location': 'Location filled in from Home Assistant, and saved.',
} as const;

/** Every token a redirect may carry. A typo here is a compile error. */
export type SavedKey = keyof typeof SAVED_MESSAGES;

/**
 * What `page()` needs to draw the strip: which sentence, and where "dismiss"
 * goes.
 *
 * The href is *relative* — everything the admin emits is, because the single
 * `<base>` element is what carries links through Home Assistant ingress. An
 * absolute path here would work on a plain install and land in Home Assistant's
 * own UI on the add-on.
 */
export interface Saved {
  readonly key: SavedKey;
  readonly dismissHref: string;
}

function isSavedKey(value: string): value is SavedKey {
  return Object.prototype.hasOwnProperty.call(SAVED_MESSAGES, value);
}

/**
 * Redirect, and say what was saved.
 *
 * The drop-in for `c.redirect(path, 302)` at a handler that changed something.
 * `path` keeps its leading slash — the ingress middleware puts the prefix back
 * on the way out, and only recognises a `Location` that starts with one.
 */
export function savedRedirect(c: Context, path: string, key: SavedKey): Response {
  const [base, query] = splitQuery(path);
  const params = new URLSearchParams(query);
  params.set('saved', key);
  return c.redirect(`${base}?${params.toString()}`, 302);
}

/**
 * Read the strip back off the request, for the page that renders it.
 *
 * Absent, unknown or repeated tokens all answer `undefined` rather than
 * guessing — an unrecognised key is somebody's bookmark or somebody's
 * curiosity, and a page that invents a confirmation for it would be the
 * dishonest half of exactly the problem this solves.
 */
export function readSaved(c: Context): Saved | undefined {
  const raw = c.req.query('saved');
  if (raw === undefined || !isSavedKey(raw)) return undefined;
  return { key: raw, dismissHref: withoutSaved(c) };
}

/**
 * The same page, without the parameter — which is what "dismiss" means here.
 *
 * Built from the request's own path and query so anything else the page was
 * carrying (`?install=…`, `?template=…`) survives being dismissed. Relative,
 * for the `<base>`; a path that is somehow empty falls back to the admin root
 * rather than to `""`, which a browser resolves as "this URL, parameters and
 * all" and would make the control do nothing.
 */
function withoutSaved(c: Context): string {
  const params = new URLSearchParams(c.req.query() as Record<string, string>);
  params.delete('saved');
  const rest = params.toString();
  const relative = c.req.path.replace(/^\/+/, '');
  if (relative === '') return 'admin';
  return rest === '' ? relative : `${relative}?${rest}`;
}

function splitQuery(path: string): readonly [string, string] {
  const mark = path.indexOf('?');
  return mark < 0 ? [path, ''] : [path.slice(0, mark), path.slice(mark + 1)];
}
