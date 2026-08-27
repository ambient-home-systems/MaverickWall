/**
 * The one timezone this installation falls back to when nobody has said.
 *
 * There used to be three of these and they disagreed. The column default was
 * `America/New_York`, the manifest's no-row fallback was `America/New_York`,
 * and the wizard preselected `Etc/UTC` — so a fresh `docker run` logged
 * "scheduler started, timezone America/New_York" at boot and then offered
 * `Etc/UTC` on the very screen that chooses it. Two different answers to the
 * question the wizard's own copy calls out: "Every all-day event and the whole
 * shift rotation are anchored to this zone. Getting it wrong puts birthdays on
 * the wrong day."
 *
 * `Etc/UTC` rather than `America/New_York`, deliberately. A fallback is what
 * gets used when detection has failed, and there it is a *claim about where
 * this wall is*. `America/New_York` is a confident wrong answer everywhere
 * outside one seaboard, and wrong in a way a household cannot see from the
 * wall — every all-day event still draws, just on the wrong day. `Etc/UTC` is
 * what an unconfigured container genuinely is, so it is the one value here
 * that is not pretending to know.
 *
 * `Etc/UTC` rather than the bare `UTC`, because the offered list has to be
 * able to contain it: `Intl.supportedValuesOf('timeZone')` carries neither
 * name on the ICU data this project has seen, and `offeredTimezones()` appends
 * exactly this one. A fallback the wizard's own `<select>` cannot show is the
 * same bug read from the other side.
 *
 * At the src root beside `version.ts` rather than under `db/`, because
 * `db/schema.ts` is bundled by drizzle-kit at generate time and must not reach
 * up into the HTTP layer to learn what it defaults to.
 */
export const DEFAULT_TIMEZONE = 'Etc/UTC';
