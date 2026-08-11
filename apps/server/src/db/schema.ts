import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

  /**
   * How much the wall shows. Owned by the household, not by the bundle.
   *
   * A ten-inch tablet in a hallway and a 43" panel in a kitchen want different
   * answers, and so do a family with one appointment a week and one with six a
   * day. These travel in the manifest so the display reads them rather than
   * carrying an opinion nobody on site can change.
   */
  displayTodayEvents: integer('display_today_events', { mode: 'number' }).notNull().default(8),
  displayNextDays: integer('display_next_days', { mode: 'number' }).notNull().default(6),
  displayHorizonWeeks: integer('display_horizon_weeks', { mode: 'number' }).notNull().default(5),

  /**
   * Which blocks the wall draws, in order, top to bottom.
   *
   * A comma-separated list rather than a table, because it is three items with
   * no attributes of their own and a join to read them would be ceremony. A
   * block left out of the list is simply not drawn — a household that only
   * wants today and the month says so by omitting the week ahead, which is a
   * different statement from asking for zero days of it.
   */
  displayBlocks: text('display_blocks').notNull().default('now,next,horizon'),

  /**
   * Which layout the wall draws.
   *
   * `auto` is the responsive zoom-pyramid that computes portrait and landscape
   * from the block list above. `freeform` is a canvas the household arranged by
   * hand — `layout_widgets`, placed anywhere. Defaults to `auto` so an existing
   * wall is unchanged, and so a wall is never blank while a free-form layout is
   * still being built.
   */
  layoutMode: text('layout_mode').notNull().default('auto'),
  /**
   * The aspect ratio (width ÷ height) the free-form canvas was authored at.
   *
   * The wall scales that canvas to fit and letterboxes a screen of a different
   * shape, so what was dragged is what is drawn rather than reflowed into
   * something nobody arranged. 9/16 portrait by default.
   */
  layoutAspect: real('layout_aspect').notNull().default(0.5625),

  /**
   * The one thing in this product that talks to anybody else.
   *
   * Off unless the household turns it on, and it stays a check rather than an
   * update: nothing is downloaded and nothing is installed. Rule nine says
   * never brick the kitchen calendar, and an installer that runs unattended in
   * a house nobody can reach is the most direct way to break that.
   */
  updateCheckEnabled: integer('update_check_enabled', { mode: 'boolean' }).notNull().default(false),
  updateLastCheckedAt: integer('update_last_checked_at', { mode: 'number' }),
  updateLatestVersion: text('update_latest_version'),
  updateLastError: text('update_last_error'),

  /** False until the first-run wizard completes. */
  setupCompletedAt: integer('setup_completed_at', { mode: 'number' }),

  ...timestamps,
});

/**
 * A widget placed on the free-form canvas.
 *
 * Only read when `household_settings.layout_mode` is `freeform`. Each row is
 * one first-party module — never a third-party embed, which rule 3 forbids on
 * the wall — positioned in normalized coordinates so a single layout scales to
 * any resolution of the authored aspect.
 */
export const layoutWidgets = sqliteTable('layout_widgets', {
  id: text('id').primaryKey(),
  /**
   * Which wall this widget belongs to.
   *
   * Null is the shared default canvas — the layout a screen draws until it is
   * given its own. A screen's id is that screen's own canvas. A plain column
   * rather than a foreign key: SQLite cannot add one by `ALTER`, and the app is
   * the thing that keeps a widget's owner honest anyway.
   */
  screenId: text('screen_id'),
  /** The module that draws here: clock, calendar, weather, homeassistant, … */
  type: text('type').notNull(),
  /** Top-left and size, each a fraction 0..1 of the canvas. */
  x: real('x').notNull(),
  y: real('y').notNull(),
  w: real('w').notNull(),
  h: real('h').notNull(),
  /** Stacking order, low behind high. */
  z: integer('z', { mode: 'number' }).notNull().default(0),
  /**
   * Per-widget settings, as JSON this process wrote and reads back. Its shape
   * is the widget's own; validated at the boundary rather than trusted here.
   */
  config: text('config'),
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

    /**
     * Per-screen overrides. Null means follow the household setting.
     *
     * A household mostly wants one look everywhere, so null is the common case
     * and has to stay the easy one. The exceptions are real though: a screen in
     * a bedroom wants the dark theme long after the kitchen has gone light, and
     * a holiday home on another clock wants its own zone.
     */
    theme: text('theme'),
    /**
     * Dead. Superseded by the columns below plus `layout_widgets.screen_id`.
     *
     * An early per-screen layout blob that was never wired to anything. Left in
     * place because dropping a column is a table rebuild, which is the one
     * migration shape that has corrupted this database before — not worth the
     * risk for a column nothing reads. Do not start using it.
     */
    layout: text('layout', { mode: 'json' }).$type<unknown>(),
    timezone: text('timezone'),
    daytimeTheme: text('daytime_theme'),
    daytimeStartsAt: text('daytime_starts_at'),
    daytimeEndsAt: text('daytime_ends_at'),

    /**
     * The rest of the per-screen overrides. Null follows the household, exactly
     * like the theme above — a household with one wall sets none of these, and
     * that stays the easy case.
     *
     * How much to show, which blocks in what order, and — for a wall arranged
     * on the free-form canvas — its mode and aspect. The widgets themselves are
     * rows in `layout_widgets` tagged with this screen's id; a non-null
     * `layout_mode` here is what says to read *those* rather than the shared
     * default set.
     */
    displayTodayEvents: integer('display_today_events', { mode: 'number' }),
    displayNextDays: integer('display_next_days', { mode: 'number' }),
    displayHorizonWeeks: integer('display_horizon_weeks', { mode: 'number' }),
    displayBlocks: text('display_blocks'),
    layoutMode: text('layout_mode'),
    layoutAspect: real('layout_aspect'),

    /**
     * Which layout to draw, regardless of what the browser reports.
     *
     * `auto` follows the viewport, which is right until it isn't: a panel in a
     * kiosk frame can report a size that has nothing to do with how it is
     * hung, and there is nobody on site to argue with it.
     */
    orientation: text('orientation', { enum: ['auto', 'portrait', 'landscape'] })
      .notNull()
      .default('auto'),

    /**
     * Quarter turns applied to the whole wall.
     *
     * Plenty of screens are mounted sideways on purpose — a widescreen panel
     * turned on its end is the cheapest portrait wall there is — and many of
     * them cannot be rotated in their own settings, or lose the setting on
     * power loss. Rotating in the page is the one place it always sticks.
     */
    rotation: integer('rotation', { mode: 'number' }).notNull().default(0),

    /**
     * Whether this screen offers a way to acknowledge an interrupt.
     *
     * Per screen, and off by default, because it is a fact about the hardware
     * rather than about the household: a television in a hall has a remote, a
     * panel screwed to a wall in a hallway has no input at all, and a kitchen
     * tablet has a touchscreen that a passing sleeve can press. Offering a
     * control on the screen that cannot be pressed is clutter; offering one on
     * the screen that gets brushed against is worse.
     *
     * What it does *not* change is the effect. Dismissal stays household-wide
     * — the hall television acknowledges on behalf of everybody, and every wall
     * goes quiet together. This only decides which screens can do the asking.
     */
    allowDismiss: integer('allow_dismiss', { mode: 'boolean' }).notNull().default(false),

    /** Rotated when the token is regenerated, invalidating old sessions. */
    tokenIssuedAt: integer('token_issued_at', { mode: 'number' }).notNull().$defaultFn(now),
    revokedAt: integer('revoked_at', { mode: 'number' }),

    /**
     * A short pairing code a screen with no camera can type by hand.
     *
     * A television cannot scan the QR — nothing points a camera at the admin
     * page — and typing a 43-character token on a remote is the worst input
     * method in the house. So the pairing page also shows an eight-character
     * code, and this is that code, hashed. The raw code is shown once and never
     * stored, exactly like the token.
     *
     * It is deliberately weaker than the ten-year token — eight characters from
     * an unambiguous alphabet, roughly 38 bits — so it does not get the token's
     * lifetime. It is single-use (cleared the moment a screen pairs with it) and
     * time-boxed (ignored past `pairing_code_expires_at`), which bounds the
     * window in which that lower entropy is a standing target. A screen that
     * pairs by code is issued a fresh token like any other, so nothing
     * downstream can tell how it was paired.
     */
    pairingCodeHash: text('pairing_code_hash'),
    pairingCodeExpiresAt: integer('pairing_code_expires_at', { mode: 'number' }),

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
 * A calendar the household has subscribed to, by whatever route.
 *
 * Started as "a subscribed ICS feed" and grew a `kind` when Home Assistant
 * calendar entities arrived. Everything below the sync job is identical for
 * both, which is the whole reason they share a table.
 */
export const calendarSources = sqliteTable(
  'calendar_sources',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),

    /**
     * Where the events come from.
     *
     * `ics` is a subscribed feed with its own address. `homeassistant` is a
     * calendar entity on the household's own Home Assistant, which has no
     * address of its own — it is reached through the one connection configured
     * on the Home Assistant screen, with that connection's credential.
     *
     * A kind rather than a second table, so everything downstream is
     * identical: colour, whose calendar it is, visibility, health, and the
     * same expanded rows in the same cache. A separate table would mean a
     * second code path through the manifest, and the manifest is the one
     * document the wall depends on.
     */
    kind: text('kind', { enum: ['ics', 'homeassistant'] })
      .notNull()
      .default('ics'),

    /**
     * The address, for an `ics` source. Null for any other kind.
     *
     * A keyring envelope, never a URL in clear. A Google private iCal address
     * is a bearer credential that never expires, and `/data` is exactly what
     * people copy to a NAS and attach to bug reports.
     */
    urlEncrypted: text('url_encrypted'),
    /** Host only, for display and diagnostics. Never the path or the token. */
    urlHost: text('url_host'),

    /**
     * The calendar entity, for a `homeassistant` source. Null otherwise.
     *
     * In clear, deliberately: `calendar.bin_collection` is a name, not a
     * credential, and the admin screen has to show which entity a source is.
     * The credential is the token, and it lives in one place.
     */
    haEntityId: text('ha_entity_id'),

    color: text('color').notNull().default('#4C7FD1'),
    /**
     * Whose calendar this is, when it is one person's.
     *
     * Null for a shared feed — the household calendar, the bin collections —
     * which is the common case and must stay the easy one. Set, it drives the
     * per-person columns on the wall.
     */
    personId: text('person_id').references(() => people.id, { onDelete: 'set null' }),
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

    /**
     * Which source's signals this rule matches.
     *
     * Still called `trigger` because renaming a column means rebuilding the
     * table, and a rebuild on a live database is the one migration that can
     * destroy something. The *values* are the source names from the model —
     * `nws`, `homeassistant`, `calendar`, `manual` — and `readSource` accepts
     * the older spellings on the way in so nothing has to be rewritten.
     */
    trigger: text('trigger', {
      enum: ['nws', 'homeassistant', 'calendar', 'manual'],
    }).notNull(),
    /**
     * The `RuleMatch` from core, as JSON. Never queried by contents.
     *
     * One opaque column rather than a column per clause, because the clauses
     * differ per source and a table with `min_severity` and `entity_id` and
     * `starts_within_sec` side by side is a table where most cells are null.
     */
    conditions: text('conditions', { mode: 'json' }).$type<unknown>(),

    /**
     * How loudly to say it.
     *
     * `banner` is a strip above the calendar and is the right answer for
     * almost everything. `takeover` covers the wall, and is for the small set
     * of facts that are worth losing the calendar over — water on the floor,
     * a garage left open overnight. `takeover_and_wake` also lights a screen
     * that has gone dark.
     *
     * `wakeScreen` below predates this and is kept in step with it rather than
     * dropped: removing a column means rebuilding the table, and a rebuild on
     * a household's live database is a worse risk than a redundant flag.
     */
    action: text('action', { enum: ['banner', 'takeover', 'takeover_and_wake'] })
      .notNull()
      .default('banner'),

    /** Breaks ties before severity does. Higher wins. */
    priority: integer('priority', { mode: 'number' }).notNull().default(0),
    /** Whether this is allowed to wake a sleeping screen. Follows `action`. */
    wakeScreen: integer('wake_screen', { mode: 'boolean' }).notNull().default(false),
    /** Auto-dismiss after this many seconds. Null means it stays until cleared. */
    dismissAfterSeconds: integer('dismiss_after_seconds', { mode: 'number' }),

    /**
     * May this light a screen that has gone dark for the night.
     *
     * Separate from `action` because they are different questions. A household
     * may want a tornado warning to cover the wall *and* wake it, and a bin
     * reminder to cover the wall and absolutely not.
     */
    piercesNightMode: integer('pierces_night_mode', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** The signal must have held this long before the rule counts. */
    minDwellSec: integer('min_dwell_sec', { mode: 'number' }).notNull().default(0),
    /**
     * Whether somebody can clear this from the wall.
     *
     * False for the things that must not be cleared by a hand moving before
     * its owner is awake.
     */
    dismissible: integer('dismissible', { mode: 'boolean' }).notNull().default(true),
    /** Come back this long after a dismissal. Null means stay dismissed. */
    reassertAfterSec: integer('reassert_after_sec', { mode: 'number' }),

    ...timestamps,
  },
  (table) => ({
    byEnabled: index('interrupt_rules_enabled_idx').on(table.enabled, table.trigger),
  }),
);

/**
 * What somebody has cleared from the wall.
 *
 * Household-wide rather than per screen, and that is the whole design: a
 * kitchen tablet and a hall television must not disagree about whether the
 * garage is still worth mentioning. Keyed `ruleId:signalKey`, so dismissing one
 * warning does not silence the next one a different county gets.
 */
export const interruptDismissals = sqliteTable('interrupt_dismissals', {
  key: text('key').primaryKey(),
  dismissedAt: integer('dismissed_at', { mode: 'number' }).notNull().$defaultFn(now),
});

/** NWS zones or points to watch. */
export const alertZones = sqliteTable('alert_zones', {
  id: text('id').primaryKey(),
  /** e.g. `MDC013`, or a `lat,lon` point. */
  code: text('code').notNull().unique(),
  label: text('label').notNull(),
  provider: text('provider').notNull().default('nws'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /**
   * Forecast zone or county.
   *
   * A household needs both. Most alerts are issued against the forecast zone;
   * flood warnings in particular are issued by county, and watching only one
   * silently misses a category of warning.
   */
  kind: text('kind', { enum: ['forecast', 'county'] }).notNull().default('forecast'),
  /** Conditional GET state, so a quiet zone costs one 304 a minute. */
  etag: text('etag'),
  lastPolledAt: integer('last_polled_at', { mode: 'number' }),
  lastError: text('last_error'),
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

    /**
     * When this message was sent. With `external_id`, the dedupe key.
     *
     * CAP is a stream of messages rather than a state document: the same event
     * arrives repeatedly as it is updated, and only `sent` orders them. Without
     * it an out-of-order poll can put a superseded copy back on the wall.
     */
    sent: text('sent'),
    messageType: text('message_type').notNull().default('Alert'),

    event: text('event').notNull(),
    headline: text('headline'),
    /** The body. Capped and stripped of control characters before it lands. */
    description: text('description'),
    /** What to actually do. The most useful line, and often the longest. */
    instruction: text('instruction'),
    /** Which counties or zones it covers, in the office's own words. */
    areaDesc: text('area_desc'),
    /** The issuing office, e.g. `NWS Baltimore/Washington`. */
    senderName: text('sender_name'),
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
// Third-party modules (docs/rfc-001-module-framework.md).
//
// A module is its own HTTP service the household registered by URL. The server
// polls it through the SSRF-guarded fetcher, validates the body against the
// Panel Data Schema, and caches it here. Nothing the module returns is ever
// executed — data crosses the boundary, code never does.
// ---------------------------------------------------------------------------

export const externalModules = sqliteTable('external_modules', {
  id: text('id').primaryKey(),
  /** The module's base URL; its `/panel` and `/maverick.json` hang off it. */
  url: text('url').notNull(),
  /** Shown to the household; from the module's manifest, or a fallback. */
  name: text('name').notNull(),
  /**
   * The block key on the wall, always `ext:<id>` so it can never collide with a
   * first-party block. Stored so the manifest and `display_blocks` agree.
   */
  blockKey: text('block_key').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /**
   * `service` (RFC 001 — a module the household runs, polled over HTTP) or
   * `recipe` (RFC 002 B1 — a declarative fetch-and-transform Maverick Wall runs
   * itself). Defaults to `service` so every existing row keeps its meaning.
   */
  kind: text('kind').notNull().default('service'),
  /** For a recipe row: its manifest, as JSON this process validated and wrote. */
  recipe: text('recipe', { mode: 'json' }).$type<unknown>(),
  /** For a recipe row: the household's filled-in config values. */
  config: text('config', { mode: 'json' }).$type<unknown>(),
  /**
   * For a recipe with `secrets`: the household's credential values, **encrypted
   * at rest** (one keyring envelope over a JSON `{key: value}`, purpose
   * `recipe-secret`). Never plaintext, never in the manifest, never logged.
   */
  secrets: text('secrets'),
  /** Order among external panels. Built-in blocks keep their own ordering. */
  sortOrder: integer('sort_order', { mode: 'number' }).notNull().default(0),
  /** Last validated Panel Data, as JSON this process wrote. */
  panel: text('panel', { mode: 'json' }).$type<unknown>(),
  /**
   * Last validated signals the module offered the interrupt evaluator, as JSON
   * this process wrote. Distinct from `panel`: a signal is a fact the rules can
   * match on, not a block on the wall. Null until a `/signals` poll succeeds.
   */
  signals: text('signals', { mode: 'json' }).$type<unknown>(),
  /**
   * What this module is allowed to do to the wall when one of its signals is
   * true: `none` (the default — a module raises nothing until the household
   * says so), `banner`, or `takeover`. Deliberately never `takeover_and_wake`:
   * a third-party module may not light a dark bedroom, which is reserved for
   * genuine safety like a tornado warning. The household sets this per module.
   */
  alertsAction: text('alerts_action').notNull().default('none'),
  lastPolledAt: integer('last_polled_at', { mode: 'number' }).notNull().default(0),
  /** The last poll's failure, for the health line on the module's card. */
  lastError: text('last_error'),
  ...timestamps,
});

// The `catalog_sources` table (remote community catalogues, 0.13.0) was removed
// when the store became a single in-repo catalogue. Migration 0020 drops it.

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

    /**
     * How to draw it.
     *
     * One widget with four shapes rather than four widgets: the design is
     * typographic, and a grid of tiles is the Lovelace this integration is
     * deliberately not competing with.
     */
    displayMode: text('display_mode', {
      enum: ['value', 'label_value', 'icon_state', 'presence'],
    })
      .notNull()
      .default('label_value'),
    /**
     * What the household calls it, when the entity's own name is wrong.
     *
     * "Sensor Temperature Kitchen 2" is what an integration named it; "Kitchen"
     * is what it is. Null means use the friendly name.
     */
    label: text('label'),
    sortOrder: integer('sort_order', { mode: 'number' }).notNull().default(0),
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
