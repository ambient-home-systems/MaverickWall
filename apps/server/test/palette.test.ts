import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createKeyring, loadOrCreateMasterKey } from '../src/secrets/keyring.js';
import { addCalendarSource } from '../src/api/sources.js';
import { addHaCalendarSource } from '../src/modules/homeassistant/store.js';
import { createPerson, readPeopleAdmin } from '../src/api/queries.js';
import { IDENTITY_PALETTE } from '../src/api/palette.js';

/**
 * Colour rotation, against a real database.
 *
 * A stub would prove nothing here: the whole rotation is a SELECT over rows the
 * previous insert wrote, so the thing under test is what SQLite actually holds
 * after each call. Every insert below goes through the same function the admin
 * screens and the wizard call — `addCalendarSource`, `addHaCalendarSource`,
 * `createPerson` — rather than through hand-written SQL, because a rotation
 * that works only when the test writes the row is not a fix.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '..', 'migrations');

/**
 * When these calendars were added. Nothing here turns on it.
 *
 * `addCalendarSource` takes the caller's clock rather than reading one, so
 * every call has to say which clock it is — and a colour test's honest answer
 * is "a fixed instant, because this is not about time". Stating it beats a
 * default: a default is how the row's stamp and the page that reads it came to
 * be two different clocks in the first place.
 */
const ADDED_AT = Date.UTC(2026, 7, 13, 11, 0, 0);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function migrated() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-palette-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  return { db, keyring: createKeyring(loadOrCreateMasterKey(dataDir).key) };
}

function colours(db: ReturnType<typeof migrated>['db']): string[] {
  return (
    db.prepare('SELECT color FROM calendar_sources ORDER BY created_at, rowid').all() as {
      color: string;
    }[]
  ).map((row) => row.color);
}

describe('the identity palette', () => {
  it('is five distinct hues', () => {
    expect(new Set(IDENTITY_PALETTE).size).toBe(IDENTITY_PALETTE.length);
    expect(IDENTITY_PALETTE.length).toBe(5);
  });

  it('reuses the display shift hues rather than inventing any', () => {
    // The values are the constraint: these were picked to separate at ten feet
    // on a wall. If somebody swaps one for a nicer-looking hex, this is where
    // they are asked to go and change the display's theme instead.
    for (const hex of ['#4C7FD1', '#E8A33D', '#35916A', '#6B7684']) {
      expect(IDENTITY_PALETTE).toContain(hex);
    }
  });
});

describe('a new calendar source', () => {
  it('gives four calendars four different colours', () => {
    const { db, keyring } = migrated();
    for (const name of ['Work', 'School', 'Bins', 'Football']) {
      const added = addCalendarSource(
        db,
        keyring,
        { name, url: `https://example.com/${name}.ics` },
        ADDED_AT,
      );
      expect(added.ok, JSON.stringify(added)).toBe(true);
    }

    const stored = colours(db);
    expect(stored.length).toBe(4);
    // The reported bug, exactly: three calendars, one colour.
    expect(new Set(stored).size).toBe(4);
  });

  it('counts a Home Assistant calendar as one of them', () => {
    // Two kinds, one wall. A HA entity that took a colour an ICS feed already
    // holds is the same indistinguishable pill, arrived at by another door.
    const { db, keyring } = migrated();
    addCalendarSource(db, keyring, { name: 'Work', url: 'https://example.com/w.ics' }, ADDED_AT);
    addHaCalendarSource(db, { entityId: 'calendar.bins', name: 'Bins' });
    addCalendarSource(db, keyring, { name: 'School', url: 'https://example.com/s.ics' }, ADDED_AT);

    expect(new Set(colours(db)).size).toBe(3);
  });

  it('wraps rather than failing once the palette is exhausted', () => {
    const { db, keyring } = migrated();
    for (let i = 0; i < 7; i++) {
      const added = addCalendarSource(db, keyring, {
        name: `Feed ${i}`,
        url: `https://example.com/${i}.ics`,
      }, ADDED_AT);
      expect(added.ok, `insert ${i}: ${JSON.stringify(added)}`).toBe(true);
    }

    const stored = colours(db);
    expect(stored.length).toBe(7);
    // The seventh exists, is a real palette entry, and is not null or blank.
    const seventh = stored[6];
    expect(seventh).toBeTruthy();
    expect(IDENTITY_PALETTE as readonly string[]).toContain(seventh);
    // The first five are still the five distinct ones; only the wrap repeats.
    expect(new Set(stored.slice(0, 5)).size).toBe(5);
  });

  it("leaves an existing row's colour alone", () => {
    const { db, keyring } = migrated();
    const first = addCalendarSource(
      db,
      keyring,
      { name: 'Work', url: 'https://example.com/w.ics' },
      ADDED_AT,
    );
    expect(first.ok).toBe(true);
    const before = colours(db)[0];

    // A household who recoloured it by hand, which they may still do.
    db.prepare('UPDATE calendar_sources SET color = ? WHERE name = ?').run('#123456', 'Work');
    addCalendarSource(db, keyring, { name: 'School', url: 'https://example.com/s.ics' }, ADDED_AT);

    const kept = (
      db.prepare('SELECT color FROM calendar_sources WHERE name = ?').get('Work') as {
        color: string;
      }
    ).color;
    expect(kept).toBe('#123456');
    expect(kept).not.toBe(before);
  });

  it('skips a hue a household has already taken by hand', () => {
    const { db, keyring } = migrated();
    addCalendarSource(db, keyring, { name: 'Work', url: 'https://example.com/w.ics' }, ADDED_AT);
    // Recoloured to the palette's *second* entry: the next insert must step
    // over it rather than hand out a duplicate.
    db.prepare('UPDATE calendar_sources SET color = ?').run(IDENTITY_PALETTE[1]);

    addCalendarSource(db, keyring, { name: 'School', url: 'https://example.com/s.ics' }, ADDED_AT);
    expect(new Set(colours(db)).size).toBe(2);
  });
});

describe('a new person', () => {
  const names = ['Amy', 'Sam', 'Ella', 'Jo'];

  it('gives four people four different colours', () => {
    const { db } = migrated();
    names.forEach((name, i) => createPerson(db, `p${i}`, name));

    const stored = readPeopleAdmin(db).map((p) => p.color);
    expect(stored.length).toBe(4);
    expect(new Set(stored).size).toBe(4);
  });

  it('wraps rather than failing once the palette is exhausted', () => {
    const { db } = migrated();
    for (let i = 0; i < 7; i++) createPerson(db, `p${i}`, `Person ${i}`);

    const stored = readPeopleAdmin(db).map((p) => p.color);
    expect(stored.length).toBe(7);
    expect(stored[6]).toBeTruthy();
    expect(IDENTITY_PALETTE as readonly string[]).toContain(stored[6]);
    expect(new Set(stored.slice(0, 5)).size).toBe(5);
  });

  it('rotates independently of the calendars', () => {
    // Two calendars then one person: the person still gets the *first* entry.
    // A shared rotation would skip them past two hues for no reason a household
    // could see.
    const { db, keyring } = migrated();
    addCalendarSource(db, keyring, { name: 'Work', url: 'https://example.com/w.ics' }, ADDED_AT);
    addCalendarSource(db, keyring, { name: 'School', url: 'https://example.com/s.ics' }, ADDED_AT);
    createPerson(db, 'p1', 'Amy');

    expect(readPeopleAdmin(db)[0]?.color).toBe(IDENTITY_PALETTE[0]);
  });

  it('matches a stored colour case-insensitively', () => {
    // `<input type="color">` posts lowercase, so the People form's own Add
    // stores `#4c7fd1`. Matched case-sensitively, the next person would be
    // handed the same blue — the bug, surviving the fix.
    const { db } = migrated();
    createPerson(db, 'p1', 'Amy', IDENTITY_PALETTE[0].toLowerCase());
    createPerson(db, 'p2', 'Sam');

    const stored = readPeopleAdmin(db).map((p) => p.color.toUpperCase());
    expect(new Set(stored).size).toBe(2);
  });

  it("leaves an existing person's colour alone", () => {
    const { db } = migrated();
    createPerson(db, 'p1', 'Amy', '#123456');
    createPerson(db, 'p2', 'Sam');

    expect(readPeopleAdmin(db).find((p) => p.id === 'p1')?.color).toBe('#123456');
  });
});
