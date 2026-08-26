import type { SqliteDatabase } from '../db/open.js';

/**
 * The colour a new calendar or a new person is given.
 *
 * Colour is the one channel on the wall that survives truncation: a month-grid
 * pill reading "Stan…" still says *whose* it is, but only if the hue differs
 * from the one next to it. Both columns used to carry a fixed literal default —
 * `#4C7FD1` for a source, the same blue pre-filled on the Add-someone form — so
 * a household who added three calendars got three identical blue pills and the
 * whole attribution mechanism was inert until they recoloured each one by hand.
 *
 * These are not new hues. They are the display's own shift colours, lifted from
 * `api/theme-generator.ts`'s `SHIFT_DEFAULTS` (which mirrors Panels in
 * `apps/display/src/theme.ts`), because those were picked against exactly this
 * constraint: four marks that stay distinguishable from ten feet away on a
 * kitchen wall. Inventing a second palette for calendars would mean two sets of
 * hues on one screen, chosen to separate against different things.
 *
 * The fourth entry is `#B3372B`, Paper Almanac's `--accent` and already the red
 * in `tools/enable-shift.ts`'s people rotation — a red the product uses, added
 * because three usable hues plus a grey is a short rotation for a household with
 * four calendars, and because it was already serving this exact purpose in a
 * tool nobody else could reach.
 *
 * Order matters at the front: `#4C7FD1` stays first so a fresh install's first
 * calendar and first person are coloured exactly as they are today. This bug
 * was never about the first row — it was about the second, third and fourth
 * being identical to it.
 *
 * A caveat worth stating rather than silently fixing: these are the *dark*
 * theme values. On Household and Almanac the same hues are darkened per-theme
 * (see `theme.ts`) to clear 4.5:1 on cream, but a stored source colour is a
 * literal and is not theme-resolved. That is pre-existing — `#4C7FD1` has been
 * the stored default all along — and is a separate fix from this one.
 */
export const IDENTITY_PALETTE = [
  '#4C7FD1', // --s-night
  '#E8A33D', // --s-day
  '#35916A', // --s-break
  '#B3372B', // Almanac's --accent
  '#6B7684', // --s-straight
] as const;

/**
 * The first palette entry nobody is using, else a wrap.
 *
 * Compared case-insensitively because `<input type="color">` posts a *lowercase*
 * hex — a person added through the Add-someone form is stored as `#4c7fd1`, and
 * a match that missed that would hand the next person the same blue, which is
 * the bug this module exists to remove.
 *
 * Once every entry is taken the rotation wraps on the row count rather than
 * refusing or returning null: rule nine — a household's sixth calendar must be
 * addable, and sharing a hue with their first is a much smaller harm than an
 * error on a form.
 */
function nextColor(inUse: readonly string[], rowCount: number): string {
  const taken = new Set(inUse.map((hex) => hex.toUpperCase()));
  const free = IDENTITY_PALETTE.find((hex) => !taken.has(hex));
  // `?? IDENTITY_PALETTE[0]` is unreachable — the modulo is in range — but it is
  // what `noUncheckedIndexedAccess` wants, and it is the right unreachable
  // answer rather than a `!` that would hand a renderer `undefined` if it ever
  // stopped being unreachable.
  return free ?? IDENTITY_PALETTE[rowCount % IDENTITY_PALETTE.length] ?? IDENTITY_PALETTE[0];
}

/**
 * The colour to give the next calendar source.
 *
 * Every kind counts — an ICS feed and a Home Assistant calendar entity draw on
 * the same wall, so they must not be allowed to collide with each other.
 */
export function nextCalendarColor(db: SqliteDatabase): string {
  const rows = db.prepare('SELECT color FROM calendar_sources').all() as { color: string }[];
  return nextColor(
    rows.map((row) => row.color),
    rows.length,
  );
}

/**
 * The colour to give the next person.
 *
 * Independent of the calendar rotation, deliberately: a person's colour marks
 * their shifts and their avatar, a source's marks its events, and a household
 * with one person and one calendar should see the same first colour on both
 * rather than have one of them skipped by the other's existence.
 */
export function nextPersonColor(db: SqliteDatabase): string {
  const rows = db.prepare('SELECT color FROM people').all() as { color: string }[];
  return nextColor(
    rows.map((row) => row.color),
    rows.length,
  );
}
