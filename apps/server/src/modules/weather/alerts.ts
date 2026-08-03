import { FETCH_LIMITS, type Fetcher, type Severity, type Urgency, type Certainty } from '@maverick-wall/core';
import { parseJsonOr, z } from '../../validation.js';

/**
 * National Weather Service alerts, parsed from CAP v1.2.
 *
 * Pure except for the two fetches at the bottom, and both of those return a
 * value. Nothing here throws: this feeds a job that runs every minute on
 * somebody's kitchen wall, and during the weather that makes it matter the
 * upstream is at its least reliable.
 *
 * ## Facts about api.weather.gov that cost time to rediscover
 *
 *   - **No API key**, but it *rejects* requests with no descriptive
 *     User-Agent naming the application and a contact. The fetcher carries one
 *     from `AGENT` in `nws.ts`.
 *   - `/alerts/active/zone/{zoneId}` is the current form. The older
 *     `?active=true&zone=` redirects, and a redirect through the SSRF guard is
 *     a second policy check nobody needed.
 *   - `/points/{lat},{lon}` gives both the forecast zone and the county zone,
 *     and takes at most four decimal places. The answer is stable for a
 *     location for ever in practice.
 */

/** What `/points` says about where a household is. */
export interface Zones {
  /** e.g. `MDZ011`. Most alerts are issued against this. */
  readonly forecast: string | null;
  /** e.g. `MDC013`. Some — flood warnings especially — are issued by county. */
  readonly county: string | null;
}

export interface CapAlert {
  /** CAP identifier. Unique per message, not per event. */
  readonly id: string;
  /** When this message was sent. With `id`, the deduplication key. */
  readonly sent: string;
  readonly messageType: 'Alert' | 'Update' | 'Cancel' | 'Ack' | 'Error';
  /** The identifiers this message replaces. */
  readonly references: readonly string[];
  /** `Tornado Warning`. The line drawn largest. */
  readonly event: string;
  readonly headline: string | null;
  readonly description: string | null;
  readonly instruction: string | null;
  readonly areaDesc: string | null;
  /** The issuing office, e.g. `NWS Baltimore/Washington`. */
  readonly senderName: string | null;
  readonly severity: Severity;
  readonly urgency: Urgency;
  readonly certainty: Certainty;
  readonly onsetAt: number | null;
  readonly expiresAt: number | null;
  readonly zoneCode: string | null;
}

/**
 * Cap the length of anything a stranger wrote.
 *
 * A CAP description can run to several thousand characters of boilerplate, and
 * the wall has room for a paragraph. Cutting here rather than in CSS means the
 * manifest stays small and a pathological payload cannot be a memory problem
 * on a Raspberry Pi.
 *
 * Control characters are stripped rather than escaped. They render as nothing
 * or as a replacement box, and a bidi override in a headline can reverse the
 * reading order of the sentence around it — which on a warning is worth
 * refusing outright rather than displaying cleverly.
 */
export function clean(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;

  /*
   * C0 and C1 controls, then the invisible formatting characters.
   *
   * U+200B..U+200F and U+202A..U+202E are the zero-width marks and bidi
   * overrides — the ones that let a headline reverse the reading order of the
   * sentence around it, or hide text inside what looks like a short line. On a
   * warning that is worth refusing outright rather than rendering cleverly.
   * U+FEFF is the byte-order mark, which turns up in real feeds often enough
   * that this project has already been bitten by U+200B in a school district's
   * calendar.
   *
   * Written as escapes rather than literals so the rule is readable in a diff
   * and so an editor cannot silently normalise it away.
   */
  /*
   * Whitespace collapses *before* the controls are stripped, and the order is
   * the whole of one bug.
   *
   * A newline is a control character (U+000A), so stripping first deleted it
   * outright and CAP's teletype-width wrapping came out as "on the lowestfloor
   * of a sturdy building" — every instruction NWS issues, joined at every line
   * break, on the highest-prominence text in the product. Collapsing runs of
   * whitespace to a single space first keeps the word boundary that the line
   * break was.
   */
  const collapsed = value.replace(/\s+/g, ' ');
  // eslint-disable-next-line no-control-regex
  const CONTROLS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;
  const stripped = collapsed.replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
  if (stripped === '') return null;
  return stripped.length <= limit ? stripped : `${stripped.slice(0, limit - 1).trimEnd()}…`;
}

function instant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A CAP feature, as api.weather.gov sends it.
 *
 * Every field is optional in practice — this is a public feed and the shape
 * that arrives during a large outbreak is not always the shape in the
 * documentation. What is *not* optional is `id` and `event`: without an
 * identifier nothing can be deduplicated, and without an event name there is
 * nothing to draw. A feature missing either is dropped rather than defaulted,
 * because inventing a name for a warning is worse than not showing it.
 *
 * `catchall` on the object rather than `strict`: a new field NWS adds must
 * never cost a household their warnings.
 */
const capProperties = z.looseObject({
  id: z.string().min(1),
  sent: z.string().optional(),
  messageType: z.enum(['Alert', 'Update', 'Cancel', 'Ack', 'Error']).catch('Alert'),
  references: z.string().optional(),
  event: z.string().min(1),
  headline: z.unknown().optional(),
  description: z.unknown().optional(),
  instruction: z.unknown().optional(),
  areaDesc: z.unknown().optional(),
  senderName: z.unknown().optional(),
  severity: z.enum(['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown']).catch('Unknown'),
  urgency: z.enum(['Immediate', 'Expected', 'Future', 'Past', 'Unknown']).catch('Unknown'),
  certainty: z.enum(['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown']).catch('Unknown'),
  onset: z.string().optional(),
  effective: z.string().optional(),
  expires: z.string().optional(),
  ends: z.string().optional(),
});

/**
 * The collection.
 *
 * One unreadable feature is skipped, not fatal — the same rule as one
 * malformed VEVENT in a feed. `z.array(...).catch([])` would throw the lot
 * away, so each entry is parsed on its own and the failures fall out.
 */
const capCollection = z.looseObject({
  features: z.array(z.unknown()).catch([]),
});

/**
 * Parse an alerts collection.
 *
 * One unreadable feature is skipped, not fatal — the same rule as one
 * malformed VEVENT in a feed. During a severe weather outbreak the collection
 * is at its largest and the chance of one odd entry is at its highest, which
 * is precisely when losing the other nine matters.
 */
export function parseAlerts(body: string, zoneCode: string | null): CapAlert[] {
  const collection = parseJsonOr(capCollection, body, { features: [] });

  const alerts: CapAlert[] = [];
  for (const feature of collection.features) {
    const shaped = capProperties.safeParse(
      (feature as { properties?: unknown } | null)?.properties,
    );
    // One bad entry costs itself. During a severe weather outbreak the
    // collection is at its largest and the chance of one odd entry highest,
    // which is precisely when losing the other nine matters.
    if (!shaped.success) continue;
    const record = shaped.data;

    const event = clean(record.event, 120);
    if (event === null) continue;

    /*
     * `references` arrives as a single string of comma-separated triples
     * (`sender,identifier,sent`). Only the identifier is useful, and pulling
     * it out here means the Update path downstream is a set lookup.
     */
    const references =
      record.references === undefined
        ? []
        : record.references
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.startsWith('urn:oid:') || part.includes('NWS'));

    alerts.push({
      id: record.id,
      sent: record.sent ?? '',
      messageType: record.messageType,
      references,
      event,
      // Limits sized to what the design can actually draw at a legible size
      // from across a room, not to what CAP permits.
      headline: clean(record.headline, 240),
      description: clean(record.description, 1200),
      instruction: clean(record.instruction, 600),
      areaDesc: clean(record.areaDesc, 300),
      senderName: clean(record.senderName, 120),
      severity: record.severity,
      urgency: record.urgency,
      certainty: record.certainty,
      onsetAt: instant(record.onset ?? record.effective),
      /*
       * `expires`, falling back to `ends`.
       *
       * One of the two is always present and they are not the same thing:
       * `expires` is when the message stops being authoritative, `ends` is when
       * the hazard is forecast to stop. Preferring `expires` is what makes the
       * client-side clear correct — a wall that has lost its connection should
       * drop a message it can no longer refresh.
       */
      expiresAt: instant(record.expires) ?? instant(record.ends),
      zoneCode,
    });
  }

  return alerts;
}

/**
 * Apply a batch of messages to what is already known.
 *
 * CAP is a message stream rather than a state document, so this is where it
 * becomes state. `Cancel` withdraws what it references. `Update` supersedes.
 * Everything is keyed by `id` and ordered by `sent`, so a poll that arrives out
 * of order cannot resurrect a cancelled warning.
 */
export interface KnownAlert {
  readonly id: string;
  readonly sent: string;
}

export interface Reconciliation {
  /** To insert or replace. */
  readonly upsert: readonly CapAlert[];
  /** Identifiers to drop: cancelled, superseded, or no longer listed. */
  readonly remove: readonly string[];
}

export function reconcile(
  incoming: readonly CapAlert[],
  known: readonly KnownAlert[],
): Reconciliation {
  const bySent = new Map<string, CapAlert>();
  const remove = new Set<string>();

  for (const alert of incoming) {
    // Anything a message references is replaced by it, whatever kind it is.
    for (const reference of alert.references) remove.add(reference);

    if (alert.messageType === 'Cancel') {
      remove.add(alert.id);
      continue;
    }
    if (alert.messageType === 'Ack' || alert.messageType === 'Error') continue;

    const existing = bySent.get(alert.id);
    // Later `sent` wins for the same id, so an out-of-order poll cannot put a
    // stale copy back.
    if (existing === undefined || alert.sent >= existing.sent) bySent.set(alert.id, alert);
  }

  /*
   * Anything we hold that the zone no longer lists is over.
   *
   * `/alerts/active` is authoritative about what is in force right now, so
   * absence is a withdrawal — and it is the only signal for an alert that was
   * cancelled while this wall was offline and so never saw the Cancel message.
   */
  const listed = new Set(incoming.map((alert) => alert.id));
  for (const alert of known) {
    if (!listed.has(alert.id)) remove.add(alert.id);
  }

  const upsert = [...bySent.values()].filter((alert) => !remove.has(alert.id));
  return { upsert, remove: [...remove] };
}

export type ZonesResult =
  | { readonly ok: true; readonly zones: Zones }
  | { readonly ok: false; readonly message: string; readonly suggestion?: string };

/** Both zone identifiers for a location, from the points document. */
/**
 * A zone URL, reduced to the code at the end of it.
 *
 * The pattern is the whole validation: `MDZ011` and `MDC027` are the only
 * shapes a zone code takes, and anything else in that position is a URL that
 * does not mean what this expects.
 */
const zoneCode = z.preprocess((value) => {
  if (typeof value !== 'string') return undefined;
  const code = value.split('/').pop();
  return code !== undefined && /^[A-Z]{2}[CZ][0-9]{3}$/.test(code) ? code : undefined;
}, z.string().optional());

const pointsZones = z.looseObject({
  properties: z
    .looseObject({ forecastZone: zoneCode, county: zoneCode })
    .catch({ forecastZone: undefined, county: undefined }),
});

export function parseZones(body: string): Zones | undefined {
  const document = parseJsonOr(pointsZones, body, null);
  if (document === null) return undefined;
  const forecast = document.properties.forecastZone ?? null;
  const county = document.properties.county ?? null;
  // Neither means the location is outside NWS coverage, which is a different
  // answer from "the document was unreadable" only to a log reader.
  if (forecast === null && county === null) return undefined;
  return { forecast, county };
}

export type AlertsFetch =
  | { readonly status: 'ok'; readonly alerts: CapAlert[]; readonly etag?: string }
  /** Nothing changed. The cheap path, and the reason ETags are stored. */
  | { readonly status: 'not-modified' }
  | {
      readonly status: 'failed';
      readonly message: string;
      /** Honoured by the scheduler, so backoff respects the upstream. */
      readonly retryAfterSeconds?: number;
      /** True for 429 and 5xx, which is when NWS is least reliable. */
      readonly backOffHard: boolean;
    };

export function alertsUrl(zoneId: string): string {
  // The current form. `?active=true&zone=` is deprecated and redirects.
  return `https://api.weather.gov/alerts/active/zone/${encodeURIComponent(zoneId)}`;
}

export async function fetchAlerts(
  fetcher: Fetcher,
  zoneId: string,
  userAgent: string,
  etag?: string | null,
): Promise<AlertsFetch> {
  const response = await fetcher.fetch({
    url: alertsUrl(zoneId),
    policy: {},
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/geo+json', 'application/json', 'application/ld+json'],
    timeoutMs: 12_000,
    userAgent,
    ...(etag ? { conditional: { etag } } : {}),
  });

  if (response.status === 'not-modified') return { status: 'not-modified' };

  if (response.status === 'rejected') {
    return { status: 'failed', message: response.message, backOffHard: false };
  }

  if (response.status === 'failed') {
    /*
     * Back off hard on 429 and 5xx.
     *
     * NWS reliability varies during major events, which is exactly when this
     * matters — and a thousand kitchen walls retrying a struggling service
     * every sixty seconds is a small part of why. The stored alerts stay up
     * throughout; backing off costs freshness, never the warning already on
     * screen.
     */
    const status = response.httpStatus ?? 0;
    const hard = status === 429 || status >= 500;
    return {
      status: 'failed',
      message: response.message,
      ...(response.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: response.retryAfterSeconds }
        : {}),
      backOffHard: hard,
    };
  }

  return {
    status: 'ok',
    alerts: parseAlerts(response.body, zoneId),
    ...(response.etag !== undefined ? { etag: response.etag } : {}),
  };
}
