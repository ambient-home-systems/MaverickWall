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

/**
 * The zones a household in the United States, or a territory the National
 * Weather Service covers, would choose in the wizard.
 *
 * This is the one place the product asks "is this household somewhere the
 * shipped weather defaults make sense?", and it asks it of the timezone
 * rather than the location because the timezone is the first thing the wizard
 * learns and the one thing every household has to answer. Three defaults hang
 * on it: the forecast provider (the NWS covers the United States and nothing
 * else), the units (°F is a United States habit), and whether the NWS alert
 * switch starts on. Before this every household in the world got Fahrenheit,
 * a provider that could not forecast for them, and an alert switch that was
 * on with no zone it could ever watch — which is what put a red "no zones
 * yet" on the Overview of every install outside one country, for ever.
 *
 * Canonical IANA names as `Intl.supportedValuesOf('timeZone')` returns them,
 * plus the legacy aliases a household might carry over from an older
 * container's `TZ`. Territories are in because the NWS serves them (Puerto
 * Rico, the Virgin Islands, Guam, the Northern Marianas, American Samoa).
 * Not `America/*`: Toronto, Mexico City and Bogotá are metric and outside the
 * service, and a prefix test would hand all three the wrong defaults.
 */
const UNITED_STATES_ZONES: ReadonlySet<string> = new Set([
  'America/Adak', 'America/Anchorage', 'America/Boise', 'America/Chicago', 'America/Denver',
  'America/Detroit', 'America/Indiana/Indianapolis', 'America/Indiana/Knox',
  'America/Indiana/Marengo', 'America/Indiana/Petersburg', 'America/Indiana/Tell_City',
  'America/Indiana/Vevay', 'America/Indiana/Vincennes', 'America/Indiana/Winamac',
  'America/Juneau', 'America/Kentucky/Louisville', 'America/Kentucky/Monticello',
  'America/Los_Angeles', 'America/Menominee', 'America/Metlakatla', 'America/New_York',
  'America/Nome', 'America/North_Dakota/Beulah', 'America/North_Dakota/Center',
  'America/North_Dakota/New_Salem', 'America/Phoenix', 'America/Sitka', 'America/Yakutat',
  'Pacific/Honolulu',
  // Territories the National Weather Service covers.
  'America/Puerto_Rico', 'America/St_Thomas', 'America/Virgin', 'Pacific/Guam',
  'Pacific/Saipan', 'Pacific/Pago_Pago', 'Pacific/Samoa', 'US/Samoa',
  // Legacy aliases.
  'US/Alaska', 'US/Aleutian', 'US/Arizona', 'US/Central', 'US/East-Indiana', 'US/Eastern',
  'US/Hawaii', 'US/Indiana-Starke', 'US/Michigan', 'US/Mountain', 'US/Pacific',
  'America/Atka', 'America/Fort_Wayne', 'America/Indianapolis', 'America/Knox_IN',
  'America/Louisville', 'America/Shiprock', 'Navajo', 'Pacific/Johnston',
]);

export function isUnitedStatesZone(zone: string): boolean {
  return UNITED_STATES_ZONES.has(zone);
}
