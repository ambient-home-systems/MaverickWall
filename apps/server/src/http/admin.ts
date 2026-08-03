import type { Context, Hono } from 'hono';
import { addCalendarSource } from '../api/sources.js';
import {
  createPerson,
  deletePerson,
  deleteShiftPlan,
  deleteSource,
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
  readWeatherSettings,
  recordUpdateCheck,
  writeWeatherSettings,
  setPersonAvatar,
  setUpdateCheckEnabled,
  readHousehold,
  requestSyncNow,
  revokeScreen,
  writeDisplaySettings,
  rotateScreenToken,
  writeScreenSettings,
  type AdminScreenRow,
  type AdminSourceRow,
  type PersonRecord,
} from '../api/queries.js';
import { randomBytes } from 'node:crypto';
import { issueDisplayToken } from '../auth/tokens.js';
import { encodeQr, qrSvg } from './qr.js';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupTo, databasePath, integrityCheck } from '../db/open.js';
import { bytesOf } from './app.js';
import { buildDiagnostics } from '../api/diagnostics.js';
import { readImage, storeImage } from '../api/media.js';
import { checkForUpdate, isNewer, RELEASE_HOST, RELEASE_URL } from '../api/update-check.js';
import type { LogBuffer } from '../logbuffer.js';
import { parseBlocks } from '../api/manifest.js';
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
import type { Fetcher } from '@maverick-wall/core';
import type { Keyring } from '../secrets/keyring.js';
import type { SqliteDatabase } from '../db/open.js';
import { errorBlock, escapeHtml, page } from './html.js';
import { registerHaRoutes } from './admin-ha.js';
import { registerAlertRoutes } from './admin-alerts.js';
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
  /** Where the database and the key live, for backup and restore. */
  readonly dataDir: string;
  readonly startedAt: number;
  readonly log: LogBuffer;
}

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value.trim() : '';
}

function checked(body: Record<string, unknown>, name: string): boolean {
  return typeof body[name] === 'string';
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
    const value = field(body, `block_${position}`);
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
  return { blocks: chosen.join(',') };
}

const THEMES = [
  { key: 'board', label: 'Board — dark, amber' },
  { key: 'slate', label: 'Kitchen Slate — warm, calm at night' },
  { key: 'almanac', label: 'Paper Almanac — light paper, red' },
  { key: 'glance', label: 'Glance — the whole screen is the status' },
] as const;

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

/** A coordinate, or undefined when it is not one. */
function coordinate(raw: string, limit: number): number | undefined {
  if (!/^-?\d{1,3}(\.\d+)?$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : undefined;
}

function isColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function isHhmm(value: string): boolean {
  return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
}

/** A whole number inside a range, or undefined so the caller can say so. */
function counted(
  body: Record<string, unknown>,
  name: string,
  low: number,
  high: number,
): number | undefined {
  const raw = field(body, name);
  if (!/^[0-9]+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= low && value <= high ? value : undefined;
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

export function registerAdminRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  registerHaRoutes(app, deps);
  registerAlertRoutes(app, deps);

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

  app.get('/admin', (c: Context) => {
    const user = currentUser(c);
    const household = readHousehold(deps.db);
    const sources = readAdminSources(deps.db);
    const screens = readAdminScreens(deps.db).filter((screen) => screen.revokedAt === null);
    const failing = sources.filter((source) => source.lastError !== null).length;

    return c.html(
      page({
        title: 'Maverick Wall',
        heading: 'Maverick Wall',
        intro: `Signed in as ${user.name}.`,
        body:
          `<p>Timezone <strong>${escapeHtml(household.timezone)}</strong>.</p>` +
          `<p><a class="link" href="/admin/calendars">Calendars</a> — ` +
          `${sources.length} configured` +
          (failing === 0 ? '' : `, <strong>${failing} failing</strong>`) +
          `</p>` +
          `<p><a class="link" href="/admin/display">Display</a> — ` +
          `theme, and how much the wall shows</p>` +
          `<p><a class="link" href="/admin/people">People</a> — ` +
          `${readPeopleAdmin(deps.db).length} added</p>` +
          `<p><a class="link" href="/admin/shifts">Shifts</a> — ` +
          `${readShiftPlansAdmin(deps.db).length} rotation` +
          `${readShiftPlansAdmin(deps.db).length === 1 ? '' : 's'}</p>` +
          `<p><a class="link" href="/admin/screens">Screens</a> — ` +
          `${screens.length} paired</p>` +
          `<p><a class="link" href="/admin/system">System</a> — ` +
          `version, backup, diagnostics</p>` +
          `<p><a class="link" href="/admin/home-assistant">Home Assistant</a> — ` +
          `${haSummary()}</p>` +
          `<p><a class="link" href="/admin/alerts">Weather alerts</a> — ` +
          `${alertSummary()}</p>` +

          `<form method="post" action="/admin/sign-out">` +
          `<button class="secondary" type="submit">Sign out</button></form>`,
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
    const name = field(body, 'name');
    const url = field(body, 'url');
    const allowPrivateNetwork = checked(body, 'allow_lan');
    const allowLoopback = checked(body, 'allow_loopback');
    const allowHttp = checked(body, 'allow_http');
    const testOnly = field(body, 'action') === 'test';
    const values = { name, url, allowPrivateNetwork, allowLoopback, allowHttp };

    if (url === '' || (!testOnly && name === '')) {
      return c.html(
        calendarsPage(values, {
          message: testOnly ? 'Enter an address to test.' : 'Enter a name and an address.',
        }),
        400,
      );
    }

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

    const added = addCalendarSource(deps.db, deps.keyring, {
      name,
      url,
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
    const name = field(body, 'name');
    const color = field(body, 'color');
    const personId = field(body, 'person_id');

    if (name === '') return c.html(calendarsPage({}, { message: 'Give the calendar a name.' }), 400);
    if (!isColor(color)) return c.html(calendarsPage({}, { message: 'Pick a colour.' }), 400);

    const people = readPeopleAdmin(deps.db);
    if (personId !== '' && !people.some((person) => person.id === personId)) {
      return c.html(calendarsPage({}, { message: 'That person is no longer there.' }), 400);
    }

    updateSource(deps.db, c.req.param('id') ?? '', {
      name,
      color,
      personId: personId === '' ? null : personId,
      enabled: checked(body, 'enabled'),
      allowPrivateNetwork: checked(body, 'allow_lan'),
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
        title: 'Remove calendar',
        heading: `Remove “${source.name}”?`,
        intro:
          'Its events disappear from the wall immediately. The calendar itself ' +
          'is untouched — this only stops Maverick Wall reading it.',
        body:
          `<form method="post" action="/admin/calendars/${encodeURIComponent(id)}/delete">` +
          `<button type="submit">Remove it</button></form>` +
          `<form method="get" action="/admin/calendars">` +
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
    setUpdateCheckEnabled(deps.db, checked(body, 'update_check_enabled'));
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
    const timezone = field(body, 'timezone');
    if (!supportedTimezones().includes(timezone)) {
      return c.html(systemPage('Choose a timezone from the list.'), 400);
    }
    deps.db
      .prepare(`UPDATE household_settings SET timezone = ?, updated_at = ? WHERE id = 'singleton'`)
      .run(timezone, now());
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
        title: 'Restore staged',
        heading: 'Ready to restore',
        intro:
          'The backup has been checked and put aside. Restart Maverick Wall to ' +
          'apply it — the current database is kept alongside it, so a restore ' +
          'that turns out to be the wrong file is not the end.',
        body:
          `<p>If your calendars come back but show no events, the encryption key ` +
          `does not match this database. Restore the key file too.</p>` +
          `<p><a class="link" href="/admin/system">← Back</a></p>`,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // People
  // -------------------------------------------------------------------------

  app.get('/admin/people', (c: Context) => c.html(peoplePage()));

  app.post('/admin/people', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const name = field(body, 'name');
    const color = field(body, 'color');
    if (name === '') return c.html(peoplePage('Give them a name.'), 400);
    if (!isColor(color)) return c.html(peoplePage('Pick a colour.'), 400);

    createPerson(deps.db, randomBytes(8).toString('hex'), name, color);
    return c.redirect('/admin/people', 302);
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
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const name = field(body, 'name');
    const color = field(body, 'color');
    if (name === '') return c.html(peoplePage('Give them a name.'), 400);
    if (!isColor(color)) return c.html(peoplePage('Pick a colour.'), 400);

    updatePerson(deps.db, c.req.param('id') ?? '', name, color);
    return c.redirect('/admin/people', 302);
  });

  app.get('/admin/people/:id/delete', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const person = readPeopleAdmin(deps.db).find((candidate) => candidate.id === id);
    if (person === undefined) return c.redirect('/admin/people', 302);

    return c.html(
      page({
        title: 'Remove person',
        heading: `Remove ${person.name}?`,
        intro:
          person.sourceCount === 0
            ? 'Their shift rotation goes too.'
            : `Their shift rotation goes too. ${person.sourceCount} calendar` +
              `${person.sourceCount === 1 ? '' : 's'} will stay subscribed but stop being ` +
              'attributed to anyone.',
        body:
          `<form method="post" action="/admin/people/${encodeURIComponent(id)}/delete">` +
          `<button type="submit">Remove them</button></form>` +
          `<form method="get" action="/admin/people">` +
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
    const slots: string[] = [];
    for (let index = 0; index < MAX_CYCLE; index++) slots.push(field(body, `slot_${index}`));

    const titleMap: { title: string; key: string }[] = [];
    for (let index = 0; index < 40; index++) {
      const title = field(body, `title_${index}`);
      if (title === '') continue;
      titleMap.push({ title, key: field(body, `map_${index}`) });
    }

    return {
      personId: field(body, 'person_id'),
      kind: field(body, 'kind') === 'pattern' ? 'pattern' : 'calendar',
      sourceId: field(body, 'source_id'),
      anchorDate: field(body, 'anchor_date'),
      slots,
      titleMap,
    };
  };

  app.get('/admin/shifts', (c: Context) => c.html(shiftsPage()));

  /** Step one: who, and where the answer comes from. */
  app.post('/admin/shifts/new', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const personId = field(body, 'person_id');
    const kind: PlanKind = field(body, 'kind') === 'pattern' ? 'pattern' : 'calendar';
    const sourceId = field(body, 'source_id');

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

  app.get('/admin/screens', (c: Context) => c.html(screensPage()));

  app.post('/admin/screens/:id', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const body = (await c.req.parseBody()) as Record<string, unknown>;

    const name = field(body, 'name');
    if (name === '') return c.html(screensPage('Give the screen a name.'), 400);

    const orientation = field(body, 'orientation');
    if (!['auto', 'portrait', 'landscape'].includes(orientation)) {
      return c.html(screensPage('Choose an orientation from the list.'), 400);
    }

    const rotation = Number(field(body, 'rotation'));
    if (![0, 90, 180, 270].includes(rotation)) {
      return c.html(screensPage('Rotation has to be a quarter turn.'), 400);
    }

    // Empty means "follow the household", which is a real answer rather than
    // a missing one, so it is stored as null instead of rejected.
    const theme = field(body, 'theme');
    if (theme !== '' && !THEMES.some((candidate) => candidate.key === theme)) {
      return c.html(screensPage('Choose a theme from the list.'), 400);
    }
    const daytimeTheme = field(body, 'daytime_theme');
    if (daytimeTheme !== '' && !THEMES.some((candidate) => candidate.key === daytimeTheme)) {
      return c.html(screensPage('Choose a daylight theme from the list.'), 400);
    }

    const startsAt = field(body, 'daytime_starts_at');
    const endsAt = field(body, 'daytime_ends_at');
    const scheduled = daytimeTheme !== '';
    if (scheduled && (!isHhmm(startsAt) || !isHhmm(endsAt))) {
      return c.html(screensPage('Enter this screen’s daylight hours as HH:MM.'), 400);
    }
    if (scheduled && startsAt === endsAt) {
      return c.html(screensPage('A daylight window of no length would never switch.'), 400);
    }

    const timezone = field(body, 'timezone');
    if (timezone !== '' && !supportedTimezones().includes(timezone)) {
      return c.html(screensPage('Choose a timezone from the list.'), 400);
    }

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
      })
    ) {
      return c.html(screensPage('That screen is no longer there.'), 404);
    }
    // The screen picks this up on its next poll, within the minute.
    return c.redirect('/admin/screens', 302);
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
    if (screen === undefined) return c.html(screensPage('That screen is no longer there.'), 404);

    const issued = issueDisplayToken();
    rotateScreenToken(deps.db, id, issued.tokenHash);
    return c.html(pairingPage(screen.name, issued.token, issued.shortCode, c));
  });

  app.post('/admin/screens/:id/revoke', (c: Context) => {
    revokeScreen(deps.db, c.req.param('id') ?? '');
    return c.redirect('/admin/screens', 302);
  });

  // -------------------------------------------------------------------------
  // Display
  // -------------------------------------------------------------------------

  app.get('/admin/display', (c: Context) => c.html(displayPage()));

  /**
   * Weather: the first panel module's own corner of the settings.
   *
   * Beside the block order rather than on its own screen, because the question
   * a household is answering — "do I want this on the wall, and where" — is
   * the same question.
   */
  app.post('/admin/display/weather', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const enabled = checked(body, 'weather_enabled');

    const latitude = coordinate(field(body, 'latitude'), 90);
    const longitude = coordinate(field(body, 'longitude'), 180);
    if (enabled && (latitude === undefined || longitude === undefined)) {
      return c.html(
        displayPage({
          message: 'Weather needs a location.',
          suggestion:
            'Latitude between -90 and 90, longitude between -180 and 180. Your phone’s map app ' +
            'will show both if you press and hold on your house.',
        }),
        400,
      );
    }

    writeWeatherSettings(deps.db, {
      enabled,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
    });
    return c.redirect('/admin/display', 302);
  });

  app.post('/admin/display', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;

    const theme = field(body, 'theme');
    if (!THEMES.some((candidate) => candidate.key === theme)) {
      return c.html(displayPage({ message: 'Choose a theme from the list.' }), 400);
    }

    /*
     * "Same theme all day" is a choice, not a missing value.
     *
     * Stored as null, which is what the manifest reads as "no schedule". A
     * household with one theme should not have to think about a time window
     * that does nothing.
     */
    const daytimeRaw = field(body, 'daytime_theme');
    const scheduled = daytimeRaw !== '' && daytimeRaw !== 'none';
    if (scheduled && !THEMES.some((candidate) => candidate.key === daytimeRaw)) {
      return c.html(displayPage({ message: 'Choose a daylight theme from the list.' }), 400);
    }

    const startsAt = field(body, 'daytime_starts_at');
    const endsAt = field(body, 'daytime_ends_at');
    if (scheduled && (!isHhmm(startsAt) || !isHhmm(endsAt))) {
      return c.html(displayPage({ message: 'Enter the daylight hours as HH:MM.' }), 400);
    }
    if (scheduled && startsAt === endsAt) {
      return c.html(
        displayPage({
          message: 'The daylight hours start and end at the same time.',
          suggestion: 'A window of no length would never switch. Set them apart, or turn the schedule off.',
        }),
        400,
      );
    }

    const order = blockOrder(body, readHousehold(deps.db).displayBlocks);
    if ('error' in order) return c.html(displayPage({ message: order.error }), 400);

    const todayEvents = counted(body, 'today_events', 1, 20);
    const nextDays = counted(body, 'next_days', 0, 14);
    const horizonWeeks = counted(body, 'horizon_weeks', 1, 8);
    if (todayEvents === undefined || nextDays === undefined || horizonWeeks === undefined) {
      return c.html(
        displayPage({
          message: 'Those amounts are outside what the wall can lay out.',
          suggestion:
            'Today takes 1 to 20 events, the week ahead 0 to 14 days, and the month 1 to 8 weeks.',
        }),
        400,
      );
    }

    writeDisplaySettings(deps.db, {
      theme,
      daytimeTheme: scheduled ? daytimeRaw : null,
      daytimeStartsAt: scheduled ? startsAt : null,
      daytimeEndsAt: scheduled ? endsAt : null,
      todayEvents,
      nextDays,
      horizonWeeks,
      blocks: order.blocks,
    });

    // The wall picks this up on its next poll, within the minute.
    return c.redirect('/admin/display', 302);
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
        `<label for="anchor_date">The cycle starts on</label>` +
        `<input id="anchor_date" name="anchor_date" type="date" required ` +
        `value="${escapeHtml(draft.anchorDate)}">` +
        `<p class="hint">A day you know what you were doing. Day 1 below is that day.</p>` +
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
      title: 'Shift rotation — Maverick Wall',
      heading: `${person?.name ?? 'Someone'}'s rotation`,
      intro:
        draft.kind === 'pattern'
          ? 'A repeating pattern. Preview it before saving — four weeks is enough to recognise.'
          : 'Read from a calendar. Preview it before saving — four weeks is enough to recognise.',
      body:
        `<p><a class="link" href="/admin/shifts">← Back</a></p>` +
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
        `<button type="submit" formaction="/admin/shifts/preview">Preview four weeks</button>` +
        `<button class="secondary" type="submit" formaction="/admin/shifts/save">Save</button>` +
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
      `<form method="post" action="/admin/shifts/${encodeURIComponent(plan.id)}/delete">` +
      `<button class="secondary" type="submit">Remove this rotation</button></form>` +
      `</article>`;

    const canAdd = people.length > 0;
    return page({
      title: 'Shifts — Maverick Wall',
      heading: 'Shift rotation',
      intro:
        'The wall colours each day by who is working. A rotation is either read ' +
        'from a calendar that already has the shifts in it, or set as a pattern ' +
        'that repeats.',
      body:
        `<p><a class="link" href="/admin">← Back</a></p>` +
        (error === undefined ? '' : errorBlock(error.message, error.suggestion)) +
        plans.map(card).join('') +
        (canAdd
          ? `<h2 class="add">Add a rotation</h2>` +
            `<form method="post" action="/admin/shifts/new">` +
            `<label for="who">Who</label>` +
            `<select id="who" name="person_id">` +
            people
              .map(
                (candidate) =>
                  `<option value="${escapeHtml(candidate.id)}">${escapeHtml(candidate.name)}</option>`,
              )
              .join('') +
            `</select>` +
            `<label for="kind">Where the shifts come from</label>` +
            `<select id="kind" name="kind">` +
            `<option value="calendar">A calendar that already has them</option>` +
            `<option value="pattern">A pattern that repeats</option>` +
            `</select>` +
            `<label for="src">Which calendar</label>` +
            `<select id="src" name="source_id">` +
            `<option value="">—</option>` +
            sources
              .map(
                (source) =>
                  `<option value="${escapeHtml(source.id)}">${escapeHtml(source.name)}</option>`,
              )
              .join('') +
            `</select>` +
            `<p class="hint">Only needed when the shifts come from a calendar.</p>` +
            `<button type="submit">Continue</button></form>`
          : `<p>Add someone on the <a class="link" href="/admin/people">People</a> screen first — ` +
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
      title: 'System — Maverick Wall',
      heading: 'System',
      body:
        `<p><a class="link" href="/admin">← Back</a></p>` +
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
        `<form method="post" action="/admin/system/timezone">` +
        `<label for="tz">Household timezone</label>` +
        `<select id="tz" name="timezone">` +
        supportedTimezones()
          .map(
            (zone) =>
              `<option value="${escapeHtml(zone)}"` +
              `${zone === household.timezone ? ' selected' : ''}>${escapeHtml(zone)}</option>`,
          )
          .join('') +
        `</select><button type="submit">Save</button></form>` +

        `<h2 class="add">Update check</h2>` +
        updateSection() +

        `<h2 class="add">Backup</h2>` +
        `<p class="hint">Two files, and you need both to restore everything. The ` +
        `database holds your calendars and settings; the key is what decrypts the ` +
        `calendar addresses inside it.</p>` +
        `<div class="row">` +
        `<form method="get" action="/admin/system/backup">` +
        `<button type="submit">Download database</button></form>` +
        `<form method="get" action="/admin/system/key">` +
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
        `<form method="post" action="/admin/system/restore" enctype="multipart/form-data">` +
        `<label for="backup">Backup file</label>` +
        `<input id="backup" name="backup" type="file" required>` +
        `<button type="submit">Stage restore</button></form>` +

        `<h2 class="add">Diagnostics</h2>` +
        `<p class="hint">Safe to attach to a bug report: it carries no calendar ` +
        `addresses, no event titles and no email addresses — only hostnames, ` +
        `counts and the log below.</p>` +
        `<form method="get" action="/admin/system/diagnostics">` +
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

      `<form method="post" action="/admin/system/updates">` +
      `<div class="checks"><label>` +
      `<input type="checkbox" name="update_check_enabled" value="1"` +
      `${state.enabled ? ' checked' : ''}> Check for updates once a day</label></div>` +
      `<p class="hint">Turning this off also forgets anything it had already found.</p>` +
      `<button type="submit">Save</button></form>` +

      status +
      (state.enabled
        ? `<form method="post" action="/admin/system/check-now">` +
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
  function weatherSection(): string {
    const weather = readWeatherSettings(deps.db);
    const value = (n: number | null): string => (n === null ? '' : String(n));

    return (
      `<p class="hint">A five-day forecast strip. Put it where you want it in the ` +
      `list above — it is a block like any other.</p>` +
      `<form method="post" action="/admin/display/weather">` +
      `<div class="checks"><label>` +
      `<input type="checkbox" name="weather_enabled" value="1"` +
      `${weather.enabled ? ' checked' : ''}> Show the forecast</label></div>` +
      `<div class="row-fields">` +
      `<span><label for="latitude">Latitude</label>` +
      `<input id="latitude" name="latitude" type="text" inputmode="decimal" ` +
      `placeholder="38.8894" value="${escapeHtml(value(weather.latitude))}"></span>` +
      `<span><label for="longitude">Longitude</label>` +
      `<input id="longitude" name="longitude" type="text" inputmode="decimal" ` +
      `placeholder="-77.0352" value="${escapeHtml(value(weather.longitude))}"></span>` +
      `</div>` +
      `<p class="hint">Press and hold your house in a phone map app to get both numbers.</p>` +
      errorBlock(
        'The forecast comes from the US National Weather Service.',
        'It covers the United States only. Elsewhere, leave this off — a second ' +
          'provider is the obvious next module.',
      ) +
      `<button type="submit">Save</button></form>`
    );
  }

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

    const card = (person: PersonRecord): string =>
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
      `<form method="post" action="/admin/people/${encodeURIComponent(person.id)}">` +
      `<div class="row-fields">` +
      `<span><label for="name-${person.id}">Name</label>` +
      `<input id="name-${person.id}" name="name" type="text" required ` +
      `value="${escapeHtml(person.name)}"></span>` +
      `<span><label for="colour-${person.id}">Colour</label>` +
      `<input id="colour-${person.id}" name="color" type="color" ` +
      `value="${escapeHtml(person.color)}"></span>` +
      `</div>` +
      `<button type="submit">Save</button></form>` +

      `<form method="post" enctype="multipart/form-data" ` +
      `action="/admin/people/${encodeURIComponent(person.id)}/avatar">` +
      `<label for="avatar-${person.id}">Picture</label>` +
      `<input id="avatar-${person.id}" name="avatar" type="file" ` +
      `accept="image/png,image/jpeg,image/gif,image/webp">` +
      `<p class="hint">PNG, JPEG, GIF or WebP, up to 2 MB. Leave the box empty ` +
      `and save to remove the picture. SVG is not accepted — it can carry code.</p>` +
      `<button class="secondary" type="submit">` +
      `${person.avatarPath === null ? 'Upload' : 'Replace or remove'}</button></form>` +

      `<form method="get" action="/admin/people/${encodeURIComponent(person.id)}/delete">` +
      `<button class="secondary" type="submit">Remove</button></form>` +
      `</article>`;

    return page({
      title: 'People — Maverick Wall',
      heading: 'People',
      intro:
        'Everyone the wall knows about. Their colour marks their events and ' +
        'their shifts, so pick ones that are easy to tell apart from across a room.',
      body:
        `<p><a class="link" href="/admin">← Back</a></p>` +
        (error === undefined ? '' : errorBlock(error, suggestion)) +
        people.map(card).join('') +
        `<h2 class="add">Add someone</h2>` +
        `<form method="post" action="/admin/people">` +
        `<div class="row-fields">` +
        `<span><label for="new-name">Name</label>` +
        `<input id="new-name" name="name" type="text" required placeholder="Sam"></span>` +
        `<span><label for="new-colour">Colour</label>` +
        `<input id="new-colour" name="color" type="color" value="#4C7FD1"></span>` +
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
  function pairingPage(name: string, token: string, shortCode: string, c: Context): string {
    const origin = new URL(c.req.url).origin;
    const url = `${origin}/pair?token=${token}`;
    const matrix = encodeQr(url);

    return page({
      title: 'Pair this screen',
      heading: `Pair ${name}`,
      intro:
        'Open this on the screen itself. It is shown once — if you lose it, ' +
        'generate another, which costs nothing.',
      body:
        (matrix === undefined
          ? errorBlock('That address is too long to put in a QR code.', 'Use the link below.')
          : `<div class="qr">${qrSvg(matrix, 260)}</div>`) +
        `<p class="hint">Or type this address on the screen:</p>` +
        `<p><span class="code">${escapeHtml(url)}</span></p>` +
        `<p class="hint">Pairing code, if the screen asks for one: ` +
        `<span class="code">${escapeHtml(shortCode)}</span></p>` +
        `<p><a class="link" href="/admin/screens">← Back to screens</a></p>`,
    });
  }

  function screenCard(screen: AdminScreenRow, at: number): string {
    const option = (value: string, label: string, selected: boolean): string =>
      `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    const action = `/admin/screens/${encodeURIComponent(screen.id)}`;

    return (
      `<article class="card">` +
      `<h2>${escapeHtml(screen.name)}</h2>` +
      `<p class="host">Last seen ${escapeHtml(ago(screen.lastSeenAt, at))}` +
      (screen.appVersion === null ? '' : ` · ${escapeHtml(screen.appVersion)}`) +
      `</p>` +
      `<form method="post" action="${action}">` +
      `<label for="name-${screen.id}">Name</label>` +
      `<input id="name-${screen.id}" name="name" type="text" required ` +
      `value="${escapeHtml(screen.name)}">` +

      `<div class="row-fields">` +
      `<span><label for="orientation-${screen.id}">Layout</label>` +
      `<select id="orientation-${screen.id}" name="orientation">` +
      option('auto', 'Follow the screen', screen.orientation === 'auto') +
      option('portrait', 'Always portrait', screen.orientation === 'portrait') +
      option('landscape', 'Always landscape', screen.orientation === 'landscape') +
      `</select></span>` +

      `<span><label for="rotation-${screen.id}">Rotation</label>` +
      `<select id="rotation-${screen.id}" name="rotation">` +
      option('0', 'None', screen.rotation === 0) +
      option('90', '90° clockwise', screen.rotation === 90) +
      option('180', 'Upside down', screen.rotation === 180) +
      option('270', '270° clockwise', screen.rotation === 270) +
      `</select></span>` +
      `</div>` +
      `<p class="hint">Rotate when the screen is physically mounted on its side. ` +
      `The layout follows the turned picture, so a rotated widescreen gets the ` +
      `portrait wall.</p>` +

      `<div class="row-fields">` +
      `<span><label for="theme-${screen.id}">Theme</label>` +
      `<select id="theme-${screen.id}" name="theme">` +
      option('', 'Follow the household', screen.theme === null) +
      THEMES.map((theme) => option(theme.key, theme.label, screen.theme === theme.key)).join('') +
      `</select></span>` +
      `<span><label for="night-${screen.id}">During the day</label>` +
      `<select id="night-${screen.id}" name="daytime_theme">` +
      option('', 'Follow the household', screen.daytimeTheme === null) +
      THEMES.map((theme) =>
        option(theme.key, theme.label, screen.daytimeTheme === theme.key),
      ).join('') +
      `</select></span>` +
      `</div>` +

      `<div class="row-fields">` +
      `<span><label for="from-${screen.id}">From</label>` +
      `<input id="from-${screen.id}" name="daytime_starts_at" type="time" ` +
      `value="${escapeHtml(screen.daytimeStartsAt ?? '07:00')}"></span>` +
      `<span><label for="until-${screen.id}">Until</label>` +
      `<input id="until-${screen.id}" name="daytime_ends_at" type="time" ` +
      `value="${escapeHtml(screen.daytimeEndsAt ?? '21:00')}"></span>` +
      `</div>` +
      `<p class="hint">Only used when this screen sets its own daylight theme.</p>` +

      `<label for="tz-${screen.id}">Timezone</label>` +
      `<select id="tz-${screen.id}" name="timezone">` +
      option('', 'Follow the household', screen.timezone === null) +
      supportedTimezones()
        .map((zone) => option(zone, zone, screen.timezone === zone))
        .join('') +
      `</select>` +
      `<p class="hint">Only for a screen somewhere else — a holiday home, say.</p>` +
      `<button type="submit">Save</button></form>` +

      `<div class="row">` +
      `<form method="post" action="${action}/regenerate">` +
      `<button class="secondary" type="submit">Show pairing link</button></form>` +
      `<form method="post" action="${action}/revoke">` +
      `<button class="secondary" type="submit">Unpair</button></form>` +
      `</div>` +
      `<p class="hint">Showing a new pairing link stops the old one working.</p>` +
      `</article>`
    );
  }

  function screensPage(error?: string): string {
    const at = now();
    const all = readAdminScreens(deps.db);
    const active = all.filter((screen) => screen.revokedAt === null);
    const revoked = all.length - active.length;

    return page({
      title: 'Screens — Maverick Wall',
      heading: 'Screens',
      ...(active.length === 0
        ? { intro: 'No screens paired yet. Pair one with the add-screen tool.' }
        : {}),
      body:
        `<p><a class="link" href="/admin">← Back</a></p>` +
        (error === undefined ? '' : errorBlock(error)) +
        active.map((screen) => screenCard(screen, at)).join('') +
        (revoked === 0
          ? ''
          : `<p class="hint">${revoked} unpaired screen${revoked === 1 ? '' : 's'} kept ` +
            `for the record. Their tokens no longer work.</p>`) +
        `<h2 class="add">Pair another</h2>` +
        `<p>Run <span class="code">add-screen "Kitchen"</span> and open the link ` +
        `it prints on the screen itself. An existing screen can be re-paired ` +
        `from its own card above.</p>`,
    });
  }

  /** One dropdown per row, so an order can be set without a drag handle. */
  function blockRows(current: readonly string[]): string {
    return BLOCKS.map((_, index) => {
      const position = index + 1;
      const selected = current[index] ?? 'none';
      const options =
        BLOCKS.map(
          (block) =>
            `<option value="${block.key}"${block.key === selected ? ' selected' : ''}>` +
            `${escapeHtml(block.label)}</option>`,
        ).join('') +
        `<option value="none"${selected === 'none' ? ' selected' : ''}>Nothing</option>`;
      return (
        `<label for="block_${position}">Row ${position}</label>` +
        `<select id="block_${position}" name="block_${position}">${options}</select>`
      );
    }).join('');
  }

  function displayPage(error?: { message: string; suggestion?: string }): string {
    const household = readHousehold(deps.db);
    const scheduled = household.daytimeTheme !== null && household.daytimeTheme !== '';

    const themeOptions = (selected: string, includeNone: boolean): string =>
      (includeNone
        ? `<option value="none"${selected === '' ? ' selected' : ''}>The same theme all day</option>`
        : '') +
      THEMES.map(
        (theme) =>
          `<option value="${escapeHtml(theme.key)}"${theme.key === selected ? ' selected' : ''}>` +
          `${escapeHtml(theme.label)}</option>`,
      ).join('');

    const number = (name: string, label: string, value: number, low: number, high: number, hint: string): string =>
      `<label for="${name}">${escapeHtml(label)}</label>` +
      `<input id="${name}" name="${name}" type="number" required inputmode="numeric" ` +
      `min="${low}" max="${high}" value="${value}">` +
      `<p class="hint">${escapeHtml(hint)}</p>`;

    return page({
      title: 'Display — Maverick Wall',
      heading: 'Display',
      intro: 'The wall picks these up within a minute. No need to touch the screen.',
      body:
        `<p><a class="link" href="/admin">← Back</a></p>` +
        (error === undefined ? '' : errorBlock(error.message, error.suggestion)) +
        `<form method="post" action="/admin/display">` +
        `<label for="theme">Theme</label>` +
        `<select id="theme" name="theme">${themeOptions(household.theme, false)}</select>` +
        `<p class="hint">Board separates the shift colours best from across a room.</p>` +

        `<label for="daytime_theme">During the day</label>` +
        `<select id="daytime_theme" name="daytime_theme">` +
        `${themeOptions(scheduled ? (household.daytimeTheme ?? '') : '', true)}</select>` +
        `<p class="hint">A dark theme at noon is a hole in the wall; a light one at 2am is a lamp.</p>` +

        `<div class="row-fields">` +
        `<span><label for="daytime_starts_at">From</label>` +
        `<input id="daytime_starts_at" name="daytime_starts_at" type="time" ` +
        `value="${escapeHtml(household.daytimeStartsAt ?? '07:00')}"></span>` +
        `<span><label for="daytime_ends_at">Until</label>` +
        `<input id="daytime_ends_at" name="daytime_ends_at" type="time" ` +
        `value="${escapeHtml(household.daytimeEndsAt ?? '21:00')}"></span>` +
        `</div>` +

        `<h2 class="add">What the wall shows</h2>` +
        `<p class="hint">Top to bottom in portrait. In landscape the month takes ` +
        `its own column and the rest stack beside it, in this order.</p>` +
        blockRows(parseBlocks(household.displayBlocks)) +

        `<h2 class="add">Weather</h2>` +
        weatherSection() +

        `<h2 class="add">How much to show</h2>` +
        number('today_events', 'Events listed for today', household.displayTodayEvents, 1, 20,
          'Anything past this is counted rather than listed.') +
        number('next_days', 'Days in the week ahead', household.displayNextDays, 0, 14,
          'Set to 0 to hide the week ahead entirely.') +
        number('horizon_weeks', 'Weeks in the month grid', household.displayHorizonWeeks, 1, 8,
          'The rotation shape. Five covers a month at a glance.') +
        `<button type="submit">Save</button></form>`,
    });
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

      `<form method="post" action="/admin/calendars/${id}/settings">` +
      `<div class="row-fields">` +
      `<span><label for="n-${source.id}">Name</label>` +
      `<input id="n-${source.id}" name="name" type="text" required ` +
      `value="${escapeHtml(source.name)}"></span>` +
      `<span><label for="c-${source.id}">Colour</label>` +
      `<input id="c-${source.id}" name="color" type="color" ` +
      `value="${escapeHtml(source.color)}"></span>` +
      `<span><label for="p-${source.id}">Belongs to</label>` +
      `<select id="p-${source.id}" name="person_id">${personOptions}</select></span>` +
      `</div>` +

      `<div class="checks">` +
      `<label><input type="checkbox" name="enabled" value="1"` +
      `${source.enabled === 1 ? ' checked' : ''}> Sync this calendar</label>` +
      `<label><input type="checkbox" name="allow_lan" value="1"` +
      `${source.allowPrivateNetwork === 1 ? ' checked' : ''}> Allow a local network address</label>` +
      `</div>` +
      // Named as a risk rather than as a feature, because it is one.
      `<p class="hint">Local network access lets this feed reach devices inside your ` +
      `home. Only turn it on for a calendar you host yourself.</p>` +
      `<button type="submit">Save</button></form>` +

      `<div class="row">` +
      `<form method="post" action="/admin/calendars/${id}/sync">` +
      `<button class="secondary" type="submit">Sync now</button></form>` +
      `<form method="get" action="/admin/calendars/${id}/delete">` +
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
      title: 'Calendars — Maverick Wall',
      heading: 'Calendars',
      ...(sources.length === 0
        ? { intro: 'No calendars yet. Add the iCal address of one below.' }
        : {}),
      body:
        `<p><a class="link" href="/admin">← Back</a></p>` +
        sources.map((source) => sourceRow(source, at, people)).join('') +
        `<h2 class="add">Add a calendar</h2>` +
        (error === undefined ? '' : errorBlock(error.message, error.suggestion)) +
        (tested === undefined ? '' : previewPanel(tested)) +
        `<form method="post" action="/admin/calendars">` +
        `<label for="name">Name</label>` +
        `<input id="name" name="name" type="text" required placeholder="Family" value="${escapeHtml(values.name ?? '')}">` +
        `<label for="url">Address</label>` +
        `<input id="url" name="url" type="text" required placeholder="https://…/basic.ics" value="${escapeHtml(values.url ?? '')}">` +
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
