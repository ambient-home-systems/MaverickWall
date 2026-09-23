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
import { issueDisplayToken } from '../src/auth/tokens.js';
import {
  buildLayout,
  keepWidgetsWithSomethingToSay,
  pruneWidgetTree,
  type HouseholdRow,
  type HouseholdSetUp,
  type PlacedWidgetRow,
} from '../src/api/manifest.js';
import { placedWidgetsBody, widgetConfigBody } from '../src/api/widget-schema.js';
import {
  applyTemplate,
  copyLayout,
  findTemplate,
  templateCanvasSchema,
  templatePreviewWidgets,
} from '../src/api/templates.js';
import { readLayoutWidgets } from '../src/api/queries.js';
import { toEpaperWidgets } from '../src/epaper/widgets.js';

/**
 * Groups as a data model (RFC 014 §5.1): a `parent_id` on `layout_widgets`,
 * a `group` widget type, and one level of nesting.
 *
 * What is held here is the *model* and its two boundaries. The schema refuses
 * a group inside a group and a child whose parent is not a group on the same
 * canvas; the manifest walker refuses both a second time and never orphans a
 * child onto the canvas; a group is kept exactly when one of its children has
 * something to say; a template's parent *keys* become minted ids with the
 * parents written first; a copy re-links the children to the copied group; and
 * a canvas with no group on it serialises byte for byte as it did before the
 * column existed — on the manifest and in the panel's ETag preimage — because
 * that is what keeps every stored ETag in the world from churning at one
 * image pull. `reflow-stability.test.ts` is where the drawn rectangles are
 * measured, on the wall and on a decoded panel frame.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const HOUSEHOLD = (over: Partial<HouseholdRow> = {}): HouseholdRow => ({
  timezone: 'Europe/London', shiftEnabled: 0, displayTodayEvents: 8, displayNextDays: 6,
  displayHorizonWeeks: 5, displayBlocks: 'now,next,horizon', clock24: 1, weekStart: 'sunday',
  layoutMode: 'freeform', layoutAspect: 0.5625, layoutLandscapeAspect: 1.7778,
  layoutBackground: null, layoutLandscapeBackground: null,
  ...over,
});

const row = (id: string, type: string, over: Partial<PlacedWidgetRow> = {}): PlacedWidgetRow => ({
  id, type, x: 0.1, y: 0.1, w: 0.3, h: 0.2, z: 0, config: undefined, ...over,
});

const NOTHING: HouseholdSetUp = { modules: [], shift: false, todoLists: [] };

/** A group and three children, the shape Classic Strip stores. */
const GROUPED: readonly PlacedWidgetRow[] = [
  row('g', 'group', { x: 0, y: 0, w: 1, h: 0.2, config: { layout: 'row' } }),
  row('c-clock', 'clock', { parentId: 'g', z: 0 }),
  row('c-weather', 'weather', { parentId: 'g', z: 1 }),
  row('c-shift', 'shift', { parentId: 'g', z: 2 }),
  row('cal', 'calendar', { y: 0.2, h: 0.8, z: 1 }),
];

describe('the boundary', () => {
  const box = { x: 0, y: 0, w: 0.5, h: 0.5 };

  it('refuses a group inside a group — nesting is one level, the ink.ink rule', () => {
    const parsed = placedWidgetsBody.safeParse([
      { id: 'g', type: 'group', ...box, z: 0 },
      { id: 'inner', type: 'group', ...box, z: 0, parentId: 'g' },
    ]);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('cannot sit inside another group');
  });

  it('refuses a child naming a stranger, a non-group, or nothing at all', () => {
    for (const widgets of [
      [{ id: 'c', type: 'clock', ...box, z: 0, parentId: 'nobody' }],
      [
        { id: 'cal', type: 'calendar', ...box, z: 0 },
        { id: 'c', type: 'clock', ...box, z: 0, parentId: 'cal' },
      ],
      [{ id: 'c', type: 'clock', ...box, z: 0, parentId: '' }],
    ]) {
      expect(placedWidgetsBody.safeParse(widgets).success, JSON.stringify(widgets)).toBe(false);
    }
  });

  it('refuses two widgets with one id, since a parent link could name either', () => {
    expect(
      placedWidgetsBody.safeParse([
        { id: 'g', type: 'group', ...box, z: 0 },
        { id: 'g', type: 'clock', ...box, z: 0 },
      ]).success,
    ).toBe(false);
  });

  it('accepts a group with children naming it, and a canvas with no group at all', () => {
    expect(
      placedWidgetsBody.safeParse([
        { id: 'g', type: 'group', ...box, z: 0, config: { layout: 'grid', columns: 3 } },
        { id: 'a', type: 'clock', ...box, z: 0, parentId: 'g' },
        { id: 'b', type: 'notes', ...box, z: 1, parentId: 'g' },
      ]).success,
    ).toBe(true);
    expect(placedWidgetsBody.safeParse([{ id: 'a', type: 'clock', ...box, z: 0 }]).success).toBe(true);
  });

  it('bounds a group’s layout and its grid width, and rejects rather than coerces', () => {
    expect(widgetConfigBody.safeParse({ layout: 'row' }).success).toBe(true);
    expect(widgetConfigBody.safeParse({ layout: 'grid', columns: 4 }).success).toBe(true);
    expect(widgetConfigBody.safeParse({ layout: 'spiral' }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ columns: 1 }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ columns: 5 }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ columns: '3' }).success).toBe(false);
  });

  it('holds a template canvas to the same tree rule, spelled with keys', () => {
    const canvas = (widgets: unknown[]) => templateCanvasSchema.safeParse({ aspect: 0.5625, widgets });
    expect(canvas([{ key: 'g', type: 'group', ...box }, { type: 'clock', parent: 'g', ...box }]).success).toBe(true);
    expect(canvas([{ type: 'clock', parent: 'g', ...box }]).success).toBe(false);
    expect(canvas([{ key: 'g', type: 'group', ...box }, { key: 'h', type: 'group', parent: 'g', ...box }]).success).toBe(false);
    expect(canvas([{ key: 'cal', type: 'calendar', ...box }, { type: 'clock', parent: 'cal', ...box }]).success).toBe(false);
    expect(canvas([{ key: 'g', type: 'group', ...box }, { key: 'g', type: 'group', ...box }]).success).toBe(false);
  });
});

describe('the walker', () => {
  it('drops a group that names a parent, with its children, and a child with no group here', () => {
    const rows = [
      row('g', 'group', { parentId: 'elsewhere' }),
      row('c', 'clock', { parentId: 'g' }),
      row('orphan', 'notes', { parentId: 'nobody', config: { text: 'x' } }),
      row('cal', 'calendar'),
    ];
    expect(pruneWidgetTree(rows).map((r) => r.id)).toEqual(['cal']);
    // …and never onto the canvas: an orphan's fractions are of a box that is
    // not there, so the manifest carries no trace of it.
    const layout = buildLayout(HOUSEHOLD(), rows, [], []);
    expect(layout.portrait.widgets.map((w) => w.id)).toEqual(['cal']);
  });

  it('keeps a group exactly when one of its children has something to say', () => {
    // Nothing set up: the clock speaks, so the group stays, with only the
    // children that speak.
    const kept = keepWidgetsWithSomethingToSay(GROUPED, NOTHING);
    expect(kept.map((r) => r.id)).toEqual(['g', 'c-clock', 'cal']);
    // Everything set up: all three children, in their order.
    const all = keepWidgetsWithSomethingToSay(GROUPED, { modules: ['weather'], shift: true, todoLists: [] });
    expect(all.map((r) => r.id)).toEqual(['g', 'c-clock', 'c-weather', 'c-shift', 'cal']);
  });

  it('drops a group whole when none of its children has anything to say', () => {
    const quiet = [
      row('g', 'group'),
      row('c-weather', 'weather', { parentId: 'g' }),
      row('c-shift', 'shift', { parentId: 'g' }),
      row('cal', 'calendar'),
    ];
    expect(keepWidgetsWithSomethingToSay(quiet, NOTHING).map((r) => r.id)).toEqual(['cal']);
    // A group with no children at all has nothing to say either.
    expect(keepWidgetsWithSomethingToSay([row('g', 'group'), row('cal', 'calendar')], NOTHING).map((r) => r.id)).toEqual(['cal']);
  });

  it('lets a child’s own fallback keep the group, and ignores a fallback on the group', () => {
    const note = { type: 'notes', config: { text: 'Bins Tuesday' } };
    const viaChild = [
      row('g', 'group'),
      row('c-weather', 'weather', { parentId: 'g', config: { whenEmpty: note } }),
      row('cal', 'calendar'),
    ];
    const kept = keepWidgetsWithSomethingToSay(viaChild, NOTHING);
    expect(kept.map((r) => [r.id, r.type, r.substituted])).toEqual([
      ['g', 'group', undefined],
      ['c-weather', 'notes', true],
      ['cal', 'calendar', undefined],
    ]);
    // A group carries no fallback of its own: its children are boxes and each
    // resolves theirs, so a `whenEmpty` on the group changes nothing.
    const onGroup = [
      row('g', 'group', { config: { whenEmpty: note } }),
      row('c-weather', 'weather', { parentId: 'g' }),
      row('cal', 'calendar'),
    ];
    expect(keepWidgetsWithSomethingToSay(onGroup, NOTHING).map((r) => r.id)).toEqual(['cal']);
  });

  it('hands back the pruned arrangement whole when nothing on it can speak (rule nine)', () => {
    const quiet = [row('g', 'group'), row('c-weather', 'weather', { parentId: 'g' })];
    expect(keepWidgetsWithSomethingToSay(quiet, NOTHING).map((r) => r.id)).toEqual(['g', 'c-weather']);
  });

  it('carries the link to the wall, parents first, and spreads it away where there is none', () => {
    const layout = buildLayout(HOUSEHOLD({ shiftEnabled: 1 }), GROUPED, [], ['weather']);
    expect(layout.portrait.widgets.map((w) => [w.id, w.parentId])).toEqual([
      ['g', undefined],
      ['cal', undefined],
      ['c-clock', 'g'],
      ['c-weather', 'g'],
      ['c-shift', 'g'],
    ]);
    const group = layout.portrait.widgets[0];
    expect(group !== undefined && 'parentId' in group).toBe(false);
    expect(JSON.stringify(layout.portrait.widgets[1])).not.toContain('parentId');
    expect(JSON.stringify(layout.portrait.widgets[2])).toContain('"parentId":"g"');
  });

  it('sends a canvas with no group byte for byte as before the column existed', () => {
    // The same rows, read as they were read before `parentId` — a row on the
    // canvas carries no key, so the two documents print identically.
    const plain = [row('clock', 'clock'), row('cal', 'calendar', { z: 1 })];
    const before = buildLayout(HOUSEHOLD(), plain, [], []);
    const after = buildLayout(HOUSEHOLD(), plain.map((r) => ({ ...r })), [], []);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(JSON.stringify(after)).not.toContain('parentId');
    expect(Object.keys(after.portrait.widgets[0] ?? {})).toEqual(['id', 'type', 'x', 'y', 'w', 'h', 'z', 'config']);
  });

  it('keeps the panel’s ETag preimage free of the link on a canvas with no group', () => {
    // `renderScreenFrame` hashes `JSON.stringify(widgets)`; an `id` on every
    // widget would move every paired panel's ETag at one image pull.
    const plain = toEpaperWidgets([row('clock', 'clock'), row('cal', 'calendar', { config: { mode: 'list' } })]);
    expect(JSON.stringify(plain)).toBe(
      JSON.stringify([
        { type: 'clock', x: 0.1, y: 0.1, w: 0.3, h: 0.2, z: 0, config: {} },
        { type: 'calendar', x: 0.1, y: 0.1, w: 0.3, h: 0.2, z: 0, config: { mode: 'list' } },
      ]),
    );
    const grouped = toEpaperWidgets(GROUPED);
    expect(grouped[0]).toMatchObject({ type: 'group', id: 'g' });
    expect(grouped[1]).toMatchObject({ type: 'clock', parentId: 'g' });
    expect('id' in (grouped[1] ?? {})).toBe(false);
  });
});

function freshDb() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-groups-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const at = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(at, at);
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
     VALUES ('wallA', 'Kitchen', 'h', 'panels', ?, ?, ?)`,
  ).run(at, at, at);
  return { db, dataDir };
}

describe('a template with a group', () => {
  it('ships one: Classic Strip, a row of the clock, the forecast and the rota over Classic’s calendars', () => {
    const strip = findTemplate('classic-strip');
    expect(strip).toBeDefined();
    for (const orientation of ['portrait', 'landscape'] as const) {
      const widgets = strip![orientation].widgets;
      const group = widgets.find((w) => w.type === 'group');
      expect(group?.key, orientation).toBe('strip');
      expect(group?.config).toEqual({ layout: 'row' });
      expect(widgets.filter((w) => w.parent === 'strip').map((w) => w.type)).toEqual(['clock', 'weather', 'shift']);
      // Classic's own calendars, untouched: the same boxes Classic authors.
      const classic = findTemplate('classic')![orientation].widgets.filter((w) => w.type === 'calendar');
      expect(widgets.filter((w) => w.type === 'calendar')).toEqual(classic);
    }
    expect(strip?.theme).toBeUndefined();
  });

  it('applies with ids minted for the parents first and the children naming them', () => {
    const { db } = freshDb();
    applyTemplate(db, 'wallA', findTemplate('classic-strip')!);
    for (const orientation of ['portrait', 'landscape'] as const) {
      const rows = readLayoutWidgets(db, 'wallA', orientation);
      const group = rows.find((r) => r.type === 'group');
      expect(group, orientation).toBeDefined();
      expect(group?.parentId).toBeUndefined();
      const children = rows.filter((r) => r.parentId !== undefined);
      expect(children.map((r) => r.type)).toEqual(['clock', 'weather', 'shift']);
      expect(children.every((r) => r.parentId === group?.id)).toBe(true);
      // Parents before children in the read, whatever their z: every row on
      // the canvas itself comes first.
      const firstChild = rows.findIndex((r) => r.parentId !== undefined);
      expect(rows.slice(0, firstChild).every((r) => r.parentId === undefined)).toBe(true);
      expect(rows.slice(firstChild).every((r) => r.parentId !== undefined)).toBe(true);
      // Minted, not the template's key.
      expect(group?.id).toMatch(/^w[0-9a-f]+$/);
      expect(children.every((r) => /^w[0-9a-f]+$/.test(r.parentId ?? ''))).toBe(true);
    }
  });

  it('previews with the same resolution the apply uses, on disposable ids', () => {
    const preview = templatePreviewWidgets(findTemplate('classic-strip')!.portrait);
    expect(preview[0]).toMatchObject({ id: 'tpl0', type: 'group' });
    expect(preview.filter((w) => w.parentId !== undefined).map((w) => [w.type, w.parentId])).toEqual([
      ['clock', 'tpl0'], ['weather', 'tpl0'], ['shift', 'tpl0'],
    ]);
    // A template with no group previews exactly as it always did.
    expect(templatePreviewWidgets(findTemplate('classic')!.portrait).every((w) => !('parentId' in w))).toBe(true);
  });

  it('copies onto another wall with the children re-linked to the copied group', () => {
    const { db } = freshDb();
    const at = Date.now();
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
       VALUES ('wallB', 'Hall', 'h2', 'panels', ?, ?, ?)`,
    ).run(at, at, at);
    applyTemplate(db, 'wallA', findTemplate('classic-strip')!);
    copyLayout(db, 'wallA', 'wallB');
    const source = readLayoutWidgets(db, 'wallA', 'portrait');
    const copy = readLayoutWidgets(db, 'wallB', 'portrait');
    const copiedGroup = copy.find((r) => r.type === 'group');
    expect(copiedGroup).toBeDefined();
    expect(copiedGroup?.id).not.toBe(source.find((r) => r.type === 'group')?.id);
    const children = copy.filter((r) => r.parentId !== undefined);
    expect(children).toHaveLength(3);
    expect(children.every((r) => r.parentId === copiedGroup?.id)).toBe(true);
  });
});

/** A signed-in harness: the real app, the wizard, a session cookie, one wall. */
async function ready() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-groups-app-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  // With a location and a rota, so the strip's forecast and badge reach the manifest.
  db.prepare(
    `INSERT INTO household_settings (id, latitude, longitude, shift_enabled, created_at, updated_at)
     VALUES ('singleton', 51.5, -0.12, 1, ?, ?)`,
  ).run(stamp, stamp);
  const address = `10.9.7.${++n}`;
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 't'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
  });
  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie !== '') headers.set('cookie', cookie);
    const res = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers, redirect: 'manual' }));
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return res;
  };
  const postForm = (path: string, fields: Record<string, string>) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  const postJson = (path: string, body: unknown) =>
    call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await call(`/setup?token=${setupToken.current().token}`);
  await postForm('/setup/account', {
    name: 'H', email: `g${n}@home.local`, password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await postForm('/setup/household', { timezone: 'Europe/London' });
  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
     VALUES ('s1', 'Wall', ?, 'panels', ?, ?, ?)`,
  ).run(issued.tokenHash, stamp, stamp, stamp);
  const manifestLayout = async () => {
    const res = await call('/d/manifest', { headers: { authorization: `Bearer ${issued.token}` } });
    const body = (await res.json()) as {
      layout: { portrait: { widgets: { id: string; type: string; parentId?: string }[] } };
    };
    return body.layout.portrait.widgets;
  };
  return { db, postForm, postJson, manifestLayout };
}

describe('through the real app', () => {
  const box = { x: 0, y: 0, w: 0.5, h: 0.5 };

  it('applies Classic Strip from the gallery and the wall reads the group back', async () => {
    const h = await ready();
    const res = await h.postForm('/admin/displays/s1/apply-template', { templateId: 'classic-strip' });
    expect(res.status).toBe(302);
    const rows = h.db
      .prepare(`SELECT id, type, parent_id AS parentId FROM layout_widgets WHERE screen_id = 's1' AND orientation = 'portrait' ORDER BY (parent_id IS NOT NULL), z`)
      .all() as { id: string; type: string; parentId: string | null }[];
    const group = rows.find((r) => r.type === 'group');
    expect(group?.parentId).toBeNull();
    expect(rows.filter((r) => r.parentId !== null).map((r) => [r.type, r.parentId])).toEqual([
      ['clock', group?.id], ['weather', group?.id], ['shift', group?.id],
    ]);
    const wall = await h.manifestLayout();
    expect(wall.map((w) => [w.type, w.parentId])).toEqual([
      ['group', undefined], ['calendar', undefined], ['calendar', undefined],
      ['clock', group?.id], ['weather', group?.id], ['shift', group?.id],
    ]);
  });

  it('refuses a hand-posted child naming a stranger’s id with a 400, writing nothing', async () => {
    const h = await ready();
    await h.postForm('/admin/displays/s1/apply-template', { templateId: 'classic' });
    const before = (h.db.prepare(`SELECT count(*) c FROM layout_widgets WHERE screen_id = 's1'`).get() as { c: number }).c;
    const res = await h.postJson('/admin/layout', {
      screen: 's1', orientation: 'portrait', mode: 'freeform', aspect: 0.5625,
      widgets: [
        { id: 'k', type: 'clock', ...box, z: 0 },
        { id: 'c', type: 'notes', ...box, z: 1, parentId: 'w-somebody-elses-group' },
      ],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('not a group on this layout');
    expect((h.db.prepare(`SELECT count(*) c FROM layout_widgets WHERE screen_id = 's1'`).get() as { c: number }).c).toBe(before);
  });

  it('refuses a group inside a group the same way', async () => {
    const h = await ready();
    const res = await h.postJson('/admin/layout', {
      screen: 's1', orientation: 'portrait', mode: 'freeform', aspect: 0.5625,
      widgets: [
        { id: 'g', type: 'group', ...box, z: 0 },
        { id: 'h', type: 'group', ...box, z: 0, parentId: 'g' },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('saves a well-formed group and reads it back with the link intact', async () => {
    const h = await ready();
    const res = await h.postJson('/admin/layout', {
      screen: 's1', orientation: 'portrait', mode: 'freeform', aspect: 0.5625,
      widgets: [
        { id: 'g', type: 'group', ...box, z: 0, config: { layout: 'grid', columns: 2 } },
        { id: 'a', type: 'clock', ...box, z: 0, parentId: 'g' },
        { id: 'b', type: 'notes', ...box, z: 1, parentId: 'g', config: { text: 'Hi' } },
        { id: 'cal', type: 'calendar', x: 0, y: 0.5, w: 1, h: 0.5, z: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(readLayoutWidgets(h.db, 's1', 'portrait').map((r) => [r.id, r.parentId])).toEqual([
      ['g', undefined], ['cal', undefined], ['a', 'g'], ['b', 'g'],
    ]);
  });
});
