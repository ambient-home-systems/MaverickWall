import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';

/**
 * One rule for every list row the household orders.
 *
 * People, Chores and Shift types each drew their reorder as one or two
 * buttons in the row's own footer — the rarest thing anybody does to a row as
 * its most visible control — while Edit sat behind a disclosure and Remove
 * behind the ⋮. Chores had three visible buttons per row. Shift types went one
 * worse and rendered every type as an open form with its own Save: 2,657px on
 * a desktop for three names, three codes and three colours, the exact fault
 * the chores screen had already fixed.
 *
 * The rule now: the name, one status line, the Edit disclosure, at most one
 * visible action that is the row's own job (Sync now, Pause), and everything
 * else — reorder included — in the ⋮ above the rule that separates it from
 * Remove. Asserted on the markup a household receives, per screen.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let clientNumber = 0;
const nextClientAddress = (): string => `10.29.29.${++clientNumber}`;

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-rows-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const address = nextClientAddress();
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'n'.repeat(32), baseUrl: 'http://localhost' },
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

  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household', email: 'family@home.local',
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  expect((await call('/admin')).status, 'the harness must reach a signed-in /admin').toBe(200);

  const text = async (path: string): Promise<string> => (await call(path)).text();
  return { db, form, text };
}

/** Each `<article class="card…">…</article>` on a page, as its markup. */
function cards(html: string): string[] {
  return [...html.matchAll(/<article class="card[^"]*">[\s\S]*?<\/article>/g)].map((m) => m[0]);
}

/**
 * The visible `<button>`s of a card: those outside its ⋮ menu and its folded
 * editor. The ⋮ nests nothing, so it is stripped first and shortest; the
 * editor can nest a disclosure of its own (the calendar row's network access),
 * so it is stripped to the card's last `</details>`, which is its own.
 */
function visibleButtons(card: string): string[] {
  const outside = card
    .replace(/<details class="ovf"[\s\S]*?<\/details>/g, '')
    .replace(/<details class="disclose">[\s\S]*<\/details>/, '');
  return [...outside.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]!.trim());
}

/** The ⋮ menu's items, in order. */
function menuItems(card: string): string[] {
  const menu = /<div class="ovf-menu"[^>]*>([\s\S]*?)<\/div><\/details>/.exec(card)?.[1] ?? '';
  return [...menu.matchAll(/<button[^>]*>([^<]*)<\/button>|<a class="ovf-item"[^>]*>([^<]*)<\/a>/g)].map(
    (m) => (m[1] ?? m[2] ?? '').replace(/…$/, '').trim(),
  );
}

describe('every ordered list draws its rows by one rule', () => {
  it('People: reorder is in the ⋮ with Remove, and nothing but the Edit disclosure is left on the card', async () => {
    const h = await harness();
    await h.form('/admin/people', { name: 'Amy', color: '#E8A33D' });
    await h.form('/admin/people', { name: 'Ben', color: '#4A90D9' });
    await h.form('/admin/people', { name: 'Cal', color: '#35916A' });
    const rows = cards(await h.text('/admin/people'));
    expect(rows.length).toBe(3);
    for (const row of rows) expect(visibleButtons(row), 'no visible action buttons').toEqual([]);
    // The ends drop the move that goes nowhere; the middle has both.
    expect(menuItems(rows[0]!)).toEqual(['Move down', 'Remove']);
    expect(menuItems(rows[1]!)).toEqual(['Move up', 'Move down', 'Remove']);
    expect(menuItems(rows[2]!)).toEqual(['Move up', 'Remove']);
    // The old footer is gone outright.
    for (const row of rows) expect(row).not.toMatch(/↑ Up|↓ Down/);
    // And the menu still moves.
    const ben = (h.db.prepare(`SELECT id FROM people WHERE name = 'Ben'`).get() as { id: string }).id;
    expect((await h.form(`/admin/people/${ben}/move`, { dir: 'up' })).status).toBe(302);
    const names = (h.db.prepare('SELECT name FROM people ORDER BY sort_order').all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(['Ben', 'Amy', 'Cal']);
  });

  it('Chores: Pause stays as the one visible action; reorder joins Remove in the ⋮', async () => {
    const h = await harness();
    await h.form('/admin/chores', { name: 'Bins out', kind: 'daily' });
    await h.form('/admin/chores', { name: 'Water the plants', kind: 'daily' });
    const rows = cards(await h.text('/admin/chores'));
    expect(rows.length).toBe(2);
    for (const row of rows) expect(visibleButtons(row)).toEqual(['Pause']);
    expect(menuItems(rows[0]!)).toEqual(['Move down', 'Remove']);
    expect(menuItems(rows[1]!)).toEqual(['Move up', 'Remove']);
    // A paused chore keeps Resume where Pause was: the one thing worth
    // pressing on a dimmed card, where the ⋮ in its head is muted with it.
    const id = (h.db.prepare(`SELECT id FROM chores WHERE name = 'Bins out'`).get() as { id: string }).id;
    await h.form(`/admin/chores/${id}/pause`, {});
    const paused = cards(await h.text('/admin/chores')).find((row) => row.includes('Bins out'))!;
    expect(visibleButtons(paused)).toEqual(['Resume']);
  });

  it('Shift types: each type is a folded row, not an open form, and reorder is in the ⋮', async () => {
    const h = await harness();
    await h.form('/admin/shifts/types', { label: 'Days', short_code: 'D', color: '#E8A33D', is_working: '1' });
    await h.form('/admin/shifts/types', { label: 'Nights', short_code: 'N', color: '#4A90D9', is_working: '1' });
    const html = await h.text('/admin/shifts/types');
    const rows = cards(html);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(visibleButtons(row), 'no Save on an unopened row').toEqual([]);
      expect(row).toContain('<details class="disclose"><summary>Edit ');
      // The one fact a folded row must still carry is the code the month
      // cells draw.
      expect(row).toMatch(/Short code [DN]/);
    }
    expect(menuItems(rows[0]!)).toEqual(['Move down', 'Remove']);
    expect(menuItems(rows[1]!)).toEqual(['Move up', 'Remove']);
    // The editors are still there, one per type, each folded.
    expect(html.match(/<details class="disclose">/g)?.length).toBe(2);
    // The Save inside a folded editor still saves.
    const id = (h.db.prepare(`SELECT id FROM shift_types WHERE label = 'Days'`).get() as { id: string }).id;
    const saved = await h.form(`/admin/shifts/types/${id}`, {
      label: 'Day shift', short_code: 'D', color: '#E8A33D', is_working: '1',
    });
    expect(saved.status).toBe(302);
    expect(await h.text('/admin/shifts/types')).toContain('Edit Day shift');
  });

  it('Calendars already follow the rule: Sync now visible, Remove in the ⋮, Edit folded', async () => {
    // The control the others are brought into line with. Not a real feed —
    // the row's shape is the subject, and a source row inserted directly
    // draws exactly as one added through the form does.
    const h = await harness();
    const stamp = Date.now();
    h.db
      .prepare(
        `INSERT INTO calendar_sources (id, name, url_encrypted, created_at, updated_at)
         VALUES ('src-1', 'Family', 'x', ?, ?)`,
      )
      .run(stamp, stamp);
    const rows = cards(await h.text('/admin/calendars'));
    expect(rows.length).toBe(1);
    expect(visibleButtons(rows[0]!)).toEqual(['Sync now']);
    expect(menuItems(rows[0]!)).toEqual(['Remove']);
    expect(rows[0]).toContain('<details class="disclose"><summary>Edit Family');
  });
});
