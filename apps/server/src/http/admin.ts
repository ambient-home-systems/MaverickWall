import type { Context, Hono } from 'hono';
import { addCalendarSource } from '../api/sources.js';
import {
  createPerson,
  deletePerson,
  movePerson,
  deleteShiftPlan,
  deleteSource,
  readShiftPlans,
  readShiftPlansAdmin,
  readShiftTypes,
  readTitleObservations,
  readTitlesByDate,
  saveShiftPlan,
  readPeopleAdmin,
  updatePerson,
  updateSource,
  readAdminScreens,
  readAdminSources,
  readUpdateState,
  recordUpdateCheck,
  setPersonAvatar,
  setUpdateCheckEnabled,
  readHousehold,
  requestSyncNow,
  createScreen,
  createEpaperScreen,
  readLayoutWidgets,
  clearLayout,
  replaceLayout,
  revokeScreen,
  writeDisplaySettings,
  rotateScreenToken,
  writeScreenSettings,
  type AdminScreenRow,
  type AdminSourceRow,
  type PairingSecret,
  type PersonRecord,
} from '../api/queries.js';
import { randomBytes } from 'node:crypto';
import {
  formatShortCode,
  hashShortCode,
  issueDisplayToken,
  PAIRING_CODE_TTL_MS,
} from '../auth/tokens.js';
import type { IssuedToken } from '../auth/tokens.js';
import type { DeviceFlowStore } from '../auth/device-flow.js';
import { encodeQr, qrSvg } from './qr.js';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupTo, databasePath, integrityCheck } from '../db/open.js';
import { bytesOf, type WallAddress } from './app.js';
import { epaperOrientation, renderScreenFrame } from '../epaper/frame.js';
import { encodePng1bit } from '../epaper/png.js';
import type { Manifest, PlacedWidgetRow } from '../api/manifest.js';
import { ingressPath } from './ingress.js';
import { buildDiagnostics } from '../api/diagnostics.js';
import { readImage, storeImage, listImages } from '../api/media.js';
import { checkForUpdate, isNewer, RELEASE_HOST, RELEASE_URL } from '../api/update-check.js';
import type { LogBuffer } from '../logbuffer.js';
import { parseBackground } from '../api/manifest.js';
import { layoutWidgetBody, backgroundSchema } from '../api/widget-schema.js';
import { applyTemplate, copyLayout, findTemplate } from '../api/templates.js';
import { CLASSIC_TEMPLATE } from '../templates/index.js';
import { TEMPLATES } from '../templates/index.js';
import {
  candidatesFor,
  cycleFrom,
  MAX_CYCLE,
  planFrom,
  previewFor,
  renderPreview,
  SLOT_OFF,
  SLOT_UNUSED,
  type Draft,
  type PlanKind,
} from './shifts.js';
import { testFeed, type TestFeedResult } from '../api/test-feed.js';
import { currentUser } from '../auth/session.js';
import type { Fetcher, ShiftPlan } from '@maverick-wall/core';
import type { Keyring } from '../secrets/keyring.js';
import type { SqliteDatabase } from '../db/open.js';
import { errorBlock, escapeHtml, icon, page, selectField, selectRow, switchRow, textField,
  type NavModule } from './html.js';
import { bounded, checkbox, colour, oneOf, optionalText, parse, text, z } from '../validation.js';

/**
 * One schema per form, stated where the constants they lean on are.
 *
 * The handlers below read as "shape it, then do the thing", which is what they
 * were always trying to say — the field-by-field checks were the same rules
 * spread over a dozen early returns.
 */
const feedBody = z.object({
  name: optionalText(80),
  url: text('An address', 2048),
  person_id: optionalText(40),
  allow_lan: checkbox(),
  allow_loopback: checkbox(),
  allow_http: checkbox(),
  action: optionalText(10),
});

const sourceSettingsBody = z.object({
  name: text('A name', 80),
  color: colour(),
  person_id: optionalText(40),
  enabled: checkbox(),
  allow_lan: checkbox(),
});

/**
 * The shift builder's form, which is a draft rather than a submission.
 *
 * It round-trips: the page renders a draft, the household changes one thing,
 * and the same shape comes back. So nothing here rejects — every field falls
 * back to empty and `planFrom` is what decides whether the *draft* is a plan
 * yet. A schema that refused a half-filled draft would refuse the form's own
 * preview button.
 *
 * The indexed fields are the reason this is a `catchall` rather than a list of
 * keys: `slot_0`…`slot_27` and `title_0`…`title_39` are positional, and naming
 * forty of them would be worse than reading them by index.
 */
const draftBody = z.looseObject({
  person_id: optionalText(40),
  kind: optionalText(20),
  source_id: optionalText(40),
  anchor_date: optionalText(10),
});

const personBody = z.object({
  name: text('A name', 80),
  color: colour(),
});

const screenBody = z.object({
  name: text('A name for the screen', 80),
  orientation: oneOf('an orientation', ['auto', 'portrait', 'landscape']),
  rotation: z
    .unknown()
    .refine((value) => ['0', '90', '180', '270'].includes(String(value)), {
      error: () => 'Rotation has to be a quarter turn.',
    })
    .transform((value) => Number(value)),
  // A built-in key or a `custom:<id>`; blank follows the household. Wide enough
  // for `custom:` + a 16-char id. Existence is checked in the handler.
  theme: optionalText(64),
  daytime_theme: optionalText(64),
  daytime_starts_at: optionalText(5),
  daytime_ends_at: optionalText(5),
  timezone: optionalText(64),
  allow_dismiss: checkbox(),
  // '' follows the household, '1' forces 24-hour, '0' forces 12-hour (RFC 005).
  clock_24: optionalText(1),
  // How much this wall shows. Empty follows the household default; a number is
  // range-checked in the handler, next to the theme and zone checks.
  today_events: optionalText(3),
  next_days: optionalText(3),
  horizon_weeks: optionalText(3),
});

/** Creating a screen asks for one thing; everything else follows the household. */
const newScreenBody = z.object({ name: text('A name for the screen', 80) });

/**
 * E-paper panel presets, all 1-bit for now (RFC 006 phase 1). Dimensions are
 * the panel's native landscape resolution; rotation is a separate field.
 */
const EPAPER_PRESETS: Record<string, { label: string; width: number; height: number }> = {
  'seeed-7in5': { label: 'Seeed 7.5" · 800×480', width: 800, height: 480 },
  'waveshare-5in83': { label: '5.83" · 648×480', width: 648, height: 480 },
  'waveshare-4in2': { label: '4.2" · 400×300', width: 400, height: 300 },
  'waveshare-2in9': { label: '2.9" · 296×128', width: 296, height: 128 },
};

const newEpaperBody = z.object({
  name: text('A name for the screen', 80),
  preset: text('A panel', 40),
  width: optionalText(6),
  height: optionalText(6),
  rotation: z
    .unknown()
    .refine((value) => ['0', '90', '180', '270'].includes(String(value)), {
      error: () => 'Rotation has to be a quarter turn.',
    })
    .transform((value) => Number(value)),
});

/**
 * Approving (or declining) a screen that started a device-authorization flow.
 *
 * The `code` is the short user code shown on the wall; the household reached
 * this form either by scanning the screen's QR (which pre-fills it) or by typing
 * it at the Screens page. `action` is which button they pressed. Everything is
 * behind the session gate, which is the entire reason an 8-character code is
 * safe here — see `auth/device-flow.ts`.
 */
const approveDeviceBody = z.object({
  code: text('A pairing code', 32),
  name: text('A name for the screen', 80),
  action: oneOf('an action', ['approve', 'deny']),
});

/**
 * A saved free-form layout, as the editor posts it — JSON, not a form.
 *
 * Rejected, not coerced (rule five). The type must be a first-party module —
 * `WIDGET_TYPES` is where rule three is enforced, so a `website` or `iframe`
 * never reaches the database. Coordinates are fractions of the canvas, sized so
 * a widget cannot be nudged off the wall or shrunk to nothing; the display
 * clamps again regardless, because a form is a boundary and so is a manifest.
 */
const layoutBody = z.object({
  // Which wall this canvas is for. Null (or absent) is the shared default; a
  // screen id is that wall's own. Validated against the real screens in the
  // handler — a stranger's id must not write onto a wall.
  screen: z.string().min(1).max(64).nullable().optional(),
  // Which of the display's two canvases this save is (RFC 005). Absent is
  // portrait, so an older editor that only knows one canvas still writes it.
  orientation: z.enum(['portrait', 'landscape']).optional(),
  mode: z.enum(['auto', 'freeform']),
  // Portrait phone through wide television, and nothing degenerate.
  aspect: z.number().min(0.2).max(5),
  // A wall is a few widgets, not a dashboard. The cap is a guard, not a target.
  widgets: z.array(layoutWidgetBody).max(50),
  // The canvas background (RFC 005 Phase 3): a solid colour or a gradient, or
  // null for none. Absent is treated as null so an older editor still saves.
  background: backgroundSchema.nullable().optional(),
});

/**
 * The canvas the e-paper designer wants previewed — the boxes it has on screen
 * right now, which may not be saved yet. Same widget schema the save path
 * validates, so a preview can express nothing a save could not.
 */
const epaperPreviewBody = z.object({
  widgets: z.array(layoutWidgetBody).max(50),
});
import { registerHaRoutes } from './admin-ha.js';
import { registerAlertRoutes } from './admin-alerts.js';
import { registerModuleRoutes } from './admin-modules.js';
import { registerShiftTypeRoutes } from './admin-shifts.js';
import { registerThemeRoutes } from './admin-themes.js';
import { isValidThemeRef, readThemes, type ThemeRow } from '../api/themes.js';
import { readEnabledExternalModules, readExternalModules } from '../api/external-modules.js';
import { readHaSettings } from '../modules/homeassistant/store.js';
import { resolveConnection } from '../modules/homeassistant/client.js';

/**
 * The admin screens.
 *
 * Server-rendered for the same reasons the wizard is: no build step, no bundle
 * that can fail to load, and every screen works on the locked-down browser most
 * likely to be pointed at a wall. Everything here is behind `requireSession`,
 * mounted by `protectPrefix` over `/admin`.
 *
 * There is no CSRF token because every form here is a same-site POST and the
 * session cookie is `SameSite=Lax`, which browsers do not attach to a
 * cross-site POST at all. That is the mitigation; a token would be a second
 * one. If a route here ever needs to accept a cross-site request, this stops
 * being true and the token has to arrive with it.
 */

export interface AdminDeps {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly fetcher: Fetcher;
  /** Signs the household out through Better Auth, carrying their cookie. */
  readonly signOut: (c: Context) => Promise<Response>;
  readonly now?: () => number;
  readonly appVersion: string;
  /**
   * The address a wall display reaches this box on — the `base_url` add-on
   * option, or `BASE_URL`. The pairing link has to carry this rather than the
   * request's own origin, because that request may have arrived through Home
   * Assistant ingress, whose origin is an internal address no screen on the
   * LAN can reach.
   */
  readonly baseUrl: string;
  /**
   * The device-authorization pairing store, shared with the `/d/pair/*` routes
   * in `app.ts`. The screen starts a flow there; the household approves it here,
   * behind the session — which is the whole security model (an 8-character code
   * is safe because approving it requires the login). See `auth/device-flow.ts`.
   */
  readonly deviceFlow: DeviceFlowStore;
  /**
   * What boot detected from the supervisor about the wall's own address — the
   * mapped port and a best-guess host. The Screens page pre-fills the pairing
   * address from it and, when the port is turned off, says so where the
   * household is looking rather than leaving a link that points nowhere.
   */
  readonly wallAddress?: WallAddress;
  /**
   * The manifest the layout editor previews from — the same document a wall
   * gets, for a default screen. Built in `app.ts`, which is where the modules
   * and the fetcher live; supplied here so the editor's preview route sits
   * behind the session with every other admin route.
   */
  readonly previewManifest?: (screenId?: string | null) => unknown;
  /** Where the database and the key live, for backup and restore. */
  readonly dataDir: string;
  readonly startedAt: number;
  readonly log: LogBuffer;
}

/**
 * The themes this build can actually draw.
 *
 * Named here rather than read from the display bundle, because the server has
 * no way to import it — and a theme offered in a dropdown that the wall then
 * falls back on would be a puzzle nobody could solve from the kitchen.
 */
/**
 * The blocks, and what to call them where somebody has to choose.
 *
 * The keys match what the display renders; the labels are what the thing
 * actually is to a person standing in a kitchen.
 */
const BLOCKS = [
  { key: 'now', label: 'Today' },
  { key: 'weather', label: 'Weather' },
  { key: 'home', label: 'The house' },
  { key: 'next', label: 'The week ahead' },
  { key: 'horizon', label: 'The month' },
] as const;

/**
 * Read three position dropdowns into an order.
 *
 * Ordering with no script is three selects rather than a drag handle. Choosing
 * "Nothing" leaves that block out, and choosing the same block twice is a
 * mistake worth naming rather than silently collapsing — somebody who did it
 * meant to move a block, not to lose one.
 */
function blockOrder(
  body: Record<string, unknown>,
  current: string,
): { blocks: string } | { error: string } {
  /*
   * Not submitted at all is not the same as "show nothing".
   *
   * The form always renders these, so a post without them came from something
   * else — and the right answer for a caller that did not mention the order is
   * to leave it alone rather than to reject them or wipe it.
   */
  const mentioned = BLOCKS.some((_, index) => `block_${index + 1}` in body);
  if (!mentioned) return { blocks: current };

  const chosen: string[] = [];
  for (let position = 1; position <= BLOCKS.length; position++) {
    const raw = body[`block_${position}`];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '' || value === 'none') continue;
    if (!BLOCKS.some((block) => block.key === value)) {
      return { error: 'Choose what each row shows from the list.' };
    }
    if (chosen.includes(value)) {
      const label = BLOCKS.find((block) => block.key === value)?.label ?? value;
      return { error: `${label} is in the list twice. Each block can only appear once.` };
    }
    chosen.push(value);
  }
  if (chosen.length === 0) {
    return { error: 'The wall has to show at least one of these.' };
  }
  // Third-party blocks are not on this form, but a Display save must not
  // silently take them off the wall — keep them after the built-in order.
  const externals = current
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b.startsWith('ext:'));
  return { blocks: [...chosen, ...externals].join(',') };
}

/**
 * The Display screen, as one schema.
 *
 * The daylight window is the interesting part: three fields that are only
 * required *together*, and only when a second theme was chosen. Expressing
 * that as a `superRefine` puts the rule beside the fields rather than three
 * `if` statements down the handler, and the message stays the one a household
 * would want — a window of no length is the mistake people actually make.
 */
const themeKeys = ['household', 'blueprint', 'panels', 'almanac'] as const;

const displayBody = z
  .object({
    // A built-in key or a `custom:<id>` — existence is checked in the handler
    // against the themes table, since the schema cannot see the database.
    theme: text('a theme', 64),
    daytime_theme: optionalText(64),
    daytime_starts_at: optionalText(5),
    daytime_ends_at: optionalText(5),
    today_events: bounded('Events listed for today', 1, 20),
    next_days: bounded('Days in the week ahead', 0, 14),
    horizon_weeks: bounded('Weeks in the month grid', 1, 8),
    // The household-wide clock format. Checked is 24-hour (the wall's original
    // behaviour); unchecked is 12-hour (RFC 005).
    clock_24: checkbox(),
    // Which day the month grid starts on. Sunday is the default the column ships
    // with; a select always submits one of the two, so it is required.
    week_start: oneOf('a week start', ['sunday', 'monday']),
  })
  .superRefine((value, ctx) => {
    const chosen = value.daytime_theme;
    if (chosen === undefined || chosen === 'none') return;

    if (!(themeKeys as readonly string[]).includes(chosen)) {
      ctx.addIssue({ code: 'custom', message: 'Choose a daylight theme from the list.' });
      return;
    }
    const from = value.daytime_starts_at;
    const to = value.daytime_ends_at;
    if (from === undefined || to === undefined || !HHMM_SHAPE.test(from) || !HHMM_SHAPE.test(to)) {
      ctx.addIssue({ code: 'custom', message: 'Enter the daylight hours as HH:MM.' });
      return;
    }
    if (from === to) {
      ctx.addIssue({
        code: 'custom',
        message:
          'The daylight hours start and end at the same time. A window of no length ' +
          'would never switch — set them apart, or turn the schedule off.',
      });
    }
  });

const HHMM_SHAPE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const THEMES = [
  { key: 'panels', label: 'Panels — dark, each block a card' },
  { key: 'household', label: 'Household — warm daylight paper' },
  { key: 'blueprint', label: 'Blueprint — light technical wireframe' },
  { key: 'almanac', label: 'Paper Almanac — the month, as a ledger' },
] as const;

/**
 * The three swatch colours per theme, for the Display screen's theme cards —
 * background, accent, a shift hue. Taken from the design file's token sets so
 * the card previews what the wall will actually look like. Kept beside `THEMES`
 * so a theme added to one is a visible hole in the other.
 */
const THEME_SWATCHES: Readonly<Record<string, readonly [string, string, string]>> = {
  panels: ['#14181E', '#5C93E0', '#E8A33D'],
  household: ['#F4F0E8', '#B5651F', '#4C7FD1'],
  blueprint: ['#F2F2F3', '#5980A6', '#2F5D8C'],
  almanac: ['#FBF8F1', '#B3372B', '#2F5D8C'],
};

/**
 * Retired theme keys mapped to their surviving equivalent, mirroring the
 * display bundle's `LEGACY_ALIASES`. A household who never changed the setting
 * still carries `board` in the database; normalising it here highlights the
 * right card and pre-selects the right option, so the picker matches the wall.
 */
const LEGACY_THEME_ALIASES: Readonly<Record<string, string>> = {
  board: 'panels',
  slate: 'panels',
  glance: 'panels',
};

/** A stored theme reference as the picker should show it — retired keys folded
 *  onto their survivor, everything else (a built-in or a `custom:<id>`) as-is. */
function displayThemeRef(ref: string): string {
  return LEGACY_THEME_ALIASES[ref] ?? ref;
}

/** The bare display name of a built-in theme key, e.g. `panels` → "Panels".
 *  Used to tell a household which theme a template was designed for. */
function themeName(key: string): string {
  const found = THEMES.find((t) => t.key === key);
  return found ? found.label.split(' — ')[0] ?? found.label : key;
}

/**
 * The theme picker as selectable cards, scriptless.
 *
 * A radio per theme wrapped in a `.themecard` label: it posts `theme` exactly
 * as the old `<select>` did, so the handler is unchanged, and the amber ring on
 * the checked card is pure CSS (`:has(input:checked)`), which is fine in the
 * admin — rule two is about the locked wall tablet, not the household's phone.
 */
function themeCards(selected: string, custom: readonly ThemeRow[] = []): string {
  const cardFor = (value: string, name: string, caption: string, swatches: readonly string[]): string =>
    `<label class="themecard">` +
    `<input type="radio" name="theme" value="${escapeHtml(value)}"${value === selected ? ' checked' : ''}>` +
    `<div class="sw">` +
    swatches.map((c) => `<i style="background:${escapeHtml(c)}"></i>`).join('') +
    `</div>` +
    `<div class="cap"><b>${escapeHtml(name)}</b><small>${escapeHtml(caption)}</small></div>` +
    `</label>`;

  const builtins = THEMES.map((theme) => {
    const [name, ...rest] = theme.label.split(' — ');
    const swatches = THEME_SWATCHES[theme.key] ?? ['#0B0E11', '#E0A33E', '#4C7FD1'];
    return cardFor(theme.key, name ?? theme.key, rest.join(' — '), swatches);
  }).join('');

  const customCards = custom
    .map((theme) =>
      cardFor(`custom:${theme.id}`, theme.name, 'Your theme', [
        theme.tokens['--bg'] ?? '#0B0E11',
        theme.tokens['--accent'] ?? '#E8A33D',
        theme.tokens['--s-night'] ?? '#4C7FD1',
      ]),
    )
    .join('');

  return `<div class="themegrid">${builtins}${customCards}</div>`;
}

/** A six-digit hex colour, which is what `<input type="color">` submits. */
/**
 * The zones offered, from the runtime rather than a bundled list.
 *
 * The same source the wizard uses, so the two screens can never disagree about
 * what a valid zone is.
 */
function supportedTimezones(): string[] {
  const values = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof values === 'function') return values('timeZone');
  return ['UTC', 'America/New_York', 'Europe/London', 'Australia/Sydney'];
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return 'unknown size';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} kB`;
}



/**
 * Relative rather than absolute, deliberately.
 *
 * "14 minutes ago" needs no timezone and no locale, and answers the only
 * question anybody asks of it: is this stale?
 */
export function ago(from: number | null, now: number): string {
  if (from === null) return 'never';
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The installed modules for the sidebar's Modules group, read live.
 *
 * Every shell page passes this so the nav is a mirror of what is installed:
 * add one from the Store and its entry appears, remove it and the entry goes.
 * Disabled modules stay listed with an "off" badge — they are installed, just
 * quiet — so the household can find one to turn back on. The db read lives here
 * rather than in `html.ts`, which never touches the database.
 */
export function navModules(db: SqliteDatabase): NavModule[] {
  return readExternalModules(db).map((m) => ({
    id: m.id,
    name: m.name,
    enabled: m.enabled === 1,
  }));
}

export function registerAdminRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  registerHaRoutes(app, deps);
  registerAlertRoutes(app, deps);
  registerModuleRoutes(app, deps);
  registerShiftTypeRoutes(app, deps);
  registerThemeRoutes(app, deps);

  /**
   * What the index says about Home Assistant.
   *
   * The link is always there, because path B — a household running Home
   * Assistant separately — has to be able to reach the form to configure it.
   * What is conditional is everything the connection unlocks: no entity
   * picker, no calendar list, no rule builder, and no block on the wall until
   * there is something to read.
   *
   * Resolved rather than read from the settings row, so an add-on installation
   * says "connected" on the index without anybody having configured anything.
   */
  const alertSummary = (): string => {
    const row = deps.db
      .prepare(`SELECT alerts_enabled AS enabled FROM household_settings WHERE id = 'singleton'`)
      .get() as { enabled: number } | undefined;
    if (row?.enabled !== 1) return 'off';
    const zones = deps.db
      .prepare(`SELECT count(*) AS n FROM alert_zones WHERE provider = 'nws'`)
      .get() as { n: number } | undefined;
    return (zones?.n ?? 0) === 0 ? 'on, working out your zones' : `watching ${zones?.n} zones`;
  };

  const haSummary = (): string => {
    const resolved = resolveConnection(deps.db, deps.keyring);
    if (!resolved.ok) return 'not connected';
    if (resolved.connection.mode === 'supervisor') return 'connected as an add-on';
    const settings = readHaSettings(deps.db);
    return settings.lastError === null ? 'connected' : 'connected, with a problem';
  };

  /**
   * A status summary as a coloured pill for the overview: green when it is
   * working, red when a summary says it is not, plain when it is simply off.
   */
  const tagFor = (summary: string): string => {
    const low = summary.toLowerCase();
    const cls =
      low.includes('not connected') || low.includes('problem') || low.includes('error')
        ? 'tag-bad'
        : low === 'off' || low.startsWith('on,')
          ? 'tag'
          : 'tag-ok';
    const dot = cls === 'tag-ok' ? '<span class="dot dot-ok"></span>' : cls === 'tag-bad' ? '<span class="dot dot-bad"></span>' : '';
    // A capitalised first letter reads as a label rather than a sentence fragment.
    const text = summary.charAt(0).toUpperCase() + summary.slice(1);
    return `<span class="tag ${cls}">${dot}${escapeHtml(text)}</span>`;
  };

  app.get('/admin', (c: Context) => {
    const user = currentUser(c);
    const household = readHousehold(deps.db);
    const sources = readAdminSources(deps.db);
    const screens = readAdminScreens(deps.db).filter((screen) => screen.revokedAt === null);
    const failing = sources.filter((source) => source.lastError !== null).length;
    const plans = readShiftPlansAdmin(deps.db);
    const at = now();
    // "Online" is loose on purpose: a wall polls on a minute, so anything seen
    // inside a few minutes is up. Enough to say "both online" rather than to
    // diagnose one that is not.
    const online = screens.filter(
      (screen) => screen.lastSeenAt !== null && at - screen.lastSeenAt < 5 * 60_000,
    ).length;

    // A span, not an anchor: the whole stat card is already an <a>, and a
    // nested anchor is invalid HTML the browser hoists out of the card.
    const manage = (): string => `<span class="link">Manage ${icon('arrow')}</span>`;

    const calTag =
      failing === 0
        ? `<span class="tag tag-ok"><span class="dot dot-ok"></span>All syncing</span>`
        : `<span class="tag tag-bad"><span class="dot dot-bad"></span>${failing} failing</span>`;
    const scrTag =
      screens.length === 0
        ? `<span class="tag">None paired</span>`
        : online === screens.length
          ? `<span class="tag tag-ok"><span class="dot dot-ok"></span>${screens.length === 1 ? 'Online' : 'All online'}</span>`
          : `<span class="tag"><span class="dot dot-idle"></span>${online} of ${screens.length} online</span>`;

    const statCard = (
      href: string,
      iconKey: string,
      tag: string,
      big: string | number,
      lab: string,
      sub: string,
    ): string =>
      `<a class="card stat" href="${href}">` +
      `<div class="top"><div class="ic">${icon(iconKey)}</div>${tag}</div>` +
      `<div class="big">${escapeHtml(String(big))}</div><div class="lab">${escapeHtml(lab)}</div>` +
      `<div class="subrow"><span>${sub}</span>${manage()}</div></a>`;

    const statusRow = (iconKey: string, name: string, meta: string, tag: string): string =>
      `<div class="frow"><div class="ic">${icon(iconKey)}</div>` +
      `<div style="flex:1;min-width:0"><div class="rname">${escapeHtml(name)}</div>` +
      (meta === '' ? '' : `<div class="host">${escapeHtml(meta)}</div>`) +
      `</div>${tag}</div>`;

    const uptime = Math.max(0, Math.round((at - deps.startedAt) / 1000));
    const uptimeText =
      uptime < 3600
        ? `${Math.round(uptime / 60)}m`
        : uptime < 172800
          ? `${Math.round(uptime / 3600)}h`
          : `${Math.round(uptime / 86400)}d`;

    return c.html(
      page({
      modules: navModules(deps.db),
        title: 'Maverick Wall',
        nav: 'home',
        heading: 'Overview',
        intro: `Signed in as ${user.name}.`,
        body:
          `<div class="grid g3">` +
          statCard(
            'admin/calendars', 'calendars', calTag, sources.length,
            `Calendar${sources.length === 1 ? '' : 's'} connected`,
            `Timezone ${escapeHtml(household.timezone)}`,
          ) +
          statCard(
            'admin/displays', 'screens', scrTag, screens.length,
            `Wall display${screens.length === 1 ? '' : 's'} paired`,
            screens.length === 0 ? 'Pair one on the Displays page' : escapeHtml(screens.map((s) => s.name).join(' · ')),
          ) +
          statCard(
            'admin/shifts', 'shifts',
            plans.length === 0 ? '<span class="tag">None set</span>' : `<span class="tag tag-accent">${plans.length} active</span>`,
            plans.length, `Rotation${plans.length === 1 ? '' : 's'}`,
            plans.length === 0 ? 'Colour each day by who is working' : escapeHtml(plans.map((p) => p.personName ?? 'Someone').join(' · ')),
          ) +
          `</div>` +

          `<div class="sect"><div class="sect-head"><h2>Status</h2>` +
          `<span class="kick">Household · ${escapeHtml(household.timezone)}</span></div>` +
          `<div class="grid g2">` +
          `<div class="card status-card">` +
          statusRow('alerts', 'Weather alerts', '', tagFor(alertSummary())) +
          statusRow('homeassistant', 'Home Assistant', '', tagFor(haSummary())) +
          statusRow('system', 'System', `${escapeHtml(deps.appVersion)} · up ${uptimeText}`, `<a class="link" href="admin/system">Open ${icon('arrow')}</a>`) +
          `</div>` +
          `<div class="card today-card">` +
          `<div class="kick">Today on the wall</div>` +
          `<div class="today-big">${escapeHtml(household.timezone)}</div>` +
          `<div class="host">${sources.length} calendar${sources.length === 1 ? '' : 's'} · ${plans.length} rotation${plans.length === 1 ? '' : 's'} · ${screens.length} screen${screens.length === 1 ? '' : 's'}</div>` +
          `<div class="row" style="margin-top:auto;padding-top:16px">` +
          `<a class="btn btn-ghost btn-sm" href="admin/displays/default">Edit what shows</a>` +
          `<a class="btn btn-ghost btn-sm" href="admin/displays/default#layout">Arrange layout</a></div>` +
          `</div></div></div>` +

          // Sign-out lives in the sidebar footer now, shown on every page for a
          // plain docker install and stripped under ingress. Here we only keep
          // the note for the ingress case, where signing out is a Home Assistant
          // action rather than ours.
          (c.get('viaIngress') === true
            ? `<p class="hint" style="margin-top:24px">Signed in through Home Assistant.</p>`
            : ''),
      }),
    );
  });

  app.post('/admin/sign-out', async (c: Context) => {
    const response = await deps.signOut(c);
    for (const cookie of response.headers.getSetCookie()) {
      c.header('set-cookie', cookie, { append: true });
    }
    return c.redirect('/admin/sign-in', 302);
  });

  // -------------------------------------------------------------------------
  // Calendars
  // -------------------------------------------------------------------------

  app.get('/admin/calendars', (c: Context) => c.html(calendarsPage()));

  /**
   * Test, then save — and testing is a first-class outcome.
   *
   * Both buttons post here. "Test feed" fetches, parses and shows what came
   * back without storing anything; "Add" does the same and stores it only if
   * it worked. Somebody pasting a URL has no way to know whether they copied
   * the right one — Google offers a public HTML link and a secret iCal link
   * side by side — and seeing five real events answers that before they
   * commit to it.
   */
  app.post('/admin/calendars', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(feedBody, body);
    // Echoed back either way, so a bad address never costs the name above it.
    const echo = {
      name: typeof body['name'] === 'string' ? body['name'] : '',
      url: typeof body['url'] === 'string' ? body['url'] : '',
      allowPrivateNetwork: typeof body['allow_lan'] === 'string',
      allowLoopback: typeof body['allow_loopback'] === 'string',
      allowHttp: typeof body['allow_http'] === 'string',
    };
    if (!shaped.ok) return c.html(calendarsPage(echo, { message: shaped.message }), 400);

    const testOnly = shaped.value.action === 'test';
    // A name is only required to *store* one. Testing an address is a
    // question, and asking it should not need the answer named first.
    if (!testOnly && shaped.value.name === undefined) {
      return c.html(calendarsPage(echo, { message: 'Enter a name and an address.' }), 400);
    }

    const name = shaped.value.name ?? '';
    const url = shaped.value.url;
    const allowPrivateNetwork = shaped.value.allow_lan;
    const allowLoopback = shaped.value.allow_loopback;
    const allowHttp = shaped.value.allow_http;
    const values = { name, url, allowPrivateNetwork, allowLoopback, allowHttp };

    const tested = await testFeed(
      {
        url,
        allowPrivateNetwork,
        allowLoopback,
        allowHttp,
        timezone: readHousehold(deps.db).timezone,
      },
      deps.fetcher,
    );
    if (!tested.ok) {
      return c.html(
        calendarsPage(values, {
          message: tested.message,
          ...(tested.suggestion !== undefined ? { suggestion: tested.suggestion } : {}),
        }),
        400,
      );
    }

    // Nothing stored yet: this is the person checking their own work.
    if (testOnly) return c.html(calendarsPage(values, undefined, tested));

    // Membership is a question for the database, not the schema. An owner who
    // has since gone is treated as "Everyone" rather than rejected — losing the
    // attribution is a smaller harm than refusing a valid feed.
    const owner = shaped.value.person_id;
    const personId =
      owner !== undefined && readPeopleAdmin(deps.db).some((p) => p.id === owner) ? owner : null;

    const added = addCalendarSource(deps.db, deps.keyring, {
      name,
      url,
      personId,
      allowPrivateNetwork,
      allowLoopback,
      allowHttp,
    });
    if (!added.ok) {
      return c.html(calendarsPage(values, { message: added.message }), 400);
    }

    return c.redirect('/admin/calendars', 302);
  });

  /** Editing what a stored source is, as opposed to where it points. */
  app.post('/admin/calendars/:id/settings', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(sourceSettingsBody, body);
    if (!shaped.ok) return c.html(calendarsPage({}, { message: shaped.message }), 400);

    // Membership, and it cannot live in the schema: who exists is a question
    // for the database rather than for the shape of the request.
    const personId = shaped.value.person_id;
    if (personId !== undefined && !readPeopleAdmin(deps.db).some((p) => p.id === personId)) {
      return c.html(calendarsPage({}, { message: 'That person is no longer there.' }), 400);
    }

    updateSource(deps.db, c.req.param('id') ?? '', {
      name: shaped.value.name,
      color: shaped.value.color,
      personId: personId ?? null,
      enabled: shaped.value.enabled,
      allowPrivateNetwork: shaped.value.allow_lan,
    });
    return c.redirect('/admin/calendars', 302);
  });

  app.post('/admin/calendars/:id/sync', (c: Context) => {
    // Automates the SQL that was previously the documented way to do this.
    requestSyncNow(deps.db, c.req.param('id') ?? '');
    return c.redirect('/admin/calendars', 302);
  });

  /**
   * Deletion is two steps and the first one is a GET.
   *
   * A single POST button would be one misclick away from losing a calendar,
   * and there is no script here to raise a confirm dialogue.
   */
  app.get('/admin/calendars/:id/delete', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const source = readAdminSources(deps.db).find((candidate) => candidate.id === id);
    if (source === undefined) return c.redirect('/admin/calendars', 302);

    return c.html(
      page({
      modules: navModules(deps.db),
        title: 'Remove calendar',
        nav: 'calendars',
        heading: `Remove “${source.name}”?`,
        intro:
          'Its events disappear from the wall immediately. The calendar itself ' +
          'is untouched — this only stops Maverick Wall reading it.',
        body:
          `<form method="post" action="admin/calendars/${encodeURIComponent(id)}/delete">` +
          `<button type="submit">Remove it</button></form>` +
          `<form method="get" action="admin/calendars">` +
          `<button class="secondary" type="submit">Keep it</button></form>`,
      }),
    );
  });

  app.post('/admin/calendars/:id/delete', (c: Context) => {
    deleteSource(deps.db, c.req.param('id') ?? '');
    return c.redirect('/admin/calendars', 302);
  });

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------

  app.get('/admin/system', (c: Context) => c.html(systemPage()));

  /**
   * Turning the check on or off.
   *
   * No check is made here, even when switching it on. Consent and an outbound
   * request in the same click would mean somebody exploring the settings makes
   * a request to a third party before they have read what the switch does.
   */
  app.post('/admin/system/updates', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(z.object({ update_check_enabled: checkbox() }), body);
    setUpdateCheckEnabled(deps.db, shaped.ok && shaped.value.update_check_enabled);
    return c.redirect('/admin/system', 302);
  });

  /** An explicit ask, which is the only thing that checks immediately. */
  app.post('/admin/system/check-now', async (c: Context) => {
    if (!readUpdateState(deps.db).enabled) {
      return c.html(systemPage('Turn update checking on first.'), 400);
    }
    const result = await checkForUpdate(deps.fetcher, deps.appVersion);
    recordUpdateCheck(
      deps.db,
      now(),
      result.status === 'ok' ? result.latest : null,
      result.status === 'ok' ? null : result.message,
    );
    return c.redirect('/admin/system', 302);
  });

  app.post('/admin/system/timezone', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(
      z.string().refine((value) => supportedTimezones().includes(value), {
        error: () => 'Choose a timezone from the list.',
      }),
      body['timezone'],
    );
    if (!shaped.ok) return c.html(systemPage(shaped.message), 400);
    deps.db
      .prepare(`UPDATE household_settings SET timezone = ?, updated_at = ? WHERE id = 'singleton'`)
      .run(shaped.value, now());
    return c.redirect('/admin/system', 302);
  });

  /**
   * The database, as a file.
   *
   * `VACUUM INTO` rather than copying the file underneath a running process:
   * it takes a consistent snapshot while the scheduler is mid-sync, which
   * copying a WAL database emphatically does not.
   */
  app.get('/admin/system/backup', (c: Context) => {
    const staging = mkdtempSync(join(tmpdir(), 'mw-backup-'));
    const target = join(staging, 'wall.db');
    try {
      backupTo(deps.db, target);
      const bytes = readFileSync(target);
      const stamp = new Date(now()).toISOString().slice(0, 10);
      c.header('content-type', 'application/octet-stream');
      c.header('content-disposition', `attachment; filename="maverick-wall-${stamp}.db"`);
      return c.body(bytesOf(bytes));
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  /**
   * The encryption key, separately and deliberately.
   *
   * Calendar URLs are stored encrypted, so a database on its own restores
   * everything except the feeds. The key is what makes the backup complete,
   * and it is also what makes it a credential — which is why it is a second,
   * separate download with its own warning rather than something bundled in
   * without the household noticing.
   */
  app.get('/admin/system/key', (c: Context) => {
    try {
      const bytes = readFileSync(join(deps.dataDir, '.secret'));
      c.header('content-type', 'application/octet-stream');
      c.header('content-disposition', 'attachment; filename="maverick-wall.key"');
      return c.body(bytesOf(bytes));
    } catch {
      return c.html(systemPage('The encryption key could not be read.'), 500);
    }
  });

  /** Everything a bug report needs and nothing that belongs to the household. */
  app.get('/admin/system/diagnostics', (c: Context) => {
    let size = 0;
    try {
      size = statSync(databasePath(deps.dataDir)).size;
    } catch {
      // Reported as zero; the integrity check below is the real signal.
    }
    const report = buildDiagnostics({
      db: deps.db,
      appVersion: deps.appVersion,
      startedAt: deps.startedAt,
      now: now(),
      log: deps.log.lines(),
      databaseSizeBytes: size,
    });
    const stamp = new Date(now()).toISOString().slice(0, 10);
    c.header('content-type', 'application/json; charset=utf-8');
    c.header('content-disposition', `attachment; filename="maverick-wall-diagnostics-${stamp}.json"`);
    return c.body(JSON.stringify(report, null, 2));
  });

  /**
   * Restore: staged, then applied on the next start.
   *
   * Swapping the file under a process that has it open, mid-sync, with WAL
   * readers attached, is how a restore turns into a corruption. Writing it
   * aside and letting boot do the swap costs a restart and cannot half-happen.
   */
  app.post('/admin/system/restore', async (c: Context) => {
    const body = await c.req.parseBody();
    const file = body['backup'];
    if (!(file instanceof File) || file.size === 0) {
      return c.html(systemPage('Choose a backup file to restore.'), 400);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    // Every SQLite file starts with this. Checking it here means a restore
    // cannot be armed with a photograph.
    if (bytes.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
      return c.html(
        systemPage('That file is not a Maverick Wall backup.'),
        400,
      );
    }

    const staged = join(deps.dataDir, 'restore.db');
    writeFileSync(staged, bytes);
    return c.html(
      page({
      modules: navModules(deps.db),
        title: 'Restore staged',
        nav: 'system',
        heading: 'Ready to restore',
        intro:
          'The backup has been checked and put aside. Restart Maverick Wall to ' +
          'apply it — the current database is kept alongside it, so a restore ' +
          'that turns out to be the wrong file is not the end.',
        body:
          `<p>If your calendars come back but show no events, the encryption key ` +
          `does not match this database. Restore the key file too.</p>` +
          `<p><a class="link" href="admin/system">← Back</a></p>`,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // People
  // -------------------------------------------------------------------------

  app.get('/admin/people', (c: Context) => c.html(peoplePage()));

  app.post('/admin/people', async (c: Context) => {
    const shaped = parse(personBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(peoplePage(shaped.message), 400);

    createPerson(deps.db, randomBytes(8).toString('hex'), shaped.value.name, shaped.value.color);
    return c.redirect('/admin/people', 302);
  });

  /**
   * The images a canvas can use — for the editor's picker (RFC 005 Phase 3b).
   * JSON behind the session; the bytes come from `/admin/media/:name`. Declared
   * before `/:name` so `list` is not swallowed as a filename.
   */
  app.get('/admin/media/list', (c: Context) =>
    c.json({ images: listImages(deps.db, 'background') }),
  );

  /**
   * Upload a canvas image, answered as JSON for the editor's fetch (RFC 005
   * Phase 3b). The same `storeImage` the avatar path uses — sniffed from magic
   * bytes, SVG refused, the stored name derived from the content hash, so a
   * filename can never reach the filesystem.
   */
  app.post('/admin/media/upload', async (c: Context) => {
    const body = await c.req.parseBody();
    const file = body['image'];
    if (!(file instanceof File) || file.size === 0) {
      return c.json({ ok: false, message: 'Choose an image to upload.' }, 400);
    }
    const stored = storeImage(deps.db, deps.dataDir, Buffer.from(await file.arrayBuffer()), file.name, 'background');
    if (!stored.ok) {
      return c.json({ ok: false, message: stored.message, suggestion: stored.suggestion }, 400);
    }
    return c.json({ ok: true, name: stored.name });
  });

  /** The same bytes as `/d/media`, behind the session instead of a screen token. */
  app.get('/admin/media/:name', (c: Context) => {
    const image = readImage(deps.dataDir, c.req.param('name') ?? '');
    if (image === undefined) return c.json({ error: 'not-found' }, 404);
    c.header('content-type', image.contentType);
    c.header('x-content-type-options', 'nosniff');
    c.header('cache-control', 'private, max-age=86400');
    return c.body(bytesOf(image.bytes));
  });

  app.post('/admin/people/:id/avatar', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    if (!readPeopleAdmin(deps.db).some((person) => person.id === id)) {
      return c.html(peoplePage('That person is no longer there.'), 404);
    }

    const body = await c.req.parseBody();
    const file = body['avatar'];

    // An empty file input means "remove the picture", which is a thing a
    // household will want and should not need a second button for.
    if (!(file instanceof File) || file.size === 0) {
      setPersonAvatar(deps.db, id, null);
      return c.redirect('/admin/people', 302);
    }

    const stored = storeImage(
      deps.db,
      deps.dataDir,
      Buffer.from(await file.arrayBuffer()),
      file.name,
      'avatar',
    );
    if (!stored.ok) {
      return c.html(peoplePage(stored.message, stored.suggestion), 400);
    }

    setPersonAvatar(deps.db, id, stored.name);
    return c.redirect('/admin/people', 302);
  });

  app.post('/admin/people/:id', async (c: Context) => {
    const shaped = parse(personBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(peoplePage(shaped.message), 400);

    updatePerson(deps.db, c.req.param('id') ?? '', shaped.value.name, shaped.value.color);
    return c.redirect('/admin/people', 302);
  });

  app.post('/admin/people/:id/move', async (c: Context) => {
    const dir = String(((await c.req.parseBody()) as Record<string, unknown>)['dir'] ?? '');
    movePerson(deps.db, c.req.param('id') ?? '', dir === 'up' ? 'up' : 'down');
    return c.redirect('/admin/people', 302);
  });

  app.get('/admin/people/:id/delete', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const person = readPeopleAdmin(deps.db).find((candidate) => candidate.id === id);
    if (person === undefined) return c.redirect('/admin/people', 302);

    return c.html(
      page({
      modules: navModules(deps.db),
        title: 'Remove person',
        nav: 'people',
        heading: `Remove ${person.name}?`,
        intro:
          person.sourceCount === 0
            ? 'Their shift rotation goes too.'
            : `Their shift rotation goes too. ${person.sourceCount} calendar` +
              `${person.sourceCount === 1 ? '' : 's'} will stay subscribed but stop being ` +
              'attributed to anyone.',
        body:
          `<form method="post" action="admin/people/${encodeURIComponent(id)}/delete">` +
          `<button type="submit">Remove them</button></form>` +
          `<form method="get" action="admin/people">` +
          `<button class="secondary" type="submit">Keep them</button></form>`,
      }),
    );
  });

  app.post('/admin/people/:id/delete', (c: Context) => {
    deletePerson(deps.db, c.req.param('id') ?? '');
    return c.redirect('/admin/people', 302);
  });

  // -------------------------------------------------------------------------
  // Shifts
  // -------------------------------------------------------------------------

  /** Read a draft back out of the form that rendered it. */
  const draftFrom = (body: Record<string, unknown>): Draft => {
    const shaped = parse(draftBody, body);
    const named = shaped.ok ? shaped.value : {};

    /** One positional field, read by index and never rejected. */
    const at = (prefix: string, index: number): string => {
      const value = (body as Record<string, unknown>)[`${prefix}_${index}`];
      return typeof value === 'string' ? value.trim() : '';
    };

    const slots: string[] = [];
    for (let index = 0; index < MAX_CYCLE; index++) slots.push(at('slot', index));

    const titleMap: { title: string; key: string }[] = [];
    for (let index = 0; index < 40; index++) {
      const title = at('title', index);
      if (title === '') continue;
      titleMap.push({ title, key: at('map', index) });
    }

    return {
      personId: named.person_id ?? '',
      kind: named.kind === 'pattern' ? 'pattern' : 'calendar',
      sourceId: named.source_id ?? '',
      anchorDate: named.anchor_date ?? '',
      slots,
      titleMap,
    };
  };

  /** The inverse of `planFrom`: a saved plan back into an editable draft. */
  const draftFromPlan = (plan: ShiftPlan, personId: string): Draft => {
    const empty = Array.from({ length: MAX_CYCLE }, () => SLOT_UNUSED);
    if (plan.kind === 'pattern') {
      const slots = [...empty];
      plan.cycle.forEach((key, index) => {
        if (index < MAX_CYCLE) slots[index] = key === null ? SLOT_OFF : key;
      });
      return { personId, kind: 'pattern', sourceId: '', anchorDate: plan.anchorDate, slots, titleMap: [] };
    }
    // Calendar: start from the titles the feed has now, pre-select the saved
    // mapping for each, and append any saved matcher whose title has since left
    // the feed so it can still be seen and cleared.
    const sourceId = plan.calendarSourceId;
    const saved = new Map(
      plan.matchers.map((m) => [m.pattern, m.shiftTypeKey === null ? SLOT_OFF : m.shiftTypeKey]),
    );
    const titleMap = suggestedTitleMap(sourceId).map((entry) => ({
      title: entry.title,
      key: saved.get(entry.title) ?? entry.key,
    }));
    for (const [title, key] of saved) {
      if (!titleMap.some((entry) => entry.title === title)) titleMap.push({ title, key });
    }
    return { personId, kind: 'calendar', sourceId, anchorDate: '', slots: empty, titleMap };
  };

  app.get('/admin/shifts', (c: Context) => c.html(shiftsPage()));

  /** Edit a saved rotation: the same draft form, pre-filled from the plan. */
  app.get('/admin/shifts/:id/edit', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const plan = readShiftPlans(deps.db).find((candidate) => candidate.id === id);
    if (plan === undefined) return c.redirect('/admin/shifts', 302);
    const owner = deps.db
      .prepare('SELECT person_id AS personId FROM shift_plans WHERE id = ?')
      .get(id) as { personId: string | null } | undefined;
    return c.html(draftPage(draftFromPlan(plan, owner?.personId ?? '')));
  });

  /** Step one: who, and where the answer comes from. */
  app.post('/admin/shifts/new', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(draftBody, body);
    if (!shaped.ok) return c.html(shiftsPage({ message: shaped.message }), 400);

    const personId = shaped.value.person_id ?? '';
    const kind: PlanKind = shaped.value.kind === 'pattern' ? 'pattern' : 'calendar';
    const sourceId = shaped.value.source_id ?? '';

    if (!readPeopleAdmin(deps.db).some((person) => person.id === personId)) {
      return c.html(shiftsPage({ message: 'Choose who the rotation is for.' }), 400);
    }
    if (kind === 'calendar' && sourceId === '') {
      return c.html(shiftsPage({ message: 'Choose which calendar the shifts are in.' }), 400);
    }

    const draft: Draft = {
      personId,
      kind,
      sourceId,
      anchorDate: localToday(),
      slots: Array.from({ length: MAX_CYCLE }, () => SLOT_UNUSED),
      titleMap: suggestedTitleMap(sourceId),
    };
    return c.html(draftPage(draft));
  });

  app.post('/admin/shifts/preview', async (c: Context) => {
    const draft = draftFrom((await c.req.parseBody()) as Record<string, unknown>);
    const plan = planFrom(draft, 'preview');
    if ('message' in plan) return c.html(draftPage(draft, plan), 400);
    return c.html(draftPage(draft, undefined, plan));
  });

  app.post('/admin/shifts/save', async (c: Context) => {
    const draft = draftFrom((await c.req.parseBody()) as Record<string, unknown>);
    const plan = planFrom(draft, randomBytes(8).toString('hex'));
    if ('message' in plan) return c.html(draftPage(draft, plan), 400);

    const person = readPeopleAdmin(deps.db).find((candidate) => candidate.id === draft.personId);
    if (person === undefined) {
      return c.html(draftPage(draft, { message: 'That person is no longer there.' }), 400);
    }

    saveShiftPlan(deps.db, {
      id: plan.id,
      personId: draft.personId,
      name: `${person.name}'s rotation`,
      kind: draft.kind,
      anchorDate: draft.kind === 'pattern' ? draft.anchorDate : null,
      cycle: draft.kind === 'pattern' ? (cycleFrom(draft.slots) as (string | null)[]) : null,
      calendarSourceId: draft.kind === 'calendar' ? draft.sourceId : null,
      matchers:
        draft.kind === 'calendar'
          ? (plan as unknown as { matchers: unknown[] }).matchers
          : null,
      effectiveFrom: '2000-01-01',
    });
    return c.redirect('/admin/shifts', 302);
  });

  app.post('/admin/shifts/:id/delete', (c: Context) => {
    deleteShiftPlan(deps.db, c.req.param('id') ?? '');
    return c.redirect('/admin/shifts', 302);
  });

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  // The unified section. Screens and Layout were two pages for one thing; a
  // display is now one place — its status, pairing, settings and layout.
  app.get('/admin/displays', (c: Context) => c.html(displaysPage()));
  app.get('/admin/displays/:id', (c: Context) => {
    const id = c.req.param('id') ?? '';
    if (id === 'default') return c.html(displayDetailPage(null));
    if (!activeScreens().some((s) => s.id === id)) return c.redirect('/admin/displays', 302);
    // An e-paper panel's page is its design page — a panel landing here (an
    // old link, or the shared layout routes before they were kind-aware) gets
    // wall settings that do not apply to it.
    if (activeScreens().some((s) => s.id === id && s.kind === 'epaper')) {
      return c.redirect(`/admin/epaper/${encodeURIComponent(id)}/design`, 302);
    }
    return c.html(displayDetailPage(id));
  });

  // Old routes kept as redirects so bookmarks and any hand-typed links land in
  // the new section rather than 404ing.
  app.get('/admin/screens', (c: Context) => c.redirect('/admin/displays', 302));

  /**
   * Approve (or decline) a screen waiting in a device-authorization flow.
   *
   * This is the household half of frictionless pairing (RFC 003 Phase 3): the
   * screen began the flow at `/d/pair/device-start` and is polling; the QR it
   * shows leads here with the code pre-filled, or the household types the code
   * at the Screens page. Behind the session gate — which is what makes the short
   * code safe, because approval is impossible without the login.
   *
   * Registered *before* `POST /admin/screens/:id` on purpose: `approve` would
   * otherwise be swallowed as an `:id`, and the settings-save handler would
   * answer instead. A static segment must be declared ahead of the param it
   * would collide with.
   */
  app.get('/admin/screens/approve', (c: Context) => {
    const code = c.req.query('code') ?? '';
    const flow = deps.deviceFlow.lookupByUserCode(code, now());
    if (flow === undefined || flow.state !== 'pending') {
      return c.html(approveResultPage(
        'Nothing to approve',
        'That pairing code has expired or was already used. Start pairing again on ' +
          'the screen, then approve the new code here.',
      ), flow === undefined ? 404 : 409);
    }
    return c.html(approvePromptPage(flow.userCode));
  });

  app.post('/admin/screens/approve', async (c: Context) => {
    const shaped = parse(approveDeviceBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(approveResultPage('That did not work', shaped.message), 400);
    const { code, name, action } = shaped.value;
    const at = now();

    if (action === 'deny') {
      deps.deviceFlow.deny(code, at);
      return c.html(approveResultPage(
        'Screen declined',
        'That screen will not be paired. It is safe to close it, or start again.',
      ));
    }

    // Issue the token first, then try to bind it to the still-pending flow.
    // Binding before creating the screen row is what prevents an orphan: if the
    // flow expired or was already approved (a double submit, or a scan racing a
    // manual entry), `approve` returns false and no screen is ever written.
    const issued = issueDisplayToken();
    if (!deps.deviceFlow.approve(code, issued.token, name, at)) {
      return c.html(approveResultPage(
        'Nothing to approve',
        'That pairing code has expired or was already used. Start pairing again on ' +
          'the screen, then approve the new code here.',
      ), 409);
    }
    const id = randomBytes(6).toString('hex');
    createScreen(deps.db, id, name, pairingSecret(issued));
    return c.html(approveResultPage(
      `${escapeHtml(name)} is paired`,
      'The screen will pick up its token on its next check, within a few seconds, ' +
        'and start drawing. You can rename or remove it from the Displays page.',
    ));
  });

  app.post('/admin/screens/:id', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const body = (await c.req.parseBody()) as Record<string, unknown>;

    const shaped = parse(screenBody, body);
    if (!shaped.ok) return c.html(displaysPage(shaped.message), 400);

    /*
     * Empty means "follow the household" on every one of these.
     *
     * That is a real answer rather than a missing one, so the schema leaves
     * them optional and the membership checks live here — a theme this build
     * cannot draw and a zone `Intl` does not know are both facts about this
     * process rather than about the shape of the request.
     */
    const { name, orientation, rotation, allow_dismiss: allowDismiss } = shaped.value;
    // '' follows the household, '1' forces 24-hour, '0' forces 12-hour.
    const clockRaw = shaped.value.clock_24 ?? '';
    const clock24 = clockRaw === '1' ? 1 : clockRaw === '0' ? 0 : null;
    const theme = shaped.value.theme ?? '';
    const daytimeTheme = shaped.value.daytime_theme ?? '';
    const startsAt = shaped.value.daytime_starts_at ?? '';
    const endsAt = shaped.value.daytime_ends_at ?? '';
    const timezone = shaped.value.timezone ?? '';

    if (!isValidThemeRef(deps.db, theme, themeKeys)) {
      return c.html(displayDetailPage(id, 'Choose a theme from the list.'), 400);
    }
    if (!isValidThemeRef(deps.db, daytimeTheme, themeKeys)) {
      return c.html(displayDetailPage(id, 'Choose a daylight theme from the list.'), 400);
    }

    const scheduled = daytimeTheme !== '';
    if (scheduled && (!HHMM_SHAPE.test(startsAt) || !HHMM_SHAPE.test(endsAt))) {
      return c.html(displayDetailPage(id, 'Enter this wall’s daylight hours as HH:MM.'), 400);
    }
    if (scheduled && startsAt === endsAt) {
      return c.html(displayDetailPage(id, 'A daylight window of no length would never switch.'), 400);
    }
    if (timezone !== '' && !supportedTimezones().includes(timezone)) {
      return c.html(displayDetailPage(id, 'Choose a timezone from the list.'), 400);
    }

    // Density overrides: empty follows the household default, a number is
    // range-checked here beside the theme and zone checks.
    const density = (
      raw: string | undefined,
      low: number,
      high: number,
      label: string,
    ): { ok: true; value: number | null } | { ok: false; message: string } => {
      const value = (raw ?? '').trim();
      if (value === '') return { ok: true, value: null };
      if (!/^[0-9]+$/.test(value)) {
        return { ok: false, message: `${label} has to be a whole number, or blank to follow the default.` };
      }
      const n = Number(value);
      if (n < low || n > high) return { ok: false, message: `${label} has to be between ${low} and ${high}.` };
      return { ok: true, value: n };
    };
    const today = density(shaped.value.today_events, 1, 20, 'Events today');
    if (!today.ok) return c.html(displayDetailPage(id, today.message), 400);
    const nextDays = density(shaped.value.next_days, 0, 14, 'Days ahead');
    if (!nextDays.ok) return c.html(displayDetailPage(id, nextDays.message), 400);
    const weeks = density(shaped.value.horizon_weeks, 1, 8, 'Weeks of month');
    if (!weeks.ok) return c.html(displayDetailPage(id, weeks.message), 400);

    if (
      !writeScreenSettings(deps.db, id, {
        name,
        orientation,
        rotation,
        theme: theme === '' ? null : theme,
        timezone: timezone === '' ? null : timezone,
        daytimeTheme: scheduled ? daytimeTheme : null,
        daytimeStartsAt: scheduled ? startsAt : null,
        daytimeEndsAt: scheduled ? endsAt : null,
        allowDismiss,
        displayTodayEvents: today.value,
        displayNextDays: nextDays.value,
        displayHorizonWeeks: weeks.value,
        clock24,
      })
    ) {
      return c.redirect('/admin/displays', 302);
    }
    // Back to the wall's own page; it picks the change up on its next poll.
    return c.redirect(`/admin/displays/${encodeURIComponent(id)}`, 302);
  });

  /**
   * The stored secrets for a freshly issued pairing: the token's hash, and the
   * short code's hash with its expiry. One place so the code's lifetime is set
   * once whether the screen is created or regenerated.
   */
  function pairingSecret(issued: IssuedToken): PairingSecret {
    return {
      tokenHash: issued.tokenHash,
      pairingCodeHash: hashShortCode(issued.shortCode),
      pairingCodeExpiresAt: Date.now() + PAIRING_CODE_TTL_MS,
    };
  }

  /**
   * Create a screen and show its pairing link.
   *
   * This is what the `add-screen` CLI does, moved to the one place a household
   * on the add-on can actually reach — they have a sidebar, not a shell. The
   * CLI stays for an SSH pairing and for the very first screen before any
   * account exists, but it is no longer the only door.
   */
  app.post('/admin/screens', async (c: Context) => {
    const shaped = parse(newScreenBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(displaysPage(shaped.message), 400);

    const issued = issueDisplayToken();
    const id = randomBytes(6).toString('hex');
    createScreen(deps.db, id, shaped.value.name, pairingSecret(issued));
    // Seed the new screen with Classic, so it opens on the standard kitchen
    // calendar the household can rearrange — never a blank editor.
    applyTemplate(deps.db, id, CLASSIC_TEMPLATE);
    return c.html(pairingPage(id, shaped.value.name, issued.token, issued.shortCode, c));
  });

  /**
   * A new token, shown once.
   *
   * The old one stops working the moment this runs, which is the point: a
   * screen that left the house, or a pairing link that ended up in a chat
   * thread, needs a way to be cut off.
   */
  app.post('/admin/screens/:id/regenerate', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = readAdminScreens(deps.db).find((candidate) => candidate.id === id);
    if (screen === undefined) return c.html(displaysPage('That screen is no longer there.'), 404);

    const issued = issueDisplayToken();
    rotateScreenToken(deps.db, id, pairingSecret(issued));
    return c.html(pairingPage(id, screen.name, issued.token, issued.shortCode, c));
  });

  app.post('/admin/screens/:id/revoke', (c: Context) => {
    revokeScreen(deps.db, c.req.param('id') ?? '');
    return c.redirect('/admin/displays', 302);
  });

  // -------------------------------------------------------------------------
  // eInk (e-paper) displays (RFC 006)
  //
  // A separate door from the browser walls: an e-paper panel is server-rendered
  // and reached either by a device that pulls its image or by Home Assistant
  // pushing it to a BLE tag. So the page's job is not a QR to scan — it is the
  // frame URL and the two recipes that consume it.

  /**
   * The origin an e-paper device (or Home Assistant) can actually reach.
   *
   * Exactly the pairing link's problem: under ingress the request origin is the
   * supervisor's internal Docker address, which an ESPHome panel on the wall
   * cannot reach, so the URL comes from `base_url`; on the port the request
   * origin is what the household typed and is right.
   */
  const epaperOrigin = (c: Context): string => {
    const underIngress = ingressPath(c) !== '';
    return (underIngress ? deps.baseUrl : new URL(c.req.url).origin).replace(/\/+$/, '');
  };
  const frameUrlFor = (token: string, c: Context): string => `${epaperOrigin(c)}/d/epaper/${token}.png`;

  const esphomeRecipe = (url: string): string =>
    `esphome:\n` +
    `  name: kitchen-eink\n` +
    `esp32:\n` +
    `  board: esp32dev\n` +
    `wifi:\n` +
    `  ssid: !secret wifi_ssid\n` +
    `  password: !secret wifi_password\n\n` +
    `display:\n` +
    `  - platform: waveshare_epaper   # match your panel's driver\n` +
    `    model: 7.50inv2\n` +
    `    cs_pin: 5\n` +
    `    dc_pin: 17\n` +
    `    busy_pin: 4\n` +
    `    reset_pin: 16\n` +
    `    update_interval: never\n` +
    `    lambda: |-\n` +
    `      it.image(0, 0, id(wall_image));\n\n` +
    `online_image:\n` +
    `  - id: wall_image\n` +
    `    url: "${url}"\n` +
    `    format: PNG\n` +
    `    type: BINARY\n\n` +
    `deep_sleep:            # drop this block for a mains panel that carries alerts\n` +
    `  run_duration: 30s\n` +
    `  sleep_duration: 30min\n\n` +
    `interval:\n` +
    `  - interval: 25s\n` +
    `    then:\n` +
    `      - component.update: wall_image\n` +
    `      - component.update: display`;

  const haRecipe = (url: string): string =>
    `# configuration.yaml — Home Assistant fetches this URL; the wall is never called back\n` +
    `camera:\n` +
    `  - platform: generic\n` +
    `    name: eInk source\n` +
    `    still_image_url: "${url}"\n\n` +
    `# automation — runs entirely inside Home Assistant\n` +
    `triggers:\n` +
    `  - trigger: time_pattern\n` +
    `    minutes: "/15"\n` +
    `actions:\n` +
    `  - action: camera.snapshot\n` +
    `    target:\n` +
    `      entity_id: camera.eink_source\n` +
    `    data:\n` +
    `      filename: /media/eink/wall.png\n` +
    `  - action: opendisplay.upload_image\n` +
    `    data:\n` +
    `      device_id: <your OpenDisplay tag>\n` +
    `      image:\n` +
    `        media_content_id: media-source://media_source/local/eink/wall.png\n` +
    `        media_content_type: image/png\n` +
    `      fit_mode: contain\n` +
    `      dither: floyd_steinberg\n` +
    `      refresh_mode: full`;

  const codeBlock = (title: string, code: string): string =>
    `<h3 style="margin:18px 0 6px">${escapeHtml(title)}</h3>` +
    `<pre class="code">${escapeHtml(code)}</pre>`;

  /**
   * The page shown once a screen exists, carrying the token in the URL.
   *
   * The token is shown here and never stored in the clear, exactly like a
   * pairing link — so this is also where "Regenerate URL" lands. A URL that says
   * `localhost` cannot be reached from a wall panel, so we say so rather than
   * hand over a dead link.
   */
  const epaperConfigPage = (
    id: string,
    name: string,
    token: string,
    geometry: { width: number; height: number; rotation: number },
    c: Context,
  ): string => {
    const url = frameUrlFor(token, c);
    const unreachable = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
    return page({
      modules: navModules(deps.db),
      title: 'eInk display — Maverick Wall',
      nav: 'epaper',
      heading: name,
      intro: `${geometry.width}×${geometry.height}, black & white${geometry.rotation === 0 ? '' : `, rotated ${geometry.rotation}°`}.`,
      body:
        (unreachable
          ? errorBlock(
              'This URL points at localhost, which a wall panel cannot reach.',
              'Set this add-on’s base URL (or open the admin by the address a device on your network uses), then regenerate the URL.',
            )
          : '') +
        `<p>This is the screen's image URL. It contains the screen's token, so it is ` +
        `shown <strong>once</strong> — copy it now. Regenerating makes a new one and ` +
        `retires this.</p>` +
        `<input readonly onclick="this.select()" value="${escapeHtml(url)}" ` +
        `style="width:100%;font:13px/1.4 ui-monospace,Menlo,Consolas,monospace" aria-label="Frame URL">` +
        `<p class="hint">A device pulls this image; Home Assistant can push it to a BLE tag. ` +
        `On battery, an e-paper panel is a glance — it sleeps, so it cannot show a weather ` +
        `takeover the moment it fires. A mains panel that polls can.</p>` +
        codeBlock('ESPHome — a wifi panel pulls the image', esphomeRecipe(url)) +
        codeBlock('Home Assistant — push to an OpenDisplay tag', haRecipe(url)) +
        `<div style="display:flex;gap:10px;margin-top:18px">` +
        `<a class="btn" href="admin/epaper">Done</a>` +
        `<form method="post" action="admin/epaper/${encodeURIComponent(id)}/regenerate">` +
        `<button class="btn ghost" type="submit">Regenerate URL</button></form>` +
        `</div>`,
    });
  };

  /** The eInk Displays list and the add form. */
  const epaperPage = (error?: string): string => {
    const screens = readAdminScreens(deps.db).filter(
      (screen) => screen.kind === 'epaper' && screen.revokedAt === null,
    );
    const seen = (at: number | null): string =>
      at === null ? 'never connected' : `last seen ${ago(at, now())}`;
    const card = (screen: (typeof screens)[number]): string =>
      `<div class="card"><div style="display:flex;align-items:center;gap:12px">` +
      `<div class="ic">${icon('screens')}</div>` +
      `<div style="flex:1;min-width:0">` +
      `<div class="rname" style="font-size:16px">${escapeHtml(screen.name)}</div>` +
      `<div class="host">${screen.panelWidth ?? '?'}×${screen.panelHeight ?? '?'}` +
      `${screen.rotation === 0 ? '' : ` · rotated ${screen.rotation}°`} · ${seen(screen.lastSeenAt)}</div>` +
      `</div></div>` +
      `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:10px">` +
      // One filled action per card; the rest are outlined ("btn ghost" here
      // never matched the .btn-ghost rule, so all three used to render filled).
      `<a class="btn" href="admin/epaper/${encodeURIComponent(screen.id)}/design">Design layout</a>` +
      `<form method="post" action="admin/epaper/${encodeURIComponent(screen.id)}/regenerate">` +
      `<button class="btn-ghost" type="submit">Show URL &amp; recipes</button></form>` +
      `<form method="post" action="admin/epaper/${encodeURIComponent(screen.id)}/revoke" ` +
      `onsubmit="return confirm('Remove ${escapeHtml(screen.name)}? Its URL stops working.')">` +
      `<button class="btn-danger" type="submit">Remove</button></form>` +
      `</div></div>`;

    const options = Object.entries(EPAPER_PRESETS)
      .map(([key, p]) => `<option value="${key}">${escapeHtml(p.label)}</option>`)
      .join('');

    return page({
      modules: navModules(deps.db),
      title: 'eInk Displays — Maverick Wall',
      nav: 'epaper',
      heading: 'eInk Displays',
      action: { label: 'Add an eInk screen', href: 'admin/epaper#add' },
      ...(screens.length === 0
        ? {
            intro:
              'Low-power e-paper panels. Maverick Wall renders the picture; a device pulls it, ' +
              'or Home Assistant pushes it to a BLE tag. Add one to get its image URL and the recipes.',
          }
        : {}),
      body:
        (error === undefined ? '' : errorBlock(error)) +
        (screens.length === 0 ? '' : `<div class="grid g2">${screens.map(card).join('')}</div>`) +
        `<h2 class="add" id="add">Add an eInk screen</h2>` +
        `<form method="post" action="admin/epaper">` +
        textField({
          label: 'Name',
          name: 'name',
          required: true,
          placeholder: 'Hallway tag',
          attrs: 'maxlength="80"',
        }) +
        selectField({
          label: 'Panel',
          name: 'preset',
          optionsHtml: `${options}<option value="custom">Custom size…</option>`,
        }) +
        `<div class="grid g2">` +
        `<div>` +
        textField({ label: 'Width (px)', name: 'width', placeholder: '800', attrs: 'inputmode="numeric"' }) +
        `</div><div>` +
        textField({ label: 'Height (px)', name: 'height', placeholder: '480', attrs: 'inputmode="numeric"' }) +
        `</div></div>` +
        `<p class="hint">Width and height are only used for a Custom panel. In the panel's ` +
        `native (landscape) resolution — rotation is separate.</p>` +
        selectField({
          label: 'Rotation',
          name: 'rotation',
          optionsHtml:
            `<option value="0">None</option><option value="90">90°</option>` +
            `<option value="180">180°</option><option value="270">270°</option>`,
        }) +
        `<p class="hint">Colour panels are coming; today every e-paper screen is rendered ` +
        `black &amp; white.</p>` +
        `<button class="btn" type="submit">Create</button>` +
        `</form>`,
    });
  };

  app.get('/admin/epaper', (c: Context) => c.html(epaperPage()));

  app.post('/admin/epaper', async (c: Context) => {
    const shaped = parse(newEpaperBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(epaperPage(shaped.message), 400);

    let width: number;
    let height: number;
    if (shaped.value.preset === 'custom') {
      width = Number(shaped.value.width);
      height = Number(shaped.value.height);
      const sane = (n: number): boolean => Number.isInteger(n) && n >= 64 && n <= 2000;
      if (!sane(width) || !sane(height)) {
        return c.html(
          epaperPage('Give the panel a width and height in pixels, each between 64 and 2000.'),
          400,
        );
      }
    } else {
      const preset = EPAPER_PRESETS[shaped.value.preset];
      if (preset === undefined) return c.html(epaperPage('Choose a panel.'), 400);
      width = preset.width;
      height = preset.height;
    }

    const issued = issueDisplayToken();
    const id = randomBytes(6).toString('hex');
    createEpaperScreen(deps.db, id, shaped.value.name, pairingSecret(issued), {
      width,
      height,
      colour: 'bw',
      rotation: shaped.value.rotation,
    });
    return c.html(
      epaperConfigPage(id, shaped.value.name, issued.token, { width, height, rotation: shaped.value.rotation }, c),
    );
  });

  app.post('/admin/epaper/:id/regenerate', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = readAdminScreens(deps.db).find(
      (candidate) => candidate.id === id && candidate.kind === 'epaper' && candidate.revokedAt === null,
    );
    if (screen === undefined) return c.html(epaperPage('That screen is no longer there.'), 404);
    const issued = issueDisplayToken();
    rotateScreenToken(deps.db, id, pairingSecret(issued));
    return c.html(
      epaperConfigPage(
        id,
        screen.name,
        issued.token,
        { width: screen.panelWidth ?? 800, height: screen.panelHeight ?? 480, rotation: screen.rotation },
        c,
      ),
    );
  });

  app.post('/admin/epaper/:id/revoke', (c: Context) => {
    revokeScreen(deps.db, c.req.param('id') ?? '');
    return c.redirect('/admin/epaper', 302);
  });

  const findEpaper = (id: string): AdminScreenRow | undefined =>
    readAdminScreens(deps.db).find((s) => s.id === id && s.kind === 'epaper' && s.revokedAt === null);

  const epaperWidgetsFor = (id: string, screen: AdminScreenRow): PlacedWidgetRow[] =>
    screen.layoutMode === 'freeform' ? readLayoutWidgets(deps.db, id, epaperOrientation(screen)) : [];

  /**
   * The saved layout, drawn exactly as the panel will — the one honest preview.
   *
   * The editor's own live preview is DOM, which has colour and anti-aliasing a
   * 1-bit panel does not; this renders the real frame through the same path the
   * device fetches, so what the household arranges is what they will see. Behind
   * the session, and never cached — it changes every time the layout is saved.
   */
  app.get('/admin/epaper/:id/preview.png', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = findEpaper(id);
    if (screen === undefined || deps.previewManifest === undefined) return c.body(null, 404);
    try {
      const widgets = epaperWidgetsFor(id, screen).map((row) => ({
        type: row.type,
        x: row.x,
        y: row.y,
        w: row.w,
        h: row.h,
        z: row.z,
        config: row.config !== null && typeof row.config === 'object' ? (row.config as Record<string, unknown>) : {},
      }));
      const frame = renderScreenFrame(deps.previewManifest(id) as Manifest, screen, widgets);
      c.header('cache-control', 'no-store');
      return c.body(bytesOf(Buffer.from(encodePng1bit(frame.fb))), 200, { 'content-type': 'image/png' });
    } catch {
      return c.body(null, 503);
    }
  });

  /**
   * The same 1-bit frame, for a canvas that has not been saved yet.
   *
   * The designer's arrange area used to be drawn by the *wall* renderer, so an
   * arrangement for a black-and-white panel was shown in colour cards and
   * looked nothing like the thing it was for. The fix is not to teach the
   * browser a second 1-bit renderer — two renderers disagreeing is the whole
   * problem — but to let the editor post the boxes it has and get back the
   * exact frame the panel would draw, from the one renderer that draws it.
   *
   * Nothing is stored. `POST` because a canvas does not belong in a URL, and
   * `no-store` because this frame is a keystroke old.
   *
   * The posted boxes are the canvas *by definition* here, so the screen goes in
   * as `freeform` whatever the row says. A panel that has never been saved has
   * `layout_mode` NULL, and reading it would have drawn the built-in layout for
   * every arrangement — a backdrop that never moves while you drag, which is
   * the very fault this endpoint exists to fix. `renderScreenFrame` still ANDs
   * with `widgets.length > 0`, so posting an empty canvas falls back to the
   * built-in layout exactly as a saved empty one does.
   */
  app.post('/admin/epaper/:id/preview.png', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = findEpaper(id);
    if (screen === undefined || deps.previewManifest === undefined) return c.body(null, 404);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ ok: false, message: 'That was not readable as JSON.' }, 400);
    }
    const shaped = parse(epaperPreviewBody, raw);
    if (!shaped.ok) return c.json({ ok: false, message: shaped.message }, 400);
    try {
      const widgets = shaped.value.widgets.map((widget) => ({
        type: widget.type,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        z: widget.z,
        config: widget.config !== undefined ? (widget.config as Record<string, unknown>) : {},
      }));
      const frame = renderScreenFrame(
        deps.previewManifest(id) as Manifest,
        { ...screen, layoutMode: 'freeform' },
        widgets,
      );
      c.header('cache-control', 'no-store');
      return c.body(bytesOf(Buffer.from(encodePng1bit(frame.fb))), 200, { 'content-type': 'image/png' });
    } catch {
      return c.body(null, 503);
    }
  });

  /**
   * Design an e-paper panel's layout — the same drag-and-drop editor a browser
   * wall uses, on this panel's own canvas, with the real 1-bit preview beside it.
   *
   * The editor writes the same `layout_widgets` and flips the screen to
   * `freeform` on save (`replaceLayout`), so nothing here has to. The canvas
   * aspect is seeded from the panel geometry so a box drawn square is square on
   * the panel; the household still sees the truth in the preview regardless.
   */
  app.get('/admin/epaper/:id/design', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = findEpaper(id);
    if (screen === undefined) return c.redirect('/admin/epaper', 302);

    const pw = screen.panelWidth ?? 800;
    const ph = screen.panelHeight ?? 480;
    const landscapeAspect = Math.max(pw, ph) / Math.min(pw, ph);
    const portraitAspect = Math.min(pw, ph) / Math.max(pw, ph);
    // The panel's own ratio, never a stored one. On a browser wall the aspect is
    // a guess about a screen nobody measured, so the household may set it; a
    // panel is 800x480 and that is the end of it. Honouring a stored 16:9 here
    // drew the boxes on a canvas the device cannot show, which is how a widget
    // ended up somewhere other than where it was dragged. Saving writes this
    // value back, so a canvas arranged before this is corrected on first save.
    const canvas = (orientation: 'portrait' | 'landscape') => ({
      aspect: orientation === 'landscape' ? landscapeAspect : portraitAspect,
      widgets: readLayoutWidgets(deps.db, id, orientation).map((w) => ({
        id: w.id,
        type: w.type,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        z: w.z,
        config: w.config,
      })),
      background: undefined,
    });
    const initial = {
      screen: id,
      // Tells the editor its host is a panel, so its Reset confirm says what
      // reset actually does here (back to the built-in layout, not Classic).
      kind: 'epaper',
      // The one orientation this panel will ever draw, so the editor opens on
      // the canvas the device reads rather than on the wall's portrait default.
      // The other canvas is still loaded and saved; it is simply not the one a
      // household is shown for a panel bolted to a wall in one orientation.
      orientation: epaperOrientation(screen),
      panel: { width: pw, height: ph },
      mode: 'freeform',
      portrait: canvas('portrait'),
      landscape: canvas('landscape'),
      // eInk ignores calendar-source and reading selection today (it draws them
      // whole), so those pickers start empty; the module picker is real.
      calendars: [],
      readings: [],
      modules: readEnabledExternalModules(deps.db).map((m) => ({ id: m.id, name: m.name })),
    };

    const preview =
      `<h2 class="add">Preview</h2>` +
      `<p class="hint">What the panel actually draws, in black &amp; white. Save your ` +
      `changes and it updates within a few seconds.</p>` +
      `<img id="ep-preview" class="ep-paper" alt="eInk preview of ${escapeHtml(screen.name)}" ` +
      `src="admin/epaper/${encodeURIComponent(id)}/preview.png">` +
      `<script>(function(){var i=document.getElementById('ep-preview');if(!i)return;` +
      `setInterval(function(){i.src='admin/epaper/${encodeURIComponent(id)}/preview.png?t='+Date.now();},4000);})();</script>` +
      `<h2 class="add">Arrange</h2>`;

    return c.html(
      page({
        modules: navModules(deps.db),
        title: `${screen.name} layout — Maverick Wall`,
        nav: 'epaper',
        heading: `${screen.name} — layout`,
        intro: `${pw}×${ph}, black & white. Drag widgets to build the panel; the preview shows the real result. Colour, gradient and shadow options do not apply on e-paper.`,
        body:
          preview +
          layoutEditorMount(initial) +
          // The one save bar, same chrome as the display page minus its
          // settings form — with no form the chrome saves the canvas and
          // reloads. Chrome first, so its `mwEditorState` hook is registered
          // before the editor publishes its bridge.
          `<div class="savebar" id="savebar">` +
          `<span class="msg" role="alert"></span>` +
          `<span class="savebar-flag" data-dirty-flag hidden>Unsaved changes</span>` +
          `<button type="button" class="btn-ghost" data-action="discard">Discard</button>` +
          `<button type="button" class="btn" data-action="save">Save this panel</button>` +
          `</div>` +
          `<script type="module" src="assets/display-editor.js"></script>` +
          `<script type="module" src="assets/layout-editor.js"></script>`,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Display
  // -------------------------------------------------------------------------

  // The global Display page is retired: its appearance controls are the Default
  // display's now. Kept as a redirect so old bookmarks and links land there.
  app.get('/admin/display', (c: Context) => c.redirect('/admin/displays/default', 302));

  // The Default display's appearance form posts here — the household defaults
  // every wall inherits. (Weather moved to its own page; see admin-alerts.ts.)
  app.post('/admin/display', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;

    const shaped = parse(displayBody, body);
    if (!shaped.ok) return c.html(displayDetailPage(null, shaped.message), 400);

    // A built-in or a custom theme that still exists — the schema let any string
    // through so the check could see the database.
    if (!isValidThemeRef(deps.db, shaped.value.theme, themeKeys)) {
      return c.html(displayDetailPage(null, 'Choose a theme from the list.'), 400);
    }

    /*
     * "Same theme all day" is a choice, not a missing value.
     *
     * Stored as null, which is what the manifest reads as "no schedule". A
     * household with one theme should not have to think about a time window
     * that does nothing.
     */
    const daytimeRaw = shaped.value.daytime_theme;
    const scheduled = daytimeRaw !== undefined && daytimeRaw !== 'none';
    if (scheduled && !isValidThemeRef(deps.db, daytimeRaw, themeKeys)) {
      return c.html(displayDetailPage(null, 'Choose a daylight theme from the list.'), 400);
    }

    const order = blockOrder(body, readHousehold(deps.db).displayBlocks);
    if ('error' in order) return c.html(displayDetailPage(null, order.error), 400);

    writeDisplaySettings(deps.db, {
      theme: shaped.value.theme,
      daytimeTheme: scheduled ? daytimeRaw : null,
      // `?? null` because the schema only guarantees these are present when a
      // daylight theme was chosen, and `scheduled` is exactly that condition —
      // but the type does not know the two are linked.
      daytimeStartsAt: scheduled ? (shaped.value.daytime_starts_at ?? null) : null,
      daytimeEndsAt: scheduled ? (shaped.value.daytime_ends_at ?? null) : null,
      todayEvents: shaped.value.today_events,
      nextDays: shaped.value.next_days,
      horizonWeeks: shaped.value.horizon_weeks,
      blocks: order.blocks,
      clock24: shaped.value.clock_24 ? 1 : 0,
      weekStart: shaped.value.week_start,
    });

    // Back to the Default display; the wall picks it up on its next poll.
    return c.redirect('/admin/displays/default', 302);
  });

  // -------------------------------------------------------------------------
  // Layout editor
  // -------------------------------------------------------------------------

  /**
   * The owner a `?screen=` or a posted `screen` names — a real paired wall, or
   * the shared default. A stranger's id resolves to the default rather than
   * writing onto, or reading, a wall that is not theirs.
   */
  function resolveOwner(id: string | null | undefined): string | null {
    if (id === null || id === undefined || id === '') return null;
    return activeScreens().some((s) => s.id === id) ? id : null;
  }

  app.get('/admin/layout', (c: Context) => {
    const owner = resolveOwner(c.req.query('screen'));
    return c.redirect(owner === null ? '/admin/displays/default' : `/admin/displays/${encodeURIComponent(owner)}`, 302);
  });

  /**
   * The manifest the editor's live preview renders from — for the wall being
   * edited, so its zone and density are the ones that wall actually uses.
   *
   * The same document that wall polls, so the preview shows real calendars,
   * forecasts and readings rather than a label — behind the session like every
   * other admin route, because it carries the household's actual data.
   */
  app.get('/admin/layout/preview.json', (c: Context) => {
    if (deps.previewManifest === undefined) return c.json({ error: 'unavailable' }, 404);
    return c.json(deps.previewManifest(resolveOwner(c.req.query('screen'))));
  });

  /**
   * Save the whole canvas.
   *
   * A JSON POST from the editor script rather than a form, because a canvas is
   * a set of shapes and coordinates, not named fields. Answered as JSON too:
   * the caller is a `fetch`, not a browser following a redirect. The schema is
   * the boundary — a bad payload is a 400 with a message, never a half-written
   * layout, because `replaceLayout` is one transaction.
   */
  app.post('/admin/layout', async (c: Context) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ ok: false, message: 'That was not readable as JSON.' }, 400);
    }

    const shaped = parse(layoutBody, raw);
    if (!shaped.ok) return c.json({ ok: false, message: shaped.message }, 400);

    // Null is the shared default; a valid screen id is that wall's own canvas.
    // An id that is not a real wall falls back to the default rather than
    // conjuring a row for a screen that does not exist. The editor posts one
    // orientation at a time; absent is portrait (RFC 005).
    replaceLayout(deps.db, resolveOwner(shaped.value.screen), shaped.value.orientation ?? 'portrait', {
      mode: shaped.value.mode,
      aspect: shaped.value.aspect,
      widgets: shaped.value.widgets,
      // Stored as JSON; null when the canvas has no background.
      background: shaped.value.background != null ? JSON.stringify(shaped.value.background) : null,
    });
    return c.json({ ok: true });
  });

  /** Whether an owner id is an e-paper panel — their layout lives on its own
   *  design page, not in the wall Displays section. */
  const isEpaperOwner = (owner: string | null): boolean =>
    owner !== null && activeScreens().some((s) => s.id === owner && s.kind === 'epaper');

  /** The layout view of a display's page, where apply/copy/reset return to.
   *  Kind-aware: an e-paper panel goes back to its design page — sending it to
   *  the wall Displays section is how Reset looked like it did nothing. */
  const layoutUrl = (owner: string | null): string =>
    isEpaperOwner(owner)
      ? `/admin/epaper/${encodeURIComponent(owner as string)}/design`
      : `/admin/displays/${owner === null ? 'default' : encodeURIComponent(owner)}#layout`;

  /**
   * The template gallery — pick a starting layout for this display (RFC 005).
   *
   * A server-rendered page: the cards, the categories, and a plain form per
   * template so applying works with no JavaScript at all. A first-party script
   * then draws each card's live preview through the wall's own `renderFreeform`,
   * so what you pick is what the wall will draw — progressive enhancement, never
   * a requirement.
   */
  app.get('/admin/displays/:id/gallery', (c: Context) => {
    const id = c.req.param('id') ?? '';
    if (id !== 'default' && !activeScreens().some((s) => s.id === id)) {
      return c.redirect('/admin/displays', 302);
    }
    return c.html(templateGalleryPage(resolveOwner(id === 'default' ? null : id)));
  });

  /**
   * Apply a template to a display. A plain form POST, because the whole gallery
   * works without script; an unknown id is a no-op with a message rather than a
   * half-applied layout. Writes both canvases (`applyTemplate`).
   */
  app.post('/admin/displays/:id/apply-template', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const owner = resolveOwner(id === 'default' ? null : id);
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const template = typeof body['templateId'] === 'string' ? findTemplate(body['templateId']) : undefined;
    if (template === undefined) {
      return c.html(templateGalleryPage(owner, 'That template is not one we ship.'), 400);
    }
    applyTemplate(deps.db, owner, template);
    return c.redirect(layoutUrl(owner), 302);
  });

  /**
   * Copy another display's layout onto this one — the "start from another wall"
   * convenience the hybrid model gives in place of shared profiles. A one-shot
   * copy; the source is untouched and the two are not linked.
   */
  app.post('/admin/displays/:id/copy-from', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const to = resolveOwner(id === 'default' ? null : id);
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const src = typeof body['sourceOwner'] === 'string' ? body['sourceOwner'] : '';
    const from = resolveOwner(src === 'default' ? null : src);
    if (from === to) {
      return c.html(templateGalleryPage(to, 'Pick a different display to copy from.'), 400);
    }
    copyLayout(deps.db, from, to);
    return c.redirect(layoutUrl(to), 302);
  });

  /**
   * Reset a display's layout to its default. For a wall that is the Classic
   * template — the standard kitchen calendar, the same layout a new display
   * starts from (there is no "stacked" mode to fall back to any more). For an
   * e-paper panel the default is different: the built-in fixed layout the
   * frame renderer draws when no canvas exists, so reset clears the canvas
   * rather than applying a wall template to a 1-bit panel.
   */
  app.post('/admin/displays/:id/reset-layout', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const owner = resolveOwner(id === 'default' ? null : id);
    if (isEpaperOwner(owner)) clearLayout(deps.db, owner as string);
    else applyTemplate(deps.db, owner, CLASSIC_TEMPLATE);
    return c.redirect(layoutUrl(owner), 302);
  });

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  /** Today in the household's own zone, for the anchor default. */
  function localToday(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: readHousehold(deps.db).timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(now()));
  }

  /**
   * The titles in a feed, pre-tagged with what they look like.
   *
   * `analyseTitles` grades each one, and a `likely` grade pre-selects its
   * guess. Nobody should have to describe a rota in the abstract — listing
   * what is genuinely in their calendar and asking which entries are work
   * gets the truth, including the variants nobody would think to type.
   */
  function suggestedTitleMap(sourceId: string): { title: string; key: string }[] {
    if (sourceId === '') return [];
    const timezone = readHousehold(deps.db).timezone;
    return candidatesFor(readTitleObservations(deps.db, sourceId), timezone).map((candidate) => ({
      title: candidate.title,
      key:
        candidate.confidence === 'likely'
          ? candidate.suggestedShiftKey === null
            ? SLOT_OFF
            : (candidate.suggestedShiftKey ?? '')
          : '',
    }));
  }

  function shiftOptions(selected: string, unusedLabel: string): string {
    const types = readShiftTypes(deps.db);
    return (
      `<option value=""${selected === '' ? ' selected' : ''}>${escapeHtml(unusedLabel)}</option>` +
      types
        .map(
          (type) =>
            `<option value="${escapeHtml(type.key)}"${type.key === selected ? ' selected' : ''}>` +
            `${escapeHtml(type.label)}</option>`,
        )
        .join('') +
      `<option value="${SLOT_OFF}"${selected === SLOT_OFF ? ' selected' : ''}>Off</option>`
    );
  }

  /** The editor: tag titles or set a cycle, preview, then save. */
  function draftPage(
    draft: Draft,
    error?: { message: string; suggestion?: string },
    plan?: ReturnType<typeof planFrom>,
  ): string {
    const person = readPeopleAdmin(deps.db).find((candidate) => candidate.id === draft.personId);
    const hidden =
      `<input type="hidden" name="person_id" value="${escapeHtml(draft.personId)}">` +
      `<input type="hidden" name="kind" value="${escapeHtml(draft.kind)}">` +
      `<input type="hidden" name="source_id" value="${escapeHtml(draft.sourceId)}">`;

    let fields: string;
    if (draft.kind === 'pattern') {
      const slots = Array.from({ length: MAX_CYCLE }, (_, index) => {
        const value = draft.slots[index] ?? SLOT_UNUSED;
        return (
          `<span><label for="slot_${index}">Day ${index + 1}</label>` +
          `<select id="slot_${index}" name="slot_${index}">` +
          `${shiftOptions(value, '—')}</select></span>`
        );
      }).join('');
      fields =
        textField({
          label: 'The cycle starts on',
          name: 'anchor_date',
          type: 'date',
          required: true,
          value: draft.anchorDate,
          hint: 'A day you know what you were doing. Day 1 below is that day.',
        }) +
        `<h2 class="add">The cycle</h2>` +
        `<p class="hint">Fill in as many days as the pattern is long, then leave the ` +
        `rest as “—”. It repeats from Day 1 for ever.</p>` +
        `<div class="slots">${slots}</div>`;
    } else {
      const source = readAdminSources(deps.db).find(
        (candidate) => candidate.id === draft.sourceId,
      );
      const rows = draft.titleMap
        .map(
          (entry, index) =>
            `<div class="row-fields">` +
            `<span class="title-cell">${escapeHtml(entry.title)}` +
            `<input type="hidden" name="title_${index}" value="${escapeHtml(entry.title)}"></span>` +
            `<span><select name="map_${index}" aria-label="What ${escapeHtml(entry.title)} means">` +
            `${shiftOptions(entry.key, 'Not a shift')}</select></span>` +
            `</div>`,
        )
        .join('');
      fields =
        `<p>Reading titles from <strong>${escapeHtml(source?.name ?? 'that calendar')}</strong>.</p>` +
        (draft.titleMap.length === 0
          ? errorBlock(
              'No repeating titles found in that calendar.',
              'Shift markers cover a lot of days. If the feed has only just been added, ' +
                'give it a sync first.',
            )
          : `<h2 class="add">What these entries mean</h2>` +
            `<p class="hint">These are the repeating titles actually in that feed. ` +
            `Tag the ones that are work or a rest day; leave the rest alone.</p>` +
            rows);
    }

    return page({
      modules: navModules(deps.db),
      title: 'Work Schedule — Maverick Wall',
      nav: 'shifts',
      heading: `${person?.name ?? 'Someone'}'s rotation`,
      intro:
        draft.kind === 'pattern'
          ? 'A repeating pattern. Preview it before saving — four weeks is enough to recognise.'
          : 'Read from a calendar. Preview it before saving — four weeks is enough to recognise.',
      body:
        `<p><a class="link" href="admin/shifts">← Back</a></p>` +
        (error === undefined ? '' : errorBlock(error.message, error.suggestion)) +
        (plan === undefined || 'message' in plan
          ? ''
          : renderPreview(
              previewFor(
                plan,
                localToday(),
                readShiftTypes(deps.db),
                draft.kind === 'calendar'
                  ? readTitlesByDate(deps.db, draft.sourceId)
                  : new Map<string, string[]>(),
                readHousehold(deps.db).timezone,
              ),
            )) +
        `<form method="post">${hidden}${fields}` +
        `<div class="row">` +
        `<button type="submit" formaction="admin/shifts/preview">Preview four weeks</button>` +
        `<button class="secondary" type="submit" formaction="admin/shifts/save">Save</button>` +
        `</div></form>`,
    });
  }

  function shiftsPage(error?: { message: string; suggestion?: string }): string {
    const plans = readShiftPlansAdmin(deps.db);
    const people = readPeopleAdmin(deps.db);
    const sources = readAdminSources(deps.db);

    const card = (plan: typeof plans[number]): string =>
      `<article class="card">` +
      `<h2>${escapeHtml(plan.personName ?? 'Nobody')}</h2>` +
      `<p class="host">` +
      (plan.kind === 'pattern'
        ? `Repeating pattern from ${escapeHtml(plan.anchorDate ?? '?')}`
        : `Read from ${escapeHtml(plan.sourceName ?? 'a calendar that has been removed')}`) +
      `</p>` +
      `<div class="row">` +
      `<a class="btn secondary btn-sm" href="admin/shifts/${encodeURIComponent(plan.id)}/edit">Edit</a>` +
      `<form method="post" action="admin/shifts/${encodeURIComponent(plan.id)}/delete">` +
      `<button class="secondary" type="submit">Remove</button></form>` +
      `</div></article>`;

    const canAdd = people.length > 0;
    return page({
      modules: navModules(deps.db),
      title: 'Work Schedule — Maverick Wall',
      nav: 'shifts',
      heading: 'Work Schedule',
      action: { label: 'Shift types', href: 'admin/shifts/types' },
      intro:
        'The wall colours each day by who is working. A rotation is either read ' +
        'from a calendar that already has the shifts in it, or set as a pattern ' +
        'that repeats. Name and colour the shift types on the Shift types screen.',
      body:
        (error === undefined ? '' : errorBlock(error.message, error.suggestion)) +
        plans.map(card).join('') +
        (canAdd
          ? `<h2 class="add" id="add">Add a rotation</h2>` +
            `<form method="post" action="admin/shifts/new">` +
            selectField({
              label: 'Who',
              name: 'person_id',
              optionsHtml: people
                .map(
                  (candidate) =>
                    `<option value="${escapeHtml(candidate.id)}">${escapeHtml(candidate.name)}</option>`,
                )
                .join(''),
            }) +
            selectField({
              label: 'Where the shifts come from',
              name: 'kind',
              optionsHtml:
                `<option value="calendar">A calendar that already has them</option>` +
                `<option value="pattern">A pattern that repeats</option>`,
            }) +
            selectField({
              label: 'Which calendar',
              name: 'source_id',
              hint: 'Only needed when the shifts come from a calendar.',
              optionsHtml:
                `<option value="">—</option>` +
                sources
                  .map(
                    (source) =>
                      `<option value="${escapeHtml(source.id)}">${escapeHtml(source.name)}</option>`,
                  )
                  .join(''),
            }) +
            `<button type="submit">Continue</button></form>`
          : `<p>Add someone on the <a class="link" href="admin/people">People</a> screen first — ` +
            `a rotation belongs to a person.</p>`),
    });
  }

  function systemPage(error?: string): string {
    const household = readHousehold(deps.db);
    const at = now();
    const integrity = integrityCheck(deps.db);
    const lines = deps.log.lines();

    let size = 0;
    try {
      size = statSync(databasePath(deps.dataDir)).size;
    } catch {
      // Shown as unknown rather than failing the page.
    }

    const uptime = Math.max(0, Math.round((at - deps.startedAt) / 1000));
    const uptimeText =
      uptime < 3600
        ? `${Math.round(uptime / 60)} minutes`
        : uptime < 172800
          ? `${Math.round(uptime / 3600)} hours`
          : `${Math.round(uptime / 86400)} days`;

    const logText = lines
      .slice(-120)
      .map((line) => {
        const stamp = new Intl.DateTimeFormat('en-GB', {
          timeZone: household.timezone,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).format(new Date(line.at));
        return `${stamp}  ${line.level === 'info' ? ' ' : line.level[0]?.toUpperCase()}  ${line.text}`;
      })
      .join('\n');

    return page({
      modules: navModules(deps.db),
      title: 'System — Maverick Wall',
      nav: 'system',
      heading: 'System',
      body:
        (error === undefined ? '' : errorBlock(error)) +

        `<article class="card">` +
        `<h2>Version ${escapeHtml(deps.appVersion)}</h2>` +
        `<p class="host">Running ${escapeHtml(uptimeText)} · schema ` +
        `${readSchemaVersionSafe()} · database ${formatBytes(size)}</p>` +
        `<p>${integrity.ok ? 'The database checks out.' : `Database problem: ${escapeHtml(integrity.detail)}`}</p>` +
        `</article>` +

        `<h2 class="add">Timezone</h2>` +
        `<p class="hint">Every all-day event and the whole shift rotation are ` +
        `anchored to this. A screen somewhere else can override it on its own card.</p>` +
        `<form method="post" action="admin/system/timezone">` +
        selectField({
          label: 'Household timezone',
          name: 'timezone',
          optionsHtml: supportedTimezones()
            .map(
              (zone) =>
                `<option value="${escapeHtml(zone)}"` +
                `${zone === household.timezone ? ' selected' : ''}>${escapeHtml(zone)}</option>`,
            )
            .join(''),
        }) +
        `<button type="submit">Save</button></form>` +

        `<h2 class="add">Update check</h2>` +
        updateSection() +

        `<h2 class="add">Backup</h2>` +
        `<p class="hint">Two files, and you need both to restore everything. The ` +
        `database holds your calendars and settings; the key is what decrypts the ` +
        `calendar addresses inside it.</p>` +
        `<div class="row">` +
        `<form method="get" action="admin/system/backup">` +
        `<button type="submit">Download database</button></form>` +
        `<form method="get" action="admin/system/key">` +
        `<button class="secondary" type="submit">Download key</button></form>` +
        `</div>` +
        errorBlock(
          'The key file is a credential.',
          'Anyone with it and your database can read your calendar addresses. ' +
            'Keep it somewhere private, and never attach it to a support request.',
        ) +

        `<h2 class="add">Restore</h2>` +
        `<p class="hint">Upload a database backup. It is checked and put aside, ` +
        `then applied when Maverick Wall next starts.</p>` +
        `<form method="post" action="admin/system/restore" enctype="multipart/form-data">` +
        textField({ label: 'Backup file', name: 'backup', type: 'file', required: true }) +
        `<button type="submit">Stage restore</button></form>` +

        `<h2 class="add">Diagnostics</h2>` +
        `<p class="hint">Safe to attach to a bug report: it carries no calendar ` +
        `addresses, no event titles and no email addresses — only hostnames, ` +
        `counts and the log below.</p>` +
        `<form method="get" action="admin/system/diagnostics">` +
        `<button type="submit">Download diagnostics</button></form>` +

        `<h2 class="add">Recent log</h2>` +
        (lines.length === 0
          ? `<p class="hint">Nothing logged yet.</p>`
          : `<pre class="log">${escapeHtml(logText)}</pre>`),
    });
  }

  /**
   * The disclosure, written to be read rather than agreed to.
   *
   * It names the host, says what leaves the house, says what does not, and
   * says that nothing is ever installed. Somebody should be able to decide
   * from this paragraph alone, without trusting the person who wrote it.
   */
  function updateSection(): string {
    const state = readUpdateState(deps.db);
    const behind =
      state.latestVersion !== null && isNewer(state.latestVersion, deps.appVersion);

    const status = !state.enabled
      ? `<p class="hint">Off. Maverick Wall is not contacting anyone.</p>`
      : state.lastError !== null
        ? errorBlock(`Last check failed: ${state.lastError}`, 'It will try again tomorrow.')
        : state.lastCheckedAt === null
          ? `<p class="hint">On. The first check runs within the day, or press the button.</p>`
          : behind
            ? `<div class="preview"><h3>Version ${escapeHtml(state.latestVersion ?? '')} is available</h3>` +
              `<p class="hint">You are running ${escapeHtml(deps.appVersion)}. Nothing has been ` +
              `downloaded — update the container when it suits you.</p></div>`
            : `<p class="hint">Up to date as of ${escapeHtml(ago(state.lastCheckedAt, now()))}. ` +
              `Running ${escapeHtml(deps.appVersion)}.</p>`;

    return (
      `<p>Maverick Wall does not contact anyone unless you switch this on.</p>` +
      `<ul class="plain">` +
      `<li><strong>What it does:</strong> once a day, this container asks ` +
      `<span class="code">${escapeHtml(RELEASE_HOST)}</span> for the latest released ` +
      `version number.</li>` +
      `<li><strong>What that reveals:</strong> your home's IP address, and that ` +
      `somebody there runs Maverick Wall. That is unavoidable in making any request ` +
      `at all, and it is the reason this is a choice rather than a default.</li>` +
      `<li><strong>What it does not send:</strong> nothing about your calendars, ` +
      `your events, your household, or your account. There is no identifier and no ` +
      `usage data. It is a plain request for a number.</li>` +
      `<li><strong>What it will never do:</strong> download or install anything. ` +
      `It only tells you a newer version exists; updating stays yours to do.</li>` +
      `</ul>` +
      `<p class="hint">The exact address it asks: ` +
      `<span class="code">${escapeHtml(RELEASE_URL)}</span></p>` +

      `<form method="post" action="admin/system/updates">` +
      switchRow({
        label: 'Check for updates once a day',
        name: 'update_check_enabled',
        checked: state.enabled,
        hint: 'Turning this off also forgets anything it had already found.',
      }) +
      `<button type="submit">Save</button></form>` +

      status +
      (state.enabled
        ? `<form method="post" action="admin/system/check-now">` +
          `<button class="secondary" type="submit">Check now</button></form>`
        : '')
    );
  }

  /**
   * The weather settings, and the honest bit about coverage.
   *
   * The provider is the US National Weather Service and covers nowhere else.
   * Saying so on the form is the difference between "this is not for me" and
   * an empty panel somebody spends an evening debugging.
   */
  function readSchemaVersionSafe(): number {
    try {
      return (
        deps.db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number }
      ).n;
    } catch {
      return 0;
    }
  }

  function peoplePage(error?: string, suggestion?: string): string {
    const people = readPeopleAdmin(deps.db);

    const card = (person: PersonRecord, first: boolean, last: boolean): string =>
      `<article class="card">` +
      `<h2>` +
      (person.avatarPath === null
        ? `<span class="swatch" style="--swatch:${escapeHtml(person.color)}"></span>`
        : `<img class="avatar" alt="" src="/admin/media/${escapeHtml(person.avatarPath)}">`) +
      `${escapeHtml(person.name)}</h2>` +
      `<p class="host">` +
      (person.sourceCount === 0
        ? 'No calendars assigned'
        : `${person.sourceCount} calendar${person.sourceCount === 1 ? '' : 's'}`) +
      (person.hasShiftRotation === 1 ? ' · has a shift rotation' : '') +
      `</p>` +
      `<form method="post" action="admin/people/${encodeURIComponent(person.id)}">` +
      `<div class="row-fields">` +
      textField({ label: 'Name', name: 'name', required: true, value: person.name }) +
      textField({ label: 'Colour', name: 'color', type: 'color', value: person.color }) +
      `</div>` +
      `<button type="submit">Save</button></form>` +

      `<form method="post" enctype="multipart/form-data" ` +
      `action="admin/people/${encodeURIComponent(person.id)}/avatar">` +
      textField({
        label: 'Picture',
        name: 'avatar',
        type: 'file',
        hint:
          'PNG, JPEG, GIF or WebP, up to 2 MB. Leave the box empty and save to ' +
          'remove the picture. SVG is not accepted — it can carry code.',
        attrs: 'accept="image/png,image/jpeg,image/gif,image/webp"',
      }) +
      `<button class="secondary" type="submit">` +
      `${person.avatarPath === null ? 'Upload' : 'Replace or remove'}</button></form>` +

      // Up/Down reorder the wall's legend and its shift order; the ends drop
      // the button that would do nothing, the way the shift-type card does.
      `<div class="row">` +
      (first
        ? ''
        : `<form method="post" action="admin/people/${encodeURIComponent(person.id)}/move">` +
          `<input type="hidden" name="dir" value="up">` +
          `<button class="secondary" type="submit">↑ Up</button></form>`) +
      (last
        ? ''
        : `<form method="post" action="admin/people/${encodeURIComponent(person.id)}/move">` +
          `<input type="hidden" name="dir" value="down">` +
          `<button class="secondary" type="submit">↓ Down</button></form>`) +
      `<form method="get" action="admin/people/${encodeURIComponent(person.id)}/delete">` +
      `<button class="secondary" type="submit" style="margin-left:auto">Remove</button></form>` +
      `</div>` +
      `</article>`;

    return page({
      modules: navModules(deps.db),
      title: 'People — Maverick Wall',
      nav: 'people',
      heading: 'People',
      action: { label: 'Add someone', href: 'admin/people#add' },
      intro:
        'Everyone the wall knows about. Their colour marks their events and ' +
        'their shifts, so pick ones that are easy to tell apart from across a room.',
      body:
        (error === undefined ? '' : errorBlock(error, suggestion)) +
        people.map((person, index) => card(person, index === 0, index === people.length - 1)).join('') +
        `<h2 class="add" id="add">Add someone</h2>` +
        `<form method="post" action="admin/people">` +
        `<div class="row-fields">` +
        textField({ label: 'Name', name: 'name', required: true, placeholder: 'Sam' }) +
        textField({ label: 'Colour', name: 'color', type: 'color', value: '#4C7FD1' }) +
        `</div>` +
        `<p class="hint">A picture can be added once they exist. The colour is what ` +
        `marks their events either way.</p>` +
        `<button type="submit">Add</button></form>`,
    });
  }

  /**
   * The pairing link, once.
   *
   * Shown with a QR because the alternative is reading a long random string off
   * one screen and typing it on another with a television remote, which is the
   * worst input method in the house. The short code is there for the same
   * reason, for anyone whose screen has no camera.
   */
  function pairingPage(id: string, name: string, token: string, shortCode: string, c: Context): string {
    // Pairing the tablet and designing the layout are separate jobs: this button
    // opens the display's page so the household can arrange it now, whether or
    // not a screen has connected yet. It is what stops the flow dead-ending on a
    // pairing code with nowhere to go.
    const setUp =
      `<p><a class="btn" href="admin/displays/${encodeURIComponent(id)}">` +
      `Set up its layout →</a></p>`;
    /*
     * The origin a wall screen can actually reach — which is not always the one
     * this request arrived on.
     *
     * Through Home Assistant ingress the request's origin is an address on the
     * supervisor's own Docker network, reachable from inside Home Assistant and
     * from nowhere a tablet on the wall lives. A QR built from it scans as a
     * dead link. So under ingress the link comes from `base_url` instead, which
     * is the whole reason that option exists.
     *
     * On the port the request origin is exactly right — it is whatever the
     * household typed to get here, `http://192.168.1.10:8080` and not a guess —
     * and better than `base_url`, which may still be its localhost default. So
     * that path keeps using it.
     */
    const underIngress = ingressPath(c) !== '';
    const origin = (underIngress ? deps.baseUrl : new URL(c.req.url).origin).replace(/\/+$/, '');
    const url = `${origin}/pair?token=${token}`;
    const matrix = encodeQr(url);

    // A pairing link that says `localhost` is a link to the tablet itself, and
    // it will pair with nothing. Only reachable under ingress, where `base_url`
    // is the only source of the address and the household may not have set it.
    const unreachable = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(origin);

    /*
     * When boot could ask the supervisor, we know more than the URL string can
     * tell us. A `null` mapped port is the port turned off — the exact fault
     * that cost a real install a 404 with nothing on screen to explain it — and
     * it is worth stopping on, because no link or code can work until it is
     * fixed. A known mapped *number* lets the localhost fallback name the port
     * to set rather than guess `8080`.
     */
    const wall = deps.wallAddress;
    const portOff = wall?.portMapped === null;
    const mappedPort = typeof wall?.portMapped === 'number' ? wall.portMapped : undefined;

    if (portOff) {
      return page({
      modules: navModules(deps.db),
        title: 'Pair this screen',
        nav: 'displays',
        heading: `Pair ${name}`,
        intro: 'This screen cannot be paired until the display port is turned on.',
        body:
          errorBlock(
            'The wall display port is turned off, so a screen has nowhere to connect.',
            'Open this add-on’s Network panel, give “Wall displays connect here” ' +
              '(8080/tcp) a free host port, and restart the add-on.',
          ) +
          `<p class="hint">Then come back to Screens and pair this screen again — ` +
          `the add-on will fill in the address for you once the port is on.</p>` +
          setUp +
          `<p><a class="link" href="admin/displays">← Back to displays</a></p>`,
      });
    }

    return page({
      modules: navModules(deps.db),
      title: 'Pair this screen',
      nav: 'displays',
      heading: `Pair ${name}`,
      intro:
        'Open this on the screen itself. It is shown once — if you lose it, ' +
        'generate another, which costs nothing.',
      body:
        (unreachable
          ? errorBlock(
              'This link points at localhost, which is nowhere from a wall screen.',
              mappedPort !== undefined
                ? `The display port is mapped to ${mappedPort}. Set the add-on’s ` +
                    `“base_url” to this box’s network address with that port — like ` +
                    `http://192.168.1.10:${mappedPort} — then pair again.`
                : underIngress
                  ? 'Set the add-on’s “base_url” option to this box’s address on ' +
                      'your network — like http://192.168.1.10:8080 — then pair again.'
                  : 'Open this admin page using the box’s address on your network — ' +
                      'like http://192.168.1.10:8080 — rather than localhost, then pair again.',
            )
          : '') +
        (matrix === undefined
          ? errorBlock('That address is too long to put in a QR code.', 'Use the link below.')
          : `<div class="qr">${qrSvg(matrix, 260)}</div>`) +
        `<p class="hint">No camera? Open Maverick Wall on the screen itself and ` +
        `type this pairing code:</p>` +
        `<p><span class="code">${escapeHtml(formatShortCode(shortCode))}</span></p>` +
        `<p class="hint">It works for the next day, and once — pairing a screen ` +
        `spends it. Or type this whole address on the screen instead:</p>` +
        `<p><span class="code">${escapeHtml(url)}</span></p>` +
        setUp +
        `<p class="hint">You can arrange its layout now — the screen does not have ` +
        `to be paired first.</p>` +
        `<p><a class="link" href="admin/displays">← Back to displays</a></p>`,
    });
  }

  /**
   * The confirm page for a device-flow pairing: name the screen, approve or
   * decline. Reached from the QR the screen shows (code pre-filled) or by typing
   * the code at the Screens page. The code travels in a hidden field so the one
   * form carries it to whichever button the household presses.
   */
  function approvePromptPage(userCode: string): string {
    return page({
      modules: navModules(deps.db),
      title: 'Approve this screen',
      nav: 'displays',
      heading: 'A screen wants to pair',
      intro:
        'A screen on your network is asking to become a wall display. Give it a ' +
        'name and approve it, or decline if you did not start this.',
      body:
        `<p class="hint">Pairing code from the screen: ` +
        `<span class="code">${escapeHtml(formatShortCode(userCode))}</span></p>` +
        `<form method="post" action="admin/screens/approve">` +
        `<input type="hidden" name="code" value="${escapeHtml(userCode)}">` +
        textField({
          label: 'Name',
          name: 'name',
          required: true,
          value: 'New screen',
          placeholder: 'Kitchen',
          hint: 'This is how the screen shows up on the Displays page.',
          attrs: 'maxlength="80"',
        }) +
        `<button type="submit" name="action" value="approve">Approve</button> ` +
        `<button class="secondary" type="submit" name="action" value="deny" ` +
        `formnovalidate>Decline</button>` +
        `</form>`,
    });
  }

  /** A plain outcome page for the approve/decline actions. */
  function approveResultPage(heading: string, message: string): string {
    return page({
      modules: navModules(deps.db),
      title: heading,
      nav: 'displays',
      heading,
      intro: message,
      body: `<p><a class="link" href="admin/displays">← Back to displays</a></p>`,
    });
  }

  /**
   * A category of wall settings: the rail row that selects it, and the panel it
   * shows. One tablist, one panel visible — a rail beside the panel on a wide
   * screen, and one focused screen at a time on a phone.
   */
  function wsetRow(key: string, label: string, blurb: string, on: boolean): string {
    return (
      `<button type="button" class="wset-navrow${on ? ' is-on' : ''}" role="tab" ` +
      `id="wset-tab-${key}" aria-controls="wset-${key}" aria-selected="${on ? 'true' : 'false'}"` +
      `${on ? '' : ' tabindex="-1"'} data-wset="${key}">` +
      `<span><b>${escapeHtml(label)}</b><small>${escapeHtml(blurb)}</small></span>` +
      `<span class="rowchev" aria-hidden="true">${icon('chev')}</span></button>`
    );
  }

  function wsetPanel(key: string, title: string, lead: string, body: string, on: boolean): string {
    return (
      `<section class="wset-panel" id="wset-${key}" role="tabpanel" ` +
      `aria-labelledby="wset-tab-${key}" data-wset-panel="${key}"${on ? '' : ' hidden'}>` +
      `<button type="button" class="wset-back" data-wset-back>${icon('back')}All settings</button>` +
      `<h3 tabindex="-1">${escapeHtml(title)}</h3>` +
      (lead === '' ? '' : `<p class="wset-lead">${escapeHtml(lead)}</p>`) +
      body +
      `</section>`
    );
  }

  /** A group of rows under a heading — spacing and a kicker, not another box. */
  function wsetGroup(kicker: string, body: string): string {
    return (
      `<div class="wset-group">` +
      (kicker === '' ? '' : `<div class="kick">${escapeHtml(kicker)}</div>`) +
      body +
      `</div>`
    );
  }

  /** The display name of a theme reference — a built-in key or `custom:<id>`. */
  function themeLabel(ref: string | null): string {
    const value = displayThemeRef(ref ?? '');
    if (value === '') return 'the same theme all day';
    if (value.startsWith('custom:')) {
      const found = readThemes(deps.db).find((t) => `custom:${t.id}` === value);
      return found?.name ?? 'a theme you built';
    }
    return themeName(value);
  }

  /**
   * A number this wall may either inherit or set for itself.
   *
   * The stored shape is unchanged — blank means "follow the household" exactly
   * as it always has. What changed is that the inheritance is *stated*: the
   * source and the effective value, rather than a placeholder reading
   * "8 (default)" that nobody could tell from a value already typed. The switch
   * is not submitted; the page chrome disables the number input while it is on,
   * which is how a blank (an absent field) reaches the handler.
   */
  function inheritedNumber(
    name: string,
    label: string,
    unit: string,
    value: number | null,
    fallback: number,
    low: number,
    high: number,
    hint: string,
  ): string {
    const inheriting = value === null;
    return (
      switchRow({
        label: `${label}: follow the household`,
        name: `inherit_${name}`,
        checked: inheriting,
        hint: `Household default — ${fallback} ${unit}`,
        attrs: `data-inherit-toggle="${escapeHtml(name)}"`,
      }) +
      // `data-inherit-default` is what the field is seeded with the first time
      // inheritance is turned off. Without it the revealed field is empty, and
      // an empty override *is* inheritance — so the switch would spring back on
      // at the next save and read as a control that does not work.
      `<div class="rowsub" data-inherit-field="${escapeHtml(name)}" ` +
      `data-inherit-default="${fallback}"${inheriting ? ' hidden' : ''}>` +
      textField({
        label,
        name,
        type: 'number',
        value: value === null ? '' : String(value),
        hint,
        attrs: `inputmode="numeric" min="${low}" max="${high}"${inheriting ? ' disabled' : ''}`,
      }) +
      `</div>`
    );
  }

  /**
   * The settings for one wall — everything about how that screen shows the
   * household's stuff, in categories rather than one continuous form.
   *
   * Every field keeps its name, so `POST /admin/screens/:id` is untouched: an
   * empty override still means "follow the household". The one addition is that
   * inheritance now says what it inherits *and* what that currently is.
   */
  function wallSettingsForm(screen: AdminScreenRow): string {
    const household = readHousehold(deps.db);
    const option = (value: string, label: string, selected: boolean): string =>
      `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    // Relative, so the `<base href>` prefix carries it through ingress/a proxy.
    const action = `admin/screens/${encodeURIComponent(screen.id)}`;
    // The household's own themes, offered beside the built-ins on both selects.
    const customThemeOptions = (selected: string | null): string =>
      readThemes(deps.db)
        .map((theme) => option(`custom:${theme.id}`, theme.name, selected === `custom:${theme.id}`))
        .join('');

    const helpId = `orient-help-${screen.id}`;
    const scheduled = screen.daytimeTheme !== null && screen.daytimeTheme !== '';

    // --- Appearance ------------------------------------------------------
    const appearance =
      wsetGroup(
        'Theme',
        `<div class="rows">` +
          selectRow({
            label: 'Theme',
            name: 'theme',
            wide: true,
            optionsHtml:
              option('', `Household default — ${themeLabel(household.theme)}`, screen.theme === null) +
              THEMES.map((theme) =>
                option(theme.key, theme.label, displayThemeRef(screen.theme ?? '') === theme.key),
              ).join('') +
              customThemeOptions(screen.theme),
          }) +
          selectRow({
            label: 'Daytime theme',
            name: 'daytime_theme',
            wide: true,
            hint: 'A lighter theme during the hours below.',
            optionsHtml:
              option(
                '',
                `Household default — ${themeLabel(household.daytimeTheme)}`,
                screen.daytimeTheme === null,
              ) +
              THEMES.map((theme) =>
                option(theme.key, theme.label, displayThemeRef(screen.daytimeTheme ?? '') === theme.key),
              ).join('') +
              customThemeOptions(screen.daytimeTheme),
          }) +
          // From/Until do nothing at all while this wall follows the household's
          // schedule, so they are not shown until it sets one of its own.
          `<div class="rowsub" data-reveal-if="daytime_theme"${scheduled ? '' : ' hidden'}>` +
          `<div class="two-up"><div>` +
          textField({
            label: 'From',
            name: 'daytime_starts_at',
            type: 'time',
            value: screen.daytimeStartsAt ?? '07:00',
          }) +
          `</div><div>` +
          textField({
            label: 'Until',
            name: 'daytime_ends_at',
            type: 'time',
            value: screen.daytimeEndsAt ?? '21:00',
          }) +
          `</div></div></div>` +
          `</div>` +
          `<p class="hint-1">A dark theme at noon is a hole in the wall; a light one at 2am ` +
          `is a lamp.</p>`,
      );

    // --- Content defaults -------------------------------------------------
    const content =
      `<div class="rows">` +
      inheritedNumber(
        'today_events', 'Events today', 'events',
        screen.displayTodayEvents, household.displayTodayEvents, 1, 20,
        'Anything past this is counted rather than listed. 1 to 20.',
      ) +
      inheritedNumber(
        'next_days', 'Days ahead', 'days',
        screen.displayNextDays, household.displayNextDays, 0, 14,
        'How many upcoming days an agenda can list. 0 to 14.',
      ) +
      inheritedNumber(
        'horizon_weeks', 'Weeks of month', 'weeks',
        screen.displayHorizonWeeks, household.displayHorizonWeeks, 1, 8,
        'How many weeks a month Calendar draws. 1 to 8.',
      ) +
      `</div>`;

    // --- Device and time --------------------------------------------------
    const device =
      wsetGroup('Identity', textField({ label: 'Wall name', name: 'name', required: true, value: screen.name })) +
      `<div class="wset-group">` +
      `<div class="kick">How it is hung ` +
        `<button type="button" class="fieldhelp" data-help="${helpId}" ` +
        `aria-label="About layout orientation">${icon('help')}</button></div>` +
        (
          `<div id="${helpId}" class="helppop" hidden>` +
          `<p><b>Layout orientation</b> chooses which layout this wall shows. ` +
          `<i>Automatic</i> picks portrait or landscape from how the screen reports ` +
          `itself — right for almost every wall. Pick <i>Always portrait</i> or ` +
          `<i>Always landscape</i> only for a kiosk frame that reports the wrong size.</p>` +
          `<p>This is not the Portrait/Landscape buttons in the layout editor: those ` +
          `choose which canvas you are arranging (you arrange both), while this decides ` +
          `which of the two the wall actually draws.</p></div>` +
          `<div class="rows">` +
          selectRow({
            label: 'Layout orientation',
            name: 'orientation',
            hint: 'Which of the two layouts this wall draws.',
            optionsHtml:
              option('auto', 'Automatic', screen.orientation === 'auto') +
              option('portrait', 'Always portrait', screen.orientation === 'portrait') +
              option('landscape', 'Always landscape', screen.orientation === 'landscape'),
          }) +
          selectRow({
            label: 'Display mounting',
            name: 'rotation',
            hint: 'For a screen hung on its side.',
            optionsHtml:
              option('0', 'No rotation', screen.rotation === 0) +
              option('90', '90° clockwise', screen.rotation === 90) +
              option('180', 'Upside down', screen.rotation === 180) +
              option('270', '270° clockwise', screen.rotation === 270),
          }) +
          `</div>`
        ) +
      `</div>` +
      wsetGroup(
        'Time',
        `<div class="rows">` +
          selectRow({
            label: 'Timezone',
            name: 'timezone',
            wide: true,
            optionsHtml:
              option('', `Household default — ${household.timezone}`, screen.timezone === null) +
              supportedTimezones()
                .map((zone) => option(zone, zone, screen.timezone === zone))
                .join(''),
          }) +
          selectRow({
            label: 'Time format',
            name: 'clock_24',
            wide: true,
            optionsHtml:
              option(
                '',
                `Household default — ${household.clock24 !== 0 ? '24-hour time' : '12-hour time'}`,
                screen.clock24 === null,
              ) +
              option('1', '24-hour (21:30)', screen.clock24 === 1) +
              option('0', '12-hour (9:30 pm)', screen.clock24 === 0),
          }) +
          `</div>`,
      );

    // --- Alerts and interaction -------------------------------------------
    const alerts =
      `<div class="rows">` +
      switchRow({
        label: 'Allow alert dismissal',
        name: 'allow_dismiss',
        checked: screen.allowDismiss === 1,
        hint:
          'Lets this display clear alerts for the household. Leave this off for ' +
          'displays without intentional input or screens that may be touched accidentally.',
      }) +
      `</div>`;

    // --- Advanced ---------------------------------------------------------
    //
    // Outside the settings form on purpose: each of these is its own POST, and
    // a form cannot be nested inside another. They are also the actions worth
    // a second thought, which is why they are behind their own category and
    // carry confirmations.
    const id = encodeURIComponent(screen.id);
    const advanced =
      `<div class="rows">` +
      `<form method="post" action="admin/screens/${id}/regenerate">` +
      `<button class="arow" type="submit"><span class="arow-text">Pairing link` +
      `<small>Shows a fresh link and code. The old one stops working.</small></span>` +
      `<span class="srow-chev" aria-hidden="true">${icon('chev')}</span></button></form>` +
      `<a class="arow" href="admin/displays/${id}/gallery"><span class="arow-text">Start from a template` +
      `<small>Replace this wall's layout with one we ship, or copy another wall's.</small></span>` +
      `<span class="srow-chev" aria-hidden="true">${icon('chev')}</span></a>` +
      `<form method="post" action="admin/displays/${id}/reset-layout" ` +
      `data-confirm="Reset both the portrait and landscape layouts of ${escapeHtml(screen.name)} ` +
      `to the Classic layout? Everything arranged here is replaced.">` +
      `<button class="arow is-danger" type="submit"><span class="arow-text">Reset layout` +
      `<small>Both orientations, back to the Classic layout.</small></span></button></form>` +
      `<form method="post" action="admin/screens/${id}/revoke" ` +
      `data-confirm="Unpair ${escapeHtml(screen.name)}? Its token stops working and it drops off the wall.">` +
      `<button class="arow is-danger" type="submit"><span class="arow-text">Unpair display` +
      `<small>The screen stops receiving this wall until it is paired again.</small></span></button></form>` +
      `<div class="frow"><span>Display id</span><code>${escapeHtml(screen.id)}</code></div>` +
      `</div>`;

    return (
      `<div class="wset" data-wset-root>` +
      `<nav class="wset-nav" role="tablist" aria-orientation="vertical" aria-label="Wall settings">` +
      wsetRow('appearance', 'Appearance', 'Theme and daylight schedule', true) +
      wsetRow('content', 'Content defaults', 'How much the calendars show', false) +
      wsetRow('device', 'Device and time', 'Name, mounting, timezone', false) +
      wsetRow('alerts', 'Alerts and interaction', 'Whether this screen can clear alerts', false) +
      wsetRow('advanced', 'Advanced', 'Pairing, reset, unpair', false) +
      `</nav>` +
      `<div class="wset-panels">` +
      `<form method="post" action="${action}" class="wall-settings" data-settings>` +
      wsetPanel('appearance', 'Appearance', 'How this wall looks. Anything left on the household default follows the Default display.', appearance, true) +
      wsetPanel('content', 'Content defaults', 'How much the calendars on this wall show. Each one follows the household until you turn that off.', content, false) +
      wsetPanel('device', 'Device and time', 'What this screen is called, how it is hung, and the clock it keeps.', device, false) +
      wsetPanel('alerts', 'Alerts and interaction', 'What this screen may do when an alert is showing.', alerts, false) +
      `</form>` +
      wsetPanel('advanced', 'Advanced', 'Infrequent, and some of it destructive. These act at once — they are not part of Save wall.', advanced, false) +
      `</div></div>`
    );
  }

  /** Online if seen within a few minutes — enough to say "up", not to diagnose. */
  function seenDot(lastSeenAt: number | null, at: number): string {
    const fresh = lastSeenAt !== null && at - lastSeenAt < 5 * 60_000;
    return fresh
      ? `<span class="dot dot-ok pulse"></span>`
      : `<span class="dot dot-idle"></span>`;
  }

  /**
   * A display on the unified Displays list: a summary that opens its own page,
   * where its status, pairing, settings and layout all live together.
   */
  function displayListCard(screen: AdminScreenRow, at: number): string {
    const href = `admin/displays/${encodeURIComponent(screen.id)}`;
    return (
      `<a class="card" href="${href}">` +
      `<div style="display:flex;align-items:center;gap:12px">` +
      seenDot(screen.lastSeenAt, at) +
      `<div style="flex:1;min-width:0">` +
      `<div class="rname" style="font-size:16px">${escapeHtml(screen.name)}</div>` +
      `<div class="host">Last seen ${escapeHtml(ago(screen.lastSeenAt, at))}` +
      (screen.appVersion === null ? '' : ` · ${escapeHtml(screen.appVersion)}`) +
      `</div></div>` +
      `<span class="link">Open ${icon('arrow')}</span>` +
      `</div></a>`
    );
  }

  /**
   * The layout editor mount: the shell and the current layout as JSON; a
   * first-party module makes it interactive. Same-origin, ships in the image
   * (rule three); the src and its fetches are relative so the single `<base>`
   * carries them through ingress. Path-independent — the editor posts to
   * `admin/layout` regardless of which page hosts it.
   */
  function layoutEditorMount(initial: unknown): string {
    // The mount and its data only — each host page (the display detail page
    // and the e-paper design page) emits the chrome and editor module scripts
    // once, in order, at the foot of its body. The mount deliberately does not
    // emit them itself any more; when it did, and the display page took over
    // emission, the e-paper page silently lost its editor for two releases.
    return (
      `<div id="layout-editor" data-json="${escapeHtml(JSON.stringify(initial))}"></div>` +
      `<noscript><p class="hint">The layout editor needs JavaScript to arrange ` +
      `widgets and save. The wall itself does not.</p></noscript>`
    );
  }

  /**
   * The Displays list: the shared Default plus every paired screen, each a card
   * that opens its own page. Screens and Layout used to be two sections for one
   * thing — this is the single door to a display.
   */
  function displaysPage(error?: string): string {
    const at = now();
    // e-paper panels live under their own "eInk Displays" door, not here.
    const all = readAdminScreens(deps.db).filter((screen) => screen.kind !== 'epaper');
    const active = all.filter((screen) => screen.revokedAt === null);
    const revoked = all.length - active.length;

    const defaultCard =
      `<a class="card" href="admin/displays/default">` +
      `<div style="display:flex;align-items:center;gap:12px">` +
      `<div class="ic">${icon('layout')}</div>` +
      `<div style="flex:1;min-width:0">` +
      `<div class="rname" style="font-size:16px">Default</div>` +
      `<div class="host">What every wall shows until it has its own layout</div></div>` +
      `<span class="link">Open ${icon('arrow')}</span>` +
      `</div></a>`;

    return page({
      modules: navModules(deps.db),
      title: 'Displays — Maverick Wall',
      nav: 'displays',
      heading: 'Displays',
      action: { label: 'Pair a new screen', href: 'admin/displays#add' },
      ...(active.length === 0
        ? { intro: 'No screens paired yet. The Default below is what a wall shows until you pair one and give it its own layout.' }
        : {}),
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<div class="grid g2">` +
        defaultCard +
        active.map((screen) => displayListCard(screen, at)).join('') +
        `</div>` +
        (revoked === 0
          ? ''
          : `<p class="hint">${revoked} unpaired screen${revoked === 1 ? '' : 's'} kept ` +
            `for the record. Their tokens no longer work.</p>`) +
        `<h2 class="add" id="add">Pair a new screen</h2>` +
        `<form method="post" action="admin/screens">` +
        textField({
          label: 'Name',
          name: 'name',
          required: true,
          placeholder: 'Kitchen',
          hint:
            'You get a QR code and a short code to enter on the screen itself. ' +
            'Open its page afterwards to arrange its layout and settings.',
          attrs: 'maxlength="80"',
        }) +
        `<button type="submit">Add screen</button></form>` +
        `<p class="hint">Over SSH instead: <span class="code">add-screen "Kitchen"</span>.</p>`,
    });
  }

  /**
   * The free-form layout editor.
   *
   * The server renders only the shell and the current layout as JSON; a
   * first-party module makes it interactive. That module is same-origin and
   * ships in the image — rule three — and nothing on the wall loads it, only
   * this admin page. The link and the script src are relative so the single
   * `<base>` handles ingress with no prefix threaded through here.
   */
  /**
   * The active paired screens, for the wall switcher.
   */
  function activeScreens(): AdminScreenRow[] {
    return readAdminScreens(deps.db).filter((screen) => screen.revokedAt === null);
  }

  /**
   * The Home Assistant reading labels currently resolving, for the widget
   * config picker — the exact labels a widget filters on. Read from the same
   * manifest the wall gets (the house panel is household-wide), so the picker
   * can never offer a label the wall would not recognise. Empty when there is
   * no manifest builder or no Home Assistant connection.
   */
  function haReadingLabels(): string[] {
    if (deps.previewManifest === undefined) return [];
    try {
      const manifest = deps.previewManifest(null) as {
        panels?: { home?: { readings?: unknown } };
      };
      const raw = manifest?.panels?.home?.readings;
      if (!Array.isArray(raw)) return [];
      const labels: string[] = [];
      for (const entry of raw) {
        const label = (entry as { label?: unknown })?.label;
        if (typeof label === 'string' && label !== '') labels.push(label);
      }
      return labels;
    } catch {
      return [];
    }
  }

  /**
   * One display: the shared Default (`ownerId` null) or a paired screen.
   *
   * Everything about that wall in one place — its status and pairing, the
   * layout editor for its canvas, and (for a real screen) its own settings. The
   * Default has no hardware, so no status or pairing; the household-wide stacked
   * defaults still live on the Display screen and are linked to from here.
   */
  /**
   * One wall's editor: its identity, its layout, and its settings.
   *
   * Three contexts, kept apart. **Layout** is the canvas, its tools and the
   * live preview, with the selected widget's own settings in a contextual
   * inspector beside it (a sheet on a phone). **Wall settings** is everything
   * wall-wide, in categories rather than one continuous form. The wall's
   * identity — where it goes back to, what it is called, whether it is on, and
   * the infrequent or destructive actions — is a compact header above both.
   *
   * It used to be one column of everything at one weight: status and pairing
   * buttons, the canvas, whichever widget was selected, then Look/Content/
   * Device, then Save. On a phone nobody could tell which of the three they
   * were editing, and pairing sat beside the everyday tools as an equal.
   */
  function displayDetailPage(ownerId: string | null, error?: string): string {
    const at = now();
    const household = readHousehold(deps.db);
    const owner = ownerId === null ? null : activeScreens().find((s) => s.id === ownerId) ?? null;
    const ownerKey = owner?.id ?? null;

    const mode = owner?.layoutMode ?? household.layoutMode;
    const canvasFor = (orientation: 'portrait' | 'landscape'): {
      readonly aspect: number;
      readonly widgets: readonly unknown[];
      readonly background?: unknown;
    } => ({
      aspect:
        orientation === 'landscape'
          ? owner?.layoutLandscapeAspect ?? household.layoutLandscapeAspect
          : owner?.layoutAspect ?? household.layoutAspect,
      // The stored background as an object, for the editor's control to reflect.
      background: parseBackground(
        orientation === 'landscape'
          ? owner?.layoutLandscapeBackground ?? household.layoutLandscapeBackground
          : owner?.layoutBackground ?? household.layoutBackground,
      ),
      widgets: readLayoutWidgets(deps.db, ownerKey, orientation).map((widget) => ({
        id: widget.id,
        type: widget.type,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        z: widget.z,
        config: widget.config,
      })),
    });
    const initial = {
      screen: ownerKey,
      mode: mode === 'freeform' ? 'freeform' : 'auto',
      // Both canvases: the editor toggles between them and saves per orientation
      // (RFC 005).
      portrait: canvasFor('portrait'),
      landscape: canvasFor('landscape'),
      // Everything the config panel needs to offer a choice: the calendars that
      // exist (id + name), and the Home Assistant reading labels currently
      // resolving. Read here rather than fetched again so the editor can build
      // its pickers without a second round trip.
      calendars: readAdminSources(deps.db).map((s) => ({ id: s.id, name: s.name })),
      readings: haReadingLabels(),
      // The registered modules, for the External widget's module picker.
      modules: readEnabledExternalModules(deps.db).map((m) => ({ id: m.id, name: m.name })),
      // The viewport this screen last reported, so the editor can offer "match
      // this screen's size" (RFC 005). Only a paired screen reports one — the
      // shared Default has no single size to match.
      ...(owner?.reportW != null && owner?.reportH != null
        ? { report: { w: owner.reportW, h: owner.reportH } }
        : {}),
    };

    // ---- the wall's own header ------------------------------------------
    //
    // Status in words rather than a colour alone, and short enough to sit on
    // one line beside a name that may be long. The five-minute freshness test
    // is the one the list page has always used.
    const online = owner !== null && owner.lastSeenAt !== null && at - owner.lastSeenAt < 5 * 60_000;
    const statusLine =
      owner === null
        ? `<b>Shared default</b> · every wall starts from this`
        : owner.lastSeenAt === null
          ? `<b>Never connected</b> · open its pairing link on the screen`
          : online
            ? `<b>Online</b>${owner.appVersion === null ? '' : ` · ${escapeHtml(owner.appVersion)}`}`
            : `<b>Not seen recently</b> · last seen ${escapeHtml(ago(owner.lastSeenAt, at))}`;

    const ownerParam = owner === null ? 'default' : encodeURIComponent(owner.id);
    const menuItems =
      (owner === null
        ? ''
        : `<form method="post" action="admin/screens/${encodeURIComponent(owner.id)}/regenerate">` +
          `<button class="ovf-item" type="submit">Pairing link…</button></form>`) +
      `<a class="ovf-item" href="admin/displays/${ownerParam}/gallery">Start from a template…</a>` +
      `<div class="ovf-sep"></div>` +
      `<form method="post" action="admin/displays/${ownerParam}/reset-layout" ` +
      `data-confirm="Reset both the portrait and landscape layouts of ${escapeHtml(
        owner === null ? 'the Default display' : owner.name,
      )} to the Classic layout? Everything arranged here is replaced.">` +
      `<button class="ovf-item is-danger" type="submit">Reset layout…</button></form>` +
      (owner === null
        ? ''
        : `<form method="post" action="admin/screens/${encodeURIComponent(owner.id)}/revoke" ` +
          `data-confirm="Unpair ${escapeHtml(owner.name)}? Its token stops working and it drops off the wall.">` +
          `<button class="ovf-item is-danger" type="submit">Unpair display…</button></form>`);

    // Status and the overflow ride the mode bar rather than a header of their
    // own: the app bar already carries the way back and the wall's name, and a
    // second header on a phone is a screenful before anything is editable.
    const statusAndMenu =
      `<p class="wall-status">` +
      (owner === null ? '' : seenDot(owner.lastSeenAt, at)) +
      `<span>${statusLine}</span></p>` +
      `<details class="ovf" data-overflow>` +
      `<summary class="ovf-btn" role="button" aria-haspopup="menu" ` +
      `aria-label="More actions for this display" title="More">${icon('more')}</summary>` +
      `<div class="ovf-menu" role="menu">${menuItems}</div>` +
      `</details>`;

    // ---- the two modes ---------------------------------------------------

    const modeButton = (key: string, label: string, on: boolean): string =>
      `<button type="button" role="tab" id="mode-tab-${key}" aria-controls="mode-${key}" ` +
      `aria-selected="${on ? 'true' : 'false'}"${on ? '' : ' tabindex="-1"'} ` +
      `class="${on ? 'on' : ''}" data-mode="${key}">${escapeHtml(label)}</button>`;

    // A settings error is about the settings, so the page opens on them.
    const startMode = error === undefined ? 'layout' : 'settings';

    // Said once, above the canvas, rather than repeated under each panel.
    const previewCaption =
      owner?.reportW != null && owner?.reportH != null
        ? `${owner.reportW}×${owner.reportH} · updates within a minute`
        : 'updates within a minute';

    const layoutPane =
      `<section class="mode" id="mode-layout" role="tabpanel" aria-labelledby="mode-tab-layout" ` +
      `data-mode-panel="layout"${startMode === 'layout' ? '' : ' hidden'}>` +
      `<div class="lay-panes">` +
      `<div class="lay-canvas" id="layout">` +
      `<div class="prev-head"><b>Live preview</b>` +
      `<small data-preview-dims>${escapeHtml(previewCaption)}</small></div>` +
      layoutEditorMount(initial) +
      `</div>` +
      // The contextual inspector. The editor script fills it when a widget is
      // selected; below 1200px the same element is the bottom sheet.
      `<aside class="lay-inspector" id="wall-inspector" aria-label="Selected widget">` +
      `<p class="insp-empty">Nothing selected. Tap a widget on the canvas to change ` +
      `what it shows and how it looks.</p>` +
      `</aside>` +
      `</div></section>`;

    const settingsPane =
      `<section class="mode" id="mode-settings" role="tabpanel" aria-labelledby="mode-tab-settings" ` +
      `data-mode-panel="settings"${startMode === 'settings' ? '' : ' hidden'}>` +
      (owner === null ? defaultsForm() : wallSettingsForm(owner)) +
      `</section>`;

    return page({
      modules: navModules(deps.db),
      title: `${owner ? owner.name : 'Default display'} — Maverick Wall`,
      nav: 'displays',
      heading: owner ? owner.name : 'Default display',
      back: { label: 'Walls', href: 'admin/displays' },
      body:
        `<div class="disp-editor" data-wall-editor>` +
        (error === undefined ? '' : errorBlock(error)) +
        `<div class="modebar">` +
        `<div class="seg modeswitch" role="tablist" aria-label="What you are editing">` +
        modeButton('layout', 'Layout', startMode === 'layout') +
        modeButton('settings', 'Wall settings', startMode === 'settings') +
        `</div>` +
        statusAndMenu +
        `</div>` +
        layoutPane +
        settingsPane +
        // The one save bar, pinned to the foot of the viewport. It saves the
        // canvas, the selected widget and every settings category together.
        `<div class="savebar" id="savebar">` +
        `<span class="savebar-flag" data-dirty-flag hidden>Unsaved changes</span>` +
        `<span class="msg" role="alert"></span>` +
        `<button type="button" class="btn-ghost" data-action="discard" hidden>Discard changes</button>` +
        `<button type="button" class="btn" data-action="save" disabled>Save wall</button>` +
        `</div>` +
        // Chrome first, so its `mwEditorState` hook is registered before the
        // editor publishes its bridge.
        `<script type="module" src="assets/display-editor.js"></script>` +
        `<script type="module" src="assets/layout-editor.js"></script>` +
        `</div>`,
    });
  }

  /**
   * The template gallery for one display (RFC 005).
   *
   * Server-rendered cards with a plain apply form each, so picking a layout works
   * with no JavaScript. The `template-gallery` mount carries every template's
   * portrait canvas as JSON; a first-party script draws each card's live preview
   * through the wall's own renderer, so the card shows what the wall will draw.
   */
  function templateGalleryPage(owner: string | null, error?: string): string {
    const ownerName = owner === null
      ? 'Default display'
      : activeScreens().find((s) => s.id === owner)?.name ?? 'this display';
    const ownerParam = owner === null ? 'default' : encodeURIComponent(owner);

    const card = (t: (typeof TEMPLATES)[number]): string =>
      `<article class="tpl-card">` +
      `<div class="tpl-thumb" data-tpl="${escapeHtml(t.id)}">` +
      `<div class="tpl-fallback">${escapeHtml(t.name)}</div></div>` +
      `<div class="tpl-body">` +
      `<div class="tpl-name">${escapeHtml(t.name)}</div>` +
      `<div class="tpl-blurb">${escapeHtml(t.blurb)}</div>` +
      (t.theme !== undefined
        ? `<div class="hint-1" style="margin:0 0 .2rem">Looks best in ` +
          `<b style="color:var(--accent)">${escapeHtml(themeName(t.theme))}</b> ` +
          `— change it after.</div>`
        : '') +
      `<form method="post" action="admin/displays/${ownerParam}/apply-template" ` +
      `data-confirm="Replace ${escapeHtml(ownerName)}'s current layout with ${escapeHtml(t.name)}?">` +
      `<input type="hidden" name="templateId" value="${escapeHtml(t.id)}">` +
      `<button class="btn-sm" type="submit">Use this layout</button></form>` +
      `</div></article>`;

    const group = (label: string, cat: 'home' | 'office'): string => {
      const cards = TEMPLATES.filter((t) => t.category === cat).map(card).join('');
      return `<div class="tpl-cat">${label}</div><div class="tpl-grid">${cards}</div>`;
    };

    // Every other display, to copy a layout from. Empty when this is the only one.
    const others = [
      ...(owner === null ? [] : [{ id: null as string | null, name: 'Default display' }]),
      ...activeScreens()
        .filter((s) => s.id !== owner)
        .map((s) => ({ id: s.id as string | null, name: s.name })),
    ];
    const copyFrom = others.length === 0
      ? ''
      : `<div class="tpl-copy"><div class="tpl-cat">Or copy another display</div>` +
        `<form method="post" action="admin/displays/${ownerParam}/copy-from" ` +
        `data-confirm="Replace ${escapeHtml(ownerName)}'s current layout with a copy?"><div class="row">` +
        selectField({
          label: 'From',
          name: 'sourceOwner',
          optionsHtml: others
            .map(
              (o) =>
                `<option value="${o.id === null ? 'default' : escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`,
            )
            .join(''),
        }) +
        `<button class="secondary" type="submit">Copy its layout</button></div></form></div>`;

    // The client needs each template's portrait canvas to draw a preview.
    const galleryData = JSON.stringify({
      owner,
      templates: TEMPLATES.map((t) => ({
        id: t.id,
        aspect: t.portrait.aspect,
        widgets: t.portrait.widgets,
        // The template's own theme and background, so the card previews the look
        // applying it produces, not the household's current one (RFC 005 3c).
        ...(t.theme !== undefined ? { theme: t.theme } : {}),
        ...(t.portrait.background !== undefined ? { background: t.portrait.background } : {}),
      })),
    });

    return page({
      modules: navModules(deps.db),
      title: `Templates — ${ownerName} — Maverick Wall`,
      nav: 'displays',
      heading: 'Start from a template',
      intro: `Pick a starting layout for ${ownerName}. You can move, remove and add to it afterwards.`,
      body:
        `<p><a class="link" href="admin/displays/${ownerParam}#layout">← Back to ${escapeHtml(ownerName)}</a></p>` +
        (error === undefined ? '' : errorBlock(error)) +
        `<div id="template-gallery" data-json="${escapeHtml(galleryData)}"></div>` +
        group('Home', 'home') +
        group('Office', 'office') +
        copyFrom +
        `<script type="module" src="assets/template-gallery.js"></script>`,
    });
  }

  /**
   * The household's default appearance — theme, daylight schedule and density —
   * shown as the Default display's Wall settings. Every wall inherits these
   * until it overrides them on its own page. Same categories as a wall's own
   * settings, so the two read as one screen with one of them missing its
   * hardware. Weather lives on the Weather page now, not here.
   */
  function defaultsForm(): string {
    const household = readHousehold(deps.db);
    const custom = readThemes(deps.db);
    const scheduled = household.daytimeTheme !== null && household.daytimeTheme !== '';

    const themeOptions = (selected: string, includeNone: boolean): string =>
      (includeNone
        ? `<option value="none"${selected === '' ? ' selected' : ''}>The same theme all day</option>`
        : '') +
      THEMES.map(
        (theme) =>
          `<option value="${escapeHtml(theme.key)}"${theme.key === selected ? ' selected' : ''}>` +
          `${escapeHtml(theme.label)}</option>`,
      ).join('') +
      custom
        .map(
          (theme) =>
            `<option value="custom:${escapeHtml(theme.id)}"${`custom:${theme.id}` === selected ? ' selected' : ''}>` +
            `${escapeHtml(theme.name)}</option>`,
        )
        .join('');

    const number = (name: string, label: string, value: number, low: number, high: number, hint: string): string =>
      textField({
        label,
        name,
        type: 'number',
        required: true,
        value: String(value),
        hint,
        attrs: `inputmode="numeric" min="${low}" max="${high}"`,
      });

    // --- Appearance ------------------------------------------------------
    const appearance =
      wsetGroup(
        'Theme',
        `<p class="hint-1">How the layout looks — its colours and type. Panels separates ` +
          `the shift colours best from across a room. Build your own on the ` +
          `<a class="link" href="admin/themes">Themes</a> screen.</p>` +
          themeCards(displayThemeRef(household.theme), custom),
      ) +
      wsetGroup(
        'Daylight',
        `<div class="rows">` +
          selectRow({
            label: 'Daytime theme',
            name: 'daytime_theme',
            wide: true,
            hint: 'A lighter theme during the hours below.',
            optionsHtml: themeOptions(scheduled ? displayThemeRef(household.daytimeTheme ?? '') : '', true),
          }) +
          // The window is ignored outright with no daytime theme set, so it is
          // not drawn until there is one.
          `<div class="rowsub" data-reveal-if="daytime_theme" data-reveal-empty="none"` +
          `${scheduled ? '' : ' hidden'}>` +
          `<div class="two-up"><div>` +
          textField({
            label: 'From',
            name: 'daytime_starts_at',
            type: 'time',
            value: household.daytimeStartsAt ?? '07:00',
          }) +
          `</div><div>` +
          textField({
            label: 'Until',
            name: 'daytime_ends_at',
            type: 'time',
            value: household.daytimeEndsAt ?? '21:00',
          }) +
          `</div></div></div>` +
          `</div>` +
          `<p class="hint-1">A dark theme at noon is a hole in the wall; a light one at ` +
          `2am is a lamp.</p>`,
      );

    // --- Content defaults -------------------------------------------------
    const content =
      number('today_events', 'Events listed for today', household.displayTodayEvents, 1, 20,
        'Anything past this is counted rather than listed.') +
      number('next_days', 'Days an agenda looks ahead', household.displayNextDays, 0, 14,
        'How many upcoming days a Calendar agenda can list.') +
      number('horizon_weeks', 'Weeks in the month grid', household.displayHorizonWeeks, 1, 8,
        'How many weeks a month Calendar draws. Five covers a month at a glance.') +
      `<div class="rows">` +
      selectRow({
        label: 'Week starts on',
        name: 'week_start',
        hint: 'The left-hand column of the month grid, on every wall.',
        optionsHtml:
          `<option value="sunday"${household.weekStart !== 'monday' ? ' selected' : ''}>Sunday</option>` +
          `<option value="monday"${household.weekStart === 'monday' ? ' selected' : ''}>Monday</option>`,
      }) +
      `</div>`;

    // --- Device and time --------------------------------------------------
    const device =
      `<div class="rows">` +
      switchRow({
        label: '24-hour clock',
        name: 'clock_24',
        checked: household.clock24 !== 0,
        hint:
          'Off shows a 12-hour clock (9:30 pm) on the wall; on shows 24-hour (21:30). ' +
          'Every wall inherits this until it sets its own.',
      }) +
      `</div>` +
      `<p class="hint-1">The Default display is not a screen, so it has no name, ` +
      `mounting or timezone of its own.</p>`;

    return (
      `<div class="wset" data-wset-root>` +
      `<nav class="wset-nav" role="tablist" aria-orientation="vertical" aria-label="Default display settings">` +
      wsetRow('appearance', 'Appearance', 'Theme and daylight schedule', true) +
      wsetRow('content', 'Content defaults', 'How much the calendars show', false) +
      wsetRow('device', 'Device and time', 'The household clock', false) +
      wsetRow('advanced', 'Advanced', 'Templates and reset', false) +
      `</nav>` +
      `<div class="wset-panels">` +
      `<form method="post" action="admin/display" data-settings>` +
      wsetPanel('appearance', 'Appearance', 'The look every wall starts from. A wall can override any of it on its own page.', appearance, true) +
      wsetPanel('content', 'Content defaults', 'How much the calendars show, on every wall that has not said otherwise.', content, false) +
      wsetPanel('device', 'Device and time', 'The clock every wall inherits. The household timezone is on the System screen.', device, false) +
      `</form>` +
      wsetPanel(
        'advanced',
        'Advanced',
        'These act at once — they are not part of Save wall.',
        `<div class="rows">` +
          `<a class="arow" href="admin/displays/default/gallery"><span class="arow-text">Start from a template` +
          `<small>Replace the default layout with one we ship, or copy a wall's.</small></span>` +
          `<span class="srow-chev" aria-hidden="true">${icon('chev')}</span></a>` +
          `<a class="arow" href="admin/system"><span class="arow-text">Household timezone` +
          `<small>${escapeHtml(household.timezone)} — set on the System screen.</small></span>` +
          `<span class="srow-chev" aria-hidden="true">${icon('chev')}</span></a>` +
          `<form method="post" action="admin/displays/default/reset-layout" ` +
          `data-confirm="Reset both the portrait and landscape default layouts to the Classic layout? ` +
          `Everything arranged here is replaced.">` +
          `<button class="arow is-danger" type="submit"><span class="arow-text">Reset layout` +
          `<small>Both orientations, back to the Classic layout.</small></span></button></form>` +
          `</div>`,
        false,
      ) +
      `</div></div>`
    );
  }

  function sourceRow(source: AdminSourceRow, at: number, people: readonly PersonRecord[]): string {
    const status =
      source.lastError !== null
        ? errorBlock(
            `Last sync failed: ${source.lastError}`,
            source.consecutiveFailures > 1
              ? `${source.consecutiveFailures} failures in a row. It keeps retrying, further apart each time.`
              : undefined,
          )
        : `<p>${source.eventCount} event${source.eventCount === 1 ? '' : 's'} · ` +
          `synced ${escapeHtml(ago(source.lastSuccessAt, at))}</p>`;

    const id = encodeURIComponent(source.id);
    const personOptions =
      `<option value=""${source.personId === null ? ' selected' : ''}>Everyone</option>` +
      people
        .map(
          (person) =>
            `<option value="${escapeHtml(person.id)}"` +
            `${person.id === source.personId ? ' selected' : ''}>` +
            `${escapeHtml(person.name)}</option>`,
        )
        .join('');

    return (
      `<article class="card">` +
      `<h2><span class="swatch" style="--swatch:${escapeHtml(source.color)}"></span>` +
      `${escapeHtml(source.name)}${source.enabled === 1 ? '' : ' (off)'}</h2>` +
      // The host and never the path. The path is the credential.
      `<p class="host">${escapeHtml(source.urlHost ?? 'unknown host')}</p>` +
      status +

      // When a calendar belongs to someone, their colour wins on the wall — so
      // the picker becomes a dead control. Show it as owned rather than let a
      // household set a colour that silently does nothing; the hidden field
      // keeps the stored colour so it returns intact if they pick "Everyone".
      (() => {
        const owner =
          source.personId === null ? null : (people.find((p) => p.id === source.personId) ?? null);
        const colourField =
          owner === null
            ? textField({ label: 'Colour', name: 'color', type: 'color', value: source.color })
            : `<span><label>Colour</label>` +
              `<span class="owned-colour"><span class="swatch" ` +
              `style="--swatch:${escapeHtml(owner.color)}"></span>Uses ${escapeHtml(owner.name)}’s colour</span>` +
              `<input type="hidden" name="color" value="${escapeHtml(source.color)}"></span>`;
        return (
          `<form method="post" action="admin/calendars/${id}/settings">` +
          `<div class="row-fields">` +
          textField({ label: 'Name', name: 'name', required: true, value: source.name }) +
          colourField +
          selectField({ label: 'Belongs to', name: 'person_id', optionsHtml: personOptions }) +
          `</div>`
        );
      })() +

      switchRow({
        label: 'Sync this calendar',
        name: 'enabled',
        checked: source.enabled === 1,
      }) +
      // Named as a risk rather than as a feature, because it is one.
      switchRow({
        label: 'Allow a local network address',
        name: 'allow_lan',
        checked: source.allowPrivateNetwork === 1,
        hint:
          'Local network access lets this feed reach devices inside your home. ' +
          'Only turn it on for a calendar you host yourself.',
      }) +
      `<button type="submit">Save</button></form>` +

      `<div class="row">` +
      `<form method="post" action="admin/calendars/${id}/sync">` +
      `<button class="secondary" type="submit">Sync now</button></form>` +
      `<form method="get" action="admin/calendars/${id}/delete">` +
      `<button class="secondary" type="submit">Remove</button></form>` +
      `</div></article>`
    );
  }

  /** What came back from a test, shown before anything is stored. */
  function previewPanel(result: TestFeedResult): string {
    if (!result.ok) return '';
    const when = (event: { startsAt: number; allDay: boolean }): string =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: readHousehold(deps.db).timezone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        ...(event.allDay ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }),
      }).format(new Date(event.startsAt));

    const rows =
      result.preview.length === 0
        ? `<li><span class="when">—</span><span>No upcoming events in this feed.</span></li>`
        : result.preview
            .map(
              (event) =>
                `<li><span class="when">${escapeHtml(when(event))}</span>` +
                `<span>${escapeHtml(event.title)}</span></li>`,
            )
            .join('');

    return (
      `<div class="preview">` +
      `<h3>${escapeHtml(result.calendarName ?? 'That address works')}</h3>` +
      `<p class="host">${escapeHtml(result.host)} · ${result.totalEvents} event` +
      `${result.totalEvents === 1 ? '' : 's'} found</p>` +
      `<ul>${rows}</ul>` +
      result.warnings
        .map((warning) => `<p class="warn">${escapeHtml(warning)}</p>`)
        .join('') +
      `<p class="hint">Nothing has been saved yet. If these look right, add it.</p>` +
      `</div>`
    );
  }

  function calendarsPage(
    values: {
      name?: string;
      url?: string;
      allowPrivateNetwork?: boolean;
      allowLoopback?: boolean;
      allowHttp?: boolean;
    } = {},
    error?: { message: string; suggestion?: string },
    tested?: TestFeedResult,
  ): string {
    const at = now();
    const sources = readAdminSources(deps.db);
    const people = readPeopleAdmin(deps.db);
    const box = (id: string, label: string, on: boolean): string =>
      `<label><input type="checkbox" name="${id}" value="1"${on ? ' checked' : ''}> ${escapeHtml(label)}</label>`;

    return page({
      modules: navModules(deps.db),
      title: 'Calendars — Maverick Wall',
      nav: 'calendars',
      heading: 'Calendars',
      action: { label: 'Add a calendar', href: 'admin/calendars#add' },
      ...(sources.length === 0
        ? { intro: 'No calendars yet. Add the iCal address of one below.' }
        : {}),
      body:
        sources.map((source) => sourceRow(source, at, people)).join('') +
        `<h2 class="add" id="add">Add a calendar</h2>` +
        (error === undefined ? '' : errorBlock(error.message, error.suggestion)) +
        (tested === undefined ? '' : previewPanel(tested)) +
        `<form method="post" action="admin/calendars">` +
        textField({
          label: 'Name',
          name: 'name',
          required: true,
          placeholder: 'Family',
          value: values.name ?? '',
        }) +
        textField({
          label: 'Address',
          name: 'url',
          required: true,
          placeholder: 'https://…/basic.ics',
          value: values.url ?? '',
        }) +
        // Owner is offered at add time only when there is someone to pick, so a
        // household with no people never sees a control that does nothing.
        (people.length === 0
          ? ''
          : selectField({
              label: 'Belongs to',
              name: 'person_id',
              hint: 'When a calendar belongs to someone, its events take their colour on the wall.',
              optionsHtml:
                `<option value="" selected>Everyone</option>` +
                people
                  .map(
                    (person) =>
                      `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}</option>`,
                  )
                  .join(''),
            })) +
        `<div class="checks">` +
        box('allow_lan', 'This feed is on my local network', values.allowPrivateNetwork === true) +
        box('allow_loopback', 'This feed is on this machine', values.allowLoopback === true) +
        box('allow_http', 'Allow plain http for this feed', values.allowHttp === true) +
        `</div>` +
        // Two buttons, one form. Testing first is the cheap habit this screen
        // exists to encourage, so it is the one on the left.
        `<div class="row">` +
        `<button type="submit" name="action" value="test">Test feed</button>` +
        `<button class="secondary" type="submit" name="action" value="save">Add</button>` +
        `</div></form>`,
    });
  }
}
