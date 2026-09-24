import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

  /**
   * IANA zone. Anchors every all-day event and the whole shift rotation.
   *
   * Must equal `DEFAULT_TIMEZONE` in `src/timezone.ts`. This column, the
   * manifest's no-row fallback and the wizard's preselect are three answers to
   * one question and they used to disagree — a fresh `docker run` booted on
   * `America/New_York` and offered `Etc/UTC` on the screen that chooses it.
   *
   * Written as a literal rather than imported because drizzle-kit transpiles
   * this file to CJS at generate time and cannot resolve an ESM `.js`
   * specifier out of it. So the drift is caught by a test instead:
   * `test/timezone-default.test.ts` runs the real migrations and reads the
   * default straight back out of SQLite.
   */
  timezone: text('timezone').notNull().default('Etc/UTC'),
  locale: text('locale').notNull().default('en-US'),

  /*
   * No theme, and no daylight theme or window, deliberately (RFC 015 phase 2).
   *
   * Four columns used to sit here — `theme` defaulting to `board`, a key that
   * had not named a theme for releases, `daytime_theme`, `daytime_starts_at`
   * and `daytime_ends_at`. They were the household *default* every wall
   * inherited, and the default was the thing that let five other mechanisms
   * decide a wall's colour without anybody seeing it (RFC 015 §2.8). A wall
   * names its own theme now — `screens.theme`, enforced by the CHECK on that
   * table — and there is nothing behind it to fall back to. Dropped by `0045`,
   * which is four `ALTER TABLE … DROP COLUMN` rather than a recreate.
   */

  /** Latitude and longitude for weather and alerts. Null until setup runs. */
  latitude: integer('latitude', { mode: 'number' }),
  longitude: integer('longitude', { mode: 'number' }),

  /** Feature switches. A household with no shift worker never sees any of it. */
  shiftEnabled: integer('shift_enabled', { mode: 'boolean' }).notNull().default(false),
  weatherEnabled: integer('weather_enabled', { mode: 'boolean' }).notNull().default(true),
  /**
   * Which forecast provider draws the strip. `nws` is the US National Weather
   * Service (the original, US-only); `openmeteo` is Open-Meteo, key-less and
   * worldwide. Defaults to `nws` so an existing US wall is untouched. Alerts are
   * a separate matter and stay NWS-only — Open-Meteo has no alert feed.
   */
  weatherProvider: text('weather_provider').notNull().default('nws'),
  /**
   * `imperial` (°F) or `metric` (°C). NWS answers in Fahrenheit regardless;
   * this is what a worldwide provider is asked for. Defaults to `imperial` to
   * match what NWS installs already show.
   */
  weatherUnits: text('weather_units').notNull().default('imperial'),
  /**
   * Whether to ask Open-Meteo's air-quality service for a reading (plan item
   * P3.8). Off by default, and that is the decision rather than a timid
   * default (Q5): it contacts a second host, `air-quality-api.open-meteo.com`,
   * whichever provider draws the forecast, so turning it on is the consent —
   * the update check's rule, one switch along.
   */
  airQualityEnabled: integer('air_quality_enabled', { mode: 'boolean' }).notNull().default(false),
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
   * 24-hour clock on the wall. Default 1 (24-hour), which is what the wall has
   * always drawn — so an existing install is unchanged; a household can turn it
   * off for a 12-hour reading (RFC 005).
   */
  clock24: integer('clock_24').notNull().default(1),

  /**
   * Which day the month grid and week columns start on: `sunday` or `monday`.
   *
   * Default `sunday` — the common convention for a wall calendar in most of the
   * world it ships to, and the value an upgrading database is filled with on the
   * ADD COLUMN (so every existing wall moves to Sunday-start, then a household
   * can pick Monday on the Display screen). The grid start and the weekday
   * headers both key off this; nothing else about the month changes.
   */
  weekStart: text('week_start').notNull().default('sunday'),

  /**
   * Vestigial. The wall draws one layout now — a free-form canvas of widgets —
   * so `layout_mode` is no longer read (`buildLayout` always emits `freeform`).
   * The responsive "auto" zoom-pyramid it used to select was retired when every
   * wall was migrated onto the Classic template (`backfillClassic`). Kept as a
   * column so no migration has to rewrite it; ignored everywhere.
   */
  layoutMode: text('layout_mode').notNull().default('auto'),
  /**
   * One-shot marker: has this database been migrated off the old "auto" stacked
   * layout onto the Classic free-form template? `backfillClassic` sets it to 1
   * the first time it runs and never touches the layout again, so a household
   * that later empties a canvas is not re-seeded. Additive, defaults to 0 so an
   * upgrading database is backfilled exactly once on its next boot.
   */
  layoutBackfilled: integer('layout_backfilled').notNull().default(0),
  /**
   * One-shot marker: has the shared "Default wall" been retired?
   *
   * That canvas was two things at once — the layout a wall drew until it had
   * one of its own, and a display the household could design. The second is
   * gone: a wall picks its own starting layout when it is paired, and every
   * screen-creating path seeds one, so nothing needs a shared canvas to fall
   * back to and nothing in the admin offers one to arrange.
   *
   * Retiring it cannot just stop reading the row, because a wall that was
   * *inheriting* it would go blank (rule nine). `retireDefaultWall` copies it
   * onto every screen that had no canvas of its own, once, and sets this. The
   * household's own widgets are left where they are rather than deleted:
   * `effectiveDisplay` still falls back to them for a screen that somehow has
   * none, which after this can only be a row nothing in this codebase writes.
   *
   * Additive, defaults to 0 so an upgrading database is retired exactly once on
   * its next boot.
   */
  defaultWallRetired: integer('default_wall_retired').notNull().default(0),
  /**
   * The aspect ratio (width ÷ height) the free-form canvas was authored at.
   *
   * The wall scales that canvas to fit and letterboxes a screen of a different
   * shape, so what was dragged is what is drawn rather than reflowed into
   * something nobody arranged. 9/16 portrait by default.
   */
  layoutAspect: real('layout_aspect').notNull().default(0.5625),
  /**
   * The aspect ratio the *landscape* free-form canvas was authored at.
   *
   * A display authors two canvases and the wall draws the one matching how it
   * is hung (RFC 005). `layout_aspect` above is the portrait canvas's; this is
   * the landscape one's. 16/9 by default. Additive so an existing wall keeps
   * its one canvas as the portrait side and letterboxes it onto landscape until
   * a landscape canvas is arranged.
   */
  layoutLandscapeAspect: real('layout_landscape_aspect').notNull().default(1.7778),
  /**
   * The canvas background, per orientation, as JSON this process wrote (RFC 005
   * Phases 3 and 3b): a solid colour, a two-stop gradient, or an uploaded image
   * by its stored name. Null is no background — the theme's
   * own wall colour shows through, which is what every existing wall has. The
   * shape is validated at the editor boundary; read back defensively here.
   */
  layoutBackground: text('layout_background'),
  layoutLandscapeBackground: text('layout_landscape_background'),

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
  /**
   * Which of the display's two canvases this widget is on.
   *
   * A display authors a portrait and a landscape canvas (RFC 005); the wall
   * draws the one matching how it is hung. Defaults to `portrait` so every
   * widget from before this column existed is read as part of the portrait
   * canvas — the aspect those rows were authored at.
   */
  orientation: text('orientation').notNull().default('portrait'),
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
  /**
   * Which of the wall's *scheduled* canvases this widget is on (RFC 014 §5.2).
   *
   * A wall may hold several named canvases per orientation and draw the one
   * the household's clock selects — a school-morning arrangement from 06:30 to
   * 08:30, the everyday one otherwise. **Null is the default canvas**, which is
   * every row that existed before this column did and every row a wall that
   * has never been scheduled writes: the migration adds the column and touches
   * nothing, so a canvas already hanging reads exactly as it did. A named slot
   * is a short lower-case name (`layout-slots.ts` is the rule), bounded per
   * screen there rather than here because a `CHECK` cannot count rows.
   *
   * The schedule that picks between them is `layout_schedule`, below. Read
   * with `IS ?` like `screen_id`, because `= NULL` matches nothing.
   */
  slot: text('slot'),
  /**
   * The group this widget sits inside (RFC 014 §5.1), or null for a widget
   * placed on the canvas itself — which is every row that existed before this
   * column did, and every row the editor writes until it can make a group.
   *
   * When set, `x`/`y`/`w`/`h` are fractions of the **parent's** box and `z` is
   * relative to the parent; a group in `row`, `column` or `grid` layout ignores
   * those fractions and lays its children out from their `z` order, so they are
   * kept only so an ungroup later can put the boxes back where they were.
   * Nesting is one level: a row of type `group` never carries a parent (the
   * schema refuses it, the way `ink.ink` is refused, and the manifest walker
   * refuses it a second time), and a child whose parent is missing is dropped
   * rather than orphaned onto the canvas. A plain column rather than a foreign
   * key, for the reason `screen_id` above is: SQLite cannot add one by `ALTER`,
   * and the app keeps the link honest — a group's children share its screen,
   * orientation and slot, so every sweep that removes a canvas takes them too.
   */
  parentId: text('parent_id'),
  /**
   * This widget's own CSS (RFC 014 §7), as the household typed it, and the
   * same text read and scoped by `api/custom-css.ts` at save time — which is
   * the text the manifest carries and the wall inserts. Two columns rather
   * than one because the two are read by two different readers: the Advanced
   * page echoes the household's own text into its textarea, comments and all,
   * and the wall is handed the compact, scoped output; parsing at render time
   * to derive the second from the first is the one thing the RFC forbids.
   *
   * **Null is no CSS**, which is every row that existed before the column did
   * and every row the editor writes: the migration adds the two and touches
   * nothing, and the manifest spreads an absent block away rather than
   * emitting a null, so a household who never opens the page sends the
   * document they sent before, byte for byte. A layout save from the editor
   * does not carry either — `replaceLayout` keeps them by widget id across
   * the rewrite, so arranging a wall cannot silently discard its CSS.
   */
  customCss: text('custom_css'),
  customCssScoped: text('custom_css_scoped'),
  ...timestamps,
});

/**
 * When a wall draws which of its named canvases (RFC 014 §5.2).
 *
 * One row per window: between `from_hhmm` and `to_hhmm` in the wall's own
 * zone, draw the canvas named `slot` instead of the default. The window wraps
 * past midnight exactly as the daylight theme's and an interrupt rule's do —
 * `from > to` is "from tonight until tomorrow morning" — and the two are
 * validated by the same all-or-nothing rule at the boundary. Outside every
 * window, or for a slot with no canvas in the orientation the wall is hung
 * at, the default canvas draws: never a blank (rule nine).
 *
 * `position` is the order the household wrote the rows in, and the first
 * window containing the moment wins, so two overlapping rows are not an
 * error and never an empty wall. The whole table travels in the manifest,
 * because the wall has to swap at the boundary offline, from its stored copy.
 * A plain `screen_id` rather than a foreign key, for the reason
 * `layout_widgets.screen_id` gives: `deleteScreen` and `clearLayout` sweep
 * it themselves.
 */
export const layoutSchedule = sqliteTable(
  'layout_schedule',
  {
    id: text('id').primaryKey(),
    screenId: text('screen_id').notNull(),
    position: integer('position', { mode: 'number' }).notNull(),
    slot: text('slot').notNull(),
    fromHhmm: text('from_hhmm').notNull(),
    toHhmm: text('to_hhmm').notNull(),
    ...timestamps,
  },
  (table) => ({
    byScreen: uniqueIndex('layout_schedule_screen_position_idx').on(table.screenId, table.position),
  }),
);

/**
 * A household-authored display theme.
 *
 * The four built-in directions (Board / Slate / Almanac / Glance) live in the
 * display bundle's `theme.ts` as code; this table is only the *custom* themes a
 * household builds. A theme is a token set — the base colours plus `--radius`
 * (and, later, font choices) — stored as JSON this process wrote and validated
 * with Zod on the way in. The derived tints (`--s-*-tint`) are computed at
 * resolve time from the base hues, not stored, so the source of truth stays the
 * handful of colours the household actually chose.
 *
 * Referenced from `household_settings.theme` / `screens.theme` as `custom:<id>`;
 * a built-in keeps its bare key. Resolving an unknown id falls back to Board
 * rather than blanking a wall (rule nine).
 */
export const themes = sqliteTable('themes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokens: text('tokens', { mode: 'json' }).$type<Record<string, string>>().notNull(),
  /**
   * The built-in shape this theme borrows (RFC 014 §4.3) — one of
   * `panels`/`household`/`blueprint`/`almanac`/`swiss`, or null for a theme
   * that has never set one. Null and `'neutral'` both resolve to the `board`
   * sentinel at read time (`apps/server/src/api/themes.ts`), so a theme
   * created before this column existed draws exactly what it always drew.
   */
  shape: text('shape'),
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
     * What kind of device draws this screen (RFC 006).
     *
     * `browser` is a wall running the display bundle — it fetches `/d/manifest`
     * and renders. `epaper` is a low-power e-paper panel that cannot run a
     * browser at all: the server renders a finished image for it and serves it
     * from `/d/epaper/<token>`, and the device (or Home Assistant, for a BLE
     * tag) only blits it. Default `browser` so every existing wall is untouched
     * and nothing has to be migrated.
     */
    kind: text('kind', { enum: ['browser', 'epaper'] })
      .notNull()
      .default('browser'),

    /**
     * The e-paper panel's facts, in device pixels, in its native (landscape)
     * scan orientation. Null on a `browser` screen, which has no fixed panel.
     *
     * `rotation` (below) is applied to the rendered frame *before* it is packed
     * for the controller, so these are always the panel's own width and height,
     * not the mounted orientation. `colour` decides the encoding: `bw` is one
     * 1-bit plane (the first target, a Seeed 7.5"), `bwr` adds a red plane,
     * `spectra6` is the six-colour panel — see the RFC for which are built.
     */
    panelWidth: integer('panel_width', { mode: 'number' }),
    panelHeight: integer('panel_height', { mode: 'number' }),
    panelColour: text('panel_colour', { enum: ['bw', 'bwr', 'spectra6'] }),

    /**
     * The theme this wall draws (RFC 015 phase 2).
     *
     * A browser wall names its own and cannot be inserted without one: the
     * `CHECK` below (`kind = 'epaper' OR theme IS NOT NULL`) is the
     * enforcement, so every door that creates a wall answers the question at
     * the engine rather than at a reviewer. Nullable in *type* because an
     * e-paper panel is a row in this same table and draws one bit — it has no
     * theme to name, and a `NOT NULL` here would make it store a colour it
     * cannot draw. There is no household theme behind this any more; a null
     * on a browser wall is not "follow the household", it is refused.
     *
     * The daylight theme and its window below stay per-screen and nullable:
     * null there is a real answer — the same theme all day — not a fallback.
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
    /** 24-hour clock override; null follows the household (RFC 005). */
    clock24: integer('clock_24'),
    layoutMode: text('layout_mode'),
    /**
     * Whose canvas this screen draws when `layout_mode` is `follow`.
     *
     * A screen id, or null for the Default display's canvas. Only an e-paper
     * panel is offered it: a panel that follows a wall draws the household's
     * *arrangement* rather than a copy of it, which is what makes the per-widget
     * `ink` override worth having — one canvas, two media, instead of two
     * canvases that drift apart the first time somebody moves a box.
     *
     * A plain column, like `screen_id` on `layout_widgets` and for the same
     * reason: SQLite cannot add a foreign key by `ALTER`. A screen that has been
     * revoked or deleted since simply reads as a canvas with no widgets, which
     * falls back to the built-in layout (rule nine) rather than to a blank panel.
     */
    layoutFollows: text('layout_follows'),
    layoutAspect: real('layout_aspect'),

    /**
     * How much room this wall leaves between the boxes on its canvas, as a
     * step on the spacing scale (RFC 014 §4.4).
     *
     * `0` to `4`, resolving to `0`, `--s1` … `--s4` — the gutter measured
     * between two adjacent boxes' *content*, which on a tiled canvas is twice
     * the `.fw` padding and nothing else. It is one number for the whole
     * screen rather than one per orientation, because how airy a wall reads is
     * a fact about the wall and not about which way up it happens to be drawn.
     *
     * **Null is what the wall drew before this column existed**, and that has
     * to stay the cheap case: `manifestEtag` hashes the serialisation, so this
     * is spread into the manifest rather than emitted as
     * `"layoutGutter": null`, exactly as the three millimetre columns above
     * are. Null and an explicit `4` draw the identical wall — `.fw`'s padding
     * is `calc(var(--s4) / 2)` today and the step-4 gutter is `--s4` — so the
     * settings control can honestly check `Normal` on a wall that has never
     * been asked, with nothing on the glass changing when it is saved.
     *
     * The top step is today's value and not a step airier, and that is the
     * scale rather than an oversight: the gutter here is drawn *as the widget
     * box's own padding*, and the spacing scale's second permission is that a
     * widget box spends at most step 4, total, per axis. A step-5 gutter would
     * be canvas spacing spent out of the widget's budget. Going airier than
     * today means giving the canvas room the boxes do not own, which is a
     * layout change rather than a spacing one.
     *
     * Read by the browser wall only. An e-paper panel draws its own metrics
     * (`epaper/metrics.ts`, every number arithmetic on the panel) and never
     * reads this — see the note at `PANEL_IGNORES` for why it is in neither
     * honours table.
     */
    layoutGutter: integer('layout_gutter', { mode: 'number' }),
    /**
     * The colours, faces, weight, tracking and inset every widget on this
     * wall starts from, as JSON in the shape of a widget's own `style` lane
     * (`api/widget-style.ts`, RFC 014 §4.1 / §4.4). Applied on the canvas so
     * every box inherits it, and a widget's lane overrides it token by token.
     *
     * **Null is what the wall drew before this column existed**, spread out
     * of the manifest rather than emitted — the `layout_gutter` argument
     * above, verbatim: `manifestEtag` hashes the serialisation. Read by the
     * browser wall only; a panel draws one bit at its own geometry and reads
     * a widget's own `style.inset` alone (see the note at `PANEL_IGNORES`).
     */
    layoutStyle: text('layout_style'),
    /**
     * The wall's own CSS (RFC 014 §7): what the household typed, and the same
     * text read and scoped under `.canvas` at save time by `api/custom-css.ts`,
     * which is what the manifest carries. The `layout_widgets` pair above
     * says why there are two and why null is what every wall drew before.
     * Read by the browser wall only; a panel draws one bit from its config
     * and never reads a stylesheet (`PANEL_IGNORES` carries the sentence).
     */
    customCss: text('custom_css'),
    customCssScoped: text('custom_css_scoped'),
    /** The landscape canvas's aspect; null follows the household (RFC 005). */
    layoutLandscapeAspect: real('layout_landscape_aspect'),
    /** Per-orientation canvas background as JSON; null is none (RFC 005 Phase 3). */
    layoutBackground: text('layout_background'),
    layoutLandscapeBackground: text('layout_landscape_background'),

    /**
     * The viewport this screen last reported, in device pixels (RFC 005).
     *
     * The wall sends its `window.innerWidth`/`innerHeight` on each manifest poll,
     * so the layout editor can offer "match this screen's real size" instead of
     * only aspect presets. Null until a paired wall has checked in at least once;
     * it is a convenience, never depended on to draw.
     */
    reportW: integer('report_w', { mode: 'number' }),
    reportH: integer('report_h', { mode: 'number' }),

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
     * How large this screen is, and how far away somebody stands to read it.
     *
     * The same kind of fact as `rotation` and `orientation` above, and here for
     * the same reason: a kitchen tablet and a hall television are not the same
     * hardware, and nothing else in this database says so. Everything that
     * decides whether a name on the wall can be *read* — a type floor, a
     * minimum scale, how many rows a cell can spend — needs an angle rather
     * than a pixel count, and an angle needs these two numbers. Without them
     * every such decision is a constant measured on one screen and defended on
     * all the others: 22px is about six arc-minutes of cap height on a 32"
     * panel at ten feet, which is at the acuity limit for a word somebody
     * already expects and nowhere near fluent reading.
     *
     * Millimetres, whole, and **as the panel is mounted** — width across the
     * wall, height down it. That is deliberately not the convention
     * `panel_width`/`panel_height` above use, which are device pixels in the
     * panel's own native scan orientation; these are what a person measures
     * with a tape while standing in front of it. A screen hung sideways has
     * its long side vertical, and the household is not going to re-measure
     * because they changed a rotation, so the derivation reconciles the pair
     * against the frame it is actually drawing rather than trusting the order
     * they were stored in (`pxPerArcminute` in the display's `orientation.ts`).
     *
     * `read_distance_mm` is separate from the size on purpose, because it is a
     * fact about the room rather than about the panel: the same 32" television
     * in a hall and in a kitchen is read from different places. It means where
     * somebody stands to *read* a name, not where they glance at it from the
     * doorway — a wall sized for the doorway is a wall nobody can read from
     * either place.
     *
     * Null on all three is the common case and must stay the cheap one: a
     * household that never opens this setting draws exactly what it drew
     * before, byte for byte. They are also all-or-nothing — two of the three
     * derive nothing — so anything downstream reads them as a set or not at
     * all.
     */
    panelWidthMm: integer('panel_width_mm', { mode: 'number' }),
    panelHeightMm: integer('panel_height_mm', { mode: 'number' }),
    readDistanceMm: integer('read_distance_mm', { mode: 'number' }),

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

    /**
     * Whether this screen may tick a chore off (RFC 008 phase 3).
     *
     * The same argument as `allow_dismiss`, one control along, and off by
     * default for the same reason: it is a fact about the hardware. A tablet at
     * elbow height in a kitchen is exactly what this is for; a panel behind
     * glass in a hallway has nothing to press it with, and a screen a coat
     * sleeve brushes past would mark the bins as done every time somebody
     * walked through.
     *
     * The *effect* stays household-wide, again like dismissal: one completion
     * row keyed on the chore and the day, so a kitchen tablet and a hall
     * television can never disagree about whether the bins went out. This only
     * decides which screens may do the asking.
     *
     * Separate from `allow_dismiss` rather than one "this screen accepts input"
     * flag, because the two are not the same risk. Clearing a tornado warning
     * is a household saying it has read something; ticking a chore is a claim
     * about the world that somebody may act on. A household can reasonably want
     * one and not the other.
     */
    allowChores: integer('allow_chores', { mode: 'boolean' }).notNull().default(false),

    /**
     * Whether this screen may tick an item off a Home Assistant to-do list
     * (RFC 012 phase 2).
     *
     * **Unread in phase 1.** Nothing selects it, nothing draws a control from it
     * and no form sets it; it lands here so the feature costs one migration
     * rather than two, and so the column a household's wall already carries is
     * the one the write endpoint reads when it arrives. Off by default for the
     * same reason as its two neighbours: it is a fact about the hardware.
     *
     * A third switch rather than a widening of `allow_chores`, because the three
     * are not the same risk. Clearing a warning is a household saying it has
     * read something; ticking a chore is a claim about the world recorded in
     * this database; ticking a to-do item changes data *outside* this
     * application, on a list the household's phones are synced to. A household
     * can reasonably want any two of the three and not the third.
     */
    allowTodo: integer('allow_todo', { mode: 'boolean' }).notNull().default(false),

    /**
     * Whether this screen's frame answers only a connection from the
     * household's own network.
     *
     * The eInk frame (`/d/epaper/:file`) carries its token in the URL path
     * rather than an `HttpOnly` cookie, because a dumb panel cannot hold one —
     * and a URL is the one credential in this product that a household is
     * expected to hand-copy into a device's own config. That makes it more
     * likely than a wall's cookie to end up somewhere with weaker access
     * control than this app: a forum post, a committed dotfiles repo, a
     * screenshot. This does not change the token itself — guessing it is
     * still infeasible either way — it bounds what a *leaked* one is worth:
     * off the household's network, a correct token still gets refused.
     *
     * Off by default (rule nine: a household whose panel fetches its picture
     * across a relay — a cloud-hosted Home Assistant, or a frame URL that
     * leaves the network and comes back through a tunnel — must not have it go
     * dark because a setting they never opened assumed their network shape).
     * That is narrower than it reads, and the admin copy says so: what is
     * judged is the *frame request*, so reaching Home Assistant's own UI from
     * outside over Nabu Casa or a VPN does not bear on it at all. Per screen,
     * like `rotation` and `allow_dismiss` above: a fact about how *that* panel
     * is reached, not a household-wide policy.
     *
     * Enforced against the visitor resolved by `resolveFrameSource` — the
     * socket, or the first `X-Forwarded-For` entry when and only when the
     * socket is a household-configured `TRUSTED_PROXY_SOURCE`, since a
     * forwarded header from anywhere else is exactly what this must not trust
     * — classified with the SSRF guard's own address classifier. An address
     * that cannot be determined fails closed. Deliberately not applied to the
     * browser wall's `/d/manifest` — its cookie cannot leave a browser the way
     * an eInk URL leaves a device, so extending this there is a separate
     * decision.
     */
    lanOnly: integer('lan_only', { mode: 'boolean' }).notNull().default(false),

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

    /**
     * Whether the last eInk frame request could be traced to a real visitor,
     * or only to something forwarding on their behalf (`ForwardingNote` in
     * `http/lan-guard.ts`; null when there is nothing to say).
     *
     * It exists because the admin cannot observe this for itself. `lan_only`
     * is judged on the address a *panel's* request arrives from, and the
     * household reads the setting on a different request entirely — from a
     * browser, through ingress or the LAN — which carries none of the headers
     * that decide it. So the observation is recorded where it is made, and the
     * settings page reads it back. Without it the only honest warning would be
     * "if you use a reverse proxy this may do nothing", shown to everybody
     * forever, which is the weak version nobody acts on.
     *
     * Written on every frame request including a refused one — a panel that
     * has gone dark *because* of the restriction is exactly when a household
     * needs the reason — and deliberately not part of `last_seen_*` above,
     * which is set after a successful render and answers a different question.
     */
    lastSeenForwarding: text('last_seen_forwarding'),

    ...timestamps,
  },
  (table) => ({
    byToken: uniqueIndex('screens_token_hash_idx').on(table.tokenHash),
    /*
     * Every wall that draws colour names its own theme (RFC 015 §3.3). A
     * `CHECK` rather than `NOT NULL` because a panel is a row here too and
     * has none to name. SQLite cannot add a constraint by `ALTER`, so this
     * cost a table recreate (`0045`) — the `0009` shape, whose `INSERT …
     * SELECT` was read column by column against the snapshot before it ran.
     */
    wallNamesTheme: check('screens_wall_names_theme', sql`"kind" = 'epaper' OR "theme" IS NOT NULL`),
  }),
);

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

/**
 * One CalDAV credential, and the several calendars it reaches (RFC 013 §6.2.1).
 *
 * The one place CalDAV does not fit the shape `calendar_sources` already has.
 * An ICS feed is one URL to one calendar and that table is exactly that; a
 * CalDAV account is **one credential to many calendars** — a household types an
 * Apple ID and one app-specific password, and what comes back is Home, Work,
 * Kids' school and Birthdays. Three of those go on the wall, in different
 * colours, with Work off the month grid.
 *
 * Asking of every existing column whether it is a fact about the *account* or
 * about the *calendar* splits them cleanly, and almost everything was already
 * in the right place. `name`, `color`, `person_id`, `visible`, `show_in_grid`,
 * the CTag, every health column and the collection href are per calendar. Only
 * three things had nowhere correct to live, and they are this table: the
 * username and password, the three network opt-ins (it is one server), and the
 * URLs discovery resolved once.
 *
 * **What decides it is password rotation**, not tidiness. Apple app-specific
 * passwords get regenerated, and under a flat scheme — each calendar row
 * carrying its own copy of the same envelope — a household then has to edit
 * four rows with the same new password. Miss one and a single calendar
 * silently stops syncing, which presents as "one of my calendars stopped
 * updating": about the hardest fault for a household to describe and for
 * `diagnose-source` to be pointed at. `caldav-account.test.ts`'s rotation case
 * — three calendars, one password change, all three sync — is the whole
 * argument of this table written as an assertion, and under a flat scheme it
 * fails on two of the three.
 *
 * The second argument is the add flow: "here is your account, here are its
 * calendars, tick the ones you want" has nowhere to come back from if the
 * account is not a row. A household who adds three calendars in March and
 * wants a fourth in June would otherwise have to retype the password, because
 * there is nothing to reopen.
 *
 * **Rejected: one `calendar_sources` row per account**, drawing all its
 * calendars. It gives a whole account one colour, one person and one
 * `show_in_grid`, which breaks the column that exists to fix the standup fault.
 *
 * **The premise, checked rather than assumed.** All of this rests on households
 * ending up with more than one calendar per CalDAV account. §11 puts that in
 * front of a real account *before* this table is written, because it is cheap
 * to reopen now and expensive afterwards; it was confirmed before this file
 * changed.
 *
 * **Removing an account's last calendar removes the account and its
 * credential** (`api/caldav-accounts.ts`). An orphaned credential is a stored
 * secret nothing uses, which is the spirit of rule six. A household wanting a
 * calendar back temporarily has `enabled` and `visible`; removal is removal.
 */
export const caldavAccounts = sqliteTable('caldav_accounts', {
  id: text('id').primaryKey(),

  /**
   * The address the household typed, as a keyring envelope.
   *
   * Encrypted for the same reason `calendar_sources.url_encrypted` is, and the
   * same reason applies less forcefully here rather than not at all: a CalDAV
   * server address on its own fetches nothing without the password beside it,
   * so this is not a bearer credential the way a Google secret iCal address is.
   * It is encrypted anyway because it is the one column that says *where a
   * household's family calendar lives*, and `/data` is exactly what people copy
   * to a NAS and attach to bug reports. `server_host` below is the clear copy
   * anything that has to display or diagnose reads.
   */
  serverUrlEncrypted: text('server_url_encrypted').notNull(),
  /** Host only, in clear, for the settings row and for diagnostics. */
  serverHost: text('server_host'),

  /**
   * The account, in clear.
   *
   * The same argument `calendar_sources.auth_username` makes and with the same
   * exception attached: a CalDAV username is very often an **email address** —
   * on iCloud it always is — which is exactly what `api/diagnostics.ts`
   * promises its export contains none of. So this column is left out of that
   * projection entirely, and the test that stuffs a database with personal data
   * and asserts none of it survives seeds one of these too.
   */
  username: text('username').notNull(),
  /**
   * The app-specific password. A keyring envelope, purpose `caldav-password`.
   *
   * Its own purpose rather than a second use of `feed-password`, for the reason
   * the keyring binds purposes into the ciphertext at all: without the split, a
   * feed's password could be swapped into this column and would still decrypt.
   *
   * It is never echoed back to a form, never formatted into `last_error`, and
   * never printed by a CLI tool — including across §6.3.1's confirmation round
   * trip, where it is not echoed because it does not cross it.
   */
  passwordEncrypted: text('password_encrypted').notNull(),

  /**
   * What discovery resolved, once, at add time.
   *
   * Storing these is what turns RFC 6764's four-request chain into a setup cost
   * rather than a per-poll one, which is the difference between CalDAV being
   * viable here and not. Sync afterwards is one `REPORT` per calendar and
   * touches neither.
   */
  principalUrl: text('principal_url'),
  homeSetUrl: text('home_set_url'),

  /**
   * A host the household has been shown and accepted (§6.3.1). Null when
   * discovery never left the host they typed, which is every self-hosted
   * server.
   *
   * The discovery chain is server-directed twice, and we attach the household's
   * password to every hop after the first — so "follow the discovery wherever
   * it points and send the credential there" is a credential-disclosure
   * primitive the SSRF guard has nothing to say about. It cannot simply be
   * refused, because iCloud requires exactly that move: `caldav.icloud.com` is
   * what a household types and `pNN-caldav.icloud.com` is where their calendars
   * are. So: same host is silent, a different host is confirmed once and stored
   * here, and every sync after reads this and asks nothing again.
   *
   * **One host, not a list.** The chain moves at most once in practice, and a
   * list is a thing that grows by one silently every time a server points
   * somewhere new.
   */
  confirmedHost: text('confirmed_host'),

  /**
   * The three network opt-ins, on the account because it is one server.
   *
   * The same deliberate per-source decisions `calendar_sources` carries, made
   * once on the screen where somebody is already paying attention rather than
   * as a global rule nobody sees. They are what `connectionFor` builds a
   * `UrlPolicy` out of, which is why a header-only resolver would have been
   * wrong: the switches would have been read from the calendar row for Phase A
   * and from here for Phase C, by two callers, which is the drift §6.2.2 exists
   * to prevent.
   */
  allowPrivateNetwork: integer('allow_private_network', { mode: 'boolean' })
    .notNull()
    .default(false),
  allowLoopback: integer('allow_loopback', { mode: 'boolean' }).notNull().default(false),
  allowHttp: integer('allow_http', { mode: 'boolean' }).notNull().default(false),

  /**
   * The last thing that went wrong for the *account* rather than for one
   * calendar — a password that stopped being accepted, which is the fault that
   * hits all of them at once.
   *
   * Per-calendar health stays on `calendar_sources`, because one calendar
   * failing must not read as the account being down.
   */
  lastError: text('last_error'),

  ...timestamps,
});


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
     * `caldav` is one collection on a CalDAV server, reached with the
     * credential on `caldav_accounts` rather than with one of its own. It is a
     * third kind rather than a flag on `ics` because the *transport* is
     * different all the way down — a `PROPFIND` for the CTag and a `REPORT`
     * for the events, against one `VCALENDAR` per resource — while everything
     * above the sync job is identical.
     *
     * A kind rather than a second table, so everything downstream is
     * identical: colour, whose calendar it is, visibility, health, and the
     * same expanded rows in the same cache. A separate table would mean a
     * second code path through the manifest, and the manifest is the one
     * document the wall depends on.
     *
     * **Widening this enum is a type change and must stay one.** Drizzle emits
     * no `CHECK` constraint for a SQLite text enum — it is a compile-time
     * narrowing over a plain `text` column — so adding a member generates no
     * DDL at all. `migration-upgrade.test.ts` asserts that, because the
     * alternative would be a table recreate on a table holding somebody's
     * calendars, which is rule seven's `0009` hazard and the one migration
     * fault in this repository that reported success.
     */
    kind: text('kind', { enum: ['ics', 'homeassistant', 'caldav'] })
      .notNull()
      .default('ics'),

    /**
     * The address, for an `ics` source. Null for any other kind.
     *
     * A keyring envelope, never a URL in clear. A Google private iCal address
     * is a bearer credential that never expires, and `/data` is exactly what
     * people copy to a NAS and attach to bug reports.
     *
     * **That is true of an uncredentialed feed and only of one.** Since a feed
     * can carry a username and a password (RFC 013 Phase A), the address of a
     * credentialed feed is no longer a password by itself: a Nextcloud
     * collection URL without the app password beside it fetches nothing. Both
     * secrets are keyring envelopes, so the trade is even — a second thing to
     * store, and a leaked row worth less than it used to be.
     */
    urlEncrypted: text('url_encrypted'),
    /** Host only, for display and diagnostics. Never the path or the token. */
    urlHost: text('url_host'),

    /**
     * The CalDAV account this collection is reached through. Null for every
     * other kind (RFC 013 §6.2.1).
     *
     * **The declared `cascade` does not reach the database, and that is
     * measured rather than assumed.** drizzle-kit emits an `ALTER TABLE ADD
     * COLUMN` whose `REFERENCES` clause carries no action at all, so SQLite
     * applies `NO ACTION` and a delete of an account that still has calendars
     * is *refused* rather than cascaded — checked by running both spellings
     * against a real `better-sqlite3` with `foreign_keys = ON`, because
     * reading the schema file here answers the wrong question. `person_id`
     * one column along has had the identical divergence since `0006`, and the
     * repository's existing answer to it is `deletePerson`, which nulls the
     * column itself inside the transaction rather than trusting a constraint.
     * `removeCaldavAccount` does the same thing for the same reason, and
     * `caldav-account.test.ts` asserts the row is gone rather than that the
     * constraint fired.
     *
     * The declaration stays, because it is the correct *intent* and is what a
     * future recreate of this table would emit; what it is not is a thing to
     * rely on today.
     *
     * The direction it describes is the one the household never presses:
     * removing an *account* takes its calendars with it, because a collection
     * href with no credential behind it fetches nothing and would sit on the
     * Calendars screen failing for ever. The journey a household actually takes
     * is the other way round — removing the last *calendar* of an account
     * removes the account — and that is a deliberate act in
     * `api/caldav-accounts.ts` rather than a constraint, because a database
     * cannot tell "they removed their last calendar" from "this is the middle
     * of a rearrangement".
     *
     * For a `caldav` source, `url_encrypted` holds the **collection href** and
     * `etag` holds the **CTag** — the collection's own change marker, which is
     * exactly what those two columns already mean one transport along. That is
     * why §6.6 needs no schema change: a CTag is an ETag for a collection.
     */
    caldavAccountId: text('caldav_account_id').references(() => caldavAccounts.id, {
      onDelete: 'cascade',
    }),

    /**
     * The calendar entity, for a `homeassistant` source. Null otherwise.
     *
     * In clear, deliberately: `calendar.bin_collection` is a name, not a
     * credential, and the admin screen has to show which entity a source is.
     * The credential is the token, and it lives in one place.
     */
    haEntityId: text('ha_entity_id'),

    /**
     * The account an `ics` feed signs in as, when it needs to (RFC 013 Phase A).
     *
     * In clear, and deliberately so: the settings row has to show *which*
     * account a feed uses, the same argument `ha_entity_id` above makes. It is
     * not the same argument as that one in every direction, though, and the
     * difference is worth writing down where somebody would otherwise copy it:
     * a Basic-auth username is very often an **email address**, which is
     * exactly what `api/diagnostics.ts` promises its export contains none of.
     * So this column is left out of that projection entirely, and the test that
     * stuffs a database with personal data and asserts none of it survives now
     * seeds one of these too.
     *
     * Null for a feed that needs no sign-in, which is most of them, and for
     * every `homeassistant` source — those are reached through the one
     * connection with that connection's credential.
     */
    authUsername: text('auth_username'),
    /**
     * The password that goes with it. A keyring envelope, purpose
     * `feed-password`, never anything readable.
     *
     * It is never echoed back to a form, never formatted into `last_error`,
     * and never printed by a CLI tool: it crosses this codebase exactly as far
     * as the keyring and the outbound `authorization` header, and
     * `api/feed-credentials.ts` is the one place that reads it.
     */
    authPasswordEncrypted: text('auth_password_encrypted'),

    // Every insert path supplies a colour now (`api/palette.ts` rotates one), so
    // this default is a floor nothing reaches — kept as the migrations created
    // it, because changing a SQLite column default forces a table recreate and
    // a dead default is not worth one. The same note stands on `people.color`.
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
     * Whether this calendar's events are drawn on the calendar grid — the month
     * squares and the week columns — as opposed to the upcoming list.
     *
     * This exists because a *high-frequency* recurring event is the least
     * informative thing on a wall and takes the most room saying it. One
     * weekday standup in a work feed drew 17 identical cells reading "Stan…" —
     * the majority of every name in the visible month — while the grid treats a
     * once-a-year birthday and a daily meeting as equally worth a row. The
     * household's own sentence is "I do not need work on the family wall", and
     * this is that sentence: a per-calendar switch rather than a ranking model
     * the manifest has no frequency data to feed.
     *
     * Deliberately not `visible`, which is a different request: `visible = 0`
     * takes a feed off the wall entirely. This one keeps every event in the
     * agenda, where a list has room to say what and when, and only declines the
     * grid, where a cell has room for one line.
     *
     * Defaults to true, so an upgrading database changes nothing: every wall
     * already hanging draws exactly what it drew before, and the household opts
     * one calendar out when it starts crowding.
     */
    showInGrid: integer('show_in_grid', { mode: 'boolean' }).notNull().default(true),

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

    /**
     * Conditional GET state, so an unchanged feed costs one 304.
     *
     * For a `caldav` source this holds the collection's **CTag** (`CS:getctag`)
     * instead, which is the same idea one transport along: one cheap
     * `PROPFIND` answers "has anything in this calendar changed", and an
     * unchanged answer costs no `REPORT` and no parsing. `last_modified` stays
     * null there — CalDAV has no equivalent at the collection.
     */
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
  // Never actually hit: `createPerson` supplies a colour on every path, either
  // the one the form sent or the next one out of the rotation in
  // `api/palette.ts` — which is also what the form's picker is pre-filled with,
  // so the two agree. This value is deliberately left as the migrations created
  // it: changing a SQLite column default forces a table recreate, and a dead
  // default is not worth one. Do not "align" this without a reason.
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
  /**
   * The default colour, as a CSS custom property the active theme owns
   * (`--s-day`, …). Left in place as the fallback and the "match theme" choice.
   */
  colorToken: text('color_token').notNull(),
  /**
   * An explicit per-type colour that overrides `colorToken` when set. Null means
   * "match theme" — follow the token above, so a custom theme re-colours it. A
   * 6-digit hex; the display derives its tints against the current background.
   */
  color: text('color'),
  /**
   * Optional start/end of the shift, `HH:MM`, shown on the wall. Null is an
   * untimed shift (the common case — a rota that only says "day" or "night").
   */
  startTime: text('start_time'),
  endTime: text('end_time'),
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
// Chores
// ---------------------------------------------------------------------------

/**
 * A chore: something somebody in the house does on a repeating day.
 *
 * Two tables rather than one, and the split is the whole model. A chore is a
 * *definition* — a name, whose it is, and when it falls due — and it is edited
 * rarely, in the admin. A completion is a *fact about one day*, recorded
 * often, and (from RFC 008 phase 3) from the wall itself. Storing "done" as a
 * boolean on the chore would work exactly until midnight, and would leave no
 * way to answer "did the bins go out last Tuesday".
 */
export const chores = sqliteTable(
  'chores',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),

    /**
     * Whose chore this is, or nobody's.
     *
     * `set null` rather than cascade: removing a person from the household
     * should not silently delete the bins. The chore becomes unassigned, which
     * is a state the wall and the admin both already have to draw.
     *
     * This is the third thing `people` owns, after a calendar source and a
     * shift rotation — so a chore inherits the colour that person is already
     * drawn in and there is no new identity model anywhere (RFC 008).
     */
    personId: text('person_id').references(() => people.id, { onDelete: 'set null' }),

    /**
     * The `ChoreSchedule` from `@maverick-wall/core`, as JSON.
     *
     * JSON because it is never queried by its contents — "is this due today"
     * is a pure function over a civil date, evaluated in code, not a WHERE
     * clause. Validated by Zod on the way in and read back defensively: `dueOn`
     * is total and answers "not due" for anything it cannot read, because it
     * runs inside manifest assembly.
     */
    schedule: text('schedule', { mode: 'json' }).$type<unknown>().notNull(),

    /**
     * `HH:MM` the chore is meant to happen by, or null for any time that day.
     *
     * Display only, and deliberately not part of `dueOn`. A chore's day is a
     * civil date; the time is a note about that day, not a second boundary that
     * could disagree with it.
     */
    dueTime: text('due_time'),

    /**
     * Suspended, keeping its history.
     *
     * The difference between this and deleting is the whole reason it exists:
     * a chore paused over the school holidays comes back with "done 6 of the
     * last 7 Tuesdays" intact, and a chore deleted takes its completions with
     * it. Both are things a household means, and only one of them was possible.
     *
     * Deliberately not shipped in phase 1. Nothing could record a completion
     * then, so a switch that preserved history would have preserved nothing —
     * an option that does nothing is worse than an option not offered, and this
     * is the first version where it does something.
     */
    paused: integer('paused', { mode: 'boolean' }).notNull().default(false),

    sortOrder: integer('sort_order', { mode: 'number' }).notNull().default(0),
    ...timestamps,
  },
  (table) => ({
    byPerson: index('chores_person_idx').on(table.personId),
  }),
);

/**
 * One chore, done, on one civil date.
 *
 * **Keyed on a civil date, never an instant**, which is the single most
 * important thing in this table. "Bins out Tuesday" ticked at 23:50 on Monday
 * belongs to Monday; the day rolls at the household's local midnight, not at
 * UTC's. Writing this as a timestamp and deriving the day later is the same
 * bug as rendering `DTEND` inclusive, and it would present as a chore that
 * un-ticks itself in the evening.
 *
 * `completedAt` is kept beside it because the two answer different questions —
 * the date is *which day it counts for*, the timestamp is *when somebody
 * pressed it* — and only the first is unique.
 *
 * The unique index is what makes the tick idempotent: a wall that presses twice
 * on a flaky network records one completion, so no client needs to be careful.
 */
export const choreCompletions = sqliteTable(
  'chore_completions',
  {
    id: text('id').primaryKey(),
    choreId: text('chore_id')
      .notNull()
      .references(() => chores.id, { onDelete: 'cascade' }),
    /** Civil date, `YYYY-MM-DD`, in the household's zone. */
    date: text('date').notNull(),
    completedAt: integer('completed_at', { mode: 'number' }).notNull().$defaultFn(now),
  },
  (table) => ({
    byChoreDate: uniqueIndex('chore_completions_chore_date_idx').on(table.choreId, table.date),
    byDate: index('chore_completions_date_idx').on(table.date),
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
 * garage is still worth mentioning. Keyed on the signal, not the rule that
 * matched it — several rules can match one warning, and clearing the loudest
 * must not silence the next one down.
 *
 * `source` names which job's reaping this belongs to — the NWS alerts job
 * runs every sixty seconds and only ever knows its own CAP keys, and without
 * this it deleted every dismissal it did not recognise, undoing an
 * acknowledged garage door or calendar reminder within the minute. Nullable
 * for rows written before this column existed: a dismissal already sitting
 * there has no source to reap by, and leaving it alone is safer than
 * guessing one.
 */
export const interruptDismissals = sqliteTable('interrupt_dismissals', {
  key: text('key').primaryKey(),
  source: text('source'),
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
// Home Assistant. Read-only apart from one write: rule 12 permits
// `todo.update_item` and nothing else, through the allowlist in
// `modules/homeassistant/client.ts`. Nothing in these tables is a write path.
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

/**
 * The Home Assistant to-do lists a household has chosen to show (RFC 012).
 *
 * The entity id is the primary key and it is stored **in clear**, for the
 * reason `calendar_sources.ha_entity_id` is: it is a name, not a credential. It
 * is reached through the one connection on the Home Assistant screen, so a list
 * has no address of its own — and it is the one column in this table that must
 * never reach a wall. The manifest carries a handle minted from it
 * (`todoListHandle` in `api/manifest.ts`) and the items' own synthetic ids,
 * never this value, never a `uid`, never the `supported_features` bitmask.
 *
 * `supports_update` is bit 4 of `supported_features`, read from
 * `GET /api/states/<entity>` on every poll because `todo.get_items` does not
 * return it. It is what the widget's whole affordance will rest on in phase 2:
 * a list that cannot be updated is still drawn, because it is a list, and it is
 * drawn with no box to tick.
 *
 * `last_error` is the client's own sentence and nothing else — never a
 * summary, never a response body — because it is shown on the Home Assistant
 * screen and could otherwise carry an item somebody typed on their phone.
 */
export const haTodoLists = sqliteTable('ha_todo_lists', {
  entityId: text('entity_id').primaryKey(),
  /** Home Assistant's friendly name, refreshed on every poll. */
  name: text('name').notNull(),
  /** What the household calls it, when the entity's own name is wrong. Null means use `name`. */
  label: text('label'),
  supportsUpdate: integer('supports_update', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order', { mode: 'number' }).notNull().default(0),
  lastFetchedAt: integer('last_fetched_at', { mode: 'number' }),
  lastError: text('last_error'),
  ...timestamps,
});

/**
 * The cached items of every watched list, every status.
 *
 * **The synthetic `id` is the handle**, and it is why this is a table rather
 * than a JSON column on the list. Rule 12's surviving clause says the display
 * never receives an entity id, so the wall cannot post `{entity_id, uid}` when
 * phase 2 lets it tick — it posts an opaque id this server minted, and the
 * server resolves it. The unique index on `(entity_id, uid)` is what makes the
 * handle *stable*: the job upserts on it and deletes what vanished, so an item
 * keeps its id across polls with no crypto and no per-poll registry.
 *
 * `uid` and never the summary is the identity, because Home Assistant's own
 * lookup matches `value in (item.uid, item.summary)` and returns the first hit
 * — a household with "Milk" on the list twice would otherwise tick whichever
 * one their integration happened to list first.
 *
 * Every status is cached and the renderer decides what to hide: filtering at
 * the service would make "show the ticked ones too" impossible without a
 * second call, and the cache is small — a shopping list, not a house.
 */
export const haTodoItems = sqliteTable(
  'ha_todo_items',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id').notNull(),
    uid: text('uid').notNull(),
    summary: text('summary').notNull(),
    /** `needs_action` or `completed` — Home Assistant's own two words. */
    status: text('status').notNull(),
    /** A due date (`YYYY-MM-DD`) or date-time as Home Assistant sent it; null when it has none. */
    due: text('due'),
    /** The list's own order, which the wall keeps. */
    position: integer('position', { mode: 'number' }).notNull().default(0),
    fetchedAt: integer('fetched_at', { mode: 'number' }).notNull().$defaultFn(now),
  },
  (table) => ({
    byEntityUid: uniqueIndex('ha_todo_items_entity_uid_idx').on(table.entityId, table.uid),
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
