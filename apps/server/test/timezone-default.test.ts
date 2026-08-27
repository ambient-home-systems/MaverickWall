import { afterAll, afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder, timezoneIsDetected } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { readHousehold } from '../src/api/queries.js';
import { DEFAULT_TIMEZONE } from '../src/timezone.js';

/**
 * One timezone default, in every place that has one.
 *
 * There were three, and they disagreed. The column default was
 * `America/New_York`, the manifest's no-row fallback was `America/New_York`,
 * and the wizard preselected `Etc/UTC` — so a fresh `docker run` logged
 * "scheduler started, timezone America/New_York" at boot and then offered
 * `Etc/UTC` on the one screen whose whole job is choosing that value.
 *
 * Nothing in the product ever looks broken when this is wrong: every all-day
 * event still draws, it just draws on the wrong day. So there is no wall to
 * look at and this has to be pinned from the outside — against the migrations
 * SQLite actually ran, and against the HTML the wizard actually served.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A real database file with the real migrations applied, as a boot does it. */
function migrated(): ReturnType<typeof openDatabase>['db'] {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-tz-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  return db;
}

let nextAddress = 0;

/** The wizard, on a database seeded exactly the way `seedDefaults` seeds it. */
function harness() {
  const address = `10.7.9.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-tz-wizard-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  // `main.ts`'s `seedDefaults`, character for character: no timezone named, so
  // whatever the column default is becomes what the scheduler reports at boot.
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at)
     VALUES ('singleton', ?, ?) ON CONFLICT(id) DO NOTHING`,
  ).run(stamp, stamp);

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'z'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const form = (path: string, fields: Record<string, string>): Promise<Response> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  /** Through step 1, so the next `/setup` is the timezone step. */
  const reachTimezoneStep = async (): Promise<void> => {
    await call(`/setup?token=${setupToken.current().token}`);
    await form('/setup/account', {
      name: 'Household',
      email: 'family@home.local',
      password: 'correct-horse-battery',
      confirm: 'correct-horse-battery',
    });
  };

  return { db, call, form, reachTimezoneStep };
}

/**
 * `process.env.TZ = undefined` stores the *string* `'undefined'`, which is not
 * the same environment the test found and leaks into every later test in this
 * worker. Restore by deleting when it was absent.
 */
const originalTz = process.env['TZ'];
function setTz(value: string | undefined): void {
  if (value === undefined) delete process.env['TZ'];
  else process.env['TZ'] = value;
}
afterEach(() => setTz(originalTz));

/** The zones the rendered `<select>` marks selected. */
function selectedZones(html: string): string[] {
  return [...html.matchAll(/<option value="([^"]*)" selected>/g)].map((m) => m[1] as string);
}

/** The hint paragraph the timezone field renders under its `<select>`. */
function timezoneHint(html: string): string {
  const after = html.slice(html.indexOf('name="timezone"'));
  return /<p class="field-hint">([\s\S]*?)<\/p>/.exec(after)?.[1] ?? '';
}

/** Journal order, so a migration is applied the way the runtime applies it. */
function journalTags(): string[] {
  const raw = readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8');
  const parsed = JSON.parse(raw) as { entries: { idx: number; tag: string }[] };
  return [...parsed.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag);
}

function applyMigration(db: Database.Database, tag: string): void {
  const sql = readFileSync(join(MIGRATIONS, `${tag}.sql`), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed !== '') db.exec(trimmed);
  }
}

describe('the migration that moved the default', () => {
  /*
   * Changing a SQLite column default is a table recreate, which is the one
   * migration shape that has nearly destroyed this project's data before: `0009`
   * listed columns in its `INSERT ... SELECT` that the old table did not have,
   * and SQLite read every one of them as a string literal instead of erroring.
   *
   * `migration-upgrade.test.ts` carries a *calendar* through every migration and
   * would not have seen this one — it seeds no household row. So the guard for
   * this rebuild lives beside the change that needed it, and asserts the whole
   * row rather than the one column, because the risk is in the 32 columns
   * nobody was thinking about.
   */
  const TAG = '0036_quick_arclight';

  it('exists, and is the only file the journal does not know about', () => {
    // The stray `… 2.sql` shape, checked here too because this change adds a file.
    const files = readdirSync(MIGRATIONS)
      .filter((n) => n.endsWith('.sql'))
      .map((n) => n.replace(/\.sql$/, ''));
    expect(files.sort()).toEqual([...journalTags()].sort());
    expect(journalTags()).toContain(TAG);
  });

  it('carries a household that had already chosen a zone through the rebuild', () => {
    const db = new Database(':memory:');
    const tags = journalTags();
    for (const tag of tags) {
      if (tag === TAG) break;
      applyMigration(db, tag);
    }

    const before = db.prepare(`PRAGMA table_info(household_settings)`).all() as {
      name: string;
    }[];

    // A household in use: a chosen zone, and settings all over the table.
    const stamp = 1_700_000_000_000;
    db.prepare(
      `INSERT INTO household_settings
         (id, timezone, locale, theme, daytime_theme, latitude, longitude,
          shift_enabled, weather_provider, display_next_days, week_start,
          setup_completed_at, created_at, updated_at)
       VALUES ('singleton', 'Europe/London', 'en-GB', 'almanac', 'board', 51, 0,
               1, 'openmeteo', 9, 'monday', ?, ?, ?)`,
    ).run(stamp, stamp, stamp);

    applyMigration(db, TAG);

    const row = db
      .prepare(`SELECT * FROM household_settings WHERE id = 'singleton'`)
      .get() as Record<string, unknown>;
    // The whole point: a zone somebody chose is not reset to any default.
    expect(row['timezone']).toBe('Europe/London');
    expect(row).toMatchObject({
      locale: 'en-GB',
      theme: 'almanac',
      daytime_theme: 'board',
      latitude: 51,
      longitude: 0,
      shift_enabled: 1,
      weather_provider: 'openmeteo',
      display_next_days: 9,
      week_start: 'monday',
      setup_completed_at: stamp,
    });

    // No column silently lost or gained by the rebuild. `0009`'s shape was a
    // *name* the old table did not have; a dropped one is the same wound.
    const after = db.prepare(`PRAGMA table_info(household_settings)`).all() as {
      name: string;
    }[];
    expect(after.map((c) => c.name).sort()).toEqual(before.map((c) => c.name).sort());

    // And a row inserted afterwards gets the new default, which is why it ran.
    db.prepare(
      `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('later', ?, ?)`,
    ).run(stamp, stamp);
    expect(
      (db.prepare(`SELECT timezone FROM household_settings WHERE id = 'later'`).get() as {
        timezone: string;
      }).timezone,
    ).toBe(DEFAULT_TIMEZONE);

    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});

describe('one timezone default, in every place that has one', () => {
  it('is what a fresh household row gets out of the real migrations', () => {
    const db = migrated();
    const stamp = Date.now();
    db.prepare(
      `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
    ).run(stamp, stamp);
    const row = db
      .prepare(`SELECT timezone FROM household_settings WHERE id = 'singleton'`)
      .get() as { timezone: string };
    expect(row.timezone).toBe(DEFAULT_TIMEZONE);
  });

  it('is what the manifest falls back to when there is no household row at all', () => {
    // `readHousehold`'s own fallback, on a migrated database with nothing in it.
    expect(readHousehold(migrated()).timezone).toBe(DEFAULT_TIMEZONE);
  });

  it('is the literal `db/schema.ts` declares, which drizzle-kit cannot import', () => {
    /*
     * drizzle-kit transpiles the schema to CJS at generate time and cannot
     * resolve an ESM `.js` specifier out of it, so that one default has to be
     * written twice. Same seam and same answer as `epaper-ladder-parity`: read
     * the file and compare what it actually says.
     */
    const schema = readFileSync(join(HERE, '..', 'src', 'db', 'schema.ts'), 'utf8');
    const declared = /timezone: text\('timezone'\)\.notNull\(\)\.default\('([^']+)'\)/.exec(schema);
    expect(declared?.[1]).toBe(DEFAULT_TIMEZONE);
  });

  it('leaves no second fallback zone hard-coded anywhere that reads one', () => {
    // The three that disagreed, plus the forecast module, which had a fourth.
    for (const file of [
      join('src', 'db', 'schema.ts'),
      join('src', 'api', 'queries.ts'),
      join('src', 'http', 'setup.ts'),
      join('src', 'modules', 'weather', 'index.ts'),
    ]) {
      const source = readFileSync(join(HERE, '..', file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      /*
       * Only as a *default*. `setup.ts` legitimately names the zone inside the
       * short list it offers on a runtime with no `Intl.supportedValuesOf`, and
       * a blanket string match would refuse that — so this matches the three
       * spellings a fallback actually takes: `?? 'x'`, `.default('x')`, and a
       * `timezone: 'x'` field on a defaults object.
       */
      const offenders = [...code.matchAll(/(?:\?\?\s*|\.default\(\s*|:\s*)'America\/New_York'/g)];
      expect(offenders.map((m) => m[0]), `${file} must not hard-code a fallback zone`).toEqual([]);
    }
  });

  it('is what the wizard preselects, so the boot log and step 2 cannot disagree', async () => {
    // Reproduces the report: `docker run` with nothing set anywhere.
    setTz('');
    const h = harness();
    await h.reachTimezoneStep();

    // Exactly the expression `main.ts` prints as "scheduler started, timezone …".
    const bootZone = readHousehold(h.db).timezone;

    const step = await h.call('/setup');
    expect(step.status).toBe(200);
    const html = await step.text();
    const selected = selectedZones(html);
    expect(selected).toHaveLength(1);

    expect(selected[0]).toBe(bootZone);
    expect(bootZone).toBe(DEFAULT_TIMEZONE);
  });

  it('stores exactly the zone the form showed', async () => {
    setTz('');
    const h = harness();
    await h.reachTimezoneStep();
    const shown = selectedZones(await (await h.call('/setup')).text())[0] as string;

    const saved = await h.form('/setup/household', { timezone: shown });
    expect(saved.status).toBe(302);
    const row = h.db
      .prepare(`SELECT timezone FROM household_settings WHERE id = 'singleton'`)
      .get() as { timezone: string };
    expect(row.timezone).toBe(shown);
  });
});

describe('the timezone step does not claim a detection that did not happen', () => {
  it('classifies what a real container resolves, including what a test cannot set', () => {
    /*
     * `process.env.TZ = ''` does not reproduce `docker run`: Node hands ICU an
     * empty zone and resolves `Etc/Unknown`, where a container with `TZ` truly
     * absent resolves `UTC` off `/etc/localtime`. Both are the same answer to
     * the household — nobody said — and only one of them can be reached from
     * inside this process, so the predicate is checked directly.
     */
    expect(timezoneIsDetected('UTC', undefined)).toBe(false); // plain `docker run`
    expect(timezoneIsDetected('Etc/UTC', undefined)).toBe(false);
    expect(timezoneIsDetected('Etc/Unknown', '')).toBe(false); // TZ present, empty
    expect(timezoneIsDetected('Etc/Unknown', 'Mars/Olympus_Mons')).toBe(false); // TZ nonsense
    expect(timezoneIsDetected('UTC', 'UTC')).toBe(true); // somebody said so
    expect(timezoneIsDetected('Europe/London', undefined)).toBe(true); // /etc/localtime
    expect(timezoneIsDetected('Europe/London', 'Europe/London')).toBe(true);
  });

  it('admits it could not tell when nothing in the container sets a zone', async () => {
    setTz('');
    const h = harness();
    await h.reachTimezoneStep();
    const hint = timezoneHint(await (await h.call('/setup')).text());

    // The bug: "Detected: UTC" is the container's own zone reported as a finding
    // about the household, on the setting the step's own copy says puts
    // birthdays on the wrong day.
    expect(hint).not.toContain('Detected');
    expect(hint).toContain('Could not work out where this wall is');
    // And it has to say the box is a placeholder, because something is always
    // selected — a "please choose" over an unexplained value reads as a finding.
    expect(hint).toContain('placeholder');
  });

  it('still reports a real detection when the container has a zone', async () => {
    setTz('Europe/London');
    const h = harness();
    await h.reachTimezoneStep();
    const html = await (await h.call('/setup')).text();

    expect(timezoneHint(html)).toContain('Detected: Europe/London');
    expect(selectedZones(html)).toEqual(['Europe/London']);
  });

  it('believes an explicit TZ of UTC, which is somebody having said so', async () => {
    // The one case the two branches could be got backwards: a household that
    // really is on UTC and configured it. `TZ` present is a statement.
    setTz('UTC');
    const h = harness();
    await h.reachTimezoneStep();
    const hint = timezoneHint(await (await h.call('/setup')).text());
    expect(hint).toContain('Detected: UTC');
  });

  it('keeps the honest wording on the 400 the step answers to a bad zone', async () => {
    setTz('');
    const h = harness();
    await h.reachTimezoneStep();
    const rejected = await h.form('/setup/household', { timezone: 'Mars/Olympus_Mons' });
    expect(rejected.status).toBe(400);
    // The re-render goes through the same detection; a second `serverTimezone()`
    // call site is exactly where a fix like this gets half-applied.
    expect(timezoneHint(await rejected.text())).not.toContain('Detected');
  });
});
