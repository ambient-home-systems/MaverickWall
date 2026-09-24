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
 * Every sentence here is a *confirmation*, drawn on the `ok` pair. There is
 * deliberately no second tone: a "nothing happened" notice in a green strip
 * shaped exactly like "Calendar added." is the strip mumbling, and the answer
 * to a control that can do nothing is not to explain it afterwards — it is not
 * to draw the control (see "Sync now" on a calendar whose sync is off).
 *
 * This file holds no markup on purpose: `page()` in `html.ts` draws the strip,
 * because that is the one place the shell's DOM order is decided. It imports
 * the table from here, so the dependency runs one way.
 */
import type { Context } from 'hono';
import { queryOf, selfHref } from './self.js';

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
  // Says what happens next, because it is asynchronous and the row the
  // household lands on cannot yet show a count. Only sent after
  // `addCalendarSource` has both stored the row and scheduled its sync, so the
  // second clause is a claim about a branch that has already happened.
  'calendar-added': 'Calendar added — fetching events now.',
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
  'alert-rule-updated': 'Alert rule updated.',
  // People
  'person-added': 'Person added.',
  'person-updated': 'Person saved.',
  'person-removed': 'Person removed.',
  'person-avatar-saved': 'Photo saved.',
  'person-avatar-removed': 'Photo removed.',
  // Reordering — shared across every screen with an Up/Down control, because
  // the sentence is the same act wherever it happens.
  'order-saved': 'Order saved.',
  // Work Schedule (rotations)
  'shift-rotation-saved': 'Rotation saved.',
  'shift-rotation-removed': 'Rotation removed.',
  // Shift types
  'shift-type-added': 'Shift type added.',
  'shift-type-saved': 'Shift type saved.',
  'shift-type-removed': 'Shift type removed.',
  // Chores
  'chore-added': 'Chore added.',
  'chore-updated': 'Chore saved.',
  'chore-removed': 'Chore removed.',
  'chore-paused': 'Chore paused.',
  'chore-resumed': 'Chore resumed.',
  // Displays / walls
  'screen-settings': 'Wall settings saved.',
  'screen-removed': 'Wall removed.',
  // Forgetting is the first hard delete of a screen (RFC 016 phase 1): the
  // row, both canvases, and a following panel's link to it. Two keys because
  // "Forget all" is its own confirm and its own POST.
  'wall-forgotten': 'Wall forgotten.',
  'walls-forgotten': 'Unpaired walls forgotten.',
  /*
   * Applying a template repaints the wall, and this is where it stops being
   * silent (RFC 015 §3.6).
   *
   * Twelve of the fourteen shipped wall templates name a theme, and until now
   * the only thing that said so was a caption on the gallery card — so a
   * household pressed Sky Week and their kitchen changed colour with the strip
   * reading "Layout applied." and nothing else.
   *
   * **It is a key per theme, not a sentence with a name in it.** This file's
   * first stated property is that the token is a key and never a message, so
   * "say which theme" cannot be done by interpolating one: the names are
   * written here as literals. That is affordable because the catalogue names
   * exactly two themes between its fourteen cards, and
   * `saved-template-theme.test.ts` is what keeps it affordable — it walks every
   * template naming a theme and fails the build when one of them has no key,
   * so a fifteenth card in a third theme is a hole somebody has to fill rather
   * than a strip that quietly says the wrong colour. Classic and Blank name no
   * theme and keep the generic sentence, as does every panel template.
   */
  'layout-template-applied': 'Layout applied.',
  'layout-template-applied-panels': 'Layout applied. This wall now wears Panels.',
  'layout-template-applied-almanac': 'Layout applied. This wall now wears Paper Almanac.',
  'layout-copied': 'Layout copied.',
  'layout-reset': 'Layout reset.',
  // e-paper
  'epaper-screen-removed': 'e-paper wall removed.',
  'epaper-source-saved': 'Panel layout source saved.',
  'epaper-lan-only-saved': 'Network access setting saved.',
  // Home Assistant
  'ha-connected': 'Connected to Home Assistant.',
  'ha-disconnected': 'Disconnected from Home Assistant.',
  // Two keys for one act, because adding a reading watches an entity and only
  // a Home Assistant widget puts it on a wall (P1.3): the handler asks which
  // walls draw it and sends the sentence that is true of that branch.
  'ha-entity-added': 'Reading added. No wall shows it yet — a wall needs a Home Assistant widget.',
  'ha-entity-added-shown': 'Reading added — it is on the wall on its next refresh.',
  'ha-entity-removed': 'Reading removed.',
  'ha-calendar-added': 'Calendar added.',
  'ha-rule-added': 'Rule added.',
  'ha-rule-removed': 'Rule removed.',
  'ha-rule-updated': 'Rule updated.',
  // To-do lists (RFC 012). Only sent once the list's first read has succeeded,
  // so "on the wall" is a claim about a branch that has already happened — a
  // list whose first read failed is rendered with the failure instead.
  'todo-list-added': 'List added — it is on the wall on its next refresh.',
  'todo-list-removed': 'List removed.',
  // Store (modules)
  'module-added': 'Module added.',
  'module-removed': 'Module removed.',
  'module-updated': 'Module updated.',
  'module-alerts-saved': 'Alerts setting saved.',
  // A wall's own CSS (RFC 014 §7). Only sent once every block on the form
  // has been read and written, so "picks it up" is a claim about a manifest
  // whose ETag has already moved.
  'wall-css': 'CSS saved. The wall picks it up within a minute.',
  // Themes
  'theme-created': 'Theme created.',
  'theme-generated': 'Theme generated.',
  'theme-saved': 'Theme saved.',
  'theme-removed': 'Theme removed.',
} as const;

/** Every token a redirect may carry. A typo here is a compile error. */
export type SavedKey = keyof typeof SAVED_MESSAGES;

/**
 * Which sentence a freshly applied template gets: the one naming its theme, or
 * the generic one.
 *
 * Here rather than in `admin.ts` because this is the file that owns the keys,
 * and because the lookup has to be able to *miss*: `template.theme` is a
 * string off the catalogue and nothing in the type system makes it one of the
 * two names written above. A miss answers the generic sentence, which is rule
 * nine's shape for a confirmation strip — a household who applied a template is
 * told their layout changed even when this table has not caught up with a new
 * card. What stops that being a quiet wrong answer is
 * `saved-template-theme.test.ts`, which walks the catalogue and fails when a
 * template names a theme with no key here.
 *
 * A panel template names no theme at all, and a panel has none to name, so
 * every e-paper apply lands on the generic sentence by the same branch.
 */
export function templateAppliedKey(theme: string | undefined): SavedKey {
  if (theme === undefined) return 'layout-template-applied';
  const named = `layout-template-applied-${theme}`;
  return isSavedKey(named) ? named : 'layout-template-applied';
}

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
  // The fragment comes off first and goes back on last. Splitting on `?` alone
  // turns `…#frag` into `…#frag?saved=key`, where the token is part of the
  // anchor, never reaches the server, and breaks the anchor on the way — and
  // the wall editor's `layoutUrl()` already redirects to fragment paths, which
  // is exactly the set Phase 3b converts.
  const [withoutHash, hash] = splitOn(path, '#');
  const [base, query] = splitOn(withoutHash, '?');
  const params = new URLSearchParams(query);
  params.set('saved', key);
  return c.redirect(`${base}?${params.toString()}${hash === '' ? '' : `#${hash}`}`, 302);
}

/**
 * Read the strip back off the request, for the page that renders it.
 *
 * An absent or unrecognised token answers `undefined` rather than guessing —
 * an unknown key is somebody's bookmark or somebody's curiosity, and a page
 * that invented a confirmation for it would be the dishonest half of exactly
 * the problem this solves. A repeated `?saved=a&saved=b` takes the first, which
 * is Hono's reading and is harmless here: only a table literal can ever render.
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
 * for the `<base>` — see `self.ts`, which owns that reasoning and which the
 * skip link needs for the same reason.
 */
function withoutSaved(c: Context): string {
  const params = queryOf(c);
  params.delete('saved');
  return selfHref(c, params);
}

function splitOn(value: string, mark: string): readonly [string, string] {
  const at = value.indexOf(mark);
  return at < 0 ? [value, ''] : [value.slice(0, at), value.slice(at + mark.length)];
}
