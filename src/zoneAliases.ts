import { isValidTimeZone } from './timezone.js';

/**
 * Outlook and Exchange emit `TZID:Eastern Standard Time` rather than an IANA
 * name, and Intl rejects those. Rather than dropping every event from a
 * corporate feed, we map the common ones. This is not the full CLDR table on
 * purpose: it stays small, auditable, and covers what household feeds actually
 * contain. Anything unmapped falls back to the display zone with a diagnostic.
 */
const WINDOWS_TO_IANA: Readonly<Record<string, string>> = {
  'dateline standard time': 'Etc/GMT+12',
  'hawaiian standard time': 'Pacific/Honolulu',
  'alaskan standard time': 'America/Anchorage',
  'pacific standard time': 'America/Los_Angeles',
  'pacific standard time (mexico)': 'America/Tijuana',
  'us mountain standard time': 'America/Phoenix',
  'mountain standard time': 'America/Denver',
  'central standard time': 'America/Chicago',
  'central standard time (mexico)': 'America/Mexico_City',
  'canada central standard time': 'America/Regina',
  'eastern standard time': 'America/New_York',
  'us eastern standard time': 'America/New_York',
  'atlantic standard time': 'America/Halifax',
  'sa pacific standard time': 'America/Bogota',
  'sa eastern standard time': 'America/Cayenne',
  'e. south america standard time': 'America/Sao_Paulo',
  'argentina standard time': 'America/Argentina/Buenos_Aires',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'gmt standard time': 'Europe/London',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'gtb standard time': 'Europe/Bucharest',
  'israel standard time': 'Asia/Jerusalem',
  'egypt standard time': 'Africa/Cairo',
  'south africa standard time': 'Africa/Johannesburg',
  'russian standard time': 'Europe/Moscow',
  'arabian standard time': 'Asia/Dubai',
  'arab standard time': 'Asia/Riyadh',
  'india standard time': 'Asia/Kolkata',
  'nepal standard time': 'Asia/Kathmandu',
  'se asia standard time': 'Asia/Bangkok',
  'china standard time': 'Asia/Shanghai',
  'singapore standard time': 'Asia/Singapore',
  'w. australia standard time': 'Australia/Perth',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'aus central standard time': 'Australia/Darwin',
  'cen. australia standard time': 'Australia/Adelaide',
  'aus eastern standard time': 'Australia/Sydney',
  'e. australia standard time': 'Australia/Brisbane',
  'tasmania standard time': 'Australia/Hobart',
  'new zealand standard time': 'Pacific/Auckland',
  'utc': 'UTC',
  'coordinated universal time': 'UTC',

  // Bare forms emitted by DDay.iCal and its descendants, seen in the wild on
  // school district and municipal feeds. Not Windows names, not IANA names.
  'us eastern': 'America/New_York',
  'us central': 'America/Chicago',
  'us mountain': 'America/Denver',
  'us pacific': 'America/Los_Angeles',
  'eastern': 'America/New_York',
  'central': 'America/Chicago',
  'mountain': 'America/Denver',
  'pacific': 'America/Los_Angeles',
};

export type ZoneResolution =
  | { readonly kind: 'iana'; readonly tzid: string }
  | { readonly kind: 'aliased'; readonly tzid: string; readonly from: string }
  | { readonly kind: 'unknown'; readonly from: string };

/**
 * Resolve a TZID parameter to something Intl accepts.
 *
 * Handles the three shapes seen in the wild: a real IANA name, a Windows
 * display name, and a producer-prefixed name such as
 * `/mozilla.org/20050126_1/America/Chicago`.
 */
export function resolveTzid(rawTzid: string): ZoneResolution {
  const trimmed = rawTzid.trim();
  if (!trimmed) return { kind: 'unknown', from: rawTzid };

  if (isValidTimeZone(trimmed)) return { kind: 'iana', tzid: trimmed };

  const aliased = WINDOWS_TO_IANA[trimmed.toLowerCase()];
  if (aliased && isValidTimeZone(aliased)) {
    return { kind: 'aliased', tzid: aliased, from: trimmed };
  }

  // Producer-prefixed forms: take the trailing Region/City segments.
  if (trimmed.includes('/')) {
    const segments = trimmed.split('/').filter(Boolean);
    for (let start = 0; start < segments.length - 1; start++) {
      const candidate = segments.slice(start).join('/');
      if (isValidTimeZone(candidate)) {
        return { kind: 'aliased', tzid: candidate, from: trimmed };
      }
    }
  }

  return { kind: 'unknown', from: trimmed };
}
