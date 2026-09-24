import { FETCH_LIMITS, type Fetcher } from '@maverick-wall/core';
import { DEFAULT_USER_AGENT } from '../../net/fetcher.js';
import { z } from '../../validation.js';

/**
 * Turning a typed town into coordinates (RFC — "find the location without
 * knowing coordinates"). The wizard and this screen both ask a household for
 * latitude and longitude, which is the one field on either form that needs a
 * phone map app and a long press to answer. Open-Meteo's geocoding service
 * answers the same question from a name a household already knows how to type.
 *
 * Key-less and worldwide, like the forecast provider it lives beside — and it
 * is a *separate* host from either forecast provider, reached the same way
 * every other outbound request in this module is: through the SSRF-guarded
 * fetcher, public https only. The household's typed text is the only thing
 * this ever sends.
 */

export const GEOCODING_HOST = 'geocoding-api.open-meteo.com';

export function placeSearchUrl(query: string): string {
  const params = new URLSearchParams({ name: query, count: '5', format: 'json' });
  return `https://${GEOCODING_HOST}/v1/search?${params.toString()}`;
}

export interface PlaceMatch {
  readonly latitude: number;
  readonly longitude: number;
  /** "Springfield, Illinois, United States" — as much of the place as the service named. */
  readonly label: string;
}

/**
 * One entry from the service.
 *
 * `admin1` (the state or region) and `country` are both optional in the
 * service's own document — a small place can arrive with either missing — so
 * neither is required here; `labelOf` below just names what it has.
 */
const placeResult = z.object({
  name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  country: z.string().optional(),
  admin1: z.string().optional(),
});

/** The document's shape, loosely: an absent `results` means no match at all. */
const geocodeDocument = z.object({
  results: z.array(z.unknown()).optional(),
});

function labelOf(result: z.infer<typeof placeResult>): string {
  const parts = [result.name, result.admin1, result.country].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  return parts.join(', ');
}

/**
 * Every result the service returned, parsed **one at a time**.
 *
 * A document-level schema would fail the whole search the moment one of five
 * results was missing a field the others carry — and the household would see
 * "no place by that name" for a query that in fact had four good answers. This
 * skips the odd one and keeps the rest, the way `expandCalendar` skips one
 * malformed event rather than losing the whole feed.
 *
 * Capped at five defensively, even though the request itself asks for `count=5`
 * — a document is a stranger's bytes, and this reads them assuming nothing.
 */
export function parsePlaceMatches(body: string): PlaceMatch[] {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return [];
  }
  const document = geocodeDocument.safeParse(raw);
  if (!document.success) return [];
  const matches: PlaceMatch[] = [];
  for (const entry of document.data.results ?? []) {
    if (matches.length >= 5) break;
    const parsed = placeResult.safeParse(entry);
    if (!parsed.success) continue;
    matches.push({
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      label: labelOf(parsed.data),
    });
  }
  return matches;
}

export type PlaceLookup =
  | { readonly ok: true; readonly matches: readonly PlaceMatch[] }
  | { readonly ok: false; readonly message: string };

/**
 * Look a typed place up.
 *
 * A failure here is the service, not the query — "no matches" is a *successful*
 * lookup with an empty list, and the caller is the one that turns that into a
 * sentence, because "no place by that name" and "the service is not answering"
 * point a household at two different things to try.
 */
export async function findPlace(fetcher: Fetcher, query: string): Promise<PlaceLookup> {
  const response = await fetcher.fetch({
    url: placeSearchUrl(query),
    policy: {},
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/json'],
    timeoutMs: 12_000,
    userAgent: DEFAULT_USER_AGENT,
  });
  if (response.status !== 'ok') {
    return {
      ok: false,
      message:
        'The lookup service is not answering right now. Try again in a moment, or type the ' +
        'latitude and longitude below yourself.',
    };
  }
  return { ok: true, matches: parsePlaceMatches(response.body) };
}
