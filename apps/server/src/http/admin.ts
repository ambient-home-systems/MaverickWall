import type { Context, Hono } from 'hono';
import { addCalendarSource } from '../api/sources.js';
import { nextPersonColor } from '../api/palette.js';
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
  readLayoutWidgets,
  panelCanvasOwner,
  clearLayout,
  replaceLayout,
  revokeScreen,
  writeDisplaySettings,
  rotateScreenToken,
  writeScreenSettings,
  writeScreenHardware,
  type AdminScreenRow,
  type AdminSourceRow,
  type PairingSecret,
  type PersonRecord,
} from '../api/queries.js';
import { countWatchedZones, hasWeatherLocation } from '../api/rules.js';
import { readWeatherSettings } from '../api/queries.js';
import { randomBytes } from 'node:crypto';
import {
  formatShortCode,
  hashShortCode,
  issueDisplayToken,
  PAIRING_CODE_TTL_MS,
} from '../auth/tokens.js';
import type { IssuedToken } from '../auth/tokens.js';
import { DEVICE_FLOW_TTL_MS, type DeviceFlowStore } from '../auth/device-flow.js';
import { createRevealStore } from './reveal.js';
import { currentUser } from '../auth/session.js';
import { encodeQr, qrSvg } from './qr.js';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupTo, databasePath, integrityCheck } from '../db/open.js';
import { bytesOf, type WallAddress } from './app.js';
import { epaperOrientation } from '../epaper/frame.js';
import { INK_LANE, PANEL_IGNORES } from '../epaper/honours.js';
import { ingressPath } from './ingress.js';
import { buildDiagnostics } from '../api/diagnostics.js';
import { readImage, storeImage, listImages } from '../api/media.js';
import { checkForUpdate, RELEASE_HOST, RELEASE_URL, updateOnOffer } from '../api/update-check.js';
import { DEV_BUILD_NOTE, isReleaseVersion } from '../version.js';
import {
  matchWallSize,
  resolveWallSize,
  PANEL_MM_MAX,
  PANEL_MM_MIN,
  READ_DISTANCE_MM_MAX,
  READ_DISTANCE_MM_MIN,
  WALL_SIZE_CUSTOM,
  WALL_SIZE_PRESETS,
} from '../wall-sizes.js';
import type { LogBuffer } from '../logbuffer.js';
import { parseBackground, widgetIsSetUp, WIDGET_TYPES } from '../api/manifest.js';
import { householdSetUp } from '../modules/index.js';
import { layoutWidgetBody, backgroundSchema } from '../api/widget-schema.js';
import {
  applyTemplate,
  classicSeed,
  copyLayout,
  findTemplate,
  panelPixelAspects,
  seedAspects,
  type DisplayTemplate,
} from '../api/templates.js';
import { TEMPLATES, PANEL_TEMPLATES, findPanelTemplate } from '../templates/index.js';
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
import { dueOn, type CivilDate, type Fetcher, type NetworkOption, type ShiftPlan } from '@maverick-wall/core';
import { activeOn, readChores } from '../api/chores.js';
import type { Keyring } from '../secrets/keyring.js';
import { normaliseMasterKeyBytes } from '../secrets/keyring.js';
import { stagedKeyPath, stagedPath } from '../db/restore.js';
import type { SqliteDatabase } from '../db/open.js';
import { confirmDestroyPage, dirtyForm, downloadForm, errorBlock, escapeHtml, icon,
  networkAccessDisclosure, networkAccessSuggestion, page, saveRow,
  selectField, selectRow, switchRow, textField, type NavModule } from './html.js';
import { card, dataTable, destructive, emptyState, listRow, section, tag } from './components.js';
import { readSaved, savedRedirect } from './saved.js';
import { bounded, checkbox, colour, oneOf, optionalText, parse, quarterTurn, text, z } from '../validation.js';

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
  // `checkbox()` and not `.optional()`: a browser sends nothing at all for an
  // unticked box, and every other spelling either refuses the body or reads the
  // absence as a value. This form's other four switches are the same shape.
  show_in_grid: checkbox(),
  allow_lan: checkbox(),
  allow_loopback: checkbox(),
  allow_http: checkbox(),
});

/**
 * One calendar's settings as the household left them, for a page that comes
 * back at 400 (RFC 009 Phase 3.1).
 *
 * The screen re-rendered every row from the database, so clearing the name and
 * pressing Save handed back an error *and* threw away the colour, the owner and
 * the switches they had changed in the same row. Same silent loss the Weather
 * screen had, one screen along — and worse now that Save is disabled until
 * something is dirty, because a row redrawn from the database has nothing to
 * save and correctly says so.
 *
 * Keyed on the source, because one page draws every calendar and only one of
 * them was being edited.
 */
interface SourceEcho {
  readonly sourceId: string;
  readonly name: string;
  readonly color: string;
  readonly personId: string;
  readonly enabled: boolean;
  readonly showInGrid: boolean;
  readonly allowLan: boolean;
  readonly allowLoopback: boolean;
  readonly allowHttp: boolean;
}

/** The echo, read off the raw body — before any schema has had an opinion. */
function sourceEchoOf(sourceId: string, body: Record<string, unknown>): SourceEcho {
  const str = (key: string): string => (typeof body[key] === 'string' ? (body[key] as string) : '');
  return {
    sourceId,
    name: str('name'),
    color: str('color'),
    personId: str('person_id'),
    enabled: typeof body['enabled'] === 'string',
    showInGrid: typeof body['show_in_grid'] === 'string',
    allowLan: typeof body['allow_lan'] === 'string',
    allowLoopback: typeof body['allow_loopback'] === 'string',
    allowHttp: typeof body['allow_http'] === 'string',
  };
}

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
  name: text('A name for the wall', 80),
  orientation: oneOf('an orientation', ['auto', 'portrait', 'landscape']),
  // Required here, unlike the add pages': this form always renders the control,
  // so a body that has lost it is a broken client rather than a household
  // asking for the default, and taking it as `0` would silently stand a wall
  // that is hung sideways back up.
  rotation: quarterTurn(),
  // A built-in key or a `custom:<id>`; blank follows the household. Wide enough
  // for `custom:` + a 16-char id. Existence is checked in the handler.
  theme: optionalText(64),
  daytime_theme: optionalText(64),
  daytime_starts_at: optionalText(5),
  daytime_ends_at: optionalText(5),
  timezone: optionalText(64),
  allow_dismiss: checkbox(),
  allow_chores: checkbox(),
  // '' follows the household, '1' forces 24-hour, '0' forces 12-hour (RFC 005).
  clock_24: optionalText(1),
  // How much this wall shows. Empty follows the household default; a number is
  // range-checked in the handler, next to the theme and zone checks.
  today_events: optionalText(3),
  next_days: optionalText(3),
  horizon_weeks: optionalText(3),
  /*
   * How large this wall is and how far away it is read from.
   *
   * A preset key, `custom`, or blank for "not measured" — and three
   * millimetre fields the choice decides whether to read at all, because a
   * browser submits a hidden input exactly as it submits a visible one.
   * `resolveWallSize` is where the three become one answer; the shape here
   * only says they are short strings.
   */
  panel_size: optionalText(20),
  panel_width_mm: optionalText(6),
  panel_height_mm: optionalText(6),
  read_distance_mm: optionalText(6),
});

/**
 * Creating a wall: its name, the two facts about the hardware, and where its
 * layout starts from.
 *
 * It used to ask for the name alone, and everything a household could say
 * about a wall lived on a settings page they reached *after* pairing it — so
 * adding a browser wall and adding an e-paper panel were two different
 * journeys for one act, and the browser one asked for less than it needed at
 * the moment the household was standing in front of the thing with its size in
 * their hand.
 *
 * **Every new field is optional and absence is exactly today's answer**, which
 * is what keeps this a widening rather than a change: no size (three nulls,
 * and the wall draws as it always has), no rotation (`0`), no template
 * (Classic, which is what seeding already gave it). A body carrying only a
 * name still creates the wall it created before, byte for byte.
 *
 * The four size fields keep the settings form's own names, because
 * `resolveWallSize` is the one place they become one answer and a second set
 * of names would be a second reading of them.
 */
const newScreenBody = z.object({
  name: text('A name for the wall', 80),
  rotation: quarterTurn(0),
  panel_size: optionalText(20),
  panel_width_mm: optionalText(6),
  panel_height_mm: optionalText(6),
  read_distance_mm: optionalText(6),
  /** A template id; blank is Classic. Membership is checked in the handler. */
  template: optionalText(64),
});


/**
 * Approving (or declining) a screen that started a device-authorization flow.
 *
 * The `code` is the short user code shown on the wall; the household reached
 * this form either by scanning the screen's QR (which pre-fills it) or by typing
 * it at the Walls page. `action` is which button they pressed. Everything is
 * behind the session gate, which is the entire reason an 8-character code is
 * safe here — see `auth/device-flow.ts`.
 */
const approveDeviceBody = z.object({
  code: text('A pairing code', 32),
  name: text('A name for the wall', 80),
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

import { registerHaRoutes } from './admin-ha.js';
import { registerAlertRoutes } from './admin-alerts.js';
import { registerModuleRoutes } from './admin-modules.js';
import { registerShiftTypeRoutes } from './admin-shifts.js';
import { registerChoreRoutes } from './admin-chores.js';
import { registerThemeRoutes } from './admin-themes.js';
import { registerEpaperRoutes } from './admin-epaper.js';
import { offeredTimezones } from './setup.js';
import { selfHref } from './self.js';
import { isValidThemeRef, readThemes, type ThemeRow } from '../api/themes.js';
import { readEnabledExternalModules, readExternalModules } from '../api/external-modules.js';
import { readHaSettings } from '../modules/homeassistant/store.js';
import { resolveConnection } from '../modules/homeassistant/client.js';
import { fetchCalendarEntities } from '../modules/homeassistant/index.js';
import { isUnitedStatesZone } from '../timezone.js';

/**
 * The admin screens.
 *
 * **The next screen added here should be a new file, not another section.**
 * This one has been split twice — `admin-ha.ts` came out at eighteen hundred
 * lines, then alerts, modules, shift types, chores, themes and e-paper — and it
 * grew back both times, because a section is always the smaller diff on the day
 * and never the smaller file. Follow `admin-epaper.ts`: one `admin-<screen>.ts`
 * exporting `register<Screen>Routes(app, deps)`, called from
 * `registerAdminRoutes` at the point in the order those routes belong. What
 * stays here is the shell (the index, sign-out) and the screens already in it.
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
   * mapped port and a best-guess host. The Walls page pre-fills the pairing
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
      return { error: `${label} is in the list twice. Each widget can only appear once.` };
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
 * The wall settings form, as one schema.
 *
 * The daylight window is the interesting part: three fields that are only
 * required *together*, and only when a second theme was chosen. Expressing
 * that as a `superRefine` puts the rule beside the fields rather than three
 * `if` statements down the handler, and the message stays the one a household
 * would want — a window of no length is the mistake people actually make.
 */
const themeKeys = ['household', 'blueprint', 'panels', 'almanac', 'swiss'] as const;

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
  { key: 'panels', label: 'Panels — dark, each widget a card' },
  { key: 'household', label: 'Household — warm daylight paper' },
  { key: 'blueprint', label: 'Blueprint — light technical wireframe' },
  { key: 'almanac', label: 'Paper Almanac — the month, as a ledger' },
  { key: 'swiss', label: 'Swiss — near-black, typographic, no cards' },
] as const;

/**
 * The three swatch colours per theme, for the wall settings theme cards —
 * background, accent, a shift hue. Taken from the design file's token sets so
 * the card previews what the wall will actually look like. Kept beside `THEMES`
 * so a theme added to one is a visible hole in the other.
 */
const THEME_SWATCHES: Readonly<Record<string, readonly [string, string, string]>> = {
  panels: ['#14181E', '#5C93E0', '#E8A33D'],
  household: ['#F4F0E8', '#B5651F', '#4C7FD1'],
  blueprint: ['#F2F2F3', '#5980A6', '#2F5D8C'],
  almanac: ['#FBF8F1', '#B3372B', '#2F5D8C'],
  swiss: ['#09090B', '#FFB224', '#5C93E0'],
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

/**
 * What `template-gallery.js` needs to draw a wall template's preview.
 *
 * One builder for the gallery page and the add-a-wall form, because they draw
 * the same picture and two shapes of this JSON is how one of them quietly stops
 * previewing. The *portrait* canvas, which is the shape a wall card has always
 * been, plus the template's own theme and background so the card shows the look
 * applying it gives rather than the household's current one (RFC 005 3c).
 */
function wallTemplatePreviews(
  catalogue: readonly DisplayTemplate[],
): readonly Record<string, unknown>[] {
  return catalogue.map((t) => ({
    id: t.id,
    aspect: t.portrait.aspect,
    widgets: t.portrait.widgets,
    ...(t.theme !== undefined ? { theme: t.theme } : {}),
    ...(t.portrait.background !== undefined ? { background: t.portrait.background } : {}),
  }));
}

/**
 * Pick a starting layout, with a picture of each one.
 *
 * The `themecard` idiom — a radio inside a label, the checked one ringed — so
 * the field's name and values are exactly the select's were and the handler
 * cannot tell the difference. The thumb is the gallery's own
 * `.tpl-thumb[data-tpl]`, which is the whole reason there is no new script
 * here: `template-gallery.js` finds every one of them on the page and draws it.
 *
 * With no script each card is its name and its blurb, which is more than the
 * select it replaces ever showed.
 */
function templateCards(selected: string): string {
  const cards = TEMPLATES.map(
    (t) =>
      `<label class="tplpick">` +
      `<input type="radio" name="template" value="${escapeHtml(t.id)}"` +
      `${t.id === selected ? ' checked' : ''}>` +
      `<div class="tpl-thumb" data-tpl="${escapeHtml(t.id)}">` +
      `<div class="tpl-fallback">${escapeHtml(t.name)}</div></div>` +
      `<div class="tplpick-cap"><b>${escapeHtml(t.name)}</b>` +
      `<small>${escapeHtml(t.blurb)}</small></div>` +
      `</label>`,
  ).join('');
  /*
   * A `<fieldset>` with a `<legend>`, which is what a group of radios is —
   * rather than a div carrying `role="radiogroup"` and an `aria-labelledby`
   * pointing at another div. The browser associates the two on its own and
   * there is no id to keep in step.
   */
  return (
    `<fieldset class="tplpick-field">` +
    `<legend class="field-label">Starting layout</legend>` +
    `<div class="tplpick-grid">${cards}</div>` +
    `</fieldset>` +
    `<p class="field-hint">Classic is today, the week ahead and the month — the standard ` +
    `kitchen calendar. You can switch to any of these afterwards, from this wall’s ` +
    `Templates gallery.</p>`
  );
}

/** A six-digit hex colour, which is what `<input type="color">` submits. */

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
/**
 * A civil date the way the wall writes one — "Sat 19 Sept" — for a line a
 * person reads. An ISO stamp is a machine's date; it belongs in a date input,
 * not in prose. UTC because a civil date carries no zone: it is the day itself.
 */
export function civilDateLabel(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`));
}

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
 * How long since a screen last called in before its dot goes idle.
 *
 * A browser wall polls every minute, so five minutes is generous and says
 * "up" without pretending to diagnose. An e-paper panel on battery sleeps
 * between pulls — the shipped ESPHome recipe sleeps thirty minutes and the
 * Home Assistant one pushes every fifteen — so its window is an hour, or
 * every sleeping panel in the house would read as idle for most of the day.
 * Exported beside `ago` because the panel's own page (`admin-epaper.ts`)
 * draws the same dot the Walls list and a browser wall's page do.
 */
export const BROWSER_SEEN_WINDOW_MS = 5 * 60_000;
export const EPAPER_SEEN_WINDOW_MS = 60 * 60_000;
/** A wall unseen for this long is worth a row on the Overview, whatever its kind. */
const DAY_MS = 24 * 60 * 60_000;
/** How many of today's events the Overview lists before saying "and N more". */
const TODAY_EVENT_LIMIT = 8;

export function seenDot(lastSeenAt: number | null, at: number, windowMs = BROWSER_SEEN_WINDOW_MS): string {
  const fresh = lastSeenAt !== null && at - lastSeenAt < windowMs;
  return fresh
    ? `<span class="dot dot-ok pulse"></span>`
    : `<span class="dot dot-idle"></span>`;
}

/**
 * What making a new pairing link costs, said before it is done.
 *
 * The control used to be labelled "Pairing link…" and posted straight to
 * `/regenerate` with no confirmation — so a household who tapped it to *look
 * at* the link revoked the one they had just printed, and on a wall that was
 * already paired cut that wall off. The wall page's own status line sent
 * them there ("open its pairing link on the wall"). The consequence differs
 * by state and the sentence says which: an unspent link that stops working,
 * or a wall that drops off until the new link is opened on it. Plain text —
 * the callers put it in a `data-confirm` attribute and escape it there.
 */
/**
 * "Move up" and "Move down" as ⋮ menu items, for a list a household orders.
 *
 * Every ordered list here — people, chores, shift types — used to draw its
 * reorder as one or two buttons in the card's own footer, which made the
 * rarest thing anybody does to a row the most visible control on it, while
 * Edit sat behind a disclosure and Remove behind the ⋮. Reorder lives in the
 * ⋮ now, above the rule that keeps a safe action from being Remove's
 * neighbour, and the ends drop the move that goes nowhere. One rule for every
 * row: the name, one status line, the Edit disclosure, at most one visible
 * action that is the row's own job (Sync now, Pause), and the rest in the ⋮.
 *
 * `action` is the relative POST path; the direction rides a hidden field, as
 * the footer buttons' did. Exported for the chores and shift-type screens,
 * which draw the same rows from their own files.
 */
export function reorderMenuItems(action: string, first: boolean, last: boolean): string {
  const item = (dir: 'up' | 'down'): string =>
    `<form method="post" action="${action}"><input type="hidden" name="dir" value="${dir}">` +
    `<button class="ovf-item" type="submit">Move ${dir}</button></form>`;
  const items = (first ? '' : item('up')) + (last ? '' : item('down'));
  return items === '' ? '' : items + `<div class="ovf-sep"></div>`;
}

/**
 * A code no pending pairing carries. It is either mistyped or expired, and
 * the store deliberately cannot tell which (`lookupByUserCode` answers the
 * same for both), so the sentence covers both and names the lifetime from the
 * flow's own constant rather than a number that would drift from it.
 */
const APPROVE_UNKNOWN_CODE =
  'No wall is waiting with that code. Check the eight characters on the wall — ' +
  `a code lasts ${Math.round(DEVICE_FLOW_TTL_MS / 60_000)} minutes, so if it has ` +
  'been longer, start pairing again there and type the new one.';

export function regenerateWarning(name: string, connected: boolean): string {
  return connected
    ? `Make a new pairing link for ${name}? ${name} drops off the wall and shows its pairing screen until the new link is opened on it.`
    : `Make a new pairing link for ${name}? The link and code you were given stop working — use the new ones on the wall.`;
}

/**
 * How long after a calendar is added its first sync is still in flight.
 *
 * `addCalendarSource` schedules the job three seconds out and the scheduler
 * ticks every thirty, with a ten-second fetch timeout on top — so under a
 * minute covers it, and two is generous without letting "Syncing…" become a
 * claim of its own. Past the window the row falls back to the honest "synced
 * never", which is what a household needs to see if the sync never ran.
 */
export const FIRST_SYNC_WINDOW_MS = 2 * 60_000;

/**
 * Whether this calendar's *first* sync has not happened yet.
 *
 * Measured: adding a working feed showed "0 events · synced never" for about
 * twenty seconds, then "12 events · synced 1 minute ago" with no user action.
 * The first sentence is exactly what a dead feed says, so the household's first
 * impression of a calendar that works was a failure state.
 *
 * Four conditions, and each one is a branch this must not claim:
 *   - never succeeded, or there is a real time to report instead;
 *   - no error, or the error block is the truth and this would bury it;
 *   - enabled, because `ics-sync` skips a disabled source outright and would
 *     never arrive — the same guard "Sync now" already carries;
 *   - added recently, because a source that has sat unsynced for an hour is
 *     not syncing, it is stuck, and saying otherwise is the lie one screen on.
 */
export function firstSyncPending(
  source: Pick<AdminSourceRow, 'lastSuccessAt' | 'lastError' | 'enabled' | 'createdAt'>,
  at: number,
): boolean {
  return (
    source.lastSuccessAt === null &&
    source.lastError === null &&
    source.enabled === 1 &&
    at - source.createdAt < FIRST_SYNC_WINDOW_MS
  );
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

/**
 * Helpers `admin-epaper.ts` needs too, at module scope so there is one of each.
 *
 * They were closures over `deps` while every caller was in this file; a panel
 * pairs exactly as a wall does, and the e-paper designer *is* this editor
 * hosted on a panel, so both of them now have a second caller. The two that
 * read the database take it as an argument, which is the whole of the change.
 */

/**
 * The stored secrets for a freshly issued pairing: the token's hash, and the
 * short code's hash with its expiry. One place so the code's lifetime is set
 * once whether the screen is created or regenerated.
 */
export function pairingSecret(issued: IssuedToken): PairingSecret {
  return {
    tokenHash: issued.tokenHash,
    pairingCodeHash: hashShortCode(issued.shortCode),
    pairingCodeExpiresAt: Date.now() + PAIRING_CODE_TTL_MS,
  };
}

/**
 * The widget types this wall will not draw, and why (RFC 009 Phase 2).
 *
 * The manifest omits a widget the household has nothing set up for — a
 * Weather box with no location, a Shift badge with no rotation — rather than
 * drawing "Nothing to show yet." on a kitchen wall for ever. That is right on
 * the glass and wrong in the editor, where the box has to stay grabbable, so
 * the editor keeps it and says so instead. This is the sentence it says.
 *
 * Derived from the same `widgetIsSetUp` the manifest uses, so the flag cannot
 * claim one thing while the wall does another; the copy lives here with the
 * rest of the admin's writing rather than in the display bundle.
 */
function whyNotDrawn(db: SqliteDatabase, type: string): string {
  switch (type) {
    case 'weather': {
      /*
       * Two reasons, and telling a household to set coordinates they already
       * typed is worse than saying nothing. `weatherModule.ready` is the
       * switch *and* the location, so the sentence has to read the same pair.
       */
      const weather = readWeatherSettings(db);
      if (!weather.enabled) return 'Turn “Show the forecast” on under Weather and this appears.';
      return 'Set a latitude and longitude on Weather and this appears.';
    }
    case 'homeassistant':
      return 'Choose some entities on Home Assistant and this appears.';
    case 'chores':
      // `ready` wants an *active* chore, so a household who paused all of
      // theirs over the holidays needs the other half of this sentence.
      return 'Add a chore on Chores — or un-pause one — and this appears.';
    case 'shift':
      // A rotation, not a person: `shift_enabled` is set by creating a plan
      // on Shifts and by nothing else, so naming People here would send
      // somebody to a screen that cannot fix it.
      return 'Set up a rotation on Shifts and this appears.';
    default:
      return 'Nothing is set up for this yet, so it is left out.';
  }
}

export function widgetsNotDrawn(db: SqliteDatabase): { type: string; why: string }[] {
  const setUp = householdSetUp(db);
  return (WIDGET_TYPES as readonly string[])
    .filter((type) => !widgetIsSetUp(type, setUp))
    .map((type) => ({ type, why: whyNotDrawn(db, type) }));
}

/**
 * The layout editor mount: the shell and the current layout as JSON; a
 * first-party module makes it interactive. Same-origin, ships in the image
 * (rule three); the src and its fetches are relative so the single `<base>`
 * carries them through ingress. Path-independent — the editor posts to
 * `admin/layout` regardless of which page hosts it.
 */
export function layoutEditorMount(initial: unknown): string {
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

export function registerAdminRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());
  /**
   * The pairing link (or e-paper frame URL) a POST just minted, waiting for
   * the page its redirect lands on to show it once. See `reveal.ts` for why a
   * secret crosses a redirect rather than being printed in the POST's answer.
   */
  const reveals = createRevealStore<IssuedToken>();

  registerHaRoutes(app, deps);
  registerAlertRoutes(app, deps);
  registerModuleRoutes(app, deps);
  registerShiftTypeRoutes(app, deps);
  registerChoreRoutes(app, deps);
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
  /**
   * What the overview says about weather alerts.
   *
   * "On, working out your zones" was printed for zero zones whatever the
   * reason, and it is only true of one of them: for the minute after a US
   * household saves a location. With no location nothing is being worked out,
   * and outside National Weather Service coverage nothing ever will be — a
   * status line that is a lie, on the one feature with a life-safety disclaimer
   * attached to it (RFC 009 Phase 2).
   *
   * Three states now, and none of them promises progress that may not come.
   * "No zones yet" is deliberately not "working them out": from here the two
   * causes — the first check has not run, and this place is outside the
   * service — are genuinely indistinguishable, and the Weather screen is where
   * both are named. The pill links there.
   */
  const alertSummary = (): string => {
    const row = deps.db
      .prepare(`SELECT alerts_enabled AS enabled FROM household_settings WHERE id = 'singleton'`)
      .get() as { enabled: number } | undefined;
    if (row?.enabled !== 1) return 'off';
    if (!hasWeatherLocation(deps.db)) return 'on — needs your location';
    // Through the shared count, which excludes a zone retired because the
    // household moved. Counting every row reported a green "watching 2 zones"
    // while the evaluator treated every rule as off — permanently, if the new
    // location turns out to be outside the service.
    const zones = countWatchedZones(deps.db);
    if (zones > 0) return `watching ${zones} zones`;
    // Outside the United States there will never be a zone, and "no zones
    // yet" promises one. The wizard turns the switch off for such a household
    // now; this is the one that turned it on, or was set up before it did.
    return isUnitedStatesZone(readHousehold(deps.db).timezone) ? 'on — no zones yet' : 'not available here';
  };

  const haSummary = (): string => {
    const resolved = resolveConnection(deps.db, deps.keyring);
    // "Not set up", not "not connected": most households never connect Home
    // Assistant, and a connection nobody asked for is not a fault.
    if (!resolved.ok) return 'not set up';
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
    // Red is for something that is switched on and not doing its job: a
    // connection with a problem, an alert switch with no location to work
    // from. Not for an integration nobody has set up, not for a wait ("no
    // zones yet" is the minute after a household in the United States saves
    // a location), and not for a place the service does not cover. Measured
    // on a fresh install in London, this card used to show two red tags on a
    // box that had never done anything wrong — and a status that is red on
    // every install is a colour nobody reads, so the first real fault would
    // have arrived in the same tone as the two false ones.
    const bad = low.includes('problem') || low.includes('error') || low.includes('needs');
    const plain = low === 'off' || low.startsWith('on,') || low.startsWith('on —') || low.startsWith('not ');
    const cls = bad ? 'tag-bad' : plain ? 'tag' : 'tag-ok';
    const dot = cls === 'tag-ok' ? '<span class="dot dot-ok"></span>' : cls === 'tag-bad' ? '<span class="dot dot-bad"></span>' : '';
    // A capitalised first letter reads as a label rather than a sentence fragment.
    const text = summary.charAt(0).toUpperCase() + summary.slice(1);
    return `<span class="tag ${cls}">${dot}${escapeHtml(text)}</span>`;
  };

  app.get('/admin', (c: Context) => {
    const household = readHousehold(deps.db);
    const sources = readAdminSources(deps.db);
    const screens = readAdminScreens(deps.db).filter((screen) => screen.revokedAt === null);
    const plans = readShiftPlansAdmin(deps.db);
    const at = now();
    const zone = household.timezone;
    const online = screens.filter(
      (screen) =>
        screen.lastSeenAt !== null &&
        at - screen.lastSeenAt <
          (screen.kind === 'epaper' ? EPAPER_SEEN_WINDOW_MS : BROWSER_SEEN_WINDOW_MS),
    ).length;

    /*
     * Today, in the household's own zone.
     *
     * The card headlined `household.timezone` in h2 type, which reads as the
     * wall's *name* — "Etc/UTC" is the largest thing on the Overview and says
     * nothing about today. The zone is still worth stating, because getting it
     * wrong puts birthdays on the wrong day, so it moves down to the line the
     * other facts already live on. en-GB for the same reason every other
     * formatter here uses it: the admin is one language and a stamp that
     * changes shape with the server's locale is a stamp nobody can test.
     */
    const todayLine = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date(at));

    /*
     * What needs attention — the first of the two questions somebody opening
     * this page actually has, and the one it used to answer with three stat
     * tiles: "4 Calendars connected", "2 Walls paired", "1 Rotation". Those
     * are three counts the household already knows, restated in a sentence
     * under a card that repeated them; a big number with a caption is a
     * dashboard idiom, and this is a calendar. Each row here is something the
     * household can go and do, in the tone the Status card uses: red only for
     * a thing that is on and not doing its job.
     */
    interface Attention {
      readonly title: string;
      readonly detail: string;
      readonly href: string;
      readonly tag: string;
      readonly bad: boolean;
    }
    const attention: Attention[] = [];
    if (sources.length === 0) {
      attention.push({
        title: 'No calendars yet',
        detail: 'The wall has nothing to draw until one is added.',
        href: 'admin/calendars', tag: 'Not set up', bad: false,
      });
    }
    for (const source of sources) {
      if (source.lastError === null) continue;
      attention.push({
        title: `${source.name} is not syncing`,
        detail: source.lastError,
        href: 'admin/calendars', tag: 'Not syncing', bad: true,
      });
    }
    if (screens.length === 0) {
      attention.push({
        title: 'No walls paired yet',
        detail: 'Pair a tablet, a television or an e-paper panel to put the calendar on a screen.',
        href: 'admin/walls', tag: 'Not set up', bad: false,
      });
    }
    for (const screen of screens) {
      const href =
        screen.kind === 'epaper'
          ? `admin/epaper/${encodeURIComponent(screen.id)}/design`
          : `admin/walls/${encodeURIComponent(screen.id)}`;
      if (screen.lastSeenAt === null) {
        attention.push({
          title: `${screen.name} has never connected`,
          detail:
            screen.kind === 'epaper'
              ? 'Nothing has fetched its picture yet. Its device recipes are on its page.'
              : 'Open its pairing link on the wall.',
          href, tag: 'Never connected', bad: false,
        });
      } else if (at - screen.lastSeenAt > DAY_MS) {
        attention.push({
          title: `${screen.name} last seen ${ago(screen.lastSeenAt, at)}`,
          detail: 'It may be off, or unable to reach this box.',
          href, tag: 'Not seen', bad: false,
        });
      }
    }
    if (alertSummary().includes('needs')) {
      attention.push({
        title: 'Weather alerts are on with no location',
        detail: 'They cannot watch anything until the Weather page has a latitude and longitude.',
        href: 'admin/alerts', tag: 'Needs location', bad: true,
      });
    }
    if (haSummary().includes('problem')) {
      attention.push({
        title: 'Home Assistant is connected, with a problem',
        detail: 'The last read failed. The Home Assistant page says what came back.',
        href: 'admin/home-assistant', tag: 'Problem', bad: true,
      });
    }
    /*
     * One rule, read rather than restated. This row used to ask
     * `latestVersion !== appVersion`, which said "update available" to a
     * household who was already up to date — the stored tag carries a `v` and
     * this version does not — and offered an older release to one who was
     * ahead of it. `updateOnOffer` is the same answer the System page draws.
     */
    const offeredVersion = updateOnOffer(readUpdateState(deps.db), deps.appVersion);
    if (offeredVersion !== undefined) {
      attention.push({
        title: `Version ${offeredVersion} is available`,
        detail: `This box runs ${deps.appVersion}. Updating stays yours to do.`,
        href: 'admin/system', tag: 'Update', bad: false,
      });
    }
    const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
    const attentionRows =
      attention.length === 0
        ? listRow(
            '',
            {
              title: 'Everything is running',
              detail: `${plural(sources.length, 'calendar')} syncing · ${online} of ${plural(screens.length, 'wall')} online`,
            },
            `<span class="tag tag-ok"><span class="dot dot-ok"></span>All good</span>`,
          )
        : attention
            .map((item) =>
              listRow(
                '',
                { title: item.title, detail: item.detail, href: item.href },
                item.bad
                  ? `<span class="tag tag-bad"><span class="dot dot-bad"></span>${escapeHtml(item.tag)}</span>`
                  : `<span class="tag">${escapeHtml(item.tag)}</span>`,
              ),
            )
            .join('');

    /*
     * What the wall draws today — the second question, answered from the same
     * manifest the Default wall polls, so this list and the glass agree by
     * construction: who is working, what is on, which chores fall due. Capped,
     * because a busy Saturday is not what this card is for; the wall is.
     */
    const today = localToday() as CivilDate;
    const manifest = deps.previewManifest?.(null) as
      | {
          days?: readonly {
            date: string;
            events: readonly { title: string; startsAt: number; allDay: boolean; color: string }[];
            shifts: readonly { personName: string; label: string }[];
          }[];
        }
      | undefined;
    const day = manifest?.days?.find((candidate) => candidate.date === today);
    const timeOf = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: household.clock24 === 1 ? 'h23' : 'h12',
    });
    const events = [...(day?.events ?? [])].sort(
      (a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt - b.startsAt,
    );
    const shown = events.slice(0, TODAY_EVENT_LIMIT);
    const rota = (day?.shifts ?? []).map((shift) => `${shift.personName}: ${shift.label}`);
    const chores = readChores(deps.db).filter(
      (chore) => activeOn(chore, today) && dueOn(chore.schedule, today),
    );
    const todayList =
      rota.length + shown.length + chores.length === 0
        ? `<p class="hint">Nothing on today.</p>`
        : `<ul class="ov-today">` +
          (rota.length === 0
            ? ''
            : `<li class="ov-rota"><span class="ov-time">Working</span>` +
              `<span class="ov-title">${escapeHtml(rota.join(' · '))}</span></li>`) +
          shown
            .map(
              (event) =>
                `<li><span class="swatch" style="--swatch:${escapeHtml(event.color)}"></span>` +
                `<span class="ov-time">${event.allDay ? 'All day' : escapeHtml(timeOf.format(new Date(event.startsAt)))}</span>` +
                `<span class="ov-title">${escapeHtml(event.title)}</span></li>`,
            )
            .join('') +
          (events.length > shown.length
            ? `<li class="ov-more"><span class="ov-time"></span>` +
              `<span class="ov-title">and ${events.length - shown.length} more</span></li>`
            : '') +
          chores
            .map(
              (chore) =>
                `<li><span class="ov-time">Chore</span><span class="ov-title">${escapeHtml(chore.name)}` +
                (chore.dueTime === null ? '' : ` · by ${escapeHtml(chore.dueTime)}`) +
                `</span></li>`,
            )
            .join('') +
          `</ul>`;

    // `.frow` restated a lead-less row with a title, an optional second line
    // and a trailing control — exactly `listRow`'s shape, so it is one now.
    const statusRow = (name: string, meta: string, trail: string): string =>
      listRow('', { title: name, ...(meta === '' ? {} : { detail: meta }) }, trail);

    const uptime = Math.max(0, Math.round((at - deps.startedAt) / 1000));
    const uptimeText =
      uptime < 3600
        ? `${Math.round(uptime / 60)}m`
        : uptime < 172800
          ? `${Math.round(uptime / 3600)}h`
          : `${Math.round(uptime / 86400)}d`;

    return c.html(
      page({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Maverick Wall',
        nav: 'home',
        heading: 'Overview',
        body:
          section('Needs attention', undefined, `<div class="card status-card">${attentionRows}</div>`) +

          `<div class="sect"><div class="sect-head"><h2>Today</h2>` +
          `<span class="kick">Household · ${escapeHtml(zone)}</span></div>` +
          `<div class="grid g2">` +
          `<div class="card today-card">` +
          `<div class="kick">Today on the wall</div>` +
          `<div class="today-big">${escapeHtml(todayLine)}</div>` +
          `<div class="sub">${plural(sources.length, 'calendar')} · ${plural(plans.length, 'rotation')} · ${plural(screens.length, 'wall')} · ${escapeHtml(zone)}</div>` +
          todayList +
          `<div class="row card-foot">` +
          `<a class="btn btn-ghost btn-sm" href="admin/walls/default">Edit what shows</a>` +
          `<a class="btn btn-ghost btn-sm" href="admin/walls/default#layout">Arrange layout</a></div>` +
          `</div>` +
          `<div class="card status-card">` +
          // Linked, because the summary can name something to go and do and a
          // pill that says "needs your location" with no way to it is a nag.
          statusRow(
            'Weather alerts',
            '',
            `<a class="link" href="admin/alerts">${tagFor(alertSummary())}</a>`,
          ) +
          statusRow('Home Assistant', '', tagFor(haSummary())) +
          statusRow('System', `${escapeHtml(deps.appVersion)} · up ${uptimeText}`, `<a class="link" href="admin/system">Open</a>`) +
          `</div>` +
          `</div></div>` +

          // Sign-out lives in the sidebar footer, shown on every page for a
          // plain docker install and stripped under ingress. Under ingress the
          // one line here says who the supervisor's request resolved to and
          // that signing out is a Home Assistant action rather than ours; on a
          // plain install the sidebar already says both. ("Signed in as …" used
          // to open every Overview as its intro line, which was a fact the
          // sidebar footer states on every page.)
          (c.get('viaIngress') === true
            ? `<p class="hint ov-footnote">Signed in as ${escapeHtml(currentUser(c).name)} through Home Assistant.</p>`
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

  app.get('/admin/calendars', async (c: Context) =>
    // One small request to Home Assistant, for the calendars it could offer.
    // It answers with none when there is no connection or the box is down, so
    // this page never waits on Home Assistant to be well (rule nine).
    c.html(calendarsPage(c, {}, undefined, undefined, await fetchCalendarEntities(
      deps.db, deps.keyring, deps.fetcher,
    ))),
  );

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
    if (!shaped.ok) return c.html(calendarsPage(c, echo, { message: shaped.message }), 400);

    const testOnly = shaped.value.action === 'test';
    // A name is only required to *store* one. Testing an address is a
    // question, and asking it should not need the answer named first.
    if (!testOnly && shaped.value.name === undefined) {
      return c.html(calendarsPage(c, echo, { message: 'Enter a name and an address.' }), 400);
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
        calendarsPage(c, values, {
          message: tested.message,
          ...(tested.suggestion !== undefined ? { suggestion: tested.suggestion } : {}),
          networkOptions: tested.networkOptions,
        }),
        400,
      );
    }

    // Nothing stored yet: this is the person checking their own work.
    if (testOnly) return c.html(calendarsPage(c, values, undefined, tested));

    // Membership is a question for the database, not the schema. An owner who
    // has since gone is treated as "Everyone" rather than rejected — losing the
    // attribution is a smaller harm than refusing a valid feed.
    const owner = shaped.value.person_id;
    const personId =
      owner !== undefined && readPeopleAdmin(deps.db).some((p) => p.id === owner) ? owner : null;

    const added = addCalendarSource(
      deps.db,
      deps.keyring,
      { name, url, personId, allowPrivateNetwork, allowLoopback, allowHttp },
      // The app's clock, which is what `firstSyncPending` reads the stamp back
      // against a few lines further down this same file.
      now(),
    );
    if (!added.ok) {
      return c.html(calendarsPage(c, values, { message: added.message }), 400);
    }

    return savedRedirect(c, '/admin/calendars', 'calendar-added');
  });

  /** Editing what a stored source is, as opposed to where it points. */
  app.post('/admin/calendars/:id/settings', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(sourceSettingsBody, body);
    // Echoed back on both failures below, so a cleared name never also costs
    // the colour and the owner changed in the same row.
    const echo = sourceEchoOf(c.req.param('id') ?? '', body);
    if (!shaped.ok) {
      return c.html(calendarsPage(c, {}, { message: shaped.message }, undefined, [], echo), 400);
    }

    // Membership, and it cannot live in the schema: who exists is a question
    // for the database rather than for the shape of the request.
    const personId = shaped.value.person_id;
    if (personId !== undefined && !readPeopleAdmin(deps.db).some((p) => p.id === personId)) {
      return c.html(
        calendarsPage(c, {}, { message: 'That person is no longer there.' }, undefined, [], echo),
        400,
      );
    }

    // The UPDATE's own answer, not a second lookup: no row means the calendar
    // went in another tab, and "Calendar settings saved." for one that is not
    // there is the same false claim `/sync` and `/delete` are guarded against.
    const saved = updateSource(deps.db, c.req.param('id') ?? '', {
      name: shaped.value.name,
      color: shaped.value.color,
      personId: personId ?? null,
      enabled: shaped.value.enabled,
      showInGrid: shaped.value.show_in_grid,
      allowPrivateNetwork: shaped.value.allow_lan,
      allowLoopback: shaped.value.allow_loopback,
      allowHttp: shaped.value.allow_http,
    });
    return saved
      ? savedRedirect(c, '/admin/calendars', 'calendar-settings')
      : c.redirect('/admin/calendars', 302);
  });

  app.post('/admin/calendars/:id/sync', (c: Context) => {
    /*
     * Say what will actually happen, which is not always a sync.
     *
     * `ics-sync` skips a source whose switch is off ("source is disabled"), and
     * the button is drawn for those rows anyway — so an unconditional "Syncing
     * now" is the strip promising a fetch that never happens, which is the
     * exact dishonesty this whole phase exists to remove. And an id that is not
     * there (a stale tab, a double submit) claims nothing at all.
     */
    const id = c.req.param('id') ?? '';
    const source = readAdminSources(deps.db).find((candidate) => candidate.id === id);
    // Nothing to confirm: an id that is not there (a stale tab, a double
    // submit), or a calendar whose sync is off, which `ics-sync` skips outright
    // — so the button is not drawn for one and this is the stale-page guard.
    if (source === undefined || source.enabled !== 1) return c.redirect('/admin/calendars', 302);
    // Automates the SQL that was previously the documented way to do this.
    requestSyncNow(deps.db, id);
    return savedRedirect(c, '/admin/calendars', 'calendar-sync');
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
        self: selfHref(c),
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
    // "Calendar removed." only when there was one. A stale tab or a second
    // press of Back-then-Remove otherwise gets a confirmation for something
    // that had already gone — and `deleteSource` already answers that, so the
    // claim is read off the delete rather than off a second scan of every row.
    return deleteSource(deps.db, c.req.param('id') ?? '')
      ? savedRedirect(c, '/admin/calendars', 'calendar-removed')
      : c.redirect('/admin/calendars', 302);
  });

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------

  app.get('/admin/system', (c: Context) => c.html(systemPage(c)));

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
    return savedRedirect(c, '/admin/system', 'update-check');
  });

  /** An explicit ask, which is the only thing that checks immediately. */
  app.post('/admin/system/check-now', async (c: Context) => {
    if (!readUpdateState(deps.db).enabled) {
      return c.html(systemPage(c, 'Turn update checking on first.'), 400);
    }
    /*
     * The same refusal the scheduled job makes, for the same reason: this
     * build is not a released one, so there is nothing for a release number to
     * be compared against. The button is not drawn in that case; this is the
     * handler agreeing, because a form nobody can see is still a form anybody
     * can post.
     */
    if (!isReleaseVersion(deps.appVersion)) {
      return c.html(systemPage(c, DEV_BUILD_NOTE), 400);
    }
    const result = await checkForUpdate(deps.fetcher, deps.appVersion);
    recordUpdateCheck(
      deps.db,
      now(),
      result.status === 'ok' ? result.latest : null,
      result.status === 'ok' ? null : result.message,
    );
    /*
     * A failed check gets no strip.
     *
     * `updateSection()` draws "Last check failed: …" in the danger box directly
     * below, so the ok-coloured "Checked for a newer version." would sit on top
     * of the red one contradicting it. The page already answers this case
     * properly; the strip's job is to say a thing happened, and here it did not.
     */
    return result.status === 'ok'
      ? savedRedirect(c, '/admin/system', 'update-checked')
      : c.redirect('/admin/system', 302);
  });

  app.post('/admin/system/timezone', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    /*
     * Whatever the form offered, which is the offered zones *and* the one this
     * household already has.
     *
     * The select adds a stored zone this build's `Intl` has never heard of
     * rather than silently swapping it for another (see `systemPage`), so a
     * handler checking only `offeredTimezones()` would refuse an option the
     * page had just drawn — "Choose a timezone from the list" about something
     * that is on the list. Reachable with script blocked, where Save is enabled
     * by design, and with script on by moving the select away and back.
     */
    const stored = readHousehold(deps.db).timezone;
    const allowed = offeredTimezones();
    const shaped = parse(
      z.string().refine((value) => value === stored || allowed.includes(value), {
        error: () => 'Choose a timezone from the list.',
      }),
      body['timezone'],
    );
    if (!shaped.ok) return c.html(systemPage(c, shaped.message), 400);
    deps.db
      .prepare(`UPDATE household_settings SET timezone = ?, updated_at = ? WHERE id = 'singleton'`)
      .run(shaped.value, now());
    return savedRedirect(c, '/admin/system', 'timezone');
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
      return c.html(systemPage(c, 'The encryption key could not be read.'), 500);
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
      return c.html(systemPage(c, 'Choose a backup file to restore.'), 400);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    // Every SQLite file starts with this. Checking it here means a restore
    // cannot be armed with a photograph.
    if (bytes.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
      return c.html(
        systemPage(c, 'That file is not a Maverick Wall backup.'),
        400,
      );
    }

    /*
     * The key, alongside the database and staged identically — optional,
     * because a household restoring onto a machine that already has the
     * right key does not need to touch it. Validated the same way the key is
     * validated at boot (RFC 009, 1.5): a trailing newline is tolerated, but
     * anything else the wrong length is refused outright rather than staged
     * and left to fail silently at the next boot.
     */
    const keyFile = body['key'];
    let keyBytes: Buffer | undefined;
    if (keyFile instanceof File && keyFile.size > 0) {
      const usable = normaliseMasterKeyBytes(Buffer.from(await keyFile.arrayBuffer()));
      if (usable === undefined) {
        return c.html(systemPage(c, 'That is not a Maverick Wall key file.'), 400);
      }
      keyBytes = usable;
    }

    writeFileSync(stagedPath(deps.dataDir), bytes);
    if (keyBytes !== undefined) writeFileSync(stagedKeyPath(deps.dataDir), keyBytes, { mode: 0o600 });

    return c.html(
      page({
        self: selfHref(c),
      modules: navModules(deps.db),
        title: 'Restore staged',
        nav: 'system',
        heading: 'Ready to restore',
        intro:
          'The backup has been checked and put aside. Restart Maverick Wall to ' +
          'apply it — the current database is kept alongside it, so a restore ' +
          'that turns out to be the wrong file is not the end.',
        body:
          keyBytes !== undefined
            ? `<p>The key was staged with it, so your calendar addresses will read ` +
              `back correctly.</p>` +
              `<p><a class="link" href="admin/system">← Back</a></p>`
            : `<p>No key was uploaded with it. If your calendars come back but show ` +
              `no events, the encryption key does not match this database — restore ` +
              `again with the key file included.</p>` +
              `<p><a class="link" href="admin/system">← Back</a></p>`,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // People
  // -------------------------------------------------------------------------

  app.get('/admin/people', (c: Context) => c.html(peoplePage(c)));

  app.post('/admin/people', async (c: Context) => {
    const shaped = parse(personBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(peoplePage(c, shaped.message), 400);

    createPerson(deps.db, randomBytes(8).toString('hex'), shaped.value.name, shaped.value.color);
    return savedRedirect(c, '/admin/people', 'person-added');
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
      return c.html(peoplePage(c, 'That person is no longer there.'), 404);
    }

    const body = await c.req.parseBody();
    const file = body['avatar'];

    // An empty file input means "remove the picture", which is a thing a
    // household will want and should not need a second button for.
    if (!(file instanceof File) || file.size === 0) {
      setPersonAvatar(deps.db, id, null);
      return savedRedirect(c, '/admin/people', 'person-avatar-removed');
    }

    const stored = storeImage(
      deps.db,
      deps.dataDir,
      Buffer.from(await file.arrayBuffer()),
      file.name,
      'avatar',
    );
    if (!stored.ok) {
      return c.html(peoplePage(c, stored.message, stored.suggestion), 400);
    }

    setPersonAvatar(deps.db, id, stored.name);
    return savedRedirect(c, '/admin/people', 'person-avatar-saved');
  });

  app.post('/admin/people/:id', async (c: Context) => {
    const shaped = parse(personBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(peoplePage(c, shaped.message), 400);

    updatePerson(deps.db, c.req.param('id') ?? '', shaped.value.name, shaped.value.color);
    return savedRedirect(c, '/admin/people', 'person-updated');
  });

  app.post('/admin/people/:id/move', async (c: Context) => {
    const dir = String(((await c.req.parseBody()) as Record<string, unknown>)['dir'] ?? '');
    movePerson(deps.db, c.req.param('id') ?? '', dir === 'up' ? 'up' : 'down');
    return savedRedirect(c, '/admin/people', 'order-saved');
  });

  app.get('/admin/people/:id/delete', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const person = readPeopleAdmin(deps.db).find((candidate) => candidate.id === id);
    if (person === undefined) return c.redirect('/admin/people', 302);

    return c.html(
      page({
        self: selfHref(c),
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
    return savedRedirect(c, '/admin/people', 'person-removed');
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

  app.get('/admin/shifts', (c: Context) => c.html(shiftsPage(c)));

  /** Edit a saved rotation: the same draft form, pre-filled from the plan. */
  app.get('/admin/shifts/:id/edit', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const plan = readShiftPlans(deps.db).find((candidate) => candidate.id === id);
    if (plan === undefined) return c.redirect('/admin/shifts', 302);
    const owner = deps.db
      .prepare('SELECT person_id AS personId FROM shift_plans WHERE id = ?')
      .get(id) as { personId: string | null } | undefined;
    return c.html(draftPage(c, draftFromPlan(plan, owner?.personId ?? '')));
  });

  /** Step one: who, and where the answer comes from. */
  app.post('/admin/shifts/new', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(draftBody, body);
    if (!shaped.ok) return c.html(shiftsPage(c, { message: shaped.message }), 400);

    const personId = shaped.value.person_id ?? '';
    const kind: PlanKind = shaped.value.kind === 'pattern' ? 'pattern' : 'calendar';
    const sourceId = shaped.value.source_id ?? '';

    if (!readPeopleAdmin(deps.db).some((person) => person.id === personId)) {
      return c.html(shiftsPage(c, { message: 'Choose who the rotation is for.' }), 400);
    }
    if (kind === 'calendar' && sourceId === '') {
      return c.html(shiftsPage(c, { message: 'Choose which calendar the shifts are in.' }), 400);
    }

    const draft: Draft = {
      personId,
      kind,
      sourceId,
      anchorDate: localToday(),
      slots: Array.from({ length: MAX_CYCLE }, () => SLOT_UNUSED),
      titleMap: suggestedTitleMap(sourceId),
    };
    return c.html(draftPage(c, draft));
  });

  app.post('/admin/shifts/preview', async (c: Context) => {
    const draft = draftFrom((await c.req.parseBody()) as Record<string, unknown>);
    const plan = planFrom(draft, 'preview');
    if ('message' in plan) return c.html(draftPage(c, draft, plan), 400);
    return c.html(draftPage(c, draft, undefined, plan));
  });

  app.post('/admin/shifts/save', async (c: Context) => {
    const draft = draftFrom((await c.req.parseBody()) as Record<string, unknown>);
    const plan = planFrom(draft, randomBytes(8).toString('hex'));
    if ('message' in plan) return c.html(draftPage(c, draft, plan), 400);

    const person = readPeopleAdmin(deps.db).find((candidate) => candidate.id === draft.personId);
    if (person === undefined) {
      return c.html(draftPage(c, draft, { message: 'That person is no longer there.' }), 400);
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
    return savedRedirect(c, '/admin/shifts', 'shift-rotation-saved');
  });

  /**
   * Removing a rotation asks first — the same GET-then-POST shape as every
   * other destructive control, in place of the one-click "Remove" the card
   * used to post directly.
   */
  app.get('/admin/shifts/:id/delete', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const plan = readShiftPlansAdmin(deps.db).find((candidate) => candidate.id === id);
    if (plan === undefined) return c.redirect('/admin/shifts', 302);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Remove rotation',
        nav: 'shifts',
        heading: `Remove ${plan.personName ?? 'this'}’s rotation?`,
        intro: 'The wall stops colouring their days by it. This cannot be undone; you can set it up again from scratch.',
        destroyAction: `admin/shifts/${encodeURIComponent(id)}/delete`,
        destroyLabel: 'Remove it',
        cancelAction: 'admin/shifts',
      }),
    );
  });

  app.post('/admin/shifts/:id/delete', (c: Context) => {
    deleteShiftPlan(deps.db, c.req.param('id') ?? '');
    return savedRedirect(c, '/admin/shifts', 'shift-rotation-removed');
  });

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  // The unified section. Screens and Layout were two pages for one thing, and
  // browser walls and e-paper walls were two nav items for one kind of object;
  // `/admin/walls` is the one list and the one canonical route now (RFC 009
  // Phase 4) — its status, pairing, settings and layout.
  app.get('/admin/walls', (c: Context) => c.html(displaysPage(c)));
  /*
   * Declared ahead of `/admin/walls/:id`, for the reason the approve route
   * states one screen along: a static segment must come before the param that
   * would otherwise swallow it. Here the swallow is silent rather than loud —
   * `:id` redirects an id it does not recognise to the Walls list, so "new"
   * would bounce off the list instead of 404ing.
   */
  app.get('/admin/walls/new', (c: Context) => c.html(newWallPage(c)));
  app.get('/admin/walls/:id', (c: Context) => {
    const id = c.req.param('id') ?? '';
    /*
     * The Default wall is retired. It was two things in one row — what every
     * wall inherits, and a canvas walls fell back to — and neither is a display:
     * nothing is paired to it and nothing draws it. Its settings are on System
     * and its canvas is copied onto the walls that were using it
     * (`retireDefaultWall`). Kept as a redirect rather than a 404, because this
     * address is in bookmarks and in every "Household default" hint shipped so
     * far.
     */
    if (id === 'default') return c.redirect('/admin/system', 302);
    if (!activeScreens().some((s) => s.id === id)) return c.redirect('/admin/walls', 302);
    // An e-paper panel's page is its design page — a panel landing here (an
    // old link, or the shared layout routes before they were kind-aware) gets
    // wall settings that do not apply to it.
    if (activeScreens().some((s) => s.id === id && s.kind === 'epaper')) {
      return c.redirect(`/admin/epaper/${encodeURIComponent(id)}/design`, 302);
    }
    return c.html(displayDetailPage(id, undefined, c));
  });

  // Old routes kept as redirects so bookmarks and any hand-typed links land in
  // the new section rather than 404ing.
  app.get('/admin/displays', (c: Context) => c.redirect('/admin/walls', 302));
  app.get('/admin/displays/:id', (c: Context) => {
    const id = c.req.param('id') ?? '';
    return c.redirect(`/admin/walls/${encodeURIComponent(id)}`, 302);
  });
  app.get('/admin/screens', (c: Context) => c.redirect('/admin/walls', 302));

  /**
   * Approve (or decline) a screen waiting in a device-authorization flow.
   *
   * This is the household half of frictionless pairing (RFC 003 Phase 3): the
   * screen began the flow at `/d/pair/device-start` and is polling; the QR it
   * shows leads here with the code pre-filled, or the household types the code
   * at the Walls page. Behind the session gate — which is what makes the short
   * code safe, because approval is impossible without the login.
   *
   * Registered *before* `POST /admin/screens/:id` on purpose: `approve` would
   * otherwise be swallowed as an `:id`, and the settings-save handler would
   * answer instead. A static segment must be declared ahead of the param it
   * would collide with.
   */
  app.get('/admin/screens/approve', (c: Context) => {
    const raw = c.req.query('code');
    // No code at all is a visit to the form, not a code that failed: the Walls
    // page links here, and somebody may simply have typed the address.
    if (raw === undefined) return c.html(approveCodePage(c, ''));
    const code = raw.trim();
    /*
     * Three ways a code can be wrong, each said as what it is and beside the
     * field it goes in, so the household corrects it rather than reading a
     * dead-end page — this used to answer every one of them with a 404 saying
     * the code had "expired", which for a mistyped character is untrue and for
     * an empty field is baffling.
     */
    if (code === '') {
      return c.html(approveCodePage(c, '', 'Type the code the wall is showing.'), 400);
    }
    const flow = deps.deviceFlow.lookupByUserCode(code, now());
    if (flow === undefined) {
      return c.html(approveCodePage(c, code, APPROVE_UNKNOWN_CODE), 404);
    }
    if (flow.state !== 'pending') {
      return c.html(approveCodePage(
        c,
        code,
        'That code has already been approved or declined, so there is nothing ' +
          'left to do with it. If the wall is still asking, start pairing again ' +
          'on it and type the new code.',
      ), 409);
    }
    return c.html(approvePromptPage(c, flow.userCode));
  });

  app.post('/admin/screens/approve', async (c: Context) => {
    const shaped = parse(approveDeviceBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(approveResultPage(c, 'That did not work', shaped.message), 400);
    const { code, name, action } = shaped.value;
    const at = now();

    if (action === 'deny') {
      deps.deviceFlow.deny(code, at);
      return c.html(approveResultPage(
      c,
        'Wall declined',
        'That wall will not be paired. It is safe to close it, or start again.',
      ));
    }

    // Issue the token first, then try to bind it to the still-pending flow.
    // Binding before creating the screen row is what prevents an orphan: if the
    // flow expired or was already approved (a double submit, or a scan racing a
    // manual entry), `approve` returns false and no screen is ever written.
    const issued = issueDisplayToken();
    if (!deps.deviceFlow.approve(code, issued.token, name, at)) {
      // The code stopped being pending between the prompt and the button —
      // it expired, or a scan and a typed entry raced. Back to the field with
      // the reason, so the new code the wall shows has somewhere to go.
      return c.html(approveCodePage(
        c,
        code,
        'That code expired, or was already approved or declined, so nothing was ' +
          'paired. Start pairing again on the wall, then type the new code here.',
      ), 409);
    }
    const id = randomBytes(6).toString('hex');
    createScreen(deps.db, id, name, pairingSecret(issued));
    /*
     * Seed it, like every other door that makes a wall.
     *
     * This one did not, and nothing said so: the wall drew the shared Default
     * canvas instead, which looked identical and was somebody else's row. With
     * that canvas retired the same omission is a wall that draws "Nothing on
     * this wall yet." for ever, because `backfillClassic` has already run on
     * this database and never runs again. Classic rather than a choice, because
     * this flow is a household approving a code on a screen they are not
     * standing at — the wall's own page is where they pick something else.
     */
    applyTemplate(deps.db, id, classicSeed(deps.db, id, householdSetUp(deps.db)));
    return c.html(approveResultPage(
      c,
      `${escapeHtml(name)} is paired`,
      'The wall will pick up its token on its next check, within a few seconds, ' +
        'and start drawing. You can rename or remove it from the Walls page.',
    ));
  });

  app.post('/admin/screens/:id', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const body = (await c.req.parseBody()) as Record<string, unknown>;

    const shaped = parse(screenBody, body);
    if (!shaped.ok) return c.html(displaysPage(c, shaped.message), 400);

    /*
     * Empty means "follow the household" on every one of these.
     *
     * That is a real answer rather than a missing one, so the schema leaves
     * them optional and the membership checks live here — a theme this build
     * cannot draw and a zone `Intl` does not know are both facts about this
     * process rather than about the shape of the request.
     */
    const {
      name, orientation, rotation,
      allow_dismiss: allowDismiss,
      allow_chores: allowChores,
    } = shaped.value;
    // '' follows the household, '1' forces 24-hour, '0' forces 12-hour.
    const clockRaw = shaped.value.clock_24 ?? '';
    const clock24 = clockRaw === '1' ? 1 : clockRaw === '0' ? 0 : null;
    const theme = shaped.value.theme ?? '';
    const daytimeTheme = shaped.value.daytime_theme ?? '';
    const startsAt = shaped.value.daytime_starts_at ?? '';
    const endsAt = shaped.value.daytime_ends_at ?? '';
    const timezone = shaped.value.timezone ?? '';

    if (!isValidThemeRef(deps.db, theme, themeKeys)) {
      return c.html(displayDetailPage(id, 'Choose a theme from the list.', c), 400);
    }
    if (!isValidThemeRef(deps.db, daytimeTheme, themeKeys)) {
      return c.html(displayDetailPage(id, 'Choose a daylight theme from the list.', c), 400);
    }

    const scheduled = daytimeTheme !== '';
    if (scheduled && (!HHMM_SHAPE.test(startsAt) || !HHMM_SHAPE.test(endsAt))) {
      return c.html(displayDetailPage(id, 'Enter this wall’s daylight hours as HH:MM.', c), 400);
    }
    if (scheduled && startsAt === endsAt) {
      return c.html(displayDetailPage(id, 'A daylight window of no length would never switch.', c), 400);
    }
    /*
     * Whatever the panel offered, which is the offered zones *and* the one this
     * screen already has.
     *
     * The picker adds a stored zone this build's `Intl` has never heard of
     * rather than silently swapping it for "Household default" (see the Time
     * group in `displayDetailPage`), so checking only `offeredTimezones()`
     * refuses an option the page had just preselected — and this 400 re-renders
     * from the database, so the whole Wall settings panel becomes unsavable and
     * every other edit in it goes with the refusal. The household select on
     * System has the same pair; getting only one half of it is how this
     * survived there once already.
     */
    const screenZone =
      readAdminScreens(deps.db).find((candidate) => candidate.id === id)?.timezone ?? null;
    if (timezone !== '' && timezone !== screenZone && !offeredTimezones().includes(timezone)) {
      return c.html(displayDetailPage(id, 'Choose a timezone from the list.', c), 400);
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
    if (!today.ok) return c.html(displayDetailPage(id, today.message, c), 400);
    const nextDays = density(shaped.value.next_days, 0, 14, 'Days ahead');
    if (!nextDays.ok) return c.html(displayDetailPage(id, nextDays.message, c), 400);
    const weeks = density(shaped.value.horizon_weeks, 1, 8, 'Weeks of month');
    if (!weeks.ok) return c.html(displayDetailPage(id, weeks.message, c), 400);

    /*
     * Three fields, one answer — and the rotation being saved is an input to
     * it, because a preset's numbers are the panel's own way up and the columns
     * hold the wall's. Resolved by a pure function rather than here, so every
     * one of its cases can be reached without a server.
     */
    const size = resolveWallSize(
      {
        size: shaped.value.panel_size,
        widthMm: shaped.value.panel_width_mm,
        heightMm: shaped.value.panel_height_mm,
        distanceMm: shaped.value.read_distance_mm,
      },
      rotation,
    );
    if (!size.ok) return c.html(displayDetailPage(id, size.message, c), 400);

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
        allowChores,
        displayTodayEvents: today.value,
        displayNextDays: nextDays.value,
        displayHorizonWeeks: weeks.value,
        clock24,
        panelWidthMm: size.widthMm,
        panelHeightMm: size.heightMm,
        readDistanceMm: size.distanceMm,
      })
    ) {
      return c.redirect('/admin/walls', 302);
    }
    // Back to the wall's own page; it picks the change up on its next poll.
    return savedRedirect(c, `/admin/walls/${encodeURIComponent(id)}`, 'screen-settings');
  });


  /**
   * Create a screen and show its pairing link.
   *
   * This is what the `add-screen` CLI does, moved to the one place a household
   * on the add-on can actually reach — they have a sidebar, not a shell. The
   * CLI stays for an SSH pairing and for the very first screen before any
   * account exists, but it is no longer the only door.
   */
  app.post('/admin/screens', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(newScreenBody, body);
    // Back to the add page carrying what was typed, never to the Walls list:
    // a refusal that renders a different page has thrown the answer away along
    // with the question.
    if (!shaped.ok) return c.html(newWallPage(c, shaped.message, body), 400);

    /*
     * Three fields, one answer, and the rotation is an input to it — a preset's
     * numbers are the panel's own way up and the columns hold the wall's. The
     * same pure function the settings form calls, so a size entered here and a
     * size entered there cannot resolve differently.
     */
    const size = resolveWallSize(
      {
        size: shaped.value.panel_size,
        widthMm: shaped.value.panel_width_mm,
        heightMm: shaped.value.panel_height_mm,
        distanceMm: shaped.value.read_distance_mm,
      },
      shaped.value.rotation,
    );
    if (!size.ok) return c.html(newWallPage(c, size.message, body), 400);

    /*
     * A wall may start from any wall template, and from no other list — the
     * gallery's own rule (`apply-template`), which exists because one lookup
     * shared with the panels would let a hand-posted `panel-built-in` put a
     * 1-bit arrangement on a colour wall. Blank is Classic, which is what
     * seeding gave every new wall before this form offered a choice.
     */
    const wanted = shaped.value.template ?? 'classic';
    const template = findTemplate(wanted);
    if (template === undefined) {
      return c.html(newWallPage(c, 'That starting layout is not one we ship.', body), 400);
    }

    const issued = issueDisplayToken();
    const id = randomBytes(6).toString('hex');
    createScreen(deps.db, id, shaped.value.name, pairingSecret(issued));
    /*
     * The hardware facts first, then the canvas — and that order is the whole
     * reason this page can ask for a size at all.
     *
     * `seedAspects` reads the millimetre columns off the row it is seeding, so
     * a wall told it is a 32" television gets a canvas at *its* aspect and no
     * letterbox; written the other way round it would read three nulls and seed
     * the card's nominal 9:16, and the size would only start mattering after a
     * Reset somebody has no reason to press.
     */
    writeScreenHardware(deps.db, id, {
      rotation: shaped.value.rotation,
      panelWidthMm: size.widthMm,
      panelHeightMm: size.heightMm,
      readDistanceMm: size.distanceMm,
    });
    /*
     * Seed the new screen, so it opens on a real arrangement the household can
     * rearrange — never a blank editor.
     *
     * Classic resolves through `classicSeed`, not the fully-equipped Classic: a
     * canvas is absolutely positioned, so a box for something the household has
     * not set up is not a placeholder, it is a hole the manifest leaves behind
     * when it drops it. Every other card is seeded as authored, at this
     * screen's own aspect — the gallery hands walls `undefined` there because a
     * card applied later is not a seed, and this is.
     */
    applyTemplate(
      deps.db,
      id,
      template.id === 'classic' ? classicSeed(deps.db, id, householdSetUp(deps.db)) : template,
      seedAspects(deps.db, id),
    );
    // Shown on the page the redirect lands on, not here: a POST's own answer
    // is a page a reload resubmits (a second wall) and Back cannot return to.
    reveals.put(id, issued, now());
    return c.redirect(`/admin/walls/${encodeURIComponent(id)}/pair`, 303);
  });

  /**
   * The pairing link, once — the page `POST /admin/screens` and
   * `/regenerate` send the household to.
   *
   * `take` is what makes it once: the first visit shows the QR, the code and
   * the link, and every visit after it — a reload, the Back button, a
   * bookmark — finds nothing and says so, with a way to make a new one. That
   * page is a 410 rather than a 404 because the link did exist and was shown;
   * what is gone is the showing. `no-store` so the browser keeps no copy of a
   * page with a token on it, which is also what makes Back refetch and reach
   * the honest answer instead of a cached secret.
   */
  app.get('/admin/walls/:id/pair', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = activeScreens().find((s) => s.id === id && s.kind === 'browser');
    if (screen === undefined) return c.redirect('/admin/walls', 302);
    c.header('cache-control', 'no-store');
    const issued = reveals.take(id, now());
    if (issued === undefined) return c.html(pairingSpentPage(c, screen), 410);
    return c.html(pairingPage(id, screen.name, issued.token, issued.shortCode, c));
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
    if (screen === undefined) return c.html(displaysPage(c, 'That wall is no longer there.'), 404);

    const issued = issueDisplayToken();
    rotateScreenToken(deps.db, id, pairingSecret(issued));
    // Same one-hop reveal as creating a wall — and here the reload case is
    // sharper: a POST answer reloaded would retire the link still on screen.
    reveals.put(id, issued, now());
    return c.redirect(`/admin/walls/${encodeURIComponent(id)}/pair`, 303);
  });

  app.post('/admin/screens/:id/revoke', (c: Context) => {
    revokeScreen(deps.db, c.req.param('id') ?? '');
    return savedRedirect(c, '/admin/walls', 'screen-removed');
  });

  // -------------------------------------------------------------------------
  // eInk (e-paper) displays (RFC 006) — admin-epaper.ts
  //
  // Registered here rather than beside the other modules at the top of this
  // function, because that is where these routes were: Hono answers with the
  // first pattern that matches, so where a group registers is behaviour.
  registerEpaperRoutes(app, deps, reveals);

  // -------------------------------------------------------------------------
  // Display
  // -------------------------------------------------------------------------

  // The global Display page is retired: its appearance controls are the Default
  // wall's now. Kept as a redirect so old bookmarks and links land there.
  app.get('/admin/display', (c: Context) => c.redirect('/admin/walls/default', 302));

  // The Default display's appearance form posts here — the household defaults
  // every wall inherits. (Weather moved to its own page; see admin-alerts.ts.)
  app.post('/admin/display', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;

    const shaped = parse(displayBody, body);
    if (!shaped.ok) return c.html(systemPage(c, shaped.message), 400);

    // A built-in or a custom theme that still exists — the schema let any string
    // through so the check could see the database.
    if (!isValidThemeRef(deps.db, shaped.value.theme, themeKeys)) {
      return c.html(systemPage(c, 'Choose a theme from the list.'), 400);
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
      return c.html(systemPage(c, 'Choose a daylight theme from the list.'), 400);
    }

    const order = blockOrder(body, readHousehold(deps.db).displayBlocks);
    if ('error' in order) return c.html(systemPage(c, order.error), 400);

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

    /*
     * Back to System, which is where these live now. They were the Default
     * wall's settings sheet, on a page that presented the shared household row
     * as a display somebody could design; the layout half of that row is
     * retired and this half was always settings.
     */
    return savedRedirect(c, '/admin/system', 'screen-settings');
  });

  // -------------------------------------------------------------------------
  // Layout editor
  // -------------------------------------------------------------------------

  /**
   * The wall a `?screen=` or a posted `screen` names, or `undefined`.
   *
   * It used to answer `null` — the shared Default wall — for anything it did
   * not recognise: an absent parameter, a blank one, a stranger's id, an
   * unpaired wall. That was a sensible default while there *was* a shared
   * canvas, and with the Default wall retired it is the opposite of one: a
   * mistyped id would have read, and in `POST /admin/layout` **written**, the
   * household row nothing can see any more. Unknown is unknown now, and every
   * caller answers it rather than acting on a wall nobody named.
   */
  function resolveOwner(id: string | null | undefined): string | undefined {
    if (id === null || id === undefined || id === '') return undefined;
    return activeScreens().some((s) => s.id === id) ? id : undefined;
  }

  app.get('/admin/layout', (c: Context) => {
    const owner = resolveOwner(c.req.query('screen'));
    // No wall named, or one that is gone: the list, which is the only thing
    // left to offer now that there is no shared canvas to fall back to.
    return c.redirect(owner === undefined ? '/admin/walls' : `/admin/walls/${encodeURIComponent(owner)}`, 302);
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
    const named = c.req.query('screen');
    /*
     * No `screen` at all is the household's own document, and that is a
     * different question from a `screen` naming a wall that is gone.
     *
     * The distinction is the whole of this branch. A named wall that has been
     * unpaired must still 404 — rendering somebody else's document under a
     * dead id is what the note here has always said. But the add-a-wall form
     * previews templates *before* a wall exists, and on a household with no
     * walls at all there is no id to name; `previewManifest(null)` is already
     * the shared-settings document two other callers in this file use for
     * exactly that, so the answer exists and only the route refused to give it.
     */
    if (named === undefined || named === '') return c.json(deps.previewManifest(null));
    const owner = resolveOwner(named);
    if (owner === undefined) return c.json({ error: 'unknown wall' }, 404);
    return c.json(deps.previewManifest(owner));
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

    /*
     * A canvas belongs to a wall, and only to a wall.
     *
     * This used to fall back to the shared default for an id it did not
     * recognise, which was the one place that fallback could *write*: a stale
     * editor tab, or a wall unpaired in another window, would have saved its
     * canvas onto the row every other wall inherited. With the Default wall
     * retired there is nothing to fall back to and the honest answer is a 404.
     * The editor posts one orientation at a time; absent is portrait (RFC 005).
     */
    const owner = resolveOwner(shaped.value.screen);
    if (owner === undefined) {
      return c.json({ ok: false, message: 'That wall is no longer there.' }, 404);
    }
    replaceLayout(deps.db, owner, shaped.value.orientation ?? 'portrait', {
      mode: shaped.value.mode,
      aspect: shaped.value.aspect,
      widgets: shaped.value.widgets,
      // Stored as JSON; null when the canvas has no background.
      background: shaped.value.background != null ? JSON.stringify(shaped.value.background) : null,
    });
    return c.json({ ok: true });
  });

  /** Whether an owner id is an e-paper panel — their layout lives on its own
   *  design page, not in the Walls section. */
  const isEpaperOwner = (owner: string | undefined): boolean =>
    owner !== undefined && activeScreens().some((s) => s.id === owner && s.kind === 'epaper');

  /**
   * A panel's two canvas aspects, from its pixels.
   *
   * The same arithmetic `epaperDesignPage` does when it seeds the editor, and
   * for the same stated reason: on a wall the aspect is a guess about a screen
   * nobody measured and the household may set one, while a panel's resolution
   * is a fact about the hardware. The design page already ignores a stored
   * aspect for that reason — reading one drew boxes on a canvas the device
   * cannot show, so a widget landed somewhere other than where it was dragged —
   * and a template applied at its nominal 800x480 would put that fault straight
   * back on the first save. Orientation-independent, because a quarter turn
   * cannot change long/short.
   */

  /** The layout view of a wall's page, where apply/copy/reset return to.
   *  Kind-aware: an e-paper panel goes back to its design page — sending it to
   *  the Walls section is how Reset looked like it did nothing. */
  const layoutUrl = (owner: string): string =>
    isEpaperOwner(owner)
      ? `/admin/epaper/${encodeURIComponent(owner)}/design`
      : `/admin/walls/${encodeURIComponent(owner)}#layout`;

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
    /*
     * `default` used to be a wall here and is not one now, so it lands in the
     * same place a stranger's id does: the list. Kept as one branch rather than
     * a special case, because "the shared canvas" and "a wall that was unpaired
     * since this link was made" are the same answer — there is nothing to
     * arrange.
     */
    const owner = resolveOwner(c.req.param('id'));
    if (owner === undefined) return c.redirect('/admin/walls', 302);
    return c.html(templateGalleryPage(c, owner));
  });

  /**
   * Apply a template to a display. A plain form POST, because the whole gallery
   * works without script; an unknown id is a no-op with a message rather than a
   * half-applied layout. Writes both canvases (`applyTemplate`).
   *
   * **The two catalogues are two lookups, not one list filtered.** A panel is
   * offered `PANEL_TEMPLATES` and may apply only those; a wall is offered
   * `TEMPLATES` and may apply only those. Sharing one lookup would make the
   * gallery's split cosmetic — a hand-posted `templateId` of `sky-week` would
   * put a colour wall arrangement on a 1-bit panel, which is exactly what the
   * split exists to stop, and rule five's point is that the shape refuses it
   * rather than a comment asking nobody to try.
   */
  app.post('/admin/displays/:id/apply-template', async (c: Context) => {
    const owner = resolveOwner(c.req.param('id'));
    if (owner === undefined) return c.redirect('/admin/walls', 302);
    const panel = isEpaperOwner(owner) ? activeScreens().find((s) => s.id === owner) : undefined;
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const wanted = typeof body['templateId'] === 'string' ? body['templateId'] : '';
    const template = panel === undefined ? findTemplate(wanted) : findPanelTemplate(wanted);
    if (template === undefined) {
      return c.html(templateGalleryPage(c, owner, 'That template is not one we ship.'), 400);
    }
    /*
     * Classic is the one template that adapts to the household, because it is
     * the one every wall is seeded with and the one a Reset returns to. Picking
     * it from the gallery has to hand over the same arrangement seeding would,
     * or the wall gets a hole the next boot would then quietly close.
     */
    applyTemplate(
      deps.db,
      owner,
      template.id === 'classic' ? classicSeed(deps.db, owner, householdSetUp(deps.db)) : template,
      // A panel's canvas is written at the panel's own shape, never the card's
      // nominal one — `TemplateAspects` carries why.
      panel === undefined ? undefined : panelPixelAspects(panel),
    );
    return savedRedirect(c, layoutUrl(owner), 'layout-template-applied');
  });

  /**
   * Copy another display's layout onto this one — the "start from another wall"
   * convenience the hybrid model gives in place of shared profiles. A one-shot
   * copy; the source is untouched and the two are not linked.
   *
   * A panel copies only from another panel, and the check is here rather than
   * only in the form that offers the list: the form is a convenience and the
   * POST is the boundary, which is rule five's whole point. A panel that wants
   * a wall's arrangement has `follow` — that keeps the two in step, where a
   * copy forks them on the first edit and does it in colour.
   */
  app.post('/admin/displays/:id/copy-from', async (c: Context) => {
    const to = resolveOwner(c.req.param('id'));
    if (to === undefined) return c.redirect('/admin/walls', 302);
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const src = typeof body['sourceOwner'] === 'string' ? body['sourceOwner'] : '';
    const from = resolveOwner(src);
    const toPanel = isEpaperOwner(to);
    if (from === to) {
      return c.html(
        templateGalleryPage(c, to, `Pick a different ${toPanel ? 'panel' : 'wall'} to copy from.`),
        400,
      );
    }
    if (from === undefined) {
      return c.html(templateGalleryPage(c, to, 'That display is no longer there.'), 400);
    }
    if (toPanel !== isEpaperOwner(from)) {
      return c.html(
        templateGalleryPage(
          c,
          to,
          toPanel
            ? 'A panel can only copy another panel’s layout. To show what a wall shows, set this ' +
              'panel to follow it on its own page — that keeps the two in step.'
            : 'A wall can only copy another wall’s layout.',
        ),
        400,
      );
    }
    copyLayout(deps.db, from, to);
    return savedRedirect(c, layoutUrl(to), 'layout-copied');
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
    const owner = resolveOwner(c.req.param('id'));
    if (owner === undefined) return c.redirect('/admin/walls', 302);
    if (isEpaperOwner(owner)) clearLayout(deps.db, owner);
    // Classic as this household would be seeded with it today — so Reset is
    // also the way to pick up a location, a rota, or a panel size entered since,
    // without waiting for a restart.
    else applyTemplate(deps.db, owner, classicSeed(deps.db, owner, householdSetUp(deps.db)));
    return savedRedirect(c, layoutUrl(owner), 'layout-reset');
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
    c: Context,
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
      self: selfHref(c),
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

  function shiftsPage(c: Context, error?: { message: string; suggestion?: string }): string {
    const plans = readShiftPlansAdmin(deps.db);
    const people = readPeopleAdmin(deps.db);
    const sources = readAdminSources(deps.db);

    const planCard = (plan: typeof plans[number]): string => {
      const id = encodeURIComponent(plan.id);
      return card(
        // The same card head every other list uses: the rotation on the left,
        // the ⋮ overflow on the right holding the destructive Remove. Edit — the
        // frequent action — stays the one visible button. The GET Remove leads
        // to already answers with `confirmDestroyPage`.
        `<div class="card-head"><div class="card-head-main">` +
        `<h2>${escapeHtml(plan.personName ?? 'Nobody')}</h2>` +
        `<p class="sub">` +
        (plan.kind === 'pattern'
          ? `Repeating pattern from ${plan.anchorDate === null ? '?' : escapeHtml(civilDateLabel(plan.anchorDate))}`
          : `Read from ${escapeHtml(plan.sourceName ?? 'a calendar that has been removed')}`) +
        `</p>` +
        `</div>` +
        `<details class="ovf" data-overflow>` +
        `<summary class="ovf-btn" role="button" aria-haspopup="menu" ` +
        `aria-label="More actions for ${escapeHtml(plan.personName ?? 'this rotation')}" title="More">${icon('more')}</summary>` +
        `<div class="ovf-menu" role="menu">` +
        destructive('Remove', {
          thing: plan.personName ?? 'this rotation',
          confirmAction: `admin/shifts/${id}/delete`,
        }) +
        `</div></details></div>` +
        `<div class="row">` +
        `<a class="btn btn-ghost btn-sm" href="admin/shifts/${id}/edit">Edit</a>` +
        `</div>`,
      );
    };

    const canAdd = people.length > 0;
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Work Schedule — Maverick Wall',
      nav: 'shifts',
      heading: 'Work Schedule',
      saved: readSaved(c),
      // No app-bar action: see the Calendars page for the rule. "Shift types"
      // used to sit here — a filled button in the app bar for what is
      // navigation, not an action — and is a link in the body now.
      intro:
        'The wall colours each day by who is working. A rotation is either read ' +
        'from a calendar that already has the shifts in it, or set as a pattern ' +
        'that repeats.',
      body:
        (error === undefined ? '' : errorBlock(error.message, error.suggestion)) +
        `<p class="hint"><a class="link" href="admin/shifts/types">Shift types</a> — ` +
        `name and colour the kinds of shift the wall knows about.</p>` +
        plans.map(planCard).join('') +
        (canAdd
          ? section(
              'Add a rotation',
              undefined,
              /*
               * The form opens on a choice that can be submitted.
               *
               * It used to open on "A calendar that already has them" over a
               * calendar select whose first option was "—", so pressing
               * Continue on the page as drawn was refused ("Choose which
               * calendar the shifts are in"), and "Who" preselected whoever
               * sorted first, who on the shipped fixture already had the only
               * rotation on the page. Now: whoever has no rotation comes first
               * and is preselected, a person who has one still can be chosen
               * and says so; the calendar option is offered only when there is
               * a calendar, with the first one preselected rather than a
               * placeholder; and the calendar select is shown only while the
               * calendar option is chosen — the chores form's script-free
               * `data-cond`, under which both fields simply show with script
               * off, as they did before.
               */
              `<form method="post" action="admin/shifts/new">` +
                selectField({
                  label: 'Who',
                  name: 'person_id',
                  optionsHtml: [...people]
                    .sort(
                      (a, b) =>
                        Number(a.hasShiftRotation === 1) - Number(b.hasShiftRotation === 1),
                    )
                    .map(
                      (candidate) =>
                        `<option value="${escapeHtml(candidate.id)}">${escapeHtml(candidate.name)}` +
                        `${candidate.hasShiftRotation === 1 ? ' (has a rotation)' : ''}</option>`,
                    )
                    .join(''),
                }) +
                selectField({
                  label: 'Where the shifts come from',
                  name: 'kind',
                  attrs: 'data-cond',
                  optionsHtml:
                    (sources.length === 0
                      ? ''
                      : `<option value="calendar">A calendar that already has them</option>`) +
                    `<option value="pattern">A pattern that repeats</option>`,
                  ...(sources.length === 0
                    ? { hint: 'Add a calendar first to read shifts from one.' }
                    : {}),
                }) +
                (sources.length === 0
                  ? ''
                  : `<div data-cond-show="calendar">` +
                    selectField({
                      label: 'Which calendar',
                      name: 'source_id',
                      optionsHtml: sources
                        .map(
                          (source) =>
                            `<option value="${escapeHtml(source.id)}">${escapeHtml(source.name)}</option>`,
                        )
                        .join(''),
                    }) +
                    `</div>`) +
                `<button type="submit">Continue</button></form>`,
              'add',
            )
          : `<p>Add someone on the <a class="link" href="admin/people">People</a> page first — ` +
            `a rotation belongs to a person.</p>`),
    });
  }

  /**
   * What every wall inherits — theme, daylight schedule, how much to show, and
   * the clock — as sections on the System page.
   *
   * These used to be the Default wall's settings sheet, which made the shared
   * household row look like a *display*: a card in the Walls list, a page, a
   * template gallery and a Reset. It was never a display — nothing is paired to
   * it and nothing draws it — and reading it as one is what let the two halves
   * of that row (defaults, and a layout walls fell back to) go on being one
   * thing. The layout half is retired (`retireDefaultWall`); this is the half
   * that was always settings, on the page the household's other settings are on.
   *
   * **One form across three sections, and that is load-bearing.**
   * `POST /admin/display` writes every field it is given and an unticked
   * checkbox is not sent at all, so a form carrying only the clock would save a
   * 12-hour clock *and* silently take the daylight schedule off every wall.
   * Sections are markup; the form spans them.
   *
   * The daylight window is drawn whatever the daytime theme says, unlike on the
   * wall's own settings sheet where a script reveals it. That page loads
   * `display-editor.js` and this one does not, so a `hidden` group here would be
   * a control nobody could ever reach — the chores form's rule, which is that no
   * group is rendered hidden and the hint carries the condition instead.
   */
  function wallDefaultsForm(): string {
    const household = readHousehold(deps.db);
    const custom = readThemes(deps.db);
    const scheduled = household.daytimeTheme !== null && household.daytimeTheme !== '';

    const number = (
      name: string,
      label: string,
      value: number,
      low: number,
      high: number,
      hint: string,
    ): string =>
      textField({
        label,
        name,
        type: 'number',
        required: true,
        value: String(value),
        hint,
        attrs: `inputmode="numeric" min="${low}" max="${high}"`,
      });

    const themeOption = (value: string, label: string, selected: boolean): string =>
      `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    const daytimeSelected = scheduled ? displayThemeRef(household.daytimeTheme ?? '') : '';

    return (
      `<form method="post" action="admin/display"${dirtyForm()}>` +
      section(
        'Wall appearance',
        'The look every wall starts from. A wall can override any of it on its own page.',
        `<p class="hint">How a wall looks — its colours and type. Panels separates the ` +
          `shift colours best from across a room. Build your own on the ` +
          `<a class="link" href="admin/themes">Themes</a> page.</p>` +
          themeCards(displayThemeRef(household.theme), custom) +
          selectField({
            label: 'Daytime theme',
            name: 'daytime_theme',
            hint: 'A lighter theme during the hours below. A dark theme at noon is a hole in the wall; a light one at 2am is a lamp.',
            optionsHtml:
              themeOption('none', 'The same theme all day', daytimeSelected === '') +
              THEMES.map((theme) =>
                themeOption(theme.key, theme.label, theme.key === daytimeSelected),
              ).join('') +
              custom
                .map((theme) =>
                  themeOption(`custom:${theme.id}`, theme.name, `custom:${theme.id}` === daytimeSelected),
                )
                .join(''),
          }) +
          `<div class="grid g2"><div>` +
          textField({
            label: 'From',
            name: 'daytime_starts_at',
            type: 'time',
            value: household.daytimeStartsAt ?? '07:00',
            hint: 'Only used when a daytime theme is set.',
          }) +
          `</div><div>` +
          textField({
            label: 'Until',
            name: 'daytime_ends_at',
            type: 'time',
            value: household.daytimeEndsAt ?? '21:00',
          }) +
          `</div></div>`,
      ) +
      section(
        'Wall content',
        'How much the calendars show, on every wall that has not said otherwise.',
        number('today_events', 'Events listed for today', household.displayTodayEvents, 1, 20,
          'Anything past this is counted rather than listed.') +
          number('next_days', 'Days an agenda looks ahead', household.displayNextDays, 0, 14,
            'How many upcoming days a Calendar agenda can list.') +
          number('horizon_weeks', 'Weeks in the month grid', household.displayHorizonWeeks, 1, 8,
            'How many weeks a month Calendar draws. Five covers a month at a glance.') +
          selectField({
            label: 'Week starts on',
            name: 'week_start',
            hint: 'The left-hand column of the month grid, on every wall.',
            optionsHtml:
              `<option value="sunday"${household.weekStart !== 'monday' ? ' selected' : ''}>Sunday</option>` +
              `<option value="monday"${household.weekStart === 'monday' ? ' selected' : ''}>Monday</option>`,
          }),
      ) +
      section(
        'Wall clock',
        'The clock every wall inherits until it sets its own.',
        `<div class="rows">` +
          switchRow({
            label: '24-hour clock',
            name: 'clock_24',
            checked: household.clock24 !== 0,
            hint: 'Off shows a 12-hour clock (9:30 pm) on the wall; on shows 24-hour (21:30).',
          }) +
          `</div>` +
          saveRow('admin/system'),
      ) +
      `</form>`
    );
  }

  function systemPage(c: Context, error?: string): string {
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
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'System — Maverick Wall',
      nav: 'system',
      heading: 'System',
      saved: readSaved(c),
      body:
        (error === undefined ? '' : errorBlock(error)) +

        card(
          `<h2>Version ${escapeHtml(deps.appVersion)}</h2>` +
            /*
             * Four readings in a table rather than four run together in a line.
             *
             * They were one `.sub` — "Running 3 hours · schema 38 · database
             * 1.2 MB" — which is the shape somebody writes when there is no
             * table to reach for, and it is the wrong shape for what this is:
             * labelled machine readings, mostly figures, on the one screen a
             * household opens *because* they are about to quote one of them
             * into a bug report. A middle-dotted sentence makes you count
             * separators to find the schema number. A table puts the labels
             * down the left and the values on a common right edge, tabular,
             * where two figures line up under each other.
             */
            dataTable(
              [{ label: 'Reading' }, { label: 'Value', numeric: true }],
              [
                ['Running', escapeHtml(uptimeText)],
                ['Schema', String(readSchemaVersionSafe())],
                ['Database', escapeHtml(formatBytes(size))],
                ['Integrity', integrity.ok ? tag('Checks out', 'ok') : tag('Problem', 'danger')],
              ],
            ) +
            (integrity.ok ? '' : `<p>Database problem: ${escapeHtml(integrity.detail)}</p>`),
          // The edge carries the hue and the row inside says it in words, so
          // neither a monochrome screenshot nor a colour-blind reader is left
          // relying on a tint. See card()'s own note on why a tone is an edge
          // here and not a ground.
          integrity.ok ? {} : { tone: 'danger' },
        ) +

        wallDefaultsForm() +

        section(
          'Timezone',
          'Every all-day event and the whole shift rotation are anchored to this. ' +
            'A wall somewhere else can override it on its own card.',
          /*
           * No echo here, deliberately — unlike Weather and Calendars.
           *
           * A rejected timezone reaches that branch *because* it is not in
           * `offeredTimezones()`, so echoing it selects nothing and the browser
           * preselects whatever sorts first: `Africa/Abidjan`, with Save live
           * over it. That is `setup.ts`'s `detectedTimezoneOption` rule
           * ("never 'nothing' … rather than leaving the select to preselect
           * whatever sorts first") and it is worth restating, because an echo
           * is the right answer for a text field and the wrong one for a closed
           * list: there is nothing to hand back that the control can show. The
           * stored zone stays selected, so the form is honestly clean and the
           * message says to choose from the list.
           */
          `<form method="post" action="admin/system/timezone"${dirtyForm()}>` +
            selectField({
              label: 'Household timezone',
              name: 'timezone',
              /*
               * The stored zone is always one of the options, even when `Intl`
               * has never heard of it.
               *
               * `offeredTimezones()` is whatever this build's `Intl` knows,
               * plus a UTC fallback — and a database restored from an image
               * with different tzdata, or one running the ten-zone list used
               * when `supportedValuesOf` is missing, can hold a zone that is
               * not in it. Listing only the offered ones then leaves *nothing*
               * selected, the browser picks whatever sorts first
               * (`Africa/Abidjan`), `looksEdited` correctly reports a form that
               * differs from its markup, and one press of the now-live Save
               * re-anchors every all-day event and the whole shift rotation to
               * west Africa.
               *
               * So the household's own zone is added rather than replaced: it
               * is a fact about them, not a suggestion. `setup.ts`'s
               * `detectedTimezoneOption` falls back to UTC instead, which is
               * right there — nothing is stored yet and it is guessing.
               */
              optionsHtml: (offeredTimezones().includes(household.timezone)
                ? offeredTimezones()
                : [household.timezone, ...offeredTimezones()]
              )
                .map(
                  (zone) =>
                    `<option value="${escapeHtml(zone)}"` +
                    `${zone === household.timezone ? ' selected' : ''}>${escapeHtml(zone)}</option>`,
                )
                .join(''),
            }) +
            saveRow('admin/system') +
            `</form>`,
        ) +

        section('Update check', undefined, updateSection()) +

        section(
          'Backup',
          'Two files, and you need both to restore everything. The database holds ' +
            'your calendars and settings; the key is what decrypts the calendar ' +
            'addresses inside it.',
          /*
           * A row per file rather than two buttons side by side.
           *
           * As a `.row` the pair said nothing about which file is which —
           * "Download database" and "Download key", with the sentence that
           * tells them apart up in the section's prose, where somebody reads it
           * once and never again. A list row puts the name and what it holds
           * beside the button that fetches it, which is the whole of what a
           * list row is for: the explanation travels with the control.
           */
          listRow(
            '',
            {
              title: 'Database',
              detail:
                'Your calendars, walls and settings. Restores everything except ' +
                'the calendar addresses.',
            },
            downloadForm('admin/system/backup', 'Download'),
          ) +
            listRow(
              '',
              {
                title: 'Encryption key',
                detail: 'What decrypts the calendar addresses inside the database.',
              },
              downloadForm('admin/system/key', 'Download', 'secondary'),
            ) +
            errorBlock(
              'The key file is a credential.',
              'Anyone with it and your database can read your calendar addresses. ' +
                'Keep it somewhere private, and never attach it to a support request.',
            ),
        ) +

        section(
          'Restore',
          'Upload a database backup, and the key if you have it — without it your ' +
            'calendar addresses stay encrypted and unreadable. Both are checked and ' +
            'put aside, then applied when Maverick Wall next starts.',
          `<form method="post" action="admin/system/restore" enctype="multipart/form-data">` +
            textField({ label: 'Backup file', name: 'backup', type: 'file', required: true }) +
            textField({
              label: 'Key file',
              name: 'key',
              type: 'file',
              hint: 'Optional. The file System → Backup downloads as maverick-wall.key.',
            }) +
            `<button type="submit">Stage restore</button></form>`,
        ) +

        section(
          'Diagnostics',
          'Safe to attach to a bug report: it carries no calendar addresses, no ' +
            'event titles and no email addresses — only hostnames, counts and the ' +
            'log below.',
          listRow(
            '',
            {
              title: 'Diagnostics export',
              detail: 'Hostnames, counts, job state and the log below.',
            },
            downloadForm('admin/system/diagnostics', 'Download'),
          ),
        ) +

        section(
          'Recent log',
          undefined,
          /*
           * "Nothing logged yet" is a claim about this process, and it is on
           * the branch that can make it: `lines` is the in-memory ring this
           * server has written since it booted, so an empty one means exactly
           * that and nothing about a log that could not be read. No action is
           * offered because there is none — a household cannot make a container
           * say something — which is the other half of emptyState's rule.
           */
          lines.length === 0
            ? emptyState('Nothing logged yet.')
            : `<pre class="log">${escapeHtml(logText)}</pre>`,
        ),
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
    /*
     * A dev build is never behind, which `updateOnOffer` now owns along with
     * the comparison itself — the Overview asked this question its own way and
     * got a different answer. `release` stays a separate reading because the
     * ladder below says something *different* about a dev build rather than
     * merely staying quiet about it.
     */
    const release = isReleaseVersion(deps.appVersion);
    const offered = updateOnOffer(state, deps.appVersion);

    const status = !state.enabled
      ? `<p class="hint">Off. Maverick Wall is not contacting anyone.</p>`
      : !release
        ? `<p class="hint">${escapeHtml(DEV_BUILD_NOTE)}</p>`
        : state.lastError !== null
        ? errorBlock(`Last check failed: ${state.lastError}`, 'It will try again tomorrow.')
        : state.lastCheckedAt === null
          ? `<p class="hint">On. The first check runs within the day, or press the button.</p>`
          : offered !== undefined
            ? `<div class="preview"><h3>Version ${escapeHtml(offered)} is available</h3>` +
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

      `<form method="post" action="admin/system/updates"${dirtyForm()}>` +
      switchRow({
        label: 'Check for updates once a day',
        name: 'update_check_enabled',
        checked: state.enabled,
        hint: 'Turning this off also forgets anything it had already found.',
      }) +
      saveRow('admin/system') +
      `</form>` +

      status +
      (state.enabled && release
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

  function peoplePage(c: Context, error?: string, suggestion?: string): string {
    const people = readPeopleAdmin(deps.db);

    const personCard = (person: PersonRecord, first: boolean, last: boolean): string => {
      const id = encodeURIComponent(person.id);
      return card(
        // The same card head every other list uses: the person on the left, the
        // ⋮ overflow on the right holding the rare actions — reorder, which
        // moves the wall's legend and the shift order, and the destructive
        // Remove, below a rule so the two are never neighbours. Reorder used to
        // be two buttons in a footer of their own, which made the rarest thing
        // a household does to a person the most visible thing on the card.
        `<div class="card-head"><div class="card-head-main">` +
        `<h2>` +
        (person.avatarPath === null
          ? `<span class="swatch" style="--swatch:${escapeHtml(person.color)}"></span>`
          : `<img class="avatar" alt="" src="/admin/media/${escapeHtml(person.avatarPath)}">`) +
        `${escapeHtml(person.name)}</h2>` +
        `<p class="sub">` +
        (person.sourceCount === 0
          ? 'No calendars assigned'
          : `${person.sourceCount} calendar${person.sourceCount === 1 ? '' : 's'}`) +
        (person.hasShiftRotation === 1 ? ' · has a shift rotation' : '') +
        `</p>` +
        `</div>` +
        `<details class="ovf" data-overflow>` +
        `<summary class="ovf-btn" role="button" aria-haspopup="menu" ` +
        `aria-label="More actions for ${escapeHtml(person.name)}" title="More">${icon('more')}</summary>` +
        `<div class="ovf-menu" role="menu">` +
        reorderMenuItems(`admin/people/${id}/move`, first, last) +
        destructive('Remove', {
          thing: person.name,
          confirmAction: `admin/people/${id}/delete`,
        }) +
        `</div></details></div>` +

        /*
         * Folded away, same idiom as `choreCard` and the calendar row: the name,
         * colour and picture are set once and rarely revisited, so a household
         * with several people should see a list of people, not a stack of two
         * open forms per person.
         */
        `<details class="disclose"><summary>Edit ${escapeHtml(person.name)}</summary>` +
        `<form method="post" action="admin/people/${id}">` +
        `<div class="row-fields">` +
        textField({ label: 'Name', name: 'name', required: true, value: person.name }) +
        textField({ label: 'Colour', name: 'color', type: 'color', value: person.color }) +
        `</div>` +
        `<button type="submit">Save</button></form>` +

        `<form method="post" enctype="multipart/form-data" ` +
        `action="admin/people/${id}/avatar">` +
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
        `</details>`,
      );
    };

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'People — Maverick Wall',
      nav: 'people',
      heading: 'People',
      saved: readSaved(c),
      // No app-bar action: see the Calendars page for the rule. The add form
      // is on this page, with the one filled Add.
      intro:
        'Everyone the wall knows about. Their colour marks their events and ' +
        'their shifts, so pick ones that are easy to tell apart from across a room.',
      body:
        (error === undefined ? '' : errorBlock(error, suggestion)) +
        people.map((person, index) => personCard(person, index === 0, index === people.length - 1)).join('') +
        section(
          'Add someone',
          undefined,
          `<form method="post" action="admin/people">` +
            `<div class="row-fields">` +
            textField({ label: 'Name', name: 'name', required: true, placeholder: 'Sam' }) +
            // Pre-filled with the colour this person would be given anyway, so
            // the picker agrees with what a household who never touches it
            // gets. A fixed literal here was half of the bug: everyone came
            // out blue.
            textField({ label: 'Colour', name: 'color', type: 'color', value: nextPersonColor(deps.db) }) +
            `</div>` +
            `<p class="hint">A picture can be added once they exist. The colour is what ` +
            `marks their events either way.</p>` +
            `<button type="submit">Add</button></form>`,
          'add',
        ),
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
    // opens the wall's page so the household can arrange it now, whether or
    // not a wall has connected yet. It is what stops the flow dead-ending on a
    // pairing code with nowhere to go.
    const setUp =
      `<p><a class="btn" href="admin/walls/${encodeURIComponent(id)}">` +
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
        self: selfHref(c),
      modules: navModules(deps.db),
        title: 'Pair this wall',
        nav: 'walls',
        heading: `Pair ${name}`,
        intro: 'This wall cannot be paired until the display port is turned on.',
        body:
          errorBlock(
            'The wall display port is turned off, so a wall has nowhere to connect.',
            'Open this add-on’s Network panel, give “Wall displays connect here” ' +
              '(8080/tcp) a free host port, and restart the add-on.',
          ) +
          `<p class="hint">Then come back to Walls and pair this wall again — ` +
          `the add-on will fill in the address for you once the port is on.</p>` +
          setUp +
          `<p><a class="link" href="admin/walls">← Back to walls</a></p>`,
      });
    }

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Pair this wall',
      nav: 'walls',
      heading: `Pair ${name}`,
      intro:
        'Open this on the wall itself. It is shown once. If you lose it, make a ' +
        'new one from the wall’s menu — this one stops working when you do.',
      body:
        (unreachable
          ? errorBlock(
              'This link points at localhost, which is nowhere from a wall.',
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
        `<p class="hint">No camera? Open Maverick Wall on the wall itself and ` +
        `type this pairing code:</p>` +
        `<p><span class="code">${escapeHtml(formatShortCode(shortCode))}</span></p>` +
        `<p class="hint">It works for the next day, and once — pairing a wall ` +
        `spends it. Or type this whole address on the wall instead:</p>` +
        `<p><span class="code">${escapeHtml(url)}</span></p>` +
        setUp +
        `<p class="hint">You can arrange its layout now — the wall does not have ` +
        `to be paired first.</p>` +
        `<p><a class="link" href="admin/walls">← Back to walls</a></p>`,
    });
  }

  /**
   * The pairing link has been shown, and this is the same address a second
   * time — a reload, the Back button, a bookmark.
   *
   * Says what happened and offers the only two things worth doing: make a new
   * link (the same POST the wall's own menu carries, with the same warning)
   * or go and arrange the wall. It must not offer the link again: the store
   * gave it up on the first visit, and a page that could show it twice would
   * be a page that had kept a secret somewhere.
   */
  function pairingSpentPage(c: Context, screen: AdminScreenRow): string {
    const id = encodeURIComponent(screen.id);
    const connected = screen.lastSeenAt !== null;
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Pair this wall',
      nav: 'walls',
      heading: `Pair ${screen.name}`,
      intro:
        'This pairing link has been shown already, and it is not kept anywhere ' +
        'it could be shown again.',
      body:
        `<p>If it was opened on the wall, there is nothing to do here. If it was ` +
        `not — the page was reloaded, or you came back to it — make a new one. ` +
        `The one you were given stops working${connected ? ', and this wall drops off until the new one is opened on it' : ''}.</p>` +
        `<form method="post" action="admin/screens/${id}/regenerate" ` +
        `data-confirm="${escapeHtml(regenerateWarning(screen.name, connected))}">` +
        `<button${connected ? ' class="btn-danger"' : ''} type="submit">Make a new pairing link</button></form>` +
        `<p><a class="link" href="admin/walls/${id}">Set up its layout →</a></p>` +
        `<p><a class="link" href="admin/walls">← Back to walls</a></p>`,
    });
  }

  /**
   * Where a typed pairing code goes: the field, with what went wrong beside
   * it when something did.
   *
   * The Walls page carries the same field as its way in; this page is where
   * it lands when the code is empty, unknown or already spent, so the
   * household corrects the code where they can see it rather than reading a
   * dead-end page and finding their way back. A scanned link with a stale
   * code lands here too, which is right: the wall it came from is showing a
   * new code by then, and this is the page that takes it.
   */
  function approveCodePage(c: Context, code: string, problem?: string): string {
    return page({
      modules: navModules(deps.db),
      title: 'Approve a pairing code',
      nav: 'walls',
      self: selfHref(c),
      heading: 'Approve a pairing code',
      intro:
        'A wall starting its own pairing shows an eight-character code. Type it ' +
        'here to approve or decline it.',
      body:
        `<form method="get" action="admin/screens/approve">` +
        textField({
          label: 'Pairing code',
          name: 'code',
          value: code,
          placeholder: 'ABCD-EFGH',
          attrs: 'maxlength="12"',
          ...(problem === undefined ? {} : { error: problem }),
        }) +
        `<button type="submit">Continue</button></form>` +
        `<p><a class="link" href="admin/walls">← Back to walls</a></p>`,
    });
  }

  /**
   * The confirm page for a device-flow pairing: name the wall, approve or
   * decline. Reached from the QR the wall shows (code pre-filled) or by typing
   * the code at the Walls page. The code travels in a hidden field so the one
   * form carries it to whichever button the household presses.
   */
  function approvePromptPage(c: Context, userCode: string): string {
    return page({
      modules: navModules(deps.db),
      title: 'Approve this wall',
      nav: 'walls',
      self: selfHref(c),
      heading: 'A wall wants to pair',
      intro:
        'A wall on your network is asking to join your household. Give it a ' +
        'name and approve it, or decline if you did not start this.',
      body:
        `<p class="hint">Pairing code from the wall: ` +
        `<span class="code">${escapeHtml(formatShortCode(userCode))}</span></p>` +
        `<form method="post" action="admin/screens/approve">` +
        `<input type="hidden" name="code" value="${escapeHtml(userCode)}">` +
        textField({
          label: 'Name',
          name: 'name',
          required: true,
          value: 'New wall',
          placeholder: 'Kitchen',
          hint: 'This is how the wall shows up on the Walls page.',
          attrs: 'maxlength="80"',
        }) +
        `<button type="submit" name="action" value="approve">Approve</button> ` +
        `<button class="secondary" type="submit" name="action" value="deny" ` +
        `formnovalidate>Decline</button>` +
        `</form>`,
    });
  }

  /** A plain outcome page for the approve/decline actions. */
  function approveResultPage(c: Context, heading: string, message: string): string {
    return page({
      modules: navModules(deps.db),
      title: heading,
      nav: 'walls',
      self: selfHref(c),
      heading,
      intro: message,
      body: `<p><a class="link" href="admin/walls">← Back to walls</a></p>`,
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

    /*
     * Which entry in the size list this wall is already on.
     *
     * Matched on the *pair* rather than on a stored key, because there is no
     * stored key — the columns hold millimetres, which is the only thing
     * anything downstream can use. `matchWallSize` compares them as a set, so a
     * wall hung sideways (whose pair `mountedSize` swapped) still reads back as
     * the television it is instead of dropping the household onto "Enter my
     * own" and implying they typed numbers they never typed.
     */
    const sizeMeasured = screen.panelWidthMm !== null && screen.panelHeightMm !== null;
    const sizePreset = matchWallSize(screen.panelWidthMm, screen.panelHeightMm);
    const sizeValue = !sizeMeasured ? '' : (sizePreset?.key ?? WALL_SIZE_CUSTOM);
    // Every value except "Not set". The distance is editable whichever size is
    // chosen, because it is a fact about the room and not about the hardware.
    const sizeChosen = [...WALL_SIZE_PRESETS.map((one) => one.key), WALL_SIZE_CUSTOM].join(' ');

    // --- Appearance ------------------------------------------------------
    //
    // The template gallery leads this panel rather than sitting under Advanced.
    // Picking a starting layout is the first thing done to a new wall and the
    // commonest thing done to an old one; Advanced is for the infrequent and
    // the destructive, and burying it there put the one control that changes
    // what the wall *shows* two taps behind a category named for pairing and
    // unpairing.
    //
    // It is a link rather than a form, which is why it can live inside the
    // settings form this panel sits in — the reason Reset and Unpair beside it
    // in Advanced cannot move with it.
    const appearance =
      wsetGroup(
        'Layout',
        `<div class="rows">` +
          `<a class="arow" href="admin/displays/${encodeURIComponent(screen.id)}/gallery">` +
          `<span class="arow-text">Start from a template` +
          `<small>Replace this wall's layout with one we ship, or copy another wall's.</small></span>` +
          `<span class="srow-chev" aria-hidden="true">${icon('chev')}</span></a>` +
          `</div>`,
      ) +
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
          `<i>Automatic</i> picks portrait or landscape from how the wall reports ` +
          `itself — right for almost every wall. Pick <i>Always portrait</i> or ` +
          `<i>Always landscape</i> only for a kiosk frame that reports the wrong size.</p>` +
          `<p>This is not the Portrait/Landscape buttons in the layout editor: those ` +
          `choose which layout you are arranging (you arrange both), while this decides ` +
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
            label: 'Wall mounting',
            name: 'rotation',
            hint: 'For a wall hung on its side.',
            optionsHtml:
              option('0', 'No rotation', screen.rotation === 0) +
              option('90', '90° clockwise', screen.rotation === 90) +
              option('180', 'Upside down', screen.rotation === 180) +
              option('270', '270° clockwise', screen.rotation === 270),
          }) +
          `</div>`
        ) +
      `</div>` +
      /*
       * The two facts nothing else in here knows, beside the mounting because
       * they are the same kind of fact: how big the hardware is, and where
       * somebody stands to read it.
       *
       * Script-free by construction, and it degrades the way `admin-chores.ts`
       * does: no group is rendered `hidden`, so a household who blocks script
       * sees every field and the handler still reads only the ones the choice
       * says to. That is why nothing here is `required` — a required control a
       * script has hidden is a form a browser refuses to submit and cannot say
       * why.
       */
      wsetGroup(
        'Size and reading distance',
        `<div class="rows">` +
          selectRow({
            label: 'Wall size',
            name: 'panel_size',
            wide: true,
            hint: 'Pick the nearest, or enter the picture’s own size.',
            attrs: 'data-cond',
            optionsHtml:
              option('', 'Not set', sizeValue === '') +
              WALL_SIZE_PRESETS.map((preset) =>
                option(preset.key, preset.label, sizeValue === preset.key),
              ).join('') +
              option(WALL_SIZE_CUSTOM, 'Enter my own', sizeValue === WALL_SIZE_CUSTOM),
          }) +
          `<div class="rowsub" data-cond-show="${WALL_SIZE_CUSTOM}">` +
          `<div class="two-up"><div>` +
          textField({
            label: 'Width',
            name: 'panel_width_mm',
            type: 'number',
            value: screen.panelWidthMm === null ? '' : String(screen.panelWidthMm),
            hint: 'Across the wall, in millimetres — the picture, not the case.',
            attrs: `inputmode="numeric" min="${PANEL_MM_MIN}" max="${PANEL_MM_MAX}"`,
          }) +
          `</div><div>` +
          textField({
            label: 'Height',
            name: 'panel_height_mm',
            type: 'number',
            value: screen.panelHeightMm === null ? '' : String(screen.panelHeightMm),
            hint: 'Down the wall, in millimetres.',
            attrs: `inputmode="numeric" min="${PANEL_MM_MIN}" max="${PANEL_MM_MAX}"`,
          }) +
          `</div></div></div>` +
          `<div class="rowsub" data-cond-show="${sizeChosen}">` +
          textField({
            label: 'Read from',
            name: 'read_distance_mm',
            type: 'number',
            value: screen.readDistanceMm === null ? '' : String(screen.readDistanceMm),
            hint:
              'How far away somebody stands to read a name off this wall, in ' +
              'millimetres — not where they glance at it from the doorway. Those ' +
              'are two different distances and this is the reading one. Left ' +
              'blank, a size from the list brings its own.',
            attrs:
              `inputmode="numeric" min="${READ_DISTANCE_MM_MIN}" max="${READ_DISTANCE_MM_MAX}"`,
          }) +
          `</div>` +
          `</div>` +
          `<p class="hint-1">Two facts about the hardware, like the mounting above: ` +
          `nothing else in here knows how large this wall is or how far away it is ` +
          `read from. Leave them unset and it draws exactly as it does today.</p>`,
      ) +
      wsetGroup(
        'Time',
        `<div class="rows">` +
          selectRow({
            label: 'Timezone',
            name: 'timezone',
            wide: true,
            /*
             * The screen's own zone is always one of the options, even one this
             * build's `Intl` has never heard of — the same rule as the
             * household select on System, and for the sharper reason. Listing
             * only the offered zones leaves nothing selected, the browser
             * preselects the first ("Household default"), and the next save of
             * this panel silently clears an override the household set.
             */
            optionsHtml:
              option('', `Household default — ${household.timezone}`, screen.timezone === null) +
              (screen.timezone === null || offeredTimezones().includes(screen.timezone)
                ? offeredTimezones()
                : [screen.timezone, ...offeredTimezones()]
              )
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
          'Lets this wall clear alerts for the household. Leave this off for ' +
          'walls without intentional input or ones that may be touched accidentally.',
      }) +
      /*
       * Its own switch rather than one "this screen accepts input", because the
       * two are not the same risk. Clearing a warning is a household saying it
       * has read something; ticking a chore is a claim about the world somebody
       * may act on. A household can reasonably want one and not the other — and
       * the wording says what the wall will actually do, since a control that
       * appears on a screen nobody meant to touch is the failure being avoided.
       */
      switchRow({
        label: 'Allow ticking chores off',
        name: 'allow_chores',
        checked: screen.allowChores === 1,
        hint:
          'Puts a tick box beside each chore on this wall. Best on a tablet ' +
          'somebody can reach; leave it off for a wall behind glass, or one a ' +
          'passing sleeve could press.',
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
      `<form method="post" action="admin/screens/${id}/regenerate" ` +
      `data-confirm="${escapeHtml(regenerateWarning(screen.name, screen.lastSeenAt !== null))}">` +
      `<button class="arow${screen.lastSeenAt === null ? '' : ' is-danger'}" type="submit">` +
      `<span class="arow-text">New pairing link` +
      `<small>Shows a fresh link and code. The current one stops working` +
      `${screen.lastSeenAt === null ? '' : ', and this wall drops off until the new one is opened on it'}.</small></span>` +
      `<span class="srow-chev" aria-hidden="true">${icon('chev')}</span></button></form>` +
      // "Start from a template" used to sit here and now leads Appearance: it is
      // neither infrequent nor destructive, which is what this category is for.
      `<form method="post" action="admin/displays/${id}/reset-layout" ` +
      `data-confirm="Reset both the portrait and landscape layouts of ${escapeHtml(screen.name)} ` +
      `to the Classic layout? Everything arranged here is replaced.">` +
      `<button class="arow is-danger" type="submit"><span class="arow-text">Reset layout` +
      `<small>Both orientations, back to the Classic layout.</small></span></button></form>` +
      `<form method="post" action="admin/screens/${id}/revoke" ` +
      `data-confirm="Unpair ${escapeHtml(screen.name)}? Its token stops working and it drops off the wall.">` +
      `<button class="arow is-danger" type="submit"><span class="arow-text">Unpair wall` +
      `<small>This wall stops receiving updates until it is paired again.</small></span></button></form>` +
      `<div class="frow"><span>Wall id</span><code>${escapeHtml(screen.id)}</code></div>` +
      `</div>`;

    return (
      `<div class="wset" data-wset-root>` +
      `<nav class="wset-nav" role="tablist" aria-orientation="vertical" aria-label="Wall settings">` +
      wsetRow('appearance', 'Appearance', 'Template, theme and daylight', true) +
      wsetRow('content', 'Content defaults', 'How much the calendars show', false) +
      wsetRow('device', 'Device and time', 'Name, mounting, size, timezone', false) +
      // Names both switches: the section holds one about alerts and one about
      // chores, and a subtitle that mentions only the first is a heading a
      // household would not open looking for the second.
      wsetRow('alerts', 'Alerts and interaction', 'What this wall can press', false) +
      wsetRow('advanced', 'Advanced', 'Pairing, reset, unpair', false) +
      `</nav>` +
      `<div class="wset-panels">` +
      `<form method="post" action="${action}" class="wall-settings" data-settings>` +
      wsetPanel('appearance', 'Appearance', 'The layout this wall starts from and how it looks. Anything left on the household default follows the wall defaults on System.', appearance, true) +
      wsetPanel('content', 'Content defaults', 'How much the calendars on this wall show. Each one follows the household until you turn that off.', content, false) +
      wsetPanel('device', 'Device and time', 'What this wall is called, how it is hung, how large it is, and the clock it keeps.', device, false) +
      // Both switches, not just the alert one — this panel is now where every
      // "can this screen write anything" decision lives, and it is worth saying
      // that a wall display can only ever press what is listed here.
      wsetPanel('alerts', 'Alerts and interaction', 'What a person standing at this wall is allowed to press. Both are off until you turn them on.', alerts, false) +
      `</form>` +
      wsetPanel('advanced', 'Advanced', 'Infrequent, and some of it destructive. These act at once — they are not part of Save wall.', advanced, false) +
      `</div></div>`
    );
  }

  /**
   * One card for every wall on the list, whatever it is (RFC 009 Phase 4).
   *
   * The list used to draw three shapes: the Default wall as a link, a browser
   * wall as a link with a status dot in its head, and an e-paper panel as a
   * static card carrying a ⋮ and an "Arrange layout" button — because a panel
   * had no page of its own to open, so its card had to be that page. It has
   * one now: its layout page, which carries the recipes link and Remove the
   * card used to (and which `/admin/walls/:id` sends a panel to). So every
   * card is the same object — a name, a kind tag, one status line, "Open" —
   * and the grid composes, which three heights and three affordances never did.
   *
   * The Default wall is gone from the list altogether: it was a card for a row
   * nothing is paired to and nothing draws, counted among a household's walls.
   * The dot still rides the status line rather than the head, which is now what
   * keeps a never-connected wall's name on the same edge as its neighbours'.
   *
   * `status` is already-escaped markup.
   */
  function wallCard(href: string, name: string, tag: string | undefined, status: string): string {
    return (
      `<a class="card wall-card" href="${href}">` +
      `<div class="wall-head">` +
      `<div class="wall-head-main">` +
      `<div class="rname">${escapeHtml(name)}` +
      (tag === undefined ? '' : ` <span class="tag">${escapeHtml(tag)}</span>`) +
      `</div>` +
      `<div class="sub">${status}</div></div>` +
      `<span class="card-go">Open <span aria-hidden="true">${icon('chev')}</span></span>` +
      `</div></a>`
    );
  }

  /** "● Last seen 3 min ago from 10.0.0.4" — the dot says whether that is recent. */
  function seenLine(screen: AdminScreenRow, at: number, windowMs?: number): string {
    return (
      seenDot(screen.lastSeenAt, at, windowMs) +
      `Last seen ${escapeHtml(ago(screen.lastSeenAt, at))}` +
      (screen.lastSeenIp === null ? '' : ` from ${escapeHtml(screen.lastSeenIp)}`)
    );
  }

  /** A browser wall: its page holds status, pairing, settings and layout together. */
  function displayListCard(screen: AdminScreenRow, at: number): string {
    return wallCard(
      `admin/walls/${encodeURIComponent(screen.id)}`,
      screen.name,
      'Browser',
      seenLine(screen, at) + (screen.appVersion === null ? '' : ` · ${escapeHtml(screen.appVersion)}`),
    );
  }

  /**
   * An e-paper panel: the same card, opening its layout page directly (the
   * `/admin/walls/:id` route would only redirect there, and a crawl of the
   * admin's own links should reach the page without a hop). The panel's
   * geometry stays on the status line because it is the one fact that tells
   * two panels apart, where two browser walls are told apart by their names.
   */
  function epaperListCard(screen: AdminScreenRow, at: number): string {
    return wallCard(
      `admin/epaper/${encodeURIComponent(screen.id)}/design`,
      screen.name,
      'E-paper',
      seenLine(screen, at, EPAPER_SEEN_WINDOW_MS) +
        ` · ${screen.panelWidth ?? '?'}×${screen.panelHeight ?? '?'}` +
        (screen.rotation === 0 ? '' : ` · rotated ${screen.rotation}°`) +
        (screen.lanOnly === 1 ? ' · LAN only' : ''),
    );
  }

  /**
   * The add-a-wall page: name it, say what it is, and say where its layout
   * starts — then pair it.
   *
   * It used to be a name field in a section on the Walls list, and adding an
   * e-paper panel was a page of its own asking for a size, a rotation and
   * (since the panel gallery) a starting view. Two doors of very different
   * shapes onto one act, and the browser one asked for the least at the one
   * moment the household is standing in front of the hardware. The two are one
   * shape now: **name, what it is, where its layout starts, then the pairing
   * step** — this page and `epaperPage` in `admin-epaper.ts` are deliberate
   * mirrors, and `test/add-display-parity.test.ts` reads both and holds them to
   * it.
   *
   * Moved off the Walls list rather than grown in place, and the reason is
   * written down one file along: `epaperPage`'s own docstring says the e-paper
   * form was kept on its own route because "the size presets and rotation
   * picker ... would otherwise crowd the pairing form every household sees".
   * That argument did not stop being true when the pairing form grew the same
   * controls.
   *
   * **Everything but the name is optional and every absence is the answer the
   * old one-field form gave**, which is what makes this safe for a household
   * who just wants a wall: no size is no size, no rotation is none, and no
   * template is Classic — the arrangement seeding already gave every new wall.
   *
   * `echo` is the submitted body, handed back on a 400. A form re-rendered
   * from nothing is the Weather screen's fault (a typed measurement thrown away
   * by the error message about it), and it costs more here than it did there
   * because there are five fields to lose rather than one.
   */
  function newWallPage(c: Context, error?: string, echo?: Record<string, unknown>): string {
    const said = (key: string): string => {
      const value = echo?.[key];
      return typeof value === 'string' ? value : '';
    };
    const option = (value: string, label: string, selected: boolean): string =>
      `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    // Blank is "Not set" and is the default: a wall nobody has measured draws
    // exactly as this product has always drawn it.
    const size = said('panel_size');
    const rotation = said('rotation') === '' ? '0' : said('rotation');
    // Classic when nothing was said, which is what seeding gives anyway.
    const template = said('template') === '' ? 'classic' : said('template');
    const sizeChosen = [...WALL_SIZE_PRESETS.map((one) => one.key), WALL_SIZE_CUSTOM].join(' ');

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Pair a new wall — Maverick Wall',
      nav: 'walls',
      heading: 'Pair a new wall',
      saved: readSaved(c),
      intro:
        'A browser wall: a tablet, a monitor or a television with Maverick Wall open ' +
        'in a browser. Name it and say what it is, and the next page has the QR and ' +
        'the short code to open on the wall itself.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<p><a class="link" href="admin/walls">← Back to walls</a></p>` +
        `<form method="post" action="admin/screens" id="add">` +
        textField({
          label: 'Name',
          name: 'name',
          required: true,
          value: said('name'),
          placeholder: 'Kitchen',
          hint: 'This is how the wall shows up on the Walls page.',
          attrs: 'maxlength="80"',
        }) +
        /*
         * The same two facts the wall's own settings page asks for, in the same
         * words and from the same lists — `WALL_SIZE_PRESETS` and the four
         * millimetre bounds are read here and there, so the two forms cannot
         * come to offer different sizes. Script-free the way that page is: no
         * group is hidden server-side and nothing is `required`, because a
         * required control a script has hidden is a form a browser refuses and
         * cannot explain.
         */
        selectField({
          label: 'Wall size',
          name: 'panel_size',
          attrs: 'data-cond',
          hint: 'Pick the nearest, or leave it unset and set it later.',
          optionsHtml:
            option('', 'Not set', size === '') +
            WALL_SIZE_PRESETS.map((preset) => option(preset.key, preset.label, size === preset.key)).join('') +
            option(WALL_SIZE_CUSTOM, 'Enter my own', size === WALL_SIZE_CUSTOM),
        }) +
        `<div class="grid g2" data-cond-show="${WALL_SIZE_CUSTOM}">` +
        `<div>` +
        textField({
          label: 'Width (mm)',
          name: 'panel_width_mm',
          value: said('panel_width_mm'),
          placeholder: '708',
          hint: 'Across the wall — the picture, not the case.',
          attrs: `inputmode="numeric" min="${PANEL_MM_MIN}" max="${PANEL_MM_MAX}"`,
        }) +
        `</div><div>` +
        textField({
          label: 'Height (mm)',
          name: 'panel_height_mm',
          value: said('panel_height_mm'),
          placeholder: '398',
          hint: 'Down the wall.',
          attrs: `inputmode="numeric" min="${PANEL_MM_MIN}" max="${PANEL_MM_MAX}"`,
        }) +
        `</div></div>` +
        `<div data-cond-show="${sizeChosen}">` +
        textField({
          label: 'Read from (mm)',
          name: 'read_distance_mm',
          value: said('read_distance_mm'),
          placeholder: '1200',
          hint:
            'How far away somebody stands to read a name off this wall — not where ' +
            'they glance at it from the doorway. Left blank, a size from the list ' +
            'brings its own.',
          attrs: `inputmode="numeric" min="${READ_DISTANCE_MM_MIN}" max="${READ_DISTANCE_MM_MAX}"`,
        }) +
        `</div>` +
        selectField({
          label: 'Rotation',
          name: 'rotation',
          hint: 'For a wall hung on its side.',
          optionsHtml:
            option('0', 'No rotation', rotation === '0') +
            option('90', '90° clockwise', rotation === '90') +
            option('180', 'Upside down', rotation === '180') +
            option('270', '270° clockwise', rotation === '270'),
        }) +
        /*
         * Cards with a real preview each, not a list of names.
         *
         * This was a plain `<select>`, on the argument — written here — that a
         * card previews by rendering the canvas a screen owns and this screen
         * does not exist yet. That was wrong about the mechanism: a *wall's*
         * gallery card is drawn in the browser from the **template's** own
         * canvas through `renderFreeform`, and the screen supplies nothing but
         * the manifest to draw with. So the same script draws the same cards
         * here against the household's own document, which is what
         * `previewManifest(null)` has always answered. No second renderer,
         * which is the thing that argument was actually protecting.
         *
         * It reported itself: "it's impossible to know what Classic is, or
         * Meeting Room, from just text" — of a control offering fourteen names
         * on the one screen where a household has never seen any of them.
         *
         * Radios in labels, the `themecard` idiom this admin already picks a
         * theme with, so the name and value the handler reads are unchanged and
         * a browser with no script gets fourteen labelled cards with blurbs —
         * strictly more than the select said.
         */
        templateCards(template) +
        `<button type="submit">Add wall</button>` +
        `</form>` +
        `<div id="template-gallery" data-json="${escapeHtml(
          JSON.stringify({ owner: null, templates: wallTemplatePreviews(TEMPLATES) }),
        )}"></div>` +
        `<script type="module" src="assets/template-gallery.js"></script>`,
    });
  }

  /**
   * The Walls list: the shared Default plus every paired wall, browser and
   * e-paper alike — one list, one nav item, one card shape, with a kind chip
   * on each row rather than two nav entries for one kind of object (RFC 009
   * Phase 4). Every card opens its wall's own page.
   */
  function displaysPage(c: Context, error?: string): string {
    const at = now();
    const all = readAdminScreens(deps.db);
    const active = all.filter((screen) => screen.revokedAt === null);
    const revoked = all.length - active.length;

    const cardFor = (screen: AdminScreenRow): string =>
      screen.kind === 'epaper' ? epaperListCard(screen, at) : displayListCard(screen, at);

    // Reachable from nothing before this (RFC 009 Phase 4) — the device-flow
    // approve/decline page existed only as a URL a QR or a hand-typed link
    // could reach, with no form anywhere in the admin to get there.
    const approveForm = section(
      'Approve a pairing code',
      'A wall starting its own pairing flow shows an eight-character code. Type ' +
        'it here to approve or decline it.',
      `<form method="get" action="admin/screens/approve"><div class="row">` +
        textField({ label: 'Pairing code', name: 'code', placeholder: 'ABCD-EFGH', attrs: 'maxlength="12"' }) +
        `<button class="secondary" type="submit">Continue</button></div></form>`,
    );

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Walls — Maverick Wall',
      nav: 'walls',
      heading: 'Walls',
      saved: readSaved(c),
      // No app-bar action: see the Calendars page for the rule. The pairing
      // form is on this page, with the one filled Add wall.
      ...(active.length === 0
        ? { intro: 'No walls paired yet. Add one below and it will start on the layout you pick for it.' }
        : {}),
      body:
        (error === undefined ? '' : errorBlock(error)) +
        /*
         * Every card here is a real, paired display. The Default wall used to
         * lead the grid and was neither — nothing is paired to it and nothing
         * draws it — so a household counting their walls counted one that does
         * not exist. What it held is split: the settings every wall inherits are
         * on System, and the canvas walls fell back to was copied onto them.
         */
        (active.length === 0 ? '' : `<div class="grid g2">` + active.map(cardFor).join('') + `</div>`) +
        (revoked === 0
          ? ''
          : `<p class="hint">${revoked} unpaired wall${revoked === 1 ? '' : 's'} kept ` +
            `for the record. Their tokens no longer work.</p>`) +
        /*
         * Two doors, one shape. The browser form used to be right here — a
         * single name field — while e-paper had a page of its own asking for a
         * size and a rotation, so the two ways of adding a wall looked nothing
         * alike and the commoner one asked for the least. Both are pages now,
         * both ask name → hardware → starting layout → pair, and this list
         * carries the two links side by side rather than one form and one link.
         */
        section(
          'Add a wall',
          undefined,
          `<p class="hint">A tablet, monitor or television with Maverick Wall open in ` +
            `a browser. You name it and say what it is, then get a QR code and a ` +
            `short code to enter on the wall itself. ` +
            `<a class="link" href="admin/walls/new">Pair a new wall →</a></p>` +
            `<p class="hint">Low-power e-paper panels are added the same way, with ` +
            `their own panel sizes and starting views. ` +
            `<a class="link" href="admin/epaper#add">Add an e-paper wall →</a></p>`,
          'add',
        ) +
        approveForm,
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
   * defaults live on System now and are linked to from here.
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
  function displayDetailPage(ownerId: string, error: string | undefined, c: Context): string {
    const at = now();
    const household = readHousehold(deps.db);
    /*
     * A real, paired wall — never the shared household row.
     *
     * This took `string | null`, and `null` rendered the Default wall: the same
     * page, the same editor, the same gallery, over a row nothing is paired to
     * and nothing draws. That is retired. `?? null` survives for an id that has
     * been unpaired since the page was linked, which the route ahead of this
     * already redirects; the `owner?.x ?? household.x` reads below are the real
     * per-wall inheritance and are untouched.
     */
    const owner = activeScreens().find((s) => s.id === ownerId) ?? null;
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
    /*
     * The e-paper panels drawing *this* canvas, for the ink lane's preview.
     *
     * `panelCanvasOwner` again, from the other side: a panel following this
     * wall is a screen whose canvas owner is this one. The first is the lane's
     * preview target, since
     * its `preview.png` renders any posted canvas at that panel's geometry.
     */
    const inkPanels = readAdminScreens(deps.db)
      .filter(
        (candidate) =>
          candidate.kind === 'epaper' &&
          candidate.revokedAt === null &&
          panelCanvasOwner(candidate) === ownerKey,
      )
      .map((panel) => ({
        id: panel.id,
        name: panel.name,
        width: panel.panelWidth ?? 800,
        height: panel.panelHeight ?? 480,
        orientation: epaperOrientation(panel),
      }));

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
      // The household, for the Shift widget's "whose rota" picker.
      people: readPeopleAdmin(deps.db).map((p) => ({ id: p.id, name: p.name })),
      // The viewport this screen last reported, so the editor can offer "match
      // this screen's size" (RFC 005). Only a paired screen reports one — the
      // shared Default has no single size to match.
      ...(owner?.reportW != null && owner?.reportH != null
        ? { report: { w: owner.reportW, h: owner.reportH } }
        : {}),
      /*
       * The ink lane (RFC 005, direction B) — present only when a panel is
       * actually looking at this canvas.
       *
       * That is the whole gate: an editor with no panel following it offers no
       * ink lane, because there is nothing for an override to reach. A
       * household with a panel gets the lane on the canvas that panel draws,
       * and nowhere else. The tables travel with it rather than being
       * transcribed into the display bundle — the ladder is written twice
       * because both *renderers* need it; this is read by the editor alone.
       */
      ...(inkPanels.length === 0
        ? {}
        : { ink: { panels: inkPanels, lane: INK_LANE, ignores: PANEL_IGNORES } }),
      // Which widgets the wall will leave out, and what to do about it. The
      // editor keeps the box — it has to be grabbable — and flags it.
      notDrawn: widgetsNotDrawn(deps.db),
    };

    // ---- the wall's own header ------------------------------------------
    //
    // Status in words rather than a colour alone, and short enough to sit on
    // one line beside a name that may be long. The five-minute freshness test
    // is the one the list page has always used.
    const online = owner !== null && owner.lastSeenAt !== null && at - owner.lastSeenAt < 5 * 60_000;
    const statusLine =
      owner === null
        ? `<b>Shared default</b> · the layout and settings every wall starts from`
        : owner.lastSeenAt === null
          ? `<b>Never connected</b> · open its pairing link on the wall, or make a new one from the menu`
          : online
            ? `<b>Online</b>${owner.appVersion === null ? '' : ` · ${escapeHtml(owner.appVersion)}`}`
            : `<b>Not seen recently</b> · last seen ${escapeHtml(ago(owner.lastSeenAt, at))}`;

    const ownerParam = encodeURIComponent(owner?.id ?? '');
    const menuItems =
      (owner === null
        ? ''
        : `<form method="post" action="admin/screens/${encodeURIComponent(owner.id)}/regenerate" ` +
          `data-confirm="${escapeHtml(regenerateWarning(owner.name, owner.lastSeenAt !== null))}">` +
          `<button class="ovf-item${owner.lastSeenAt === null ? '' : ' is-danger'}" type="submit">` +
          `New pairing link…</button></form>`) +
      `<a class="ovf-item" href="admin/displays/${ownerParam}/gallery">Start from a template…</a>` +
      `<div class="ovf-sep"></div>` +
      `<form method="post" action="admin/displays/${ownerParam}/reset-layout" ` +
      `data-confirm="Reset both the portrait and landscape layouts of ${escapeHtml(
        owner?.name ?? 'this wall',
      )} to the Classic layout? Everything arranged here is replaced.">` +
      `<button class="ovf-item is-danger" type="submit">Reset layout…</button></form>` +
      (owner === null
        ? ''
        : `<form method="post" action="admin/screens/${encodeURIComponent(owner.id)}/revoke" ` +
          `data-confirm="Unpair ${escapeHtml(owner.name)}? Its token stops working and it drops off the wall.">` +
          `<button class="ovf-item is-danger" type="submit">Unpair wall…</button></form>`);

    // Status and the overflow ride the mode bar rather than a header of their
    // own: the app bar already carries the way back and the wall's name, and a
    // second header on a phone is a screenful before anything is editable.
    const statusAndMenu =
      `<p class="wall-status">` +
      (owner === null ? '' : seenDot(owner.lastSeenAt, at)) +
      `<span>${statusLine}</span></p>` +
      `<details class="ovf" data-overflow>` +
      `<summary class="ovf-btn" role="button" aria-haspopup="menu" ` +
      `aria-label="More actions for this wall" title="More">${icon('more')}</summary>` +
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
      `<p class="insp-empty">Nothing selected. Tap a widget on the layout to change ` +
      `what it shows and how it looks.</p>` +
      `</aside>` +
      `</div></section>`;

    const settingsPane =
      `<section class="mode" id="mode-settings" role="tabpanel" aria-labelledby="mode-tab-settings" ` +
      `data-mode-panel="settings"${startMode === 'settings' ? '' : ' hidden'}>` +
      (owner === null ? '' : wallSettingsForm(owner)) +
      `</section>`;

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: `${owner?.name ?? 'Wall'} — Maverick Wall`,
      nav: 'walls',
      heading: owner?.name ?? 'Wall',
      saved: readSaved(c),
      back: { label: 'Walls', href: 'admin/walls' },
      // The canvas is sized from the room its pane gives it, so this screen is
      // the one place the admin's 1180px measure costs a picture rather than
      // buying a readable line.
      wide: true,
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
   * canvas as JSON; a first-party script draws each card's live preview through
   * the renderer that will actually draw it, so the card shows what the display
   * will draw.
   *
   * **It is two galleries, because a panel is not a wall.** Everything below
   * that reads `panel` is that split. Offered the wall's list, an 800x480
   * black-and-white e-paper screen got thirteen colour arrangements previewed on
   * a portrait 9:16 canvas, each captioned with a theme it cannot have, over an
   * offer to copy a wall's layout onto it — and the one layout it had actually
   * been drawing since the day it was paired, its built-in view, was not among
   * them. `PANEL_TEMPLATES` is the panel's own list and `panel-built-in` leads
   * it, so the arrangement a household has already seen is the one they can
   * start from.
   *
   * Three things follow from the split rather than being separate decisions.
   * The preview is a real 1-bit frame from `POST /admin/epaper/:id/preview.png`
   * — the *same* endpoint the designer's backdrop uses and so the same renderer
   * the device runs, because two renderers disagreeing about one canvas is the
   * fault the design page already had to fix once. There is no theme line,
   * because there is no theme. And "copy another display's layout" offers only
   * other panels: copying a wall's colour arrangement onto one bit is the same
   * category error the whole split exists to remove, and a panel that wants to
   * show what a wall shows has `follow` for it, which keeps the two in step
   * instead of forking them.
   */
  function templateGalleryPage(c: Context, owner: string, error?: string): string {
    // Always a real wall now. The gallery used to take `null` and title itself
    // "Default wall", which is the shared household row — a thing with no
    // screen, no size and nothing drawing it, offered a page of arrangements.
    const screen = activeScreens().find((s) => s.id === owner);
    const panel = isEpaperOwner(owner) ? screen : undefined;
    const ownerName = screen?.name ?? 'this wall';
    const ownerParam = encodeURIComponent(owner);
    const catalogue = panel === undefined ? TEMPLATES : PANEL_TEMPLATES;
    // Relative, like every link here, so the single <base> carries it through
    // ingress; kind-aware for the reason `layoutUrl` is, one screen along.
    const backHref = panel === undefined
      ? `admin/walls/${ownerParam}#layout`
      : `admin/epaper/${ownerParam}/design`;

    /*
     * A panel card's thumbnail is the shape of the frame that comes back.
     *
     * The panel's *native* buffer, deliberately, and not the orientation a
     * viewer sees: `renderScreenFrame` draws the visual canvas and then turns
     * the raster, so what the preview endpoint answers with is always
     * `panelWidth x panelHeight` however the panel is hung. The widgets posted
     * with it are the visual orientation's (`epaperOrientation` above), which is
     * the same pair the designer's own backdrop uses — so a rotated panel's card
     * shows its buffer sideways, exactly as the Arrange preview does and exactly
     * as the device holds it.
     *
     * Carried as a custom property rather than a declaration, so the stylesheet
     * keeps the rule and the markup carries only the number.
     */
    const inkRatio = panel === undefined
      ? ''
      : ` style="--tpl-ar:${panel.panelWidth ?? 800}/${panel.panelHeight ?? 480}"`;

    const card = (t: DisplayTemplate): string =>
      `<article class="tpl-card">` +
      `<div class="tpl-thumb${panel === undefined ? '' : ' is-ink'}" data-tpl="${escapeHtml(t.id)}"${inkRatio}>` +
      `<div class="tpl-fallback">${escapeHtml(t.name)}</div></div>` +
      `<div class="tpl-body">` +
      `<div class="tpl-name">${escapeHtml(t.name)}</div>` +
      `<div class="tpl-blurb">${escapeHtml(t.blurb)}</div>` +
      // No theme line on a panel: it has no theme, and a card advertising one
      // would be a control that does nothing.
      (t.theme !== undefined && panel === undefined
        ? `<div class="hint-1">Looks best in ` +
          `<b style="color:var(--accent)">${escapeHtml(themeName(t.theme))}</b> ` +
          `— change it after.</div>`
        : '') +
      `<form method="post" action="admin/displays/${ownerParam}/apply-template" ` +
      `data-confirm="Replace ${escapeHtml(ownerName)}'s current layout with ${escapeHtml(t.name)}?">` +
      `<input type="hidden" name="templateId" value="${escapeHtml(t.id)}">` +
      `<button class="btn-sm" type="submit">Use this layout</button></form>` +
      `</div></article>`;

    const group = (label: string, cat: 'home' | 'office'): string => {
      const cards = catalogue.filter((t) => t.category === cat).map(card).join('');
      return cards === '' ? '' : `<div class="tpl-cat">${label}</div><div class="tpl-grid">${cards}</div>`;
    };

    /*
     * What this display may copy a layout from.
     *
     * A wall may copy any other display's; a panel may copy only another
     * panel's. That is the split's rule rather than a separate one — a wall's
     * arrangement is authored in colour on a canvas of its own aspect, and
     * putting it on one bit is what `follow` is for, where the two stay in step
     * instead of forking on the first edit.
     */
    /*
     * Other real displays, and nothing else. The Default wall used to lead this
     * list — a canvas with no screen behind it, offered as something to copy —
     * and it is retired.
     */
    const others = activeScreens()
      .filter((s) => s.id !== owner && (panel === undefined || s.kind === 'epaper'))
      .map((s) => ({ id: s.id, name: s.name }));
    const copyFrom = others.length === 0
      ? ''
      : `<div class="tpl-copy"><div class="tpl-cat">Or copy another ${panel === undefined ? 'wall' : 'panel'}'s layout</div>` +
        `<form method="post" action="admin/displays/${ownerParam}/copy-from" ` +
        `data-confirm="Replace ${escapeHtml(ownerName)}'s current layout with a copy?"><div class="row">` +
        selectField({
          label: 'From',
          name: 'sourceOwner',
          optionsHtml: others
            .map(
              (o) =>
                `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`,
            )
            .join(''),
        }) +
        `<button class="secondary" type="submit">Copy its layout</button></div></form></div>`;

    /*
     * What the client needs to draw a preview.
     *
     * A wall's card is drawn in the browser through `renderFreeform` off its
     * *portrait* canvas — that is the shape a wall card has always been. A
     * panel's is a real frame from the server, so the client needs the
     * orientation the panel actually draws (its own, after rotation) and the
     * endpoint to post it to; nothing about the panel's shape is computed in
     * the browser, because the panel's shape is not the browser's to guess.
     */
    const galleryData = JSON.stringify({
      owner,
      ...(panel === undefined
        ? {}
        : { panelPreview: `admin/epaper/${ownerParam}/preview.png` }),
      // The wall case is `wallTemplatePreviews`, shared with the add-a-wall
      // form so the two pages cannot come to send different shapes of this.
      // A panel's is this page's alone: it needs the orientation the panel
      // actually draws, and neither theme nor background reaches it — it has
      // no theme and one ground.
      templates:
        panel === undefined
          ? wallTemplatePreviews(catalogue)
          : catalogue.map((t) => {
              const canvas = t[epaperOrientation(panel)];
              return { id: t.id, aspect: canvas.aspect, widgets: canvas.widgets };
            }),
    });

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: `Templates — ${ownerName} — Maverick Wall`,
      nav: 'walls',
      heading: 'Start from a template',
      intro:
        panel === undefined
          ? `Pick a starting layout for ${ownerName}. You can move, remove and add to it afterwards.`
          : `Pick a starting layout for ${ownerName}. Each card is the real ${panel.panelWidth ?? 800}×` +
            `${panel.panelHeight ?? 480} frame this panel would draw. You can move, remove and add to ` +
            `it afterwards, and Reset layout puts the built-in view back.`,
      body:
        `<p><a class="link" href="${escapeHtml(backHref)}">← Back to ${escapeHtml(ownerName)}</a></p>` +
        (error === undefined ? '' : errorBlock(error)) +
        `<div id="template-gallery" data-json="${escapeHtml(galleryData)}"></div>` +
        (panel === undefined
          ? group('Home', 'home') + group('Office', 'office')
          : `<div class="tpl-grid">${catalogue.map(card).join('')}</div>`) +
        copyFrom +
        `<script type="module" src="assets/template-gallery.js"></script>`,
    });
  }

  function sourceRow(
    source: AdminSourceRow,
    at: number,
    people: readonly PersonRecord[],
    /**
     * What the household had in this row's fields, when a save of it came back
     * at 400 — so the error costs only the thing that was wrong. Absent is the
     * ordinary case and the row draws from the database.
     */
    echo?: SourceEcho,
  ): string {
    const status =
      source.lastError !== null
        ? errorBlock(
            `Last sync failed: ${source.lastError}`,
            source.consecutiveFailures > 1
              ? `${source.consecutiveFailures} failures in a row. It keeps retrying, further apart each time.`
              : undefined,
          )
        : firstSyncPending(source, at)
          ? // Deliberately no event count beside it: zero is what this row
            // reports before the first fetch lands, and "0 events" next to
            // "Syncing…" is the failure sentence back again in a quieter voice.
            `<p><strong>Syncing…</strong> ` +
            `<span class="sub">fetching this calendar for the first time</span></p>`
          : `<p>${source.eventCount} event${source.eventCount === 1 ? '' : 's'} · ` +
            `synced ${escapeHtml(ago(source.lastSuccessAt, at))}</p>`;

    const id = encodeURIComponent(source.id);
    // The echo wins wherever there is one; with none, the stored row is the form.
    const shown = {
      name: echo?.name ?? source.name,
      color: echo?.color ?? source.color,
      /*
       * Only a person who exists, so the closed list always has one option
       * selected. The 400 this echo is for is "That person is no longer
       * there." — the very case where the posted id matches no option, which
       * would leave the browser to preselect the first ("Everyone") on a row
       * with a live Save. Falling back to `null` selects Everyone *deliberately*,
       * which is also what the next Save would store. Same rule as the timezone
       * and the two weather selects.
       */
      personId:
        echo === undefined
          ? source.personId
          : people.some((person) => person.id === echo.personId)
            ? echo.personId
            : null,
      enabled: echo?.enabled ?? source.enabled === 1,
      showInGrid: echo?.showInGrid ?? source.showInGrid === 1,
      allowLan: echo?.allowLan ?? source.allowPrivateNetwork === 1,
      allowLoopback: echo?.allowLoopback ?? source.allowLoopback === 1,
      allowHttp: echo?.allowHttp ?? source.allowHttp === 1,
    };
    const personOptions =
      `<option value=""${shown.personId === null ? ' selected' : ''}>Everyone</option>` +
      people
        .map(
          (person) =>
            `<option value="${escapeHtml(person.id)}"` +
            `${person.id === shown.personId ? ' selected' : ''}>` +
            `${escapeHtml(person.name)}</option>`,
        )
        .join('');

    return card(
      /*
       * The name, the host, and an overflow for the destructive one.
       *
       * Remove used to sit in the row at the foot of the card, beside Sync now,
       * at the same visual weight — a destructive action one mis-tap from a
       * safe one, and a household scanning a list of calendars reads two
       * equally-weighted buttons per row. It moves to the ⋮ every wall header
       * and every alert rule row already uses: a `<details>`, so it opens with
       * no script at all, which matters here because the Calendars page ships
       * none. What it does *not* change is the confirmation — Remove is still a
       * GET to a page that names what is destroyed, and still a POST to perform
       * it. This moves where it is reached from, not how it works.
       */
      `<div class="card-head"><div class="card-head-main">` +
      `<h2><span class="swatch" style="--swatch:${escapeHtml(source.color)}"></span>` +
      /*
       * "(off)" used to be two words appended to the name, so a calendar's
       * heading read "Work (off)" and its state was a parenthesis inside the
       * thing it was about — invisible scanning a list of eight, and
       * indistinguishable from a calendar somebody had actually named that. It
       * is a tag now: its own element, its own ground, and still a *word*,
       * which is what a monochrome screenshot and a colour-blind reader both
       * need. The colour is never the signal on its own. It rides in the head's
       * flex row beside the name — the same place the Walls kind chip and the
       * Store card's "Off" sit — rather than dropping to its own line.
       */
      `${escapeHtml(source.name)}` +
      (source.enabled === 1 ? '' : tag('Not syncing', 'warn')) +
      `</h2>` +
      // The host and never the path. The path is the credential. A Home
      // Assistant calendar has neither — it is an entity read through the one
      // connection — so it says what it is rather than "unknown host".
      `<p class="host">${escapeHtml(
        source.kind === 'homeassistant'
          ? `Home Assistant · ${source.haEntityId ?? 'calendar entity'}`
          : source.urlHost ?? 'unknown host',
      )}</p>` +
      `</div>` +
      `<details class="ovf" data-overflow>` +
      `<summary class="ovf-btn" role="button" aria-haspopup="menu" ` +
      `aria-label="More actions for ${escapeHtml(source.name)}" title="More">${icon('more')}</summary>` +
      `<div class="ovf-menu" role="menu">` +
      // The ellipsis, the GET rather than a one-click POST, and an accessible
      // name that says *which* calendar are all `destructive()`'s now rather
      // than three things this row had to remember. Eight rows of "Remove" is
      // what a screen reader hears without the last of them.
      destructive('Remove', {
        thing: source.name,
        confirmAction: `admin/calendars/${id}/delete`,
      }) +
      `</div></details></div>` +
      status +

      /*
       * Folded away, because a list of calendars has to read as a list.
       *
       * Expanded, one card is a name, a colour, an owner, a sync switch and the
       * network-access disclosure — the same weight the chore editor used to
       * carry per chore, for something looked at once at setup and rarely
       * again. The facts that matter for a glance (name, host, sync status)
       * stay above the fold; the `<details>` is the script-free split, same as
       * `admin-chores.ts`'s `choreCard`. Open by default when there is an
       * echo — a rejected save's edits and the reason for it must not be
       * hidden behind a tap the household has no reason to make.
       */
      `<details class="disclose"${echo === undefined ? '' : ' open'}>` +
      `<summary>Edit ${escapeHtml(source.name)}</summary>` +

      // When a calendar belongs to someone, their colour wins on the wall — so
      // the picker becomes a dead control. Show it as owned rather than let a
      // household set a colour that silently does nothing; the hidden field
      // keeps the stored colour so it returns intact if they pick "Everyone".
      (() => {
        const owner =
          shown.personId === null ? null : (people.find((p) => p.id === shown.personId) ?? null);
        const colourField =
          owner === null
            ? textField({ label: 'Colour', name: 'color', type: 'color', value: shown.color })
            : `<span><label>Colour</label>` +
              `<span class="owned-colour"><span class="swatch" ` +
              `style="--swatch:${escapeHtml(owner.color)}"></span>Uses ${escapeHtml(owner.name)}’s colour</span>` +
              `<input type="hidden" name="color" value="${escapeHtml(shown.color)}"></span>`;
        return (
          `<form method="post" action="admin/calendars/${id}/settings"${dirtyForm(echo !== undefined)}>` +
          `<div class="row-fields">` +
          textField({ label: 'Name', name: 'name', required: true, value: shown.name }) +
          colourField +
          selectField({ label: 'Belongs to', name: 'person_id', optionsHtml: personOptions }) +
          `</div>`
        );
      })() +

      switchRow({
        label: 'Sync this calendar',
        name: 'enabled',
        checked: shown.enabled,
      }) +
      /*
       * The answer to one calendar flooding the squares.
       *
       * A daily standup is the least informative thing a wall can draw and it
       * takes a row in every cell to say it: one weekday meeting filled 17 of
       * the visible month's cells with the same cut-off word. Worded as the
       * household's own sentence — "I do not need work on the family wall" —
       * rather than as a filter or a rule, and it names the *other* place the
       * events still are, because a switch that reads like "hide this calendar"
       * is one nobody turns on.
       */
      switchRow({
        label: 'Show on the calendar grid',
        name: 'show_in_grid',
        checked: shown.showInGrid,
        hint:
          'The month squares and the week view. Turn this off for a busy work ' +
          'calendar that would otherwise fill every day — its events still ' +
          'appear in the upcoming list.',
      }) +
      // Named as a risk rather than as a feature, because it is one — and not
      // drawn at all for a Home Assistant calendar, which is not fetched from
      // an address the household typed. Its events arrive through the one
      // Home Assistant connection, so there is no outbound rule to relax and
      // the control would do nothing whichever way it was set.
      (source.kind === 'homeassistant'
        ? ''
        : networkAccessDisclosure({
            allowPrivateNetwork: shown.allowLan,
            allowLoopback: shown.allowLoopback,
            allowHttp: shown.allowHttp,
          })) +
      saveRow('admin/calendars') +
      `</form>` +
      `</details>` +

      /*
       * Not drawn while sync is off: `ics-sync` skips a disabled source, so the
       * button would report a fetch that never happens. A control that can do
       * nothing is worse than a control that is not offered.
       *
       * The *stored* switch, not `shown.enabled` — this is an action on the
       * calendar as it is, and the endpoint guards on the stored row too. Read
       * off the echo, a 400 re-render would draw the button for a calendar the
       * database still has disabled (press it and nothing happens) or hide it
       * for one that is enabled.
       *
       * The row is drawn only when there is something in it. With Remove moved
       * to the overflow, a disabled calendar's foot would otherwise be an empty
       * flex container carrying its own margins.
       */
      (source.enabled === 1
        ? `<div class="row">` +
          `<form method="post" action="admin/calendars/${id}/sync">` +
          `<button class="secondary" type="submit">Sync now</button></form>` +
          `</div>`
        : ''),
      // A failing calendar takes the hue on its own edge, so a list of eight
      // says which one to look at before a word of it is read. The tone follows
      // the branch the status text above is on, never a second opinion about
      // it — and it is an edge rather than a ground precisely so the error
      // block inside it stays legible. See `card`.
      source.lastError !== null ? { tone: 'danger' } : {},
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
      `<p class="sub"><span class="host">${escapeHtml(result.host)}</span> · ${result.totalEvents} event` +
      `${result.totalEvents === 1 ? '' : 's'} found</p>` +
      `<ul>${rows}</ul>` +
      result.warnings
        .map((warning) => `<p class="warn">${escapeHtml(warning)}</p>`)
        .join('') +
      `<p class="hint">Nothing has been saved yet. If these look right, add it.</p>` +
      `</div>`
    );
  }

  /**
   * Calendars Home Assistant already has, offered here.
   *
   * The path existed before this — on the Home Assistant screen — and nobody
   * arriving at "I want to add a calendar" would ever have found it. Adding it
   * posts to the same endpoint that screen does, so there is one validation and
   * one writer, and what lands is an ordinary `calendar_sources` row: same
   * cache, same manifest, same renderer, edited on this page like any other.
   *
   * Drawn only when there is something to add. A household with no Home
   * Assistant, or one that has already added all of them, sees nothing.
   */
  function haCalendarSection(
    available: readonly { readonly entityId: string; readonly name: string }[],
    sources: readonly AdminSourceRow[],
  ): string {
    const already = new Set(
      sources.filter((s) => s.kind === 'homeassistant').map((s) => s.haEntityId),
    );
    const offer = available.filter((entity) => !already.has(entity.entityId));
    if (offer.length === 0) return '';

    return section(
      'From Home Assistant',
      `Home Assistant is connected and has ` +
        `${offer.length} calendar${offer.length === 1 ? '' : 's'} you have not added yet. ` +
        `Adding one here needs no address — its events come through the same ` +
        `connection, and it behaves exactly like a feed once it is in.`,
      /*
       * One row per calendar rather than one `<select>` over all of them.
       *
       * The select was the cheap thing to write and it hides the answer to the
       * question somebody arrives with: *which* of my Home Assistant calendars
       * are not on the wall yet. A closed list says "there are some" and makes
       * you open it to find out, and adding two means two round trips through a
       * control that has forgotten the first. `listRow` is the shape this
       * always wanted — the entity's name, its id under it, the one action on
       * the right — and it posts to the same endpoint with the same field, so
       * there is still one validation and one writer.
       */
      offer
        .map((entity) =>
          listRow(
            '',
            { title: entity.name, detail: entity.entityId },
            `<form method="post" action="admin/home-assistant/calendars">` +
              `<input type="hidden" name="entity_id" value="${escapeHtml(entity.entityId)}">` +
              `<button class="secondary" type="submit"` +
              ` aria-label="Add ${escapeHtml(entity.name)} from Home Assistant">Add</button>` +
              `</form>`,
          ),
        )
        .join(''),
    );
  }

  function calendarsPage(
    c: Context,
    values: {
      name?: string;
      url?: string;
      allowPrivateNetwork?: boolean;
      allowLoopback?: boolean;
      allowHttp?: boolean;
    } = {},
    error?: {
      message: string;
      suggestion?: string;
      /**
       * The network opt-ins this address still needs, when it was refused for
       * one. Named all at once and used to open the disclosure they live in:
       * an error pointing at a control folded shut is an error nobody can act
       * on, and it took three submissions to add a loopback http feed.
       */
      networkOptions?: readonly NetworkOption[];
    },
    tested?: TestFeedResult,
    /**
     * The Home Assistant calendars on offer, when there are any.
     *
     * Passed in rather than looked up here, because this function is sync and
     * the lookup is a request. Empty is the ordinary case — no Home Assistant,
     * or a connection that is unwell — and draws nothing at all rather than an
     * empty section explaining itself.
     */
    haCalendars: readonly { readonly entityId: string; readonly name: string }[] = [],
    /** One row's unsaved values, when a save of that row came back at 400. */
    echo?: SourceEcho,
  ): string {
    const at = now();
    const sources = readAdminSources(deps.db);
    const people = readPeopleAdmin(deps.db);

    const networkOptions = error?.networkOptions ?? [];
    /*
     * The switch-naming sentence wins wherever there is one.
     *
     * It is the only sentence composed from the table the checkboxes are drawn
     * from, so it is the only one that can quote the label the household is
     * looking at. `testFeed`'s per-code advice fills in underneath, for the
     * refusals no switch reaches.
     */
    const networkSuggestion = networkAccessSuggestion(networkOptions);
    const suggestion = networkSuggestion !== '' ? networkSuggestion : error?.suggestion;
    const errorHtml = error === undefined ? '' : errorBlock(error.message, suggestion);

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Calendars — Maverick Wall',
      nav: 'calendars',
      heading: 'Calendars',
      saved: readSaved(c),
      /*
       * No app-bar action, deliberately — and the same rule now holds on
       * People, Chores, Walls and Work Schedule, which used to carry one each.
       *
       * `page()`'s action is a *filled* button for the top-right of the shell,
       * and a filled "Add a calendar" there competes with the form's own
       * filled Add while the form it would scroll to is already on the page:
       * two primaries for one act. The app bar's slot is for an action that
       * leads somewhere else (Themes' "New theme" opens the builder), not
       * for a scroll. Half the pages had one and half did not, which read as
       * the button meaning something different on each.
       */
      body:
        /*
         * A row's error belongs above the rows, not under "Add a calendar".
         *
         * One page, two error sources: the add form at the foot, and a rejected
         * save of one existing calendar. The block has always been drawn under
         * the add form's heading, which was right when that was the only way to
         * fail — and became a real fault once a rejected row is echoed back at
         * the top with Save live: the household sees their edits, an enabled
         * Save, and the reason 2,000px further down under the wrong heading,
         * which reads as a save that worked. The echo is what tells the two
         * apart, because it is only ever set by a row's own handler.
         */
        (echo === undefined || error === undefined ? '' : errorHtml) +
        /*
         * The empty state is a claim, so it sits on the branch that can make it.
         *
         * `sources.length === 0` is "this household has added no calendars",
         * which is exactly the sentence — not "the list is loading", not "you
         * have filtered them all out". It used to be the page's `intro`: a grey
         * lead line above an expanse of nothing, with the form it refers to
         * three hundred pixels below it. It is where the rows would be now, and
         * it names the one action, which is that form.
         */
        (sources.length === 0
          ? /*
             * And no action on it, which is `emptyState`'s rule read the way
             * round it is written: *offer the one action*, where there is one
             * to offer. On an empty Calendars page the add form is already on
             * screen a few hundred pixels down — a button here would be a
             * second primary whose whole effect is to scroll, which is the
             * same objection that keeps an "Add a calendar" out of the app
             * bar on this screen and which `admin-saved.test.ts` pins. The
             * sentence names the thing that is missing and points at the form;
             * a control that only moves the viewport is not an action.
             */
            emptyState('No calendars yet. Add the iCal address of one below.')
          : sources
              .map((source) =>
                sourceRow(source, at, people, echo?.sourceId === source.id ? echo : undefined),
              )
              .join('')) +
        haCalendarSection(haCalendars, sources) +
        section(
          'Add a calendar',
          undefined,
          (echo !== undefined || error === undefined ? '' : errorHtml) +
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
            // Owner is offered at add time only when there is someone to pick,
            // so a household with no people never sees a control that does
            // nothing.
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
            networkAccessDisclosure({
              allowPrivateNetwork: values.allowPrivateNetwork === true,
              allowLoopback: values.allowLoopback === true,
              allowHttp: values.allowHttp === true,
              // Only for the add form's own refusal. A rejected row save is
              // echoed at the top of the page and has nothing to do with these
              // controls.
              open: echo === undefined && networkOptions.length > 0,
            }) +
            /*
             * Two buttons, one form — and the emphasis was the wrong way round.
             *
             * Test feed was the filled primary and Add the outlined secondary,
             * so the optional diagnostic was styled as the goal and the goal as
             * optional. Add is the one thing this screen exists to do, so it is
             * the filled button and the only one on the page. Testing first is
             * still the cheap habit worth encouraging, so it keeps the
             * left-hand position — order says "do this first", weight says
             * "this is what you came for", and they are different sentences.
             */
            `<div class="row">` +
            `<button class="secondary" type="submit" name="action" value="test">Test feed</button>` +
            `<button type="submit" name="action" value="save">Add</button>` +
            `</div></form>`,
          // The fragment the empty state's action links to.
          'add',
        ),
    });
  }
}
