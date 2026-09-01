/**
 * A real installation, a real browser (RFC 009 Phase 0).
 *
 * There is no DOM environment anywhere else in this repository, which leaves
 * `render.ts`, `layout-editor.ts`, `main.ts`, `sw.ts` and the rest — some
 * 6,700 lines — imported by no test at all. That is the region every finding in
 * RFC 009 came from, and `CLAUDE.md`'s own list of sixty-two bugs says the same
 * thing a different way: the sharp ones were found by *looking*, by *measuring
 * the DOM*, by *killing the server*.
 *
 * So this harness does exactly those things and nothing clever:
 *
 *  - a real HTTP server on an ephemeral port, wired the way `main.ts` wires it,
 *    including boot's own seed — not `app.fetch`, because a service worker, a
 *    secure context and a reload are the things under test;
 *  - a real ICS feed on loopback, so the wall draws events somebody wrote
 *    rather than rows somebody inserted;
 *  - a real browser, because every question these five tests ask — does a
 *    reload work with the server dead, how big is that text *after* the
 *    transform, did the drawer open, did the guard fire — is a question jsdom
 *    answers wrongly or not at all;
 *  - and a **kill**, not a mocked network. `CLAUDE.md`: "A refused connection
 *    put the HA address on the wall | Killing the fake outright instead of
 *    returning 502."
 *
 * jsdom is deliberately absent. The RFC's split is "jsdom for structure, focus
 * and tab order; real layout needs Chromium", and applying that split honestly
 * to these five leaves nothing on the jsdom side: service workers, transform
 * scale, CSS sibling selectors, `beforeunload` and pointer drags are all things
 * jsdom either does not implement or implements as a stub that would agree with
 * a broken wall. A jsdom lane is worth adding the day a test needs it.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { DEFAULT_SHIFT_TYPES } from '@maverick-wall/core';
import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { createIcsSyncHandler } from '../src/jobs/ics-sync.js';
import { seedDefaultRules } from '../src/api/rules.js';
import { backfillClassic } from '../src/api/templates.js';
import { readHousehold } from '../src/api/queries.js';
import { householdSetUp } from '../src/modules/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');
const DISPLAY_DIR = join(HERE, '..', '..', 'display', 'dist');

// ---------------------------------------------------------------------------
// The legibility floor
// ---------------------------------------------------------------------------

/**
 * The smallest a word may be drawn on the wall, as a multiple of the wall's own
 * root size.
 *
 * **In rem, never in pixels**, and that is the whole point of the number. The
 * rem *is* the canvas: `orientation.ts` writes `--root-size` as 1% of the
 * canvas height (times 1.5 in landscape, `display.css:1180`), so every declared
 * size in the design is already canvas-relative. A pixel threshold would be
 * right on the screen it was written against and wrong on every other one — and
 * the fault this catches is scale-invariant, which is exactly why it survived:
 * measured on the shipped Classic wall, the agenda draws at the *same*
 * 0.34–0.83rem at 1920x1080 and at 1280x720, which is 6.5px on one and 4.4px on
 * the other.
 *
 * The value is derived from the two judgements this project has already
 * recorded, and it is quoted here rather than imported from either, so that
 * moving one of them has to come past this test rather than dragging it along:
 *
 * | source                        | value       | what it settles                       |
 * |-------------------------------|-------------|---------------------------------------|
 * | `--t-micro` (`display.css:99`)| 1.15rem     | the smallest *declared* size that is still legible at five to ten feet |
 * | `MIN_CHORE_SCALE` (`density.ts`) | 0.62     | the deepest *scale* a section may be drawn at and stay readable across a room |
 *
 * 1.15 x 0.62 = **0.713rem** — the smallest legible type, at the deepest
 * sanctioned scale. Below that is below every judgement this project has made.
 *
 * `--t-micro` has an honest exemption for text whose box is fixed by something
 * other than type (avatar initials at 0.95rem, a month cell's overflow count at
 * 1.05rem, and "the compact widget renderings that fitToBox already scales").
 * The floor above is what *bounds* that exemption, so it is deliberately well
 * under the exemptions themselves: the chore board at its own accepted worst
 * case draws its 2rem names at 1.24rem, still 1.7x clear of this.
 *
 * Measured against the shipped wall, this is a real bar rather than a mirror.
 * Before RFC 009 1.3 the Classic agenda drew its smallest word at 0.31rem —
 * 2.3x under. With `minScaleFor('calendar')` at `MIN_CALENDAR_SCALE` it draws
 * at 0.775rem, which clears this by 9%; at a floor of 0.5 it draws 0.642rem in
 * portrait and would not, which is one of the two things that settled the
 * constant (see its table in `density.ts`).
 */
export const LEGIBILITY_FLOOR_REM = 0.713;

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

let shared: Browser | undefined;

/**
 * One browser for the whole file.
 *
 * Vitest runs each test file in its own worker, so a module-global is one
 * browser per file — and these five live in one file for exactly that reason.
 * The alternative, a browser per test, is five Chromium processes competing
 * with the seventy-nine other test files in this package for a CI box with two
 * cores.
 */
export async function browser(): Promise<Browser> {
  if (shared !== undefined) return shared;

  /*
   * Whatever Chromium this machine already has, in order of how much we know
   * about it. Nothing here downloads a browser: `playwright-core` ships no
   * binaries, and a `playwright install` in CI is a hundred-odd megabytes and a
   * minute of wall clock on a job that currently finishes in under two.
   */
  const args = process.env['CI'] === undefined
    ? []
    // A CI container's default shm is 64MB, which Chromium exhausts, and some
    // runners cannot use the sandbox. Only in CI: a developer's browser keeps
    // both.
    : ['--no-sandbox', '--disable-dev-shm-usage'];

  const explicit = process.env['MW_BROWSER_EXECUTABLE'];
  if (explicit !== undefined && explicit !== '') {
    shared = await chromium.launch({ executablePath: explicit, args });
    return shared;
  }

  const provisioned = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '/opt/pw-browsers';
  if (existsSync(provisioned)) {
    process.env['PLAYWRIGHT_BROWSERS_PATH'] = provisioned;
    const bundled = await chromium.launch({ args }).catch(() => undefined);
    if (bundled !== undefined) {
      shared = bundled;
      return shared;
    }
  }

  for (const channel of ['chromium', 'chrome'] as const) {
    const found = await chromium.launch({ channel, args }).catch(() => undefined);
    if (found !== undefined) {
      shared = found;
      return shared;
    }
  }

  throw new Error(
    'No Chromium to drive. Install Google Chrome, or point MW_BROWSER_EXECUTABLE ' +
      'at a Chromium binary, or set PLAYWRIGHT_BROWSERS_PATH at a provisioned ' +
      'Playwright browser directory. These five tests measure real layout and ' +
      'cannot be answered without one.',
  );
}

/**
 * How long a browser file's `afterAll` gets.
 *
 * Every one of them had the default ten seconds, while its `beforeAll` was
 * given a named `SLOW` running to minutes — so the files declared that
 * *building* a server, a browser and several walls is slow and then gave
 * *tearing the same thing down* no budget at all. Under a full parallel run
 * that is marginal rather than wrong, which is why it surfaced as one suite
 * in five failing with every test in it passing: the tests were finished and
 * the close was not.
 *
 * One constant rather than each file's own `SLOW`, because teardown does not
 * scale with how much a file set up — it closes one browser and one server
 * however many walls were measured through them.
 */
export const TEARDOWN = 60_000;

export async function shutDownBrowser(): Promise<void> {
  await shared?.close();
  shared = undefined;
}

// ---------------------------------------------------------------------------
// A real installation
// ---------------------------------------------------------------------------

/**
 * A fresh client address per installation.
 *
 * The auth rate limiter's counters live in module-global memory and outlive an
 * app and even its database — with one address shared across a file, the fourth
 * harness cannot sign up and every page it then asks for is a bodyless
 * redirect. That reads as almost anything except its cause.
 */
let clientNumber = 0;

export interface InstallOptions {
  /** Run the wizard: account, timezone, and (with `feed`) a calendar. */
  readonly wizard?: boolean;
  /** Serve a real ICS feed on loopback, add it through the wizard, and sync it. */
  readonly feed?: boolean;
  /** The zone the wizard is told. Ignored when `wizard` is false. */
  readonly timezone?: string;
  /**
   * Extra calendars, each served on its own loopback port and added through the
   * admin form the way a household adds one.
   *
   * A household wall is not one feed. The month grid's whole problem is what
   * three of them look like in one 139px cell, and a single ten-event calendar
   * cannot pose that question — so a test that needs a busy month says so here
   * rather than inserting rows behind the sync's back.
   */
  readonly calendars?: readonly NamedFeed[];
}

/** A named calendar to serve and add: a feed somebody in the house owns. */
export interface NamedFeed {
  readonly name: string;
  readonly events: readonly FeedEvent[];
}

/**
 * One event as a feed writes it: a title, a day offset from today, and either a
 * clock pair or nothing at all, which is an all-day event.
 */
export interface FeedEvent {
  readonly title: string;
  readonly day: number;
  /** `HHMM`, or absent for an all-day event. */
  readonly from?: string;
  readonly to?: string;
  /**
   * How many days an all-day event covers. One by default.
   *
   * Written as a *count of days on the wall*, and turned into `DTEND` by
   * adding it to `DTSTART` — because `DTEND` is exclusive and a fixture that
   * spells it out by hand is a fixture that will eventually spell it wrong.
   * The single most common ICS bug does not get to live in the harness that
   * exists to catch it.
   */
  readonly days?: number;
}

export interface Installation {
  readonly base: string;
  readonly db: SqliteDatabase;
  /**
   * The household account — **present only when the wizard ran here.**
   *
   * `wizard: false` hands the wizard to the browser, which creates whatever
   * account the test types; a field naming credentials nobody signed up with
   * would be a sign-in that fails against a harness insisting it is right.
   */
  readonly account: { readonly email: string; readonly password: string } | undefined;
  /** The bootstrap code, for a wizard driven through the browser. */
  readonly setupToken: string;
  call(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, fields: Record<string, string>): Promise<Response>;
  /** A new screen and the pairing link the admin prints for it. */
  pairLink(name?: string): Promise<string>;
  /**
   * The loopback ICS feed's address — **only with `feed: true`**.
   *
   * Exposed so a test can add a *second* and *third* calendar through the real
   * admin form. One household with several feeds is the ordinary case and there
   * was no way to build one here.
   */
  readonly feedUrl: string | undefined;
  /** Run the real sync job over every source, as the scheduler would. */
  sync(): Promise<void>;
  /** Sign this browser in the way a household does: the form, not a cookie. */
  signIn(page: Page): Promise<void>;
  /** A power cut: the port closes and connections are refused, not stubbed. */
  kill(): Promise<void>;
  dispose(): Promise<void>;
}

export async function install(options: InstallOptions = {}): Promise<Installation> {
  const { wizard = true, feed = false, timezone = 'Europe/London', calendars = [] } = options;
  const address = `10.44.0.${(clientNumber++ % 250) + 1}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-browser-'));

  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 2000 });
  seedBoot(db);

  // The zone this installation's wall is set to, so `day: 0` is the day that
  // wall calls today rather than the day the runner's UTC clock does.
  const feedServer = feed ? await startFeed(DEFAULT_FEED, timezone) : undefined;
  const extraFeeds: { readonly name: string; readonly url: string; readonly stop: () => void }[] = [];
  for (const calendar of calendars) {
    const served = await startFeed(calendar.events, timezone);
    extraFeeds.push({ name: calendar.name, url: served.url, stop: served.stop });
  }

  const setupToken = createSetupTokenHolder(() => {});
  const keyring = createKeyring(randomBytes(32));
  const app = createApp({
    db,
    appVersion: '0.0.0-browser-test',
    bootNotices: [],
    auth: { secret: 'p'.repeat(32), baseUrl: 'http://127.0.0.1' },
    keyring,
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
    displayDir: DISPLAY_DIR,
  });

  let server: ServerType | undefined = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  const listening = server;
  // `error` as well as `listening`: a bind that fails emits one and never the
  // other, and a promise that only waits for the good news turns "this box
  // would not give me a port" into a bare sixty-second timeout.
  const port = await new Promise<number>((resolve, reject) => {
    listening.on('listening', () => {
      const bound = listening.address();
      resolve(typeof bound === 'object' && bound !== null ? bound.port : 0);
    });
    listening.on('error', (reason: Error) => reject(new Error(`could not listen: ${reason.message}`)));
  });
  const base = `http://127.0.0.1:${port}`;

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    // Every non-GET is checked against the origin it claims to come from.
    headers.set('origin', base);
    const response = await fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const post = (path: string, fields: Record<string, string>): Promise<Response> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  const account = { email: `family${clientNumber}@home.local`, password: 'correct-horse-battery' };

  try {
    if (wizard) await runWizard();
  } catch (reason) {
    /*
     * Both servers go before the throw.
     *
     * They are listening by here, and `install` is what registers an
     * installation for disposal — so an exception on the way out leaves a
     * bound socket keeping the worker's event loop alive. A refused feed would
     * then be a clear assertion failure *and* a run that never exits.
     */
    await kill();
    feedServer?.stop();
    for (const extra of extraFeeds) extra.stop();
    rmSync(dataDir, { recursive: true, force: true });
    throw reason;
  }

  async function runWizard(): Promise<void> {
    await call(`/setup?token=${setupToken.current().token}`);
    await post('/setup/account', {
      name: 'Household',
      email: account.email,
      password: account.password,
      confirm: account.password,
    });
    await post('/setup/household', { timezone });

    for (const extra of extraFeeds) {
      /*
       * The admin form, not an INSERT: the address goes through the same SSRF
       * guard, the same feed test and the same encrypted write a household's
       * does. A row inserted behind it would be a calendar this server has
       * never actually fetched.
       */
      const stored = await post('/admin/calendars', {
        name: extra.name,
        url: extra.url,
        allow_loopback: '1',
        allow_http: '1',
      });
      if (stored.status !== 302) {
        throw new Error(`the admin refused ${extra.name} (${stored.status}): ${await stored.text()}`);
      }
    }

    if (feedServer === undefined) {
      if (extraFeeds.length > 0) await syncEveryFeed(db, keyring);
      return;
    }
    const added = await post('/setup/calendar', {
      name: 'Family',
      url: feedServer.url,
      allow_loopback: '1',
      allow_http: '1',
    });
    if (added.status !== 302) {
      throw new Error(`the wizard refused the feed (${added.status}): ${await added.text()}`);
    }
    await syncEveryFeed(db, keyring);
  }

  return {
    base,
    db,
    account: wizard ? account : undefined,
    setupToken: setupToken.current().token,
    call,
    post,
    async signIn(page: Page): Promise<void> {
      if (!wizard) {
        throw new Error(
          'this installation ran no wizard, so there is no account to sign in with. ' +
            'Drive the wizard in the browser first, or create it with install({ wizard: true }).',
        );
      }
      await page.goto(`${base}/admin/sign-in`, { waitUntil: 'load' });
      await page.fill('input[name="email"]', account.email);
      await page.fill('input[name="password"]', account.password);
      await Promise.all([
        page.waitForURL((url) => !url.pathname.endsWith('/sign-in'), { timeout: 20_000 }),
        page.click('button[type="submit"]'),
      ]);
    },
    async pairLink(name = 'Kitchen'): Promise<string> {
      const html = await (await post('/admin/screens', { name })).text();
      const link = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
      if (link === undefined) throw new Error('the pairing page printed no link');
      return link;
    },
    feedUrl: feedServer?.url,
    sync: (): Promise<void> => syncEveryFeed(db, keyring),
    kill,
    async dispose(): Promise<void> {
      await kill();
      feedServer?.stop();
      for (const extra of extraFeeds) extra.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };

  async function kill(): Promise<void> {
    const dying = server;
    server = undefined;
    await new Promise<void>((resolve) => {
      if (dying === undefined) return resolve();
      dying.close(() => resolve());
      /*
       * Anything the browser is already holding must go too.
       *
       * `close` stops accepting and then waits for existing sockets, and a
       * browser keeps its keep-alive connection open for minutes — so without
       * this the "power cut" keeps answering requests and the offline test
       * measures a server that is still up. `ServerType` is a union whose
       * Http2 half has no such method; boot only ever makes the http one.
       */
      (dying as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  }
}

/**
 * The rows boot inserts before anything can read them.
 *
 * A copy of `main.ts`'s `seedDefaults`, which is not exported, followed by the
 * two seeds that run beside it. Without them `household_settings` has no row,
 * the wizard's timezone `UPDATE` matches nothing, setup never completes, and
 * every admin page is a redirect back to `/setup` — which is a long way from
 * looking like a missing seed.
 */
function seedBoot(db: SqliteDatabase): void {
  const at = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at)
     VALUES ('singleton', ?, ?) ON CONFLICT(id) DO NOTHING`,
  ).run(at, at);
  const insert = db.prepare(
    `INSERT INTO shift_types (id, key, label, short_code, color_token, is_working, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`,
  );
  DEFAULT_SHIFT_TYPES.forEach((type, index) => {
    insert.run(
      `shift-${type.key}`, type.key, type.label, type.shortCode, type.colorToken,
      type.isWorking ? 1 : 0, index, at, at,
    );
  });
  seedDefaultRules(db);
  backfillClassic(db, householdSetUp(db));
}

/** Run the real sync job over every source, exactly as the scheduler would. */
async function syncEveryFeed(db: SqliteDatabase, keyring: ReturnType<typeof createKeyring>): Promise<void> {
  const handler = createIcsSyncHandler({
    db,
    fetcher: createFetcher(),
    keyring,
    timezone: () => readHousehold(db).timezone,
  });
  const sources = db.prepare('SELECT id FROM calendar_sources').all() as { id: string }[];
  for (const source of sources) {
    const result = await handler({
      kind: 'ics-sync',
      // `sourceIdFromJobKey` reads everything after the first colon, so the
      // key has to carry one — a bare id syncs nothing and says "skipped".
      key: `ics-sync:${source.id}`,
      nextRunAt: Date.now(),
      consecutiveFailures: 0,
    });
    if (result.status !== 'ok') {
      throw new Error(`the feed did not sync: ${JSON.stringify(result)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// A calendar somebody wrote
// ---------------------------------------------------------------------------

/**
 * A week and a bit of an ordinary family's events, served over loopback.
 *
 * Written out as ICS text rather than inserted as rows, so the whole path a
 * household's calendar takes — fetch through the SSRF guard, parse, expand,
 * store, build a manifest, draw — is the path under test. Dated from today so
 * the events land inside the sync and manifest windows wherever this runs.
 */
const DEFAULT_FEED: readonly FeedEvent[] = [
  { title: 'Dentist', day: 1, from: '0900', to: '1000' },
  { title: 'Football practice', day: 1, from: '1730', to: '1900' },
  { title: 'Parents evening', day: 2, from: '1800', to: '2000' },
  { title: 'Bin day', day: 3 },
  { title: 'Swimming lesson', day: 4, from: '0730', to: '0830' },
  { title: 'Book club', day: 5, from: '1930', to: '2130' },
  { title: 'Dad works late', day: 6, from: '1600', to: '2300' },
  { title: 'School trip to the aquarium', day: 7, from: '0830', to: '1600' },
  { title: 'Grandma visiting', day: 9 },
  { title: 'Car service', day: 11, from: '0800', to: '1200' },
];

/**
 * The date `days` from *the wall's* today, as an ICS `YYYYMMDD` stamp.
 *
 * Every fixture in this suite means "today" by `day: 0` — today as the
 * household reads it off the glass, which is a civil date in the household's
 * timezone. This used to read the runner's clock in UTC, and those are two
 * different days for part of every day: at 23:30 UTC in British Summer Time it
 * is already tomorrow in London, so `day: 0` stamped *yesterday's* London date
 * and every fixture in the suite slid one day earlier than the wall's today.
 *
 * That is not a subtle failure. `browser-grid-calendar` seeds today's cell with
 * an all-day Bin day and a Standup and asserts the cell counts two; in that
 * hour the all-day event lands on yesterday, the timed one is still today, and
 * the cell counts one. `browser-classic-proportions` measures the agenda's fit,
 * and an agenda holding a different day's events settles at a different scale —
 * a shift chip at 20.6px against a 22px floor. Both fail every night between
 * 23:00 and 00:00 UTC through British Summer Time, and pass the rest of the
 * day, which reads exactly like a flake and is not one: it is the clock, and it
 * is the same two assertions with the same numbers every time.
 *
 * The arithmetic is civil and deliberately not an instant: today's date *in the
 * zone*, then plus a number of days, on a UTC anchor that has no zone and no
 * daylight saving in it. `Date.now() + days * 86_400_000` is the version that
 * cannot be right — it adds 24 hours, and a day is not always 24 hours.
 *
 * `now` is a parameter so this can be asserted at an instant rather than at
 * whatever o'clock the suite happens to run (see `harness-fixture-dates`).
 */
export function fixtureDate(zone: string, days: number, now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const field = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const shifted = new Date(Date.UTC(field('year'), field('month') - 1, field('day') + days));
  return `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}`;
}

function icsBody(events: readonly FeedEvent[], salt = '', zone = 'Europe/London'): string {
  const stamp = (days: number): string => fixtureDate(zone, days);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Maverick Wall tests//EN'];
  events.forEach(({ title, day, from, to, days }, index) => {
    // Unique per feed as well as per event: two calendars sharing a UID is one
    // calendar as far as any deduplication downstream is concerned.
    lines.push('BEGIN:VEVENT', `UID:e${index}${salt}@browser-test`, `SUMMARY:${title}`);
    if (from === undefined || to === undefined) {
      // DTEND is exclusive: an all-day event covering `days` days ends on the
      // day *after* the last one it is on, so a one-day event on the 15th ends
      // on the 16th and a week-long one starting there ends on the 22nd.
      const span = days !== undefined && days >= 1 ? Math.trunc(days) : 1;
      lines.push(`DTSTART;VALUE=DATE:${stamp(day)}`, `DTEND;VALUE=DATE:${stamp(day + span)}`);
    } else {
      // The household's zone, not a literal: an event written in London time
      // on a wall set to New York is an event at a different hour of a
      // different day, which is a fixture describing a wall nobody has.
      lines.push(
        `DTSTART;TZID=${zone}:${stamp(day)}T${from}00`,
        `DTEND;TZID=${zone}:${stamp(day)}T${to}00`,
      );
    }
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR', '');
  return lines.join('\r\n');
}

let feedNumber = 0;

async function startFeed(
  events: readonly FeedEvent[] = DEFAULT_FEED,
  zone = 'Europe/London',
): Promise<{ url: string; stop: () => void }> {
  const body = icsBody(events, `-f${feedNumber++}`, zone);
  const server: HttpServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const bound = server.address();
  const port = typeof bound === 'object' && bound !== null ? bound.port : 0;
  return { url: `http://127.0.0.1:${port}/family.ics`, stop: (): void => void server.close() };
}

// ---------------------------------------------------------------------------
// A household with something to show
// ---------------------------------------------------------------------------

/**
 * Three calendars an ordinary household has, with the titles people write.
 *
 * Extracted from `browser-classic-proportions.test.ts`, which is where this
 * exact fixture was built and tuned: served over loopback rather than
 * inserted as rows, so the whole path — fetch through the SSRF guard, parse,
 * expand, store, manifest, draw — is what is measured. A single feed cannot
 * pose the question either of the files reusing this asks: legibility and
 * density are set by how much there is to say, and one quiet calendar is the
 * easy case.
 */
export const HOUSEHOLD_CALENDARS: readonly NamedFeed[] = [
  {
    name: 'Family',
    events: [
      { title: 'Bin day', day: 2 },
      { title: 'Bin day', day: 9 },
      { title: "Grandma's 80th birthday", day: 4 },
      { title: 'Dentist', day: 1, from: '0900', to: '1000' },
      { title: 'Car service', day: 11, from: '0800', to: '1200' },
      /*
       * A week, not a day — a half term that lasts one day describes nothing a
       * household has, and the one-day version left this fixture with no
       * multi-day event at all. That mattered the moment the month grid started
       * drawing a multi-day event as one bar across its days: with nothing to
       * span, the density ratchet could not see that rule being removed.
       */
      { title: 'Half term', day: 18, days: 7 },
      { title: 'Swimming lesson', day: 0, from: '0730', to: '0830' },
      { title: 'Book club', day: 5, from: '1930', to: '2130' },
    ],
  },
  {
    name: 'School',
    events: [
      { title: 'Year 6 trip to the Science Museum', day: 3, from: '0830', to: '1600' },
      { title: 'INSET day - school closed', day: 7 },
      { title: 'Parents evening', day: 2, from: '1800', to: '2000' },
      { title: 'Football practice', day: 1, from: '1730', to: '1900' },
      { title: 'School photos', day: 6, from: '0900', to: '1100' },
      { title: 'Assembly', day: 0, from: '0915', to: '1000' },
      { title: 'Cake sale', day: 17, from: '1500', to: '1600' },
    ],
  },
  {
    name: 'Work',
    events: [
      { title: 'Standup', day: 0, from: '0930', to: '0945' },
      { title: 'Standup', day: 1, from: '0930', to: '0945' },
      { title: 'Standup', day: 2, from: '0930', to: '0945' },
      { title: 'Design critique - wall renderer', day: 2, from: '1400', to: '1500' },
      { title: 'Quarterly planning review', day: 8, from: '1000', to: '1200' },
      { title: 'One to one', day: 5, from: '1130', to: '1200' },
    ],
  },
];

/**
 * Give the household a location, a cached forecast and a rota.
 *
 * Without these three the Weather and Shift widgets are dropped from the
 * manifest entirely (`keepWidgetsWithSomethingToSay`), so the wall under test
 * would be a different wall from the one Classic is drawn for — and a
 * household with no rota is precisely the case that hides the faults these
 * measurements exist to catch (the rota chip is often the run that sits
 * lowest in a box, or the last colour a busy month cell has room to paint).
 */
export function equipHousehold(db: SqliteDatabase): void {
  const at = Date.now();
  db.prepare(
    `UPDATE household_settings SET weather_enabled = 1, latitude = ?, longitude = ?,
       weather_provider = 'openmeteo', shift_enabled = 1, updated_at = ? WHERE id = 'singleton'`,
  ).run(51.5074, -0.1278, at);
  const iso = (offset: number): string =>
    new Date(at + offset * 86_400_000).toISOString().slice(0, 10);
  const days = ['Today', 'Tomorrow', 'Wednesday', 'Thursday', 'Friday'].map((name, index) => ({
    name,
    date: iso(index),
    high: 18 - index,
    low: 9 + index,
    unit: 'C',
    summary: ['Sunny', 'Light rain', 'Cloudy', 'Sunny', 'Showers'][index]!,
    icon: '☀',
  }));
  db.prepare(
    `INSERT INTO weather_cache (id, provider, cache_key, payload, fetched_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
  ).run('openmeteoforecast', 'openmeteo', 'openmeteo:forecast', JSON.stringify({ days, fetchedAt: at }), at, null);
  db.prepare(
    `INSERT INTO people (id, name, color, sort_order, has_shift_rotation, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING`,
  ).run('p-amy', 'Amy', '#E8A33D', 0, at, at);
  db.prepare(
    `INSERT INTO shift_plans
       (id, person_id, name, kind, effective_from, priority, anchor_date, cycle, consumes_events, created_at, updated_at)
     VALUES (?, ?, ?, 'pattern', ?, 0, ?, ?, 0, ?, ?) ON CONFLICT(id) DO NOTHING`,
  ).run(
    'plan-amy', 'p-amy', 'Amy rota', iso(-30), iso(-30),
    JSON.stringify(['day', 'day', 'night', 'night', null, null]), at, at,
  );
}

/**
 * Load a paired wall in a fresh browser context at `size`, past the font race.
 *
 * `fitToBox` and `trimCellRows` (`render.ts`) measure once, synchronously, as
 * their section is appended, and nothing re-runs them — so on a cold context
 * whose web fonts have not arrived the wall settles on a fit computed against
 * fallback metrics and keeps it, which measured anywhere from 2 to 13 named
 * month cells across runs of the identical wall. Holding the first manifest
 * back gives the page time to fetch its fonts, and the reload is what proves
 * it: the second load has them in the HTTP cache, which is the steady state a
 * wall that has been hanging for a while is actually in, and it is
 * repeatable. See `browser-font-race.test.ts` for the fault this avoids.
 *
 * Extracted from `browser-classic-proportions.test.ts`'s `measureWallBoxes`,
 * which had this inline — every file measuring a real drawn wall needs the
 * identical settle, so a second copy would be the next place this bug hides.
 * The caller owns disposal via the returned `close`.
 */
export async function loadWallSettled(
  link: string,
  size: { readonly width: number; readonly height: number },
): Promise<{ readonly page: Page; readonly context: BrowserContext; readonly close: () => Promise<void> }> {
  const context = await (await browser()).newContext({ viewport: size });
  const page: Page = await context.newPage();
  let held = false;
  await page.route('**/d/manifest*', async (route) => {
    if (!held) {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    await route.continue();
  });
  await page.goto(link, { waitUntil: 'load' });
  await settleWall(page);
  await page.reload({ waitUntil: 'load' });
  await settleWall(page);
  return { page, context, close: (): Promise<void> => context.close() };
}

// ---------------------------------------------------------------------------
// Measuring what is actually on screen
// ---------------------------------------------------------------------------

export interface TextRun {
  /** The words themselves, so a failure names what a household would read. */
  readonly text: string;
  /** Enough of the element to find it: tag plus classes. */
  readonly where: string;
  /** `font-size` as the cascade resolved it — before any transform. */
  readonly declaredPx: number;
  /** The product of every ancestor transform's scale. */
  readonly scale: number;
  readonly effectivePx: number;
  /** The one that matters: effective size as a multiple of the wall's rem. */
  readonly effectiveRem: number;
}

export interface Overflowing {
  readonly where: string;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Something drawn outside the glass, reported as the rect and the frame it left. */
export interface OutsideViewport {
  readonly where: string;
  readonly rect: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  readonly viewport: { readonly width: number; readonly height: number };
}

/**
 * The canvas measured against the letterbox it is supposed to be.
 *
 * `expected` is `display.css`'s own arithmetic — the largest box of the
 * canvas's aspect that fits the frame — recomputed here from the viewport and
 * the `--aspect` the renderer wrote, so it is a second opinion rather than a
 * reading of the same number twice.
 */
export interface CanvasFit {
  readonly aspect: number;
  readonly actual: { readonly width: number; readonly height: number };
  readonly expected: { readonly width: number; readonly height: number };
}

export interface WallMeasurement {
  readonly remPx: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly overflowing: readonly Overflowing[];
  readonly outsideViewport: readonly OutsideViewport[];
  readonly canvasFit: CanvasFit | undefined;
  readonly runs: readonly TextRun[];
}

/**
 * Every rendered word, with the size it is actually drawn at.
 *
 * The size of a word on this wall is **not** its `font-size`. `fitToBox`
 * (`render.ts`) lays a section out at its box width and then scales the whole
 * thing with a CSS transform, which leaves `font-size` reading exactly what the
 * stylesheet said while the ink on the glass is a quarter of it. Reading
 * `getComputedStyle(...).fontSize` would report 28.8px for text a household
 * cannot see at 7.1px — a measurement that agrees with a broken wall, which is
 * worse than no measurement.
 *
 * So this walks the ancestors of every text node and multiplies out their
 * transforms. `sqrt(|det|)` of the 2-D matrix is the uniform scale factor:
 * `fitToBox` only ever writes `scale(f)`, and a rotation (`orientation.ts`
 * turns the whole canvas a quarter turn) has determinant 1 and correctly counts
 * for nothing.
 */
export async function measureWall(page: Page): Promise<WallMeasurement> {
  return page.evaluate(() => {
    const describe = (element: Element): string =>
      element.tagName.toLowerCase() +
      (element.id === '' ? '' : `#${element.id}`) +
      (String(element.className).trim() === ''
        ? ''
        : `.${String(element.className).trim().split(/\s+/).join('.')}`);

    const scaleOf = (element: Element): number => {
      let scale = 1;
      for (
        let node: Element | null = element;
        node !== null && node !== document.documentElement;
        node = node.parentElement
      ) {
        const transform = getComputedStyle(node).transform;
        if (transform === '' || transform === 'none') continue;
        const numbers = /matrix\(([^)]+)\)/.exec(transform);
        if (numbers === null) continue;
        const [a, b, c, d] = numbers[1]!.split(',').map(Number) as [number, number, number, number];
        const determinant = Math.abs(a * d - b * c);
        if (determinant > 0) scale *= Math.sqrt(determinant);
      }
      return scale;
    };

    /** Whether every clipping ancestor has cut this rect out of view entirely. */
    const clippedAway = (element: Element, rect: DOMRect): boolean => {
      for (
        let node: Element | null = element.parentElement;
        node !== null && node !== document.documentElement;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        if (style.overflow === 'visible' && style.overflowX === 'visible' && style.overflowY === 'visible') {
          continue;
        }
        const frame = node.getBoundingClientRect();
        if (rect.right <= frame.left || rect.left >= frame.right) return true;
        if (rect.bottom <= frame.top || rect.top >= frame.bottom) return true;
      }
      return false;
    };

    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const runs: {
      text: string; where: string; declaredPx: number;
      scale: number; effectivePx: number; effectiveRem: number;
    }[] = [];

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const counted = new Set<Element>();
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.nodeValue ?? '').trim();
      if (text === '') continue;
      const element = node.parentElement;
      if (element === null || counted.has(element)) continue;
      counted.add(element);

      const style = getComputedStyle(element);
      // Not drawn at all is not drawn too small.
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (parseFloat(style.opacity) < 0.05) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      /*
       * And neither is text an ancestor has clipped away.
       *
       * The wall degrades by clipping on purpose: `fitToBox` clamps at
       * `minScaleFor` and lets the box's `overflow: hidden` cut what is left,
       * which is rule nine working. Counting the cut tail would report ink
       * nobody can see and turn a correct degradation into a failure — so a
       * run wholly outside every clipping ancestor is not measured. Partly
       * visible still counts: half a word on the glass is a word on the glass.
       */
      if (clippedAway(element, rect)) continue;

      const declaredPx = parseFloat(style.fontSize);
      const scale = scaleOf(element);
      runs.push({
        text: text.length > 40 ? `${text.slice(0, 39)}…` : text,
        where: describe(element),
        declaredPx,
        scale,
        effectivePx: declaredPx * scale,
        effectiveRem: remPx > 0 ? (declaredPx * scale) / remPx : 0,
      });
    }

    /*
     * Overflow, measured the way this project has learned to measure it:
     * `scrollHeight` against `clientHeight`. `overflow: hidden` means anything
     * past the edge is silently gone, and a month grid missing its last week
     * looks deliberate — so a rect check would see nothing wrong.
     */
    const overflowing: {
      where: string; scrollWidth: number; clientWidth: number;
      scrollHeight: number; clientHeight: number;
    }[] = [];
    const frames = [
      document.documentElement,
      document.getElementById('wall'),
      document.querySelector('#wall .screen'),
      document.querySelector('#wall .canvas'),
    ];
    for (const frame of frames) {
      if (!(frame instanceof HTMLElement)) continue;
      // A pixel of slack: a section a subpixel over its box is a rounding
      // artefact, which is the same tolerance `fitToBox` itself allows.
      if (frame.scrollWidth <= frame.clientWidth + 1 && frame.scrollHeight <= frame.clientHeight + 1) {
        continue;
      }
      overflowing.push({
        where: describe(frame),
        scrollWidth: frame.scrollWidth,
        clientWidth: frame.clientWidth,
        scrollHeight: frame.scrollHeight,
        clientHeight: frame.clientHeight,
      });
    }

    /*
     * And the other half of "nothing overflows the viewport": the canvas is
     * letterboxed into the frame, so its own rect has to be inside the glass.
     * `scrollHeight` cannot see this — a canvas positioned off to one side has
     * no scrollable overflow at all, which is how "the takeover drew in the
     * left half of a television" survived being looked at.
     */
    const outsideViewport: {
      where: string;
      rect: { left: number; top: number; right: number; bottom: number };
      viewport: { width: number; height: number };
    }[] = [];
    const glass = { width: window.innerWidth, height: window.innerHeight };
    for (const frame of [document.getElementById('wall'), document.querySelector('#wall .canvas')]) {
      if (!(frame instanceof HTMLElement)) continue;
      const box = frame.getBoundingClientRect();
      if (box.left >= -1 && box.top >= -1 && box.right <= glass.width + 1 && box.bottom <= glass.height + 1) {
        continue;
      }
      outsideViewport.push({
        where: describe(frame),
        rect: {
          left: Math.round(box.left), top: Math.round(box.top),
          right: Math.round(box.right), bottom: Math.round(box.bottom),
        },
        viewport: glass,
      });
    }

    /*
     * And whether the canvas is the letterbox it claims to be.
     *
     * Inside the glass is not the same as filling it. A canvas squeezed by a
     * padding box is wholly on screen and wholly wrong — measured, a
     * half-applied landscape fix drew 1920x1002 on a 1920x1080 television,
     * with a 42px band of ground above the wall and 36px below, and every rect
     * check above passed it. So the size is compared against the arithmetic
     * `.canvas` is written from: the largest box of this aspect that fits.
     *
     * The frame is the viewport here because nothing rotates in these tests; a
     * quarter turn swaps it, and `orientation.ts` is where that lives.
     */
    let canvasFit: {
      aspect: number;
      actual: { width: number; height: number };
      expected: { width: number; height: number };
    } | undefined;
    const canvas = document.querySelector('#wall .canvas');
    if (canvas instanceof HTMLElement) {
      const aspect = parseFloat(getComputedStyle(canvas).getPropertyValue('--aspect'));
      if (aspect > 0) {
        const box = canvas.getBoundingClientRect();
        canvasFit = {
          aspect,
          actual: { width: box.width, height: box.height },
          expected: {
            width: Math.min(glass.width, glass.height * aspect),
            height: Math.min(glass.height, glass.width / aspect),
          },
        };
      }
    }

    return { remPx, viewport: glass, overflowing, outsideViewport, canvasFit, runs };
  });
}

// ---------------------------------------------------------------------------
// The month grid, cell by cell
// ---------------------------------------------------------------------------

/** One run of text inside a month cell, and whether all of it is on the glass. */
export interface CellText {
  /** The words themselves, so a failure names what a household would read. */
  readonly text: string;
  /** Tag plus classes, enough to find the element again. */
  readonly where: string;
  /** `font-size` as drawn — the cascade's value times every ancestor scale. */
  readonly fontPx: number;
  /**
   * Whether any of it is cut off: an ellipsis, a clipped edge, or a line the
   * element's own box does not have room for.
   *
   * Read from `scrollWidth`/`scrollHeight` against `clientWidth`/`clientHeight`
   * rather than from the presence of `text-overflow`, because a declaration is
   * not a measurement — `.wi-seg`'s ellipsis was inert for months and the
   * markup said otherwise the whole time.
   */
  readonly truncated: boolean;
  /** How much of the string is on the glass, 0–1. The brief's "worst fit". */
  readonly fit: number;
  /**
   * How many lines the words took.
   *
   * The wrap allowance is the difference between "Grandma's 80th birthday" and
   * "+1", so it needs its own number: a grid that had quietly gone back to one
   * line would cut nothing and say much less, which every other measurement
   * here would pass.
   */
  readonly lines: number;
  /** The element's own content width, and the width the string wants. */
  readonly widthPx: number;
  readonly neededPx: number;
  /** How wide this run's own box is, as a fraction of the cell's content. */
  readonly ofCell: number;
  /**
   * How wide the *row* carrying it is, as a fraction of the cell's content.
   *
   * Kept apart from `ofCell` because the two claims are different: the row is
   * the banner, the run inside it is the words. Worth knowing that on its own
   * this distinguishes nothing — every row is a stretched flex item and spans
   * the cell — which is why `markerPx` and `ofCell` are the numbers an all-day
   * claim is actually made against.
   */
  readonly rowOfCell: number;
  /**
   * The width of the colour dot ahead of the words, or 0 where there is none.
   *
   * This is what "an all-day event takes the whole cell" comes down to in
   * pixels: a timed event spends a column on its dot, and an all-day one does
   * not, because it carries its colour as a rule down the row's own edge. A
   * measurement rather than a class, so the assertion fails when the dot comes
   * back rather than when the markup is renamed.
   */
  readonly markerPx: number;
  /** Where the row sits in the viewport, for "all-day events are drawn first". */
  readonly topPx: number;
  /** Whether this run belongs to an all-day event. */
  readonly allDay: boolean;
}

/** One day of the month grid, as drawn. */
export interface MonthCell {
  /** The date number, so a failure can name the day. */
  readonly day: string;
  /** The day's real total, which the renderer stamps from the model. */
  readonly total: number;
  /** The titles actually on the glass. */
  readonly shown: readonly CellText[];
  /** Rows the trim pass hid. */
  readonly hidden: number;
  /** What the overflow counter says: `+3`, or empty when it says nothing. */
  readonly more: string;
  /** The counter as a number, or 0 when there is none. */
  readonly moreCount: number;
  readonly contentWidth: number;
  /**
   * The drawn width of the density mark, in CSS pixels, or 0 where none is on
   * the glass. A width and never a class: the encoding *is* the length, and
   * this project has shipped a control whose class was right and whose pixels
   * were an empty outline.
   */
  readonly markPx: number;
  /** How many of this day's events a span bar is drawing over the cell. */
  readonly spans: number;
  /**
   * Where the cell sits.
   *
   * All four edges, because a span bar is a separate grid item and the only
   * way to check it landed on the right days is to hold its own rectangle
   * against the rectangles of the cells it claims to cover. Reading its
   * `grid-column` instead would be reading back the number the renderer wrote.
   */
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** One multi-day bar, as drawn across the grid. */
export interface MonthSpanBar {
  /**
   * The event, so the pieces of one run can be put back together — a
   * continuation carries no title by design, which is the thing under test,
   * so the title cannot be what attributes it.
   */
  readonly id: string;
  /** The words on it, or empty for a continuation, which carries none. */
  readonly title: string;
  /** Whether it has a title element at all. */
  readonly labelled: boolean;
  /** How many days it covers. */
  readonly days: number;
  readonly leftPx: number;
  readonly rightPx: number;
  readonly topPx: number;
  readonly bottomPx: number;
  /** The cells it covers, as ordinals into `cells`. */
  readonly cover: readonly number[];
}

export interface MonthGrid {
  readonly remPx: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly cells: readonly MonthCell[];
  /** Every text run inside the grid, cells and furniture alike. */
  readonly texts: readonly CellText[];
  /** Every multi-day bar on the glass. */
  readonly spans: readonly MonthSpanBar[];
  /**
   * Only the event names, across every cell.
   *
   * Kept apart from `texts` because the two questions are different. The type
   * floor is a claim about *everything* in the grid — a weekday header nobody
   * can read is as absent as a title. Clipping is a claim about the *titles*,
   * because they are the only runs whose whole meaning is the string: a day
   * number cannot be truncated and a "+3" is already a summary.
   */
  readonly titles: readonly CellText[];
}

/**
 * The month grid as a household sees it: every cell, every title, and how much
 * of each title is actually on the glass.
 *
 * This is the measurement the brief is written from, and it exists because the
 * two obvious readings are both wrong. Counting `.hz-row` elements reports rows
 * the trim pass has hidden; reading `font-size` reports the size the stylesheet
 * asked for rather than the size drawn. Neither notices that "Year 6 trip to
 * the Science Museum" and "Year 6 sports day" are the same five characters on
 * the wall.
 */
export async function measureMonthGrid(page: Page): Promise<MonthGrid> {
  return page.evaluate(() => {
    const describe = (element: Element): string =>
      element.tagName.toLowerCase() +
      (String(element.className).trim() === ''
        ? ''
        : `.${String(element.className).trim().split(/\s+/).join('.')}`);

    const scaleOf = (element: Element): number => {
      let scale = 1;
      for (
        let node: Element | null = element;
        node !== null && node !== document.documentElement;
        node = node.parentElement
      ) {
        const transform = getComputedStyle(node).transform;
        if (transform === '' || transform === 'none') continue;
        const numbers = /matrix\(([^)]+)\)/.exec(transform);
        if (numbers === null) continue;
        const [a, b, c, d] = numbers[1]!.split(',').map(Number) as [number, number, number, number];
        const determinant = Math.abs(a * d - b * c);
        if (determinant > 0) scale *= Math.sqrt(determinant);
      }
      return scale;
    };

    const grid = document.querySelector('#wall .horizon, #wall .sky');

    /**
     * The cell's *content* width — what a row actually has to lay out in.
     *
     * `clientWidth` is the padding box, so measuring against it reports a row
     * that fills the cell completely as 0.86 of it, which reads as a bug in the
     * row rather than as padding on the cell.
     */
    const contentWidthOf = (cell: Element | null): number => {
      if (!(cell instanceof HTMLElement)) return 0;
      const style = getComputedStyle(cell);
      return cell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    };

    const runFor = (
      element: HTMLElement,
      cellWidth: number,
      row?: HTMLElement,
    ): {
      text: string; where: string; fontPx: number; truncated: boolean;
      fit: number; lines: number; widthPx: number; neededPx: number; ofCell: number;
      rowOfCell: number; markerPx: number; topPx: number; allDay: boolean;
    } => {
      const style = getComputedStyle(element);
      const scale = scaleOf(element);
      /*
       * A pixel of slack across, half a line down.
       *
       * Across is straightforward: `scrollWidth` past `clientWidth` is an
       * ellipsis or a clipped edge, and a pixel covers sub-pixel rounding.
       *
       * Down is the trap this project has already paid for. A block whose
       * `line-height` is under 1 — `.hz-num` is `line-height: 1`, and the
       * font's own ascent and descent are taller than that — reports a
       * `scrollHeight` past its `clientHeight` by the leading alone, with
       * nothing hidden at all. Measured, that flagged all 35 day numbers as
       * truncated. Text can only actually be lost a *line* at a time, so half
       * a line is the bar: negative leading never reaches it and a dropped
       * line always does.
       */
      const lineHeight = parseFloat(style.lineHeight);
      const slack = Number.isFinite(lineHeight) ? Math.max(1, lineHeight / 2) : 1;
      const overWide = element.scrollWidth > element.clientWidth + 1;
      const overTall = element.scrollHeight > element.clientHeight + slack;
      const needed = Math.max(element.scrollWidth, element.clientWidth);
      const rect = element.getBoundingClientRect();
      return {
        text: (element.textContent ?? '').trim(),
        where: describe(element),
        fontPx: parseFloat(style.fontSize) * scale,
        truncated: overWide || overTall,
        fit: needed > 0 ? Math.min(1, element.clientWidth / needed) : 1,
        lines:
          Number.isFinite(lineHeight) && lineHeight > 0
            ? Math.max(1, Math.round(element.scrollHeight / lineHeight))
            : 1,
        widthPx: element.clientWidth,
        neededPx: needed,
        ofCell: cellWidth > 0 ? rect.width / cellWidth : 0,
        rowOfCell:
          row !== undefined && cellWidth > 0 ? row.getBoundingClientRect().width / cellWidth : 0,
        markerPx: row?.querySelector('.hz-rowdot')?.getBoundingClientRect().width ?? 0,
        topPx: (row ?? element).getBoundingClientRect().top,
        allDay: element.closest('.allday') !== null || element.classList.contains('allday'),
      };
    };

    const cells: {
      day: string; total: number; shown: ReturnType<typeof runFor>[];
      hidden: number; more: string; moreCount: number; contentWidth: number;
      markPx: number; spans: number; top: number; bottom: number;
      left: number; right: number;
    }[] = [];
    const texts: ReturnType<typeof runFor>[] = [];
    const spans: {
      id: string; title: string; labelled: boolean; days: number;
      leftPx: number; rightPx: number; topPx: number; bottomPx: number;
      cover: number[];
    }[] = [];

    if (grid !== null) {
      // Every text node in the grid, furniture included: the floor is a claim
      // about the whole grid, not only about the titles.
      const walker = document.createTreeWalker(grid, NodeFilter.SHOW_TEXT);
      const counted = new Set<Element>();
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if ((node.nodeValue ?? '').trim() === '') continue;
        const element = node.parentElement;
        if (element === null || counted.has(element)) continue;
        counted.add(element);
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        texts.push(runFor(element, contentWidthOf(element.closest('.hz-cell, .sk-cell'))));
      }

      for (const cell of grid.querySelectorAll('.hz-cell, .sk-cell')) {
        if (!(cell instanceof HTMLElement)) continue;
        const titles: ReturnType<typeof runFor>[] = [];
        let hidden = 0;
        // Every treatment's title element: a flat row, a pill, a sky bar.
        for (const row of cell.querySelectorAll('.hz-row, .hz-pill, .sk-ev, .sk-bar')) {
          if (!(row instanceof HTMLElement)) continue;
          if (row.classList.contains('hz-pill-more')) continue;
          if (getComputedStyle(row).display === 'none') {
            hidden++;
            continue;
          }
          // The text element inside a flat row; the row itself otherwise. The
          // row's own width travels with it, because "an all-day event takes
          // the whole cell" is a claim about the row and "its title gets more
          // of the cell" is a claim about the text — two different numbers.
          const inner = row.querySelector('.hz-rowtext');
          titles.push(runFor(inner instanceof HTMLElement ? inner : row, contentWidthOf(cell), row));
        }
        /*
         * The counter, wherever it ended up.
         *
         * `trimCellRows` moves it *into* the last row it counts for, so a
         * search rooted at the cell is the only one that finds it either way —
         * and "is it visible" has to be asked of the element rather than of
         * the cell, because an empty one is `display:none` by stylesheet.
         */
        const counter = cell.querySelector('.hz-more, .hz-pill-more, .sk-more');
        const more =
          counter instanceof HTMLElement && getComputedStyle(counter).display !== 'none'
            ? (counter.textContent ?? '').trim()
            : '';
        const number = cell.querySelector('.hz-num, .sk-mnum');
        /*
         * The density mark, measured rather than counted.
         *
         * Its *width* is the encoding, so a test that read the class would
         * pass on a mark of no length — this project has already shipped a
         * chore tick whose class was right and whose pixels were an empty
         * outline. `getBoundingClientRect` is through the widget's scale
         * transform, which is what a household actually sees.
         */
        const markNode = cell.querySelector('.hz-mark');
        const markVisible =
          markNode instanceof HTMLElement && getComputedStyle(markNode).display !== 'none';
        cells.push({
          day: (number?.textContent ?? '').trim(),
          total: Number(cell.getAttribute('data-count') ?? '0'),
          shown: titles,
          hidden,
          more,
          moreCount: /^\+(\d+)$/.test(more) ? Number(/^\+(\d+)$/.exec(more)![1]) : 0,
          contentWidth: contentWidthOf(cell),
          markPx:
            markVisible && markNode instanceof HTMLElement
              ? markNode.getBoundingClientRect().width
              : 0,
          spans: 0,
          top: cell.getBoundingClientRect().top,
          bottom: cell.getBoundingClientRect().bottom,
          left: cell.getBoundingClientRect().left,
          right: cell.getBoundingClientRect().right,
        });
      }

      /*
       * The span bars, which are grid items rather than children of a cell.
       *
       * `data-cover` is the renderer's own list of the cells a bar crosses, so
       * this reads which days are covered from the same place the trim does,
       * instead of re-deriving it from geometry and agreeing with itself.
       */
      const byIndex = new Map<string, number>();
      let index = 0;
      for (const cell of grid.querySelectorAll('.hz-cell')) {
        byIndex.set(cell.getAttribute('data-cell') ?? `x${index}`, index);
        index++;
      }
      for (const bar of grid.querySelectorAll('.hz-span')) {
        if (!(bar instanceof HTMLElement)) continue;
        if (getComputedStyle(bar).display === 'none') continue;
        const text = bar.querySelector('.hz-spantext');
        const rect = bar.getBoundingClientRect();
        const cover = (bar.getAttribute('data-cover') ?? '')
          .split(' ')
          .filter((one) => one !== '');
        for (const key of cover) {
          const at = byIndex.get(key);
          const entry = at !== undefined ? cells[at] : undefined;
          if (entry !== undefined) entry.spans += 1;
        }
        spans.push({
          id: bar.getAttribute('data-span') ?? '',
          title: (text?.textContent ?? '').trim(),
          labelled: text !== null,
          days: cover.length,
          leftPx: rect.left,
          rightPx: rect.right,
          topPx: rect.top,
          bottomPx: rect.bottom,
          cover: cover.map((key) => byIndex.get(key) ?? -1),
        });
      }
    }

    return {
      remPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      cells,
      texts,
      spans,
      titles: cells.flatMap((cell) => cell.shown),
    };
  });
}

/**
 * Wait until the wall has drawn and stopped moving.
 *
 * The fonts matter: `fitToBox` measures once, synchronously, as the section is
 * appended, so a fit computed against fallback metrics would be a different
 * number from the one a household sees. In practice the waiting screen
 * (`renderMessage`, drawn before the first request is even sent) has already
 * asked for them by the time a manifest arrives — but waiting for
 * `document.fonts.ready` is what makes that true on a slow box rather than
 * true by luck.
 */
export async function settleWall(page: Page, timeout = 20_000): Promise<void> {
  await page.waitForSelector('#wall .canvas', { timeout });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(250);
}

/**
 * What the service worker has actually stored, whichever cache it is using.
 *
 * Enumerated rather than named. `sw.ts` documents bumping `CACHE` as the way to
 * retire an old one, and `caches.open('…-v1')` *creates* a cache that is not
 * there — so a hard-coded name would survive the next bump by silently reading
 * an empty cache nothing writes, and the failure message for the offline test
 * would lose the eleven-versus-fifteen entry count that is its whole diagnosis.
 */
export async function shellCache(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const paths: string[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) paths.push(new URL(request.url).pathname);
    }
    return paths.sort();
  });
}

/** A rect, rounded, in the shape a failure message can print. */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * What is on the wall at all: enough to tell a drawn calendar from a black
 * screen, and enough to tell a banner *beside* the wall from one *across* it.
 */
export async function wallState(page: Page): Promise<{
  readonly children: number;
  readonly canvases: number;
  readonly widgets: number;
  readonly text: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly canvas: Rect | undefined;
  readonly banner: Rect | undefined;
}> {
  return page.evaluate(() => {
    const round = (value: number): number => Math.round(value);
    const rectOf = (selector: string): Rect | undefined => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return undefined;
      const box = element.getBoundingClientRect();
      return {
        left: round(box.left), top: round(box.top),
        right: round(box.right), bottom: round(box.bottom),
      };
    };
    const wall = document.getElementById('wall');
    return {
      children: wall?.childElementCount ?? 0,
      canvases: document.querySelectorAll('#wall .canvas').length,
      widgets: document.querySelectorAll('#wall .canvas > .fw').length,
      text: (wall?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      canvas: rectOf('#wall .canvas'),
      banner: rectOf('#wall .banners'),
    };
  });
}

/** One stack of days — an agenda or a chore week — and where its days ended up. */
export interface DayStack {
  /** The widget box, as `describe` names it: `div.fw.fw-calendar`. */
  readonly where: string;
  /** The box's content bottom — its own bottom, less its padding. */
  readonly contentBottom: number;
  /** Every day the wall drew, in order, top and bottom. */
  readonly days: readonly { readonly top: number; readonly bottom: number }[];
}

/**
 * Every stack of days on the wall, measured against the box that clips it.
 *
 * `fitAndTrimToDays` (`render.ts`) is the second half of RFC 009 1.3: a section
 * too tall for its box gives up whole days from the bottom and fits again,
 * rather than being scaled until it fits or clipped wherever the pixel falls.
 * Which of those happened is not visible in the text sizes — a row sliced
 * across the middle is drawn at exactly the same size as one that fits — so it
 * needs its own measurement, and the measurement is the *boundary*: does the
 * cut land between two days or through one.
 *
 * Reported rather than judged, so a failure can print where the cut fell.
 */
export async function measureDayStacks(page: Page): Promise<readonly DayStack[]> {
  return page.evaluate(() => {
    const stacks: {
      where: string;
      contentBottom: number;
      days: { top: number; bottom: number }[];
    }[] = [];
    for (const box of document.querySelectorAll('#wall .canvas > .fw')) {
      if (!(box instanceof HTMLElement)) continue;
      const week = box.querySelector('.ch-week');
      const agenda = box.querySelector('section.next');
      const stack = week ?? agenda;
      if (stack === null) continue;
      const rows = stack.querySelectorAll(week !== null ? '.ch-day' : '.day-row');
      const frame = box.getBoundingClientRect();
      stacks.push({
        where:
          box.tagName.toLowerCase() +
          `.${String(box.className).trim().split(/\s+/).join('.')}`,
        contentBottom: frame.bottom - parseFloat(getComputedStyle(box).paddingBottom || '0'),
        /*
         * The days actually drawn, which is what `dayGroups` trims and what a
         * household can see. `display.css` hides `.day-row:nth-child(n + 6)`
         * on a short landscape screen; those rows are in the DOM with a zero
         * rect, and counting them would report a stack of days at the top-left
         * corner of the viewport that nobody is looking at.
         */
        days: [...rows]
          .map((row) => row.getBoundingClientRect())
          .filter((rect) => rect.height > 0)
          .map((rect) => ({ top: rect.top, bottom: rect.bottom })),
      });
    }
    return stacks;
  });
}

/**
 * What the wall drew, and what it left bare (RFC 009 Phase 2).
 *
 * Two questions the size measurements cannot answer. Which widgets are on the
 * glass at all — because Phase 2 makes a widget the household has nothing set
 * up for *absent* rather than a sentence saying so, and "absent" is only
 * correct if the rest are still there. And how much of the canvas is left with
 * nothing on it, because yielding space is only an improvement if the space is
 * not then a hole.
 *
 * `notes` is deliberately the two "nothing yet" notes and not the third. A
 * `.cd-empty` — "Add a note in this widget's options" — is a prompt naming a
 * control one click away and is allowed to stay; `.fw-empty` and
 * `.canvas-empty` are the ones that can only ever say nothing.
 */
export interface CanvasInk {
  readonly canvas: Rect;
  /** Widget boxes as drawn, in canvas coordinates. */
  readonly boxes: readonly Rect[];
  /** The widget types on the glass, e.g. `clock`, `calendar`. */
  readonly drawn: readonly string[];
  readonly notes: readonly { readonly where: string; readonly text: string }[];
}

export async function measureCanvasInk(page: Page): Promise<CanvasInk | undefined> {
  return page.evaluate(() => {
    const canvas = document.querySelector('#wall .canvas');
    if (!(canvas instanceof HTMLElement)) return undefined;
    const frame = canvas.getBoundingClientRect();
    const relative = (box: DOMRect): Rect => ({
      left: Math.round(box.left - frame.left),
      top: Math.round(box.top - frame.top),
      right: Math.round(box.right - frame.left),
      bottom: Math.round(box.bottom - frame.top),
    });
    const boxes: Rect[] = [];
    const drawn: string[] = [];
    for (const box of canvas.querySelectorAll(':scope > .fw')) {
      if (!(box instanceof HTMLElement)) continue;
      const rect = box.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      boxes.push(relative(rect));
      const type = [...box.classList].find((name) => name.startsWith('fw-') && name !== 'fw-fill');
      drawn.push(type === undefined ? 'unknown' : type.slice(3));
    }
    const notes: { where: string; text: string }[] = [];
    for (const note of document.querySelectorAll('#wall .fw-empty, #wall .canvas-empty')) {
      const parent = note.parentElement;
      notes.push({
        where:
          parent === null
            ? 'unknown'
            : parent.tagName.toLowerCase() +
              (String(parent.className).trim() === ''
                ? ''
                : `.${String(parent.className).trim().split(/\s+/).join('.')}`),
        text: (note.textContent ?? '').trim(),
      });
    }
    return {
      canvas: { left: 0, top: 0, right: Math.round(frame.width), bottom: Math.round(frame.height) },
      boxes,
      drawn,
      notes,
    };
  });
}

/**
 * The largest rectangle inside the canvas that no widget box covers, as a
 * fraction of the canvas.
 *
 * Measured against the *boxes*, not the words in them. A widget box is where a
 * household's eye goes — it carries the card ground, the padding and whatever
 * the renderer chose to fill it with — so treating one as inked is the generous
 * reading and the right one: measuring text rects instead would report the
 * gutter between two agenda rows as a hole in the wall.
 *
 * Computed here rather than in the page, and by enumeration rather than
 * cleverly: every candidate edge is a box edge or a canvas edge, so with a
 * handful of widgets the exhaustive answer is exact and instant. An
 * approximation would be the wrong trade in a check whose whole job is to be
 * believed.
 */
export function largestBareRegion(ink: CanvasInk): { rect: Rect; fraction: number } {
  const width = ink.canvas.right;
  const height = ink.canvas.bottom;
  const area = width * height;
  const xs = [...new Set([0, width, ...ink.boxes.flatMap((b) => [b.left, b.right])])]
    .filter((x) => x >= 0 && x <= width)
    .sort((a, b) => a - b);
  const ys = [...new Set([0, height, ...ink.boxes.flatMap((b) => [b.top, b.bottom])])]
    .filter((y) => y >= 0 && y <= height)
    .sort((a, b) => a - b);

  let best = { rect: { left: 0, top: 0, right: 0, bottom: 0 }, fraction: 0 };
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      for (let k = 0; k < ys.length - 1; k++) {
        for (let l = k + 1; l < ys.length; l++) {
          const rect = { left: xs[i]!, right: xs[j]!, top: ys[k]!, bottom: ys[l]! };
          const size = (rect.right - rect.left) * (rect.bottom - rect.top);
          if (area === 0 || size / area <= best.fraction) continue;
          const covered = ink.boxes.some(
            (box) =>
              box.left < rect.right &&
              box.right > rect.left &&
              box.top < rect.bottom &&
              box.bottom > rect.top,
          );
          if (!covered) best = { rect, fraction: size / area };
        }
      }
    }
  }
  return best;
}

/**
 * How much of the canvas a household's eye actually lands on: the union of
 * every widget box, as a fraction of the canvas.
 *
 * The complement of `largestBareRegion` in spirit and the same exhaustive
 * technique, because "the largest hole" and "how much is not a hole" are
 * different questions — a canvas can have no single large bare region and
 * still be mostly empty, spread thin across many small gaps.
 */
export function coveredFraction(ink: CanvasInk): number {
  const width = ink.canvas.right;
  const height = ink.canvas.bottom;
  const area = width * height;
  if (area <= 0) return 0;
  const xs = [...new Set([0, width, ...ink.boxes.flatMap((b) => [b.left, b.right])])]
    .filter((x) => x >= 0 && x <= width)
    .sort((a, b) => a - b);
  const ys = [...new Set([0, height, ...ink.boxes.flatMap((b) => [b.top, b.bottom])])]
    .filter((y) => y >= 0 && y <= height)
    .sort((a, b) => a - b);

  let covered = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    for (let k = 0; k < ys.length - 1; k++) {
      const rect = { left: xs[i]!, right: xs[i + 1]!, top: ys[k]!, bottom: ys[k + 1]! };
      const size = (rect.right - rect.left) * (rect.bottom - rect.top);
      const isCovered = ink.boxes.some(
        (box) => box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top,
      );
      if (isCovered) covered += size;
    }
  }
  return covered / area;
}
