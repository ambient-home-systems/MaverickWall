import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * One household. One database. No tenancy.
 *
 * There is no `tenant_id` and there will never be one. Adding it "just in case"
 * would cost a column on every table, a predicate on every query, and an entire
 * class of bug where a missing filter leaks one family's calendar to another —
 * all to serve a deployment model this product does not have. If a household
 * needs a second wall, they run a second container.
 *
 * Conventions:
 *   - Text primary keys, generated in application code. Opaque, not guessable,
 *     and safe to put in a URL.
 *   - Timestamps are epoch milliseconds in an INTEGER column. SQLite has no
 *     date type and storing ISO strings makes range queries lexicographic.
 *   - Booleans are INTEGER 0/1.
 *   - Anything structured is JSON in a TEXT column, and only where it is never
 *     queried by its contents.
 *   - Credentials are stored as envelopes from the keyring, never in clear.
 */

const now = (): number => Date.now();

/** Applied to every table that a human can edit, for the audit trail. */
const timestamps = {
  createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull().$defaultFn(now).$onUpdateFn(now),
};

// ---------------------------------------------------------------------------
// Household
// ---------------------------------------------------------------------------

/**
 * Exactly one row, id `singleton`.
 *
 * A settings table rather than a key-value store because these are read on
 * every display poll and typed columns beat parsing JSON on a Raspberry Pi.
 */
export const householdSettings = sqliteTable('household_settings', {
  id: text('id').primaryKey().default('singleton'),

  /** IANA zone. Anchors every all-day event and the whole shift rotation. */
  timezone: text('timezone').notNull().default('America/New_York'),
  locale: text('locale').notNull().default('en-US'),

  /** Theme key from the display bundle. */
  theme: text('theme').notNull().default('board'),
  /** Optional daylight theme, and the local times to switch between them. */
  daytimeTheme: text('daytime_theme'),
  daytimeStartsAt: text('daytime_starts_at').default('07:00'),
  daytimeEndsAt: text('daytime_ends_at').default('21:00'),

  /** Latitude and longitude for weather and alerts. Null until setup runs. */
  latitude: integer('latitude', { mode: 'number' }),
  longitude: integer('longitude', { mode: 'number' }),

  /** Feature switches. A household with no shift worker never sees any of it. */
  shiftEnabled: integer('shift_enabled', { mode: 'boolean' }).notNull().default(false),
  weatherEnabled: integer('weather_enabled', { mode: 'boolean' }).notNull().default(true),
  alertsEnabled: integer('alerts_enabled', { mode: 'boolean' }).notNull().default(true),

  /** False until the first-run wizard completes. */
  setupCompletedAt: integer('setup_completed_at', { mode: 'number' }),

  ...timestamps,
});

// ---------------------------------------------------------------------------
// Auth. Shapes are dictated by Better Auth; do not rename columns.
// ---------------------------------------------------------------------------

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    byUser: index('session_user_idx').on(table.userId),
    byExpiry: index('session_expires_idx').on(table.expiresAt),
  }),
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    idToken: text('id_token'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    byUser: index('account_user_idx').on(table.userId),
  }),
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
  },
  (table) => ({
    byIdentifier: index('verification_identifier_idx').on(table.identifier),
  }),
);

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/**
 * A wall display.
 *
 * Screens authenticate with a long random token, stored hashed: the plaintext
 * is shown once at pairing and never again. Hashing means a leaked database
 * does not hand out working display credentials, and it costs nothing since
 * the token is high-entropy and needs no slow KDF.
 */
export const screens = sqliteTable(
  'screens',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),

    /** Per-screen overrides. Null means follow the household setting. */
    theme: text('theme'),
    layout: text('layout', { mode: 'json' }).$type<unknown>(),
    timezone: text('timezone'),

    /** Rotated when the token is regenerated, invalidating old sessions. */
    tokenIssuedAt: integer('token_issued_at', { mode: 'number' }).notNull().$defaultFn(now),
    revokedAt: integer('revoked_at', { mode: 'number' }),

    /** Diagnostics: is that tablet in the kitchen actually still alive? */
    lastSeenAt: integer('last_seen_at', { mode: 'number' }),
    lastSeenIp: text('last_seen_ip'),
    lastSeenUserAgent: text('last_seen_user_agent'),
    appVersion: text('app_version'),

    ...timestamps,
  },
  (table) => ({
    byToken: uniqueIndex('screens_token_hash_idx').on(table.tokenHash),
  }),
);

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

/**
 * A subscribed ICS feed.
 *
 * `urlEncrypted` holds a keyring envelope, never a URL. A Google private iCal
 * address is a bearer credential that never expires, and `/data` is exactly
 * what people copy to a NAS and attach to bug reports.
 */
export const calendarSources = sqliteTable(
  'calendar_sources',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    urlEncrypted: text('url_encrypted').notNull(),
    /** Host only, for display and diagnostics. Never the path or the token. */
    urlHost: text('url_host'),

    color: text('color').notNull().default('#4C7FD1'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Hidden feeds still sync; they just do not render. */
    visible: integer('visible', { mode: 'boolean' }).notNull().default(true),

    /**
     * Deliberate opt-in to reach a LAN address. Off by default, and never a
     * global setting: a household legitimately needs to fetch from their own
     * Nextcloud, but that must not silently widen every other feed's reach.
     */
    allowPrivateNetwork: integer('allow_private_network', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * Permit the loopback interface, separately from the LAN.
     *
     * Home Assistant add-ons reach each other over localhost, and a
     * `--network host` deployment may have a service bound only to 127.0.0.1.
     * Kept distinct from `allowPrivateNetwork` so enabling LAN access never
     * implies it — and neither opens link-local, where the cloud metadata
     * endpoint lives.
     */
    allowLoopback: integer('allow_loopback', { mode: 'boolean' }).notNull().default(false),
    allowHttp: integer('allow_http', { mode: 'boolean' }).notNull().default(false),

    /** Conditional GET state, so an unchanged feed costs one 304. */
    etag: text('etag'),
    lastModified: text('last_modified'),

    lastSyncAt: integer('last_sync_at', { mode: 'number' }),
    lastSuccessAt: integer('last_success_at', { mode: 'number' }),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures', { mode: 'number' }).notNull().default(0),
    /** Count from the last successful expansion, for the admin UI. */
    eventCount: integer('event_count', { mode: 'number' }).notNull().default(0),

    ...timestamps,
  },
  (table) => ({
    byEnabled: index('calendar_sources_enabled_idx').on(table.enabled),
  }),
);

/**
 * Expanded occurrences, bounded to a window around today.
 *
 * Storing occurrences rather than rules is the whole point: recurrence is
 * expanded once on the server so the display never sees an RRULE and a poll is
 * a single indexed range scan.
 *
 * Rows are replaced wholesale per source inside a transaction. There is no
 * attempt at incremental diffing — a feed is small, the expansion is fast, and
 * a partial update is a class of bug nobody wants to debug from a kitchen.
 */
export const calendarEventsCache = sqliteTable(
  'calendar_events_cache',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => calendarSources.id, { onDelete: 'cascade' }),

    uid: text('uid').notNull(),
    /** Basic-format local reading of the slot this instance fills. */
    recurrenceId: text('recurrence_id'),

    title: text('title').notNull(),
    location: text('location'),
    /** Only populated when the source opts in; stripped by default. */
    description: text('description'),

    startsAt: integer('starts_at', { mode: 'number' }).notNull(),
    endsAt: integer('ends_at', { mode: 'number' }).notNull(),
    allDay: integer('all_day', { mode: 'boolean' }).notNull().default(false),
    /** Local dates in the household zone, for grid placement without recompute. */
    startLocalDate: text('start_local_date').notNull(),
    endLocalDate: text('end_local_date').notNull(),

    sourceTzid: text('source_tzid').notNull(),
    status: text('status', { enum: ['CONFIRMED', 'TENTATIVE'] }).notNull().default('CONFIRMED'),
    isRecurringInstance: integer('is_recurring_instance', { mode: 'boolean' })
      .notNull()
      .default(false),

    syncedAt: integer('synced_at', { mode: 'number' }).notNull().$defaultFn(now),
  },
  (table) => ({
    // The index every display poll uses.
    byStart: index('events_starts_at_idx').on(table.startsAt),
    byLocalDate: index('events_local_date_idx').on(table.startLocalDate),
    bySource: index('events_source_idx').on(table.sourceId),
    // Identity, so a re-sync can be reconciled and per-instance state attached.
    identity: uniqueIndex('events_identity_idx').on(
      table.sourceId,
      table.uid,
      table.recurrenceId,
    ),
  }),
);

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const people = sqliteTable('people', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color').notNull().default('#E8A33D'),
  /** Path under /data/media, never an external URL. */
  avatarPath: text('avatar_path'),
  sortOrder: integer('sort_order', { mode: 'number' }).notNull().default(0),
  /** Whose shift rotation the wall shows. Usually exactly one person. */
  hasShiftRotation: integer('has_shift_rotation', { mode: 'boolean' }).notNull().default(false),
  ...timestamps,
});

// ---------------------------------------------------------------------------
// Shift rotation
//
// The spec lists a single `shift_rotation` table. Split into three because
// overrides must be queryable by date — a swap is looked up per day on every
// render — and folding them into a JSON blob would mean parsing the entire
// roster to answer "what am I doing on Thursday".
// ---------------------------------------------------------------------------

export const shiftTypes = sqliteTable('shift_types', {
  id: text('id').primaryKey(),
  /** Stable key referenced by cycles and matchers. Renaming the label is free. */
  key: text('key').notNull().unique(),
  label: text('label').notNull(),
  shortCode: text('short_code').notNull(),
  /** A CSS custom property name. Themes own the value. */
  colorToken: text('color_token').notNull(),
  isWorking: integer('is_working', { mode: 'boolean' }).notNull().default(true),
  sortOrder: integer('sort_order', { mode: 'number' }).notNull().default(0),
  ...timestamps,
});

export const shiftPlans = sqliteTable(
  'shift_plans',
  {
    id: text('id').primaryKey(),
    personId: text('person_id').references(() => people.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['pattern', 'calendar'] }).notNull(),

    /** Inclusive civil dates. `effectiveTo` null means open-ended. */
    effectiveFrom: text('effective_from').notNull(),
    effectiveTo: text('effective_to'),
    priority: integer('priority', { mode: 'number' }).notNull().default(0),

    /** Pattern plans: the anchor and the flat cycle array as JSON. */
    anchorDate: text('anchor_date'),
    cycle: text('cycle', { mode: 'json' }).$type<(string | null)[]>(),

    /** Calendar plans: which feed, and the title matchers as JSON. */
    calendarSourceId: text('calendar_source_id').references(() => calendarSources.id, {
      onDelete: 'set null',
    }),
    matchers: text('matchers', { mode: 'json' }).$type<unknown[]>(),
    /**
     * Remove matched events from the agenda.
     *
     * A feed that marks every day with "Working Day Shift" or "Break Day" would
     * otherwise bury the appointments somebody is looking at the wall to find.
     */
    consumesEvents: integer('consumes_events', { mode: 'boolean' }).notNull().default(true),

    ...timestamps,
  },
  (table) => ({
    byRange: index('shift_plans_range_idx').on(table.effectiveFrom, table.effectiveTo),
  }),
);

export const shiftOverrides = sqliteTable(
  'shift_overrides',
  {
    id: text('id').primaryKey(),
    personId: text('person_id').references(() => people.id, { onDelete: 'cascade' }),
    /** Civil date, `YYYY-MM-DD`. */
    date: text('date').notNull(),
    /** Null means explicitly not working, distinct from no information. */
    shiftTypeKey: text('shift_type_key'),
    note: text('note'),
    ...timestamps,
  },
  (table) => ({
    byPersonDate: uniqueIndex('shift_overrides_person_date_idx').on(table.personId, table.date),
    byDate: index('shift_overrides_date_idx').on(table.date),
  }),
);

// ---------------------------------------------------------------------------
// Interrupts and alerts
// ---------------------------------------------------------------------------

export const interruptRules = sqliteTable(
  'interrupt_rules',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

    /** What can trigger this. Weather alerts first; more sources later. */
    trigger: text('trigger', { enum: ['weather_alert', 'calendar_event', 'ha_entity'] }).notNull(),
    /** Trigger-specific matching, as JSON. Never queried by contents. */
    conditions: text('conditions', { mode: 'json' }).$type<unknown>(),

    /** Higher wins when two interrupts fire at once. */
    priority: integer('priority', { mode: 'number' }).notNull().default(0),
    /** Whether this is allowed to wake a sleeping screen. */
    wakeScreen: integer('wake_screen', { mode: 'boolean' }).notNull().default(false),
    /** Auto-dismiss after this many seconds. Null means it stays until cleared. */
    dismissAfterSeconds: integer('dismiss_after_seconds', { mode: 'number' }),

    ...timestamps,
  },
  (table) => ({
    byEnabled: index('interrupt_rules_enabled_idx').on(table.enabled, table.trigger),
  }),
);

/** NWS zones or points to watch. */
export const alertZones = sqliteTable('alert_zones', {
  id: text('id').primaryKey(),
  /** e.g. `MDC013`, or a `lat,lon` point. */
  code: text('code').notNull().unique(),
  label: text('label').notNull(),
  provider: text('provider').notNull().default('nws'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  ...timestamps,
});

/**
 * Alerts currently in force.
 *
 * Kept rather than derived so the display has something to show when the
 * upstream is unreachable, and so an alert that expires while the network is
 * down still clears itself on schedule.
 */
export const activeAlerts = sqliteTable(
  'active_alerts',
  {
    id: text('id').primaryKey(),
    /** Provider's own identifier, for deduplication across polls. */
    externalId: text('external_id').notNull(),
    zoneCode: text('zone_code'),

    event: text('event').notNull(),
    headline: text('headline'),
    severity: text('severity'),
    urgency: text('urgency'),
    certainty: text('certainty'),

    onsetAt: integer('onset_at', { mode: 'number' }),
    expiresAt: integer('expires_at', { mode: 'number' }),
    fetchedAt: integer('fetched_at', { mode: 'number' }).notNull().$defaultFn(now),

    /** Set when someone clears it on the wall, so it stops interrupting. */
    dismissedAt: integer('dismissed_at', { mode: 'number' }),
  },
  (table) => ({
    byExternal: uniqueIndex('active_alerts_external_idx').on(table.externalId),
    byExpiry: index('active_alerts_expires_idx').on(table.expiresAt),
  }),
);

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

/**
 * Last good weather reading.
 *
 * A cache with an explicit fetch time rather than a TTL: when the upstream is
 * unreachable the display still shows a temperature, labelled with how old it
 * is. Blanking the panel would be worse than showing a two-hour-old reading.
 */
export const weatherCache = sqliteTable('weather_cache', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull().default('nws'),
  /** Provider-specific cache key, e.g. a resolved gridpoint. */
  cacheKey: text('cache_key').notNull().unique(),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
  fetchedAt: integer('fetched_at', { mode: 'number' }).notNull().$defaultFn(now),
  /** Provider's own staleness hint, honoured to keep polling polite. */
  expiresAt: integer('expires_at', { mode: 'number' }),
});

// ---------------------------------------------------------------------------
// Home Assistant. Read-only, always.
// ---------------------------------------------------------------------------

export const haSettings = sqliteTable('ha_settings', {
  id: text('id').primaryKey().default('singleton'),
  baseUrl: text('base_url'),
  /** Keyring envelope. A long-lived access token is a bearer credential. */
  tokenEncrypted: text('token_encrypted'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  /**
   * Home Assistant is usually on the LAN, so this exists — but it is still an
   * explicit per-integration decision rather than a global relaxation.
   */
  allowPrivateNetwork: integer('allow_private_network', { mode: 'boolean' })
    .notNull()
    .default(true),
  lastSyncAt: integer('last_sync_at', { mode: 'number' }),
  lastError: text('last_error'),
  ...timestamps,
});

/**
 * Snapshot of watched entities.
 *
 * A cache, never a control surface. Nothing in this application calls a Home
 * Assistant service, and no column here is writable from the display.
 */
export const haEntityCache = sqliteTable(
  'ha_entity_cache',
  {
    entityId: text('entity_id').primaryKey(),
    state: text('state'),
    attributes: text('attributes', { mode: 'json' }).$type<unknown>(),
    friendlyName: text('friendly_name'),
    unitOfMeasurement: text('unit_of_measurement'),
    lastChangedAt: integer('last_changed_at', { mode: 'number' }),
    fetchedAt: integer('fetched_at', { mode: 'number' }).notNull().$defaultFn(now),
    /** Whether the display is currently showing this one. */
    watched: integer('watched', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => ({
    byWatched: index('ha_entity_watched_idx').on(table.watched),
  }),
);

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export const mediaAssets = sqliteTable(
  'media_assets',
  {
    id: text('id').primaryKey(),
    /** Relative to /data/media. Never absolute, never escaping the directory. */
    path: text('path').notNull().unique(),
    originalName: text('original_name'),
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size', { mode: 'number' }).notNull(),
    width: integer('width', { mode: 'number' }),
    height: integer('height', { mode: 'number' }),
    /** Content hash, so the same photo uploaded twice is stored once. */
    sha256: text('sha256').notNull(),
    usage: text('usage', { enum: ['background', 'avatar', 'other'] }).notNull().default('other'),
    ...timestamps,
  },
  (table) => ({
    byHash: index('media_sha_idx').on(table.sha256),
    byUsage: index('media_usage_idx').on(table.usage),
  }),
);

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Next-run times, persisted so the scheduler survives a restart.
 *
 * Without this, every container restart re-runs every job immediately, which
 * on a household that restarts often turns into a self-inflicted hammering of
 * whatever upstream a feed points at.
 */
export const jobState = sqliteTable(
  'job_state',
  {
    /** e.g. `ics-sync:<sourceId>`, `backup`, `retention`, `optimize`. */
    key: text('key').primaryKey(),
    kind: text('kind').notNull(),

    nextRunAt: integer('next_run_at', { mode: 'number' }).notNull(),
    lastRunAt: integer('last_run_at', { mode: 'number' }),
    lastDurationMs: integer('last_duration_ms', { mode: 'number' }),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures', { mode: 'number' }).notNull().default(0),

    /**
     * Set while a job is running so a slow job is never started twice.
     * Cleared on completion; a stale value from a crash is reclaimed by age,
     * the same way the migration lock is.
     */
    runningSince: integer('running_since', { mode: 'number' }),

    ...timestamps,
  },
  (table) => ({
    byNextRun: index('job_state_next_run_idx').on(table.nextRunAt),
  }),
);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * What changed, when, and who did it.
 *
 * Not for compliance — for answering "why did the calendar stop working on
 * Tuesday" without access to the machine. Trimmed by the retention job.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    at: integer('at', { mode: 'number' }).notNull().$defaultFn(now),
    actor: text('actor').notNull().default('system'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    /** Never contains a credential. Envelopes and tokens are redacted upstream. */
    detail: text('detail', { mode: 'json' }).$type<unknown>(),
  },
  (table) => ({
    byTime: index('audit_log_at_idx').on(table.at),
    byEntity: index('audit_log_entity_idx').on(table.entityType, table.entityId),
  }),
);

/** Pragmas applied on every connection. See open.ts for why each one. */
export const REQUIRED_PRAGMAS = sql`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`;
